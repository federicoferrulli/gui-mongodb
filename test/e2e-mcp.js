'use strict';

// Test end-to-end del gateway MCP: esercita l'endpoint /mcp con il client
// ufficiale dell'SDK contro un MongoDB locale.
// Richiede il server già avviato su :3030 (env PORT) e MongoDB su :27017.
// Uso: node test/e2e-mcp.js

const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { MongoClient } = require('mongodb');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { assertReadOnlySql, assertReadOnlyPipeline } = require('../mcp/McpGateway');

const PORT = process.env.PORT || 3030;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'gui_mongodb_e2e_mcp';
const DROP_DB = 'gui_mongodb_e2e_mcp_drop';
const CONN_NAME = 'e2e-mcp';
const RW_NAME = 'e2e-mcp-rw';

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
    for (const t of ['list_saved_connections', 'connect_database', 'disconnect_database', 'get_databases_and_collections', 'get_schema', 'execute_query', 'execute_write', 'set_connection_read_only']) {
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

    console.log('10b. Fase 2: prompts');
    const prompts = await mcp1.client.listPrompts();
    const pnames = prompts.prompts.map((p) => p.name);
    assert(pnames.includes('genera-report') && pnames.includes('esplora-database'), `prompts esposti (${pnames.join(', ')})`);
    const prompt = await mcp1.client.getPrompt({ name: 'genera-report', arguments: { connessione: CONN_NAME, db: DB, periodo: '2026' } });
    const ptext = prompt.messages[0].content.text;
    assert(ptext.includes(CONN_NAME) && ptext.includes(DB) && ptext.includes('2026'), 'prompt parametrizzato con connessione, db e periodo');

    console.log('10c. Fase 2: resource schema://');
    const tmpl = await mcp1.client.listResourceTemplates();
    assert(tmpl.resourceTemplates.some((t) => t.uriTemplate === 'schema://{connectionId}/{db}'), 'template schema:// pubblicato');
    const resr = await mcp1.client.readResource({ uri: `schema://${cid}/${DB}` });
    const rtext = resr.contents[0].text;
    assert(resr.contents[0].mimeType === 'text/markdown' && rtext.includes('erDiagram'), 'risorsa markdown con diagramma Mermaid');
    assert(rtext.includes('people') && /orders\.people_id.*people/.test(rtext.replace(/`/g, '')), 'dizionario dati con relazione orders.people_id -> people');
    const resrBad = await mcp1.client.readResource({ uri: `schema://sconosciuto/${DB}` }).then(() => true, () => false);
    assert(!resrBad, 'risorsa con connection_id sconosciuto rifiutata');

    console.log('11. isolamento tra sessioni MCP');
    mcp2 = await newMcpClient();
    const cross = await call(mcp2.client, 'execute_query', { connection_id: cid, db: DB, collection: 'people' });
    assert(!cross.ok, 'connection_id di un\'altra sessione MCP rifiutato');

    console.log('12. disconnect_database');
    const disc = await call(mcp1.client, 'disconnect_database', { connection_id: cid });
    assert(disc.ok && disc.data.disconnected, 'disconnessione riuscita');
    const afterDisc = await call(mcp1.client, 'execute_query', { connection_id: cid, db: DB, collection: 'people' });
    assert(!afterDisc.ok, 'query dopo la disconnessione rifiutata');

    console.log('13. Fase 3: execute_write rifiutata su connessione read-only (default)');
    const roConn = await call(mcp1.client, 'connect_database', { saved: CONN_NAME });
    const roCid = roConn.ok ? roConn.data.connection_id : '';
    assert(roConn.ok && roConn.data.writable === false, 'connessione di default non scrivibile');
    const wDenied = await call(mcp1.client, 'execute_write', { connection_id: roCid, db: DB, collection: 'people', operation: 'insert', doc: '{ "name": "X" }' });
    assert(!wDenied.ok && /sola lettura/i.test(wDenied.text), 'scrittura rifiutata con messaggio esplicativo');
    await call(mcp1.client, 'disconnect_database', { connection_id: roCid });

    console.log('14. Fase 3: scritture con conferma su connessione readOnly=false');
    const savedRw = await emit(socket, 'connections:save', { name: RW_NAME, cfg: { host: '127.0.0.1', port: 27017, readOnly: 'false' } });
    assert(savedRw.ok, `connections:save "${RW_NAME}" con readOnly=false`);
    const listRw = await call(mcp1.client, 'list_saved_connections', {});
    assert(listRw.ok && listRw.data.connections.some((c) => c.name === RW_NAME && c.readOnly === false), 'flag readOnly esposto in list_saved_connections');
    const rw = await call(mcp1.client, 'connect_database', { saved: RW_NAME });
    assert(rw.ok && rw.data.writable === true, 'connessione scrivibile aperta');
    const cid2 = rw.ok ? rw.data.connection_id : '';

    const ins1 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, collection: 'people', operation: 'insert', doc: '{ "name": "Carla", "age": 29 }' });
    assert(ins1.ok && ins1.data.requires_confirmation && ins1.data.confirm_token, 'primo passo: anteprima + confirm_token');
    const ins2 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, confirm_token: ins1.data.confirm_token });
    assert(ins2.ok && ins2.data.executed, 'secondo passo: insert eseguito col token');
    const afterIns = await call(mcp1.client, 'execute_query', { connection_id: cid2, db: DB, collection: 'people', filter: '{ "name": "Carla" }' });
    assert(afterIns.ok && afterIns.data.total === 1, 'documento inserito e rileggibile');
    const reuse = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, confirm_token: ins1.data.confirm_token });
    assert(!reuse.ok, 'confirm_token monouso: riuso rifiutato');
    const fake = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, confirm_token: 'token-inventato' });
    assert(!fake.ok, 'confirm_token inventato rifiutato');

    const upd1 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, collection: 'people', operation: 'update', filter: '{ "name": "Carla" }', set: '{ "age": 30 }' });
    assert(upd1.ok && upd1.data.affected_estimate === 1, `stima documenti interessati = ${upd1.ok ? upd1.data.affected_estimate : upd1.text}`);
    const upd2 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, confirm_token: upd1.data.confirm_token });
    assert(upd2.ok && upd2.data.result.modified === 1, 'update confermato ed eseguito');

    const delEmpty = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, collection: 'people', operation: 'delete', filter: '{}' });
    assert(!delEmpty.ok, 'delete con filtro vuoto rifiutata subito');
    const del1 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, collection: 'people', operation: 'delete', filter: '{ "name": "Carla" }' });
    const del2 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, confirm_token: del1.ok ? del1.data.confirm_token : '' });
    assert(del1.ok && del2.ok && del2.data.result.deleted === 1, 'delete confermata ed eseguita');

    console.log('14b. Fase 3: drop_collection e drop_database con conferma');
    await mongo.db(DB).collection('scratch').insertOne({ tmp: 1 });
    const dc1 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, collection: 'scratch', operation: 'drop_collection' });
    assert(dc1.ok && dc1.data.requires_confirmation && dc1.data.affected_estimate === 1, `drop_collection: anteprima con stima = ${dc1.ok ? dc1.data.affected_estimate : dc1.text}`);
    const dc2 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, confirm_token: dc1.data.confirm_token });
    assert(dc2.ok && dc2.data.executed, 'drop_collection confermato ed eseguito');
    const afterDc = await call(mcp1.client, 'get_databases_and_collections', { connection_id: cid2, db: DB });
    assert(afterDc.ok && !afterDc.data.collections.some((c) => c.name === 'scratch'), 'collection "scratch" eliminata');
    const dcNoColl = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DB, operation: 'drop_collection' });
    assert(!dcNoColl.ok, 'drop_collection senza "collection" rifiutato');

    await mongo.db(DROP_DB).collection('x').insertOne({ tmp: 1 });
    const dd1 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DROP_DB, operation: 'drop_database' });
    assert(dd1.ok && dd1.data.requires_confirmation && dd1.data.affected_estimate === 1, 'drop_database: anteprima con numero di collection');
    const dd2 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: DROP_DB, confirm_token: dd1.data.confirm_token });
    assert(dd2.ok && dd2.data.executed, 'drop_database confermato ed eseguito');
    const afterDd = await call(mcp1.client, 'get_databases_and_collections', { connection_id: cid2 });
    assert(afterDd.ok && !afterDd.data.databases.some((d) => d.name === DROP_DB), `database "${DROP_DB}" eliminato`);

    const ddSys1 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: 'admin', operation: 'drop_database' });
    const ddSys2 = await call(mcp1.client, 'execute_write', { connection_id: cid2, db: 'admin', confirm_token: ddSys1.ok ? ddSys1.data.confirm_token : '' });
    assert(ddSys1.ok && !ddSys2.ok && /sistema/i.test(ddSys2.text), 'drop_database su db di sistema bloccato dalla strategia');

    const qGuard = await call(mcp1.client, 'execute_query', { connection_id: cid2, db: DB, collection: 'people', pipeline: '[{ "$out": "x" }]' });
    assert(!qGuard.ok, 'execute_query resta di sola lettura anche su connessione scrivibile (policy per-tool)');

    const auditPath = path.join(__dirname, '..', 'mcp-audit.log');
    const auditText = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
    assert(auditText.includes(`"connection":"${RW_NAME}"`) && auditText.includes('"event":"executed"'), 'audit log con eventi requested/executed');

    await call(mcp1.client, 'disconnect_database', { connection_id: cid2 });

    console.log('15. set_connection_read_only: flag readOnly con doppia conferma');
    const ro1 = await call(mcp1.client, 'set_connection_read_only', { connection_name: CONN_NAME, read_only: false });
    assert(ro1.ok && ro1.data.requires_confirmation && ro1.data.confirm_token, 'primo passo: anteprima + confirm_token');
    const roFake = await call(mcp1.client, 'set_connection_read_only', { connection_name: CONN_NAME, confirm_token: 'token-inventato' });
    assert(!roFake.ok, 'confirm_token inventato rifiutato');
    const roCross = await call(mcp1.client, 'execute_write', { connection_id: 'x', db: DB, confirm_token: ro1.data.confirm_token });
    assert(!roCross.ok, 'token di set_connection_read_only non spendibile su execute_write');
    const ro2 = await call(mcp1.client, 'set_connection_read_only', { connection_name: CONN_NAME, confirm_token: ro1.data.confirm_token });
    assert(ro2.ok && ro2.data.executed && ro2.data.readOnly === false, 'secondo passo: flag aggiornato col token');
    const listAfter = await call(mcp1.client, 'list_saved_connections', {});
    assert(listAfter.ok && listAfter.data.connections.some((c) => c.name === CONN_NAME && c.readOnly === false), 'readOnly=false visibile in list_saved_connections');
    const rwNow = await call(mcp1.client, 'connect_database', { saved: CONN_NAME });
    assert(rwNow.ok && rwNow.data.writable === true, 'nuova connessione scrivibile dopo il cambio flag');
    await call(mcp1.client, 'disconnect_database', { connection_id: rwNow.ok ? rwNow.data.connection_id : '' });
    const roBack1 = await call(mcp1.client, 'set_connection_read_only', { connection_name: CONN_NAME, read_only: true });
    assert(roBack1.ok && roBack1.data.requires_confirmation, 'anche il ritorno a sola lettura richiede conferma');
    const roBack2 = await call(mcp1.client, 'set_connection_read_only', { connection_name: CONN_NAME, confirm_token: roBack1.data.confirm_token });
    assert(roBack2.ok && roBack2.data.executed && roBack2.data.readOnly === true, 'flag riportato a sola lettura');
    const roNoop = await call(mcp1.client, 'set_connection_read_only', { connection_name: CONN_NAME, read_only: true });
    assert(roNoop.ok && roNoop.data.changed === false, 'valore già impostato: nessun token, nessuna modifica');
    const roMissing = await call(mcp1.client, 'set_connection_read_only', { connection_name: 'inesistente-mcp', read_only: false });
    assert(!roMissing.ok, 'connessione inesistente rifiutata');

    console.log(process.exitCode ? '\nTEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  } catch (err) {
    console.error('Errore inatteso:', err);
    process.exitCode = 1;
  } finally {
    // Pulizia: chiudi le sessioni MCP sul server (DELETE /mcp), rimuovi la
    // connessione salvata e il database di test.
    if (mcp1) { await mcp1.transport.terminateSession().catch(() => {}); await mcp1.client.close().catch(() => {}); }
    if (mcp2) { await mcp2.transport.terminateSession().catch(() => {}); await mcp2.client.close().catch(() => {}); }
    if (socket && socket.connected) {
      await emit(socket, 'connections:delete', { name: CONN_NAME });
      await emit(socket, 'connections:delete', { name: RW_NAME });
    }
    if (socket) socket.close();
    if (mongo) {
      await mongo.db(DB).dropDatabase().catch(() => {});
      await mongo.db(DROP_DB).dropDatabase().catch(() => {});
      await mongo.close().catch(() => {});
    }
  }
})();

setTimeout(() => {
  console.error('Timeout: il server non risponde.');
  process.exit(1);
}, 60000).unref();
