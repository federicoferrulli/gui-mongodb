'use strict';

// Test E2E per il nuovo Query & Aggregate Engine (Task 6)
// Uso: node test/e2e-query-engine.js

const { io } = require('socket.io-client');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');

const socket = io('http://localhost:3030');
const DB = 'gui_mongodb_e2e';
const COLL = 'query_test_items';

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

socket.on('connect', async () => {
  try {
    console.log('--- Test E2E Query & Aggregate Engine ---');

    console.log('1. Connessione MongoDB');
    const conn = await emit('mongo:connect', { host: 'localhost', port: 27017 });
    assert(conn.ok, 'Connessione a MongoDB riuscita');
    if (!conn.ok) return socket.close();

    console.log('2. Inserimento documenti di prova');
    await emit('doc:insert', { db: DB, coll: COLL, doc: '{ "item": "laptop", "qty": 10, "price": 1200 }' });
    await emit('doc:insert', { db: DB, coll: COLL, doc: '{ "item": "phone", "qty": 25, "price": 800 }' });

    console.log('3. Esecuzione query:execute (Pipeline MQL)');
    const mqlRes = await emit('query:execute', {
      engine: 'mongodb',
      db: DB,
      coll: COLL,
      code: `[ { "$match": { "qty": { "$gte": 10 } } }, { "$sort": { "price": -1 } } ]`
    });
    assert(mqlRes.ok && mqlRes.data.length === 2, `MQL Aggregate ritornato ${mqlRes.data ? mqlRes.data.length : 0} documenti`);
    assert(mqlRes.ok && mqlRes.data[0].item === 'laptop', 'Ordinamento prezzo corretto');

    console.log('4. Test Unitario VirtualJoinEngine in-memory merge');
    const dummyStrategyA = {
      type: 'mysql',
      async collectionAggregate() {
        return { docs: [{ id: 1, user_id: 'usr_100', total: 150 }] };
      }
    };
    const dummyStrategyB = {
      type: 'mongodb',
      async collectionAggregate() {
        return { docs: [{ _id: 'usr_100', name: 'Mario Rossi', email: 'mario@example.com' }] };
      }
    };

    const vjSpec = {
      virtualJoin: {
        sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
        sourceB: { dbType: 'mongodb', db: 'crm', collection: 'users' },
        on: { leftKey: 'user_id', rightKey: '_id' },
        as: 'user_details'
      }
    };

    const vjResult = await VirtualJoinEngine.execute(vjSpec, dummyStrategyA, dummyStrategyB);
    assert(vjResult.length === 1, 'VirtualJoinEngine ha ritornato 1 elemento unito');
    assert(vjResult[0].user_details && vjResult[0].user_details.name === 'Mario Rossi', 'Cross-DB merge dati corretto');

    console.log('5. Pulizia database di test');
    await emit('db:drop', { db: DB });
    console.log('--- Tutti i test superati con successo! ---');

  } catch (err) {
    console.error('Errore durante i test:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
