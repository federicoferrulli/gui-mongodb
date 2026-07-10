'use strict';

// Test end-to-end del gateway MCP: esercita l'endpoint /mcp con il client
// ufficiale dell'SDK contro un MongoDB locale.
// Richiede il server già avviato su :3030 (env PORT) e MongoDB su :27017.
// Uso: node test/e2e-mcp.js

const { io } = require('socket.io-client');
const { MongoClient } = require('mongodb');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { assertReadOnlySql, assertReadOnlyPipeline } = require('../mcp/McpGateway');

const PORT = process.env.PORT || 3030;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'gui_mongodb_e2e_mcp';
const CONN_NAME = 'e2e-mcp';

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

function rejects(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// Invoca un tool e ne decodifica il risultato: { ok, text, data }.
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content && res.content[0] && res.content[0].text) || '';
  return { ok: !res.isError, text, data: res.isError ? null : JSON.parse(text) };
}

async function newMcpClient() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: 'gui-mongodb-e2e-mcp', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

(async () => {
  let mongo = null;
  let socket = null;
  let mcp1 = null;
  let mcp2 = null;
  try {
    console.log('0. guardie di sola lettura (unit, senza server)');
    const okSql = [
      'SELECT 1',
      'select * from clienti where eta > 30 limit 10',
      '  (SELECT 1) UNION (SELECT 2)',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT 1',
      'SHOW TABLES',
      'DESCRIBE clienti',
    ];
    const badSql = [
      'DROP TABLE clienti',
      'UPDATE clienti SET eta = 1',
      'INSERT INTO clienti VALUES (1)',
      'DELETE FROM clienti',
      'TRUNCATE clienti',
      'SET GLOBAL sql_mode = ""',
      'CALL procedura()',
      'START TRANSACTION',
      "SELECT * FROM clienti INTO OUTFILE '/tmp/x'",
    ];
    assert(okSql.every((s) => !rejects(() => assertReadOnlySql(s))), 'statement di lettura ammessi');
    assert(badSql.every((s) => rejects(() => assertReadOnlySql(s))), 'statement di scrittura rifiutati');
    assert(!rejects(() => assertReadOnlyPipeline('[{ "$match": { "a": 1 } }]')), 'pipeline di lettura ammessa');
    assert(rejects(() => assertReadOnlyPipeline('[{ "$merge": { "into": "x" } }]')), 'pipeline con $merge rifiutata');

    console.log('1. seed dei dati di test (driver MongoDB)');
    mongo = new MongoClient('mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
    await mongo.connect();
    await mongo.db(DB).dropDatabase().catch(() => {});
    const ins = await mongo.db(DB).collection('people').insertMany([
      { name: 'Ada', age: 36, city: 'Torino' },
      { name: 'Bruno', age: 41, city: 'Bari', tags: ['a', 'b'] },
    ]);
    await mongo.db(DB).collection('orders').insertOne({ people_id: ins.insertedIds[0], amount: 10 });

    console.log('2. connessione salvata di test (via socket, come farebbe la UI)');
    socket = io(BASE);
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const saved = await emit(socket, 'connections:save', { name: CONN_NAME, cfg: { host: '127.0.0.1', port: 27017 } });
    assert(saved.ok, `connections:save "${CONN_NAME}"${saved.ok ? '' : ' (' + saved.error + ')'}`);

    console.log('3. handshake MCP e tools/list');
    mcp1 = await newMcpClient();
    const tools = await mcp1.client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const t of ['list_saved_connections', 'connect_database', 'disconnect_database', 'get_databases_and_collections', 'get_schema', 'execute_query']) {
      assert(names.includes(t), `tool "${t}" esposto`);
    }

    console.log('4. list_saved_connections');
    const list = await call(mcp1.client, 'list_saved_connections', {});
    assert(list.ok && list.data.connections.some((c) => c.name === CONN_NAME && c.dbType === 'mongodb'), 'connessione di test elencata');
    assert(list.ok && !/password/i.test(list.text), 'nessun campo password nel risultato');

    console.log('5. connect_database');
    const conn = await call(mcp1.client, 'connect_database', { saved: CONN_NAME });
    assert(conn.ok && conn.data.connection_id && conn.data.dbType === 'mongodb', `connessione aperta${conn.ok ? '' : ' (' + conn.text + ')'}`);
    const cid = conn.ok ? conn.data.connection_id : '';
    const connBad = await call(mcp1.client, 'connect_database', { saved: 'inesistente-mcp' });
    assert(!connBad.ok, 'connessione salvata inesistente rifiutata');

    console.log('6. get_databases_and_collections');
    const dbs = await call(mcp1.client, 'get_databases_and_collections', { connection_id: cid });
    assert(dbs.ok && dbs.data.databases.some((d) => d.name === DB), 'elenco database contiene il db di test');
    const colls = await call(mcp1.client, 'get_databases_and_collections', { connection_id: cid, db: DB });
    assert(colls.ok && ['people', 'orders'].every((n) => colls.data.collections.some((c) => c.name === n)), 'collection "people" e "orders" elencate');

    console.log('7. get_schema');
    const schema = await call(mcp1.client, 'get_schema', { connection_id: cid, db: DB });
    assert(schema.ok && schema.data.collections.some((c) => c.name === 'people' && c.fields.some((f) => f.name === 'name')), 'schema campionato di "people"');
    assert(schema.ok && schema.data.relations.some((r) => r.from === 'orders' && r.to === 'people' && r.field === 'people_id'), 'relazione orders.people_id -> people rilevata');

    console.log('8. execute_query: find con filtro e sort (EJSON)');
    const q = await call(mcp1.client, 'execute_query', {
      connection_id: cid, db: DB, collection: 'people',
      filter: '{ "age": { "$gt": 30 } }', sort: '{ "age": -1 }', limit: 10,
    });
    assert(q.ok && q.data.total === 2 && q.data.docs[0].name === 'Bruno', `find: total = ${q.ok ? q.data.total : q.text}`);
    assert(q.ok && q.data.docs[0]._id && q.data.docs[0]._id.$oid, '_id in Extended JSON ($oid)');

    console.log('9. execute_query: pipeline di aggregazione');
    const agg = await call(mcp1.client, 'execute_query', {
      connection_id: cid, db: DB, collection: 'people',
      pipeline: '[{ "$group": { "_id": null, "totale": { "$sum": "$age" } } }]',
    });
    assert(agg.ok && agg.data.docs[0].totale === 77, `aggregazione: totale = ${agg.ok ? agg.data.docs[0].totale : agg.text}`);

    console.log('10. guardie e parametri errati');
    const out = await call(mcp1.client, 'execute_query', { connection_id: cid, db: DB, collection: 'people', pipeline: '[{ "$out": "copia" }]' });
    assert(!out.ok && /\$out/.test(out.text), 'pipeline con $out rifiutata');
    const sqlOnMongo = await call(mcp1.client, 'execute_query', { connection_id: cid, db: DB, sql: 'SELECT 1' });
    assert(!sqlOnMongo.ok, 'parametro "sql" rifiutato su MongoDB');
    const badConn = await call(mcp1.client, 'execute_query', { connection_id: 'sconosciuto', db: DB, collection: 'people' });
    assert(!badConn.ok, 'connection_id sconosciuto rifiutato');
    const badFilter = await call(mcp1.client, 'execute_query', { connection_id: cid, db: DB, collection: 'people', filter: '{ non valido }' });
    assert(!badFilter.ok, 'filtro con sintassi errata: errore riportato');

    console.log('11. isolamento tra sessioni MCP');
    mcp2 = await newMcpClient();
    const cross = await call(mcp2.client, 'execute_query', { connection_id: cid, db: DB, collection: 'people' });
    assert(!cross.ok, 'connection_id di un\'altra sessione MCP rifiutato');

    console.log('12. disconnect_database');
    const disc = await call(mcp1.client, 'disconnect_database', { connection_id: cid });
    assert(disc.ok && disc.data.disconnected, 'disconnessione riuscita');
    const afterDisc = await call(mcp1.client, 'execute_query', { connection_id: cid, db: DB, collection: 'people' });
    assert(!afterDisc.ok, 'query dopo la disconnessione rifiutata');

    console.log(process.exitCode ? '\nTEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  } catch (err) {
    console.error('Errore inatteso:', err);
    process.exitCode = 1;
  } finally {
    // Pulizia: chiudi le sessioni MCP sul server (DELETE /mcp), rimuovi la
    // connessione salvata e il database di test.
    if (mcp1) { await mcp1.transport.terminateSession().catch(() => {}); await mcp1.client.close().catch(() => {}); }
    if (mcp2) { await mcp2.transport.terminateSession().catch(() => {}); await mcp2.client.close().catch(() => {}); }
    if (socket && socket.connected) await emit(socket, 'connections:delete', { name: CONN_NAME });
    if (socket) socket.close();
    if (mongo) {
      await mongo.db(DB).dropDatabase().catch(() => {});
      await mongo.close().catch(() => {});
    }
  }
})();

setTimeout(() => {
  console.error('Timeout: il server non risponde.');
  process.exit(1);
}, 60000).unref();
