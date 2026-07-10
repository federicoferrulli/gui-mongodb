'use strict';

// Test end-to-end del gateway MCP sul percorso MySQL: whitelist SQL di sola
// lettura, transazione READ ONLY a livello di motore e serializzazione EJSON.
// Richiede il server già avviato su :3030 (env PORT) e un MySQL locale
// (root, password vuota; override con env MYSQL_PORT / MYSQL_PASSWORD).
// Uso: node test/e2e-mcp-mysql.js

const mysql = require('mysql2/promise');
const { io } = require('socket.io-client');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const PORT = process.env.PORT || 3030;
const BASE = `http://127.0.0.1:${PORT}`;
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const DB = 'gui_mysql_e2e_mcp';
const CONN_NAME = 'e2e-mcp-mysql';

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

// Invoca un tool e ne decodifica il risultato: { ok, text, data }.
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content && res.content[0] && res.content[0].text) || '';
  return { ok: !res.isError, text, data: res.isError ? null : JSON.parse(text) };
}

(async () => {
  let admin = null;
  let socket = null;
  let client = null;
  let transport = null;
  try {
    console.log('1. seed dei dati di test (driver MySQL)');
    admin = await mysql.createConnection({ host: '127.0.0.1', port: MYSQL_PORT, user: 'root', password: MYSQL_PASSWORD });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.query(`CREATE TABLE ${DB}.people (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), age INT, born DATETIME)`);
    await admin.query(`INSERT INTO ${DB}.people (name, age, born) VALUES ('Ada', 36, '1990-01-15 10:00:00'), ('Bruno', 41, '1985-06-02 08:30:00')`);

    console.log('2. connessione salvata di test (via socket, come farebbe la UI)');
    socket = io(BASE);
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const saved = await emit(socket, 'connections:save', {
      name: CONN_NAME,
      cfg: { dbType: 'mysql', host: '127.0.0.1', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD },
    });
    assert(saved.ok, `connections:save "${CONN_NAME}"${saved.ok ? '' : ' (' + saved.error + ')'}`);

    console.log('3. MCP: connect_database su MySQL');
    transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
    client = new Client({ name: 'gui-mongodb-e2e-mcp-mysql', version: '1.0.0' });
    await client.connect(transport);
    const conn = await call(client, 'connect_database', { saved: CONN_NAME });
    assert(conn.ok && conn.data.dbType === 'mysql', `connessione aperta (dbType = ${conn.ok ? conn.data.dbType : conn.text})`);
    const cid = conn.ok ? conn.data.connection_id : '';

    console.log('4. get_databases_and_collections e get_schema');
    const colls = await call(client, 'get_databases_and_collections', { connection_id: cid, db: DB });
    assert(colls.ok && colls.data.collections.some((c) => c.name === 'people'), 'tabella "people" elencata');
    const schema = await call(client, 'get_schema', { connection_id: cid, db: DB });
    assert(schema.ok && schema.data.collections.some((c) => c.name === 'people' && c.fields.some((f) => f.name === 'born')), 'schema con le colonne reali');

    console.log('5. execute_query: SELECT');
    const sel = await call(client, 'execute_query', { connection_id: cid, db: DB, sql: 'SELECT * FROM people ORDER BY age DESC' });
    assert(sel.ok && sel.data.total === 2 && sel.data.docs[0].name === 'Bruno', `SELECT: total = ${sel.ok ? sel.data.total : sel.text}`);
    assert(sel.ok && sel.data.docs[0].born && sel.data.docs[0].born.$date, 'DATETIME serializzato come $date (EJSON)');

    console.log('6. guardie di sola lettura');
    const upd = await call(client, 'execute_query', { connection_id: cid, db: DB, sql: 'UPDATE people SET age = 1' });
    assert(!upd.ok, 'UPDATE bloccato dalla whitelist');
    const cte = await call(client, 'execute_query', { connection_id: cid, db: DB, sql: 'WITH x AS (SELECT 1) DELETE FROM people WHERE age IN (SELECT * FROM x)' });
    assert(!cte.ok && /READ ONLY/i.test(cte.text), 'DML annidato in CTE bloccato dal motore (READ ONLY)');
    const outfile = await call(client, 'execute_query', { connection_id: cid, db: DB, sql: "SELECT * FROM people INTO OUTFILE '/tmp/x'" });
    assert(!outfile.ok, 'INTO OUTFILE bloccato');
    const filt = await call(client, 'execute_query', { connection_id: cid, db: DB, collection: 'people', filter: 'age > 30' });
    assert(!filt.ok && /"sql"/.test(filt.text), 'parametri MongoDB su MySQL: errore che indirizza a "sql"');
    const count = await call(client, 'execute_query', { connection_id: cid, db: DB, sql: 'SELECT COUNT(*) AS n FROM people' });
    assert(count.ok && Number(count.data.docs[0].n) === 2, 'dati intatti dopo i tentativi di scrittura');

    console.log('7. percorso UI invariato (SQL Raw senza readOnly scrive ancora)');
    const ui = await emit(socket, 'mongo:connect', {
      dbType: 'mysql', host: '127.0.0.1', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD, tabId: 'ui',
    });
    assert(ui.ok, 'mongo:connect mysql (tab UI)');
    const uiWrite = await emit(socket, 'collection:aggregate', { tabId: 'ui', db: DB, coll: null, pipeline: "UPDATE people SET age = 37 WHERE name = 'Ada'" });
    assert(uiWrite.ok && uiWrite.docs[0].righeCoinvolte === 1, 'UPDATE dalla UI eseguito (nessuna regressione)');
    await emit(socket, 'mongo:disconnect', { tabId: 'ui' });

    console.log('8. disconnect_database');
    const disc = await call(client, 'disconnect_database', { connection_id: cid });
    assert(disc.ok && disc.data.disconnected, 'disconnessione riuscita');

    console.log(process.exitCode ? '\nTEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  } catch (err) {
    console.error('Errore inatteso:', err);
    process.exitCode = 1;
  } finally {
    if (transport) await transport.terminateSession().catch(() => {});
    if (client) await client.close().catch(() => {});
    if (socket && socket.connected) await emit(socket, 'connections:delete', { name: CONN_NAME });
    if (socket) socket.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
})();

setTimeout(() => {
  console.error('Timeout: il server non risponde.');
  process.exit(1);
}, 60000).unref();
