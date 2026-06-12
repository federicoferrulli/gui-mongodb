'use strict';

// Test end-to-end della strategia MySQL: esercita l'intero flusso socket
// contro un MySQL locale (root, password vuota).
// Uso: node test/e2e-mysql.js            (MySQL su localhost:3306)
//      MYSQL_PORT=3307 node test/e2e-mysql.js
// Richiede il server della GUI già avviato su :3030.

const { io } = require('socket.io-client');

const socket = io('http://localhost:3030');
const MYSQL_PORT = process.env.MYSQL_PORT || 3306;
const DB = 'gui_mysql_e2e';
const DB2 = 'gui_mysql_e2e_ren';
const TABLE = 'people';

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

// Esegue una query SQL libera nel database indicato (modalità "SQL Raw").
function sql(db, query) {
  return emit('collection:aggregate', { db, coll: null, pipeline: query });
}

socket.on('connect', async () => {
  try {
    console.log('1. mongo:connect (dbType = mysql)');
    const conn = await emit('mongo:connect', {
      dbType: 'mysql', host: 'localhost', port: MYSQL_PORT, username: 'root', password: '',
    });
    assert(conn.ok && conn.dbType === 'mysql',
      `connessione riuscita (${conn.ok ? conn.databases.length + ' schema, dbType=' + conn.dbType : conn.error})`);
    if (!conn.ok) return socket.close();

    // Pulizia da eventuali esecuzioni precedenti fallite.
    await emit('db:drop', { db: DB });
    await emit('db:drop', { db: DB2 });

    console.log('2. db:create + SQL Raw (CREATE TABLE)');
    const created = await emit('db:create', { db: DB, coll: '' });
    assert(created.ok, `database "${DB}" creato`);
    const dup = await emit('db:create', { db: DB, coll: '' });
    assert(!dup.ok, 'creazione di un db già esistente rifiutata');
    const ddl = await sql(DB,
      `CREATE TABLE ${TABLE} (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(50) NOT NULL,
         age INT,
         city VARCHAR(50),
         born DATETIME
       )`);
    assert(ddl.ok, `tabella "${TABLE}" creata via SQL Raw`);

    console.log('3. doc:insert (righe come JSON)');
    const ins1 = await emit('doc:insert', { db: DB, coll: TABLE, doc: '{ "name": "Ada", "age": 36, "city": "Torino" }' });
    const ins2 = await emit('doc:insert', {
      db: DB, coll: TABLE,
      doc: '{ "name": "Bruno", "age": 41, "city": "Bari", "born": { "$date": "1984-05-09T10:30:00.000Z" } }',
    });
    assert(ins1.ok && ins2.ok, `due righe inserite (insertId = ${ins1.ok ? ins1.insertedId : ins1.error}, ${ins2.ok ? ins2.insertedId : ins2.error})`);

    console.log('4. db:collections');
    const colls = await emit('db:collections', { db: DB });
    assert(colls.ok && colls.collections.some((c) => c.name === TABLE), `tabella "${TABLE}" presente`);

    console.log('5. collection:find con WHERE e ordinamento');
    const find = await emit('collection:find', {
      db: DB, coll: TABLE,
      filter: 'age > 30',
      sort: '{ "age": -1 }', // JSON come dal click sull'intestazione di colonna
      limit: 50, skip: 0,
    });
    assert(find.ok && find.total === 2, `total = ${find.ok ? find.total : find.error}`);
    assert(find.ok && find.docs[0].name === 'Bruno', 'ordinamento decrescente per age');
    assert(find.ok && find.docs[0]._id && typeof find.docs[0]._id.id === 'number',
      `_id virtuale dalla chiave primaria (${find.ok ? JSON.stringify(find.docs[0]._id) : ''})`);
    assert(find.ok && find.columns[0] === 'id' && find.columns.includes('born'), 'colonne nell\'ordine della tabella');
    assert(find.ok && find.docs[0].born && typeof find.docs[0].born.$date === 'string',
      'DATETIME serializzato come { "$date": ... }');

    const sorted = await emit('collection:find', { db: DB, coll: TABLE, filter: '', sort: 'name ASC' });
    assert(sorted.ok && sorted.docs[0].name === 'Ada', 'ordinamento SQL libero (name ASC)');

    console.log('6. doc:update (UPDATE via chiave primaria)');
    const id = JSON.stringify(find.docs[0]._id);
    const upd = await emit('doc:update', {
      db: DB, coll: TABLE, id,
      set: { age: 42, city: 'Roma', born: { $date: '1984-05-09T10:30:00.000Z' } },
    });
    assert(upd.ok && upd.matched === 1, 'riga aggiornata');
    const check = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'" });
    assert(check.ok && check.docs[0].age === 42 && check.docs[0].city === 'Roma', 'modifica persistita');
    assert(check.ok && check.docs[0].born &&
      new Date(check.docs[0].born.$date).getTime() === Date.parse('1984-05-09T10:30:00.000Z'),
      'data EJSON round-trip senza shift di fuso');

    console.log('7. SQL Raw (SELECT aggregato)');
    const agg = await sql(DB, `SELECT SUM(age) AS totale FROM ${TABLE}`);
    assert(agg.ok && Number(agg.docs[0].totale) === 78, `aggregazione SQL: totale = ${agg.ok ? agg.docs[0].totale : agg.error}`);

    console.log('8. WHERE con errore di sintassi');
    const bad = await emit('collection:find', { db: DB, coll: TABLE, filter: 'non na senso ===' });
    assert(!bad.ok && bad.error, 'errore riportato correttamente');

    console.log('9. doc:replace (riga intera)');
    const rep = await emit('doc:replace', {
      db: DB, coll: TABLE, id,
      doc: '{ "name": "Bruno", "age": 50, "city": "Milano", "born": null }',
    });
    assert(rep.ok && rep.matched === 1, 'riga sostituita');
    const repCheck = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'" });
    assert(repCheck.ok && repCheck.docs[0].age === 50 && repCheck.docs[0].born === null,
      'replace persistito (born = NULL)');

    console.log('10. collection:stats');
    const stats = await emit('collection:stats', { db: DB, coll: TABLE });
    assert(stats.ok && stats.indexes.some((i) => i.name === 'PRIMARY' && i.unique), 'indice PRIMARY presente');
    assert(stats.ok && stats.fields.some((f) => f.name === 'name' && f.types[0].startsWith('varchar')),
      'schema: colonna "name" varchar');

    console.log('11. db:schema con foreign key (orders.people_id -> people)');
    const fk = await sql(DB,
      `CREATE TABLE orders (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         people_id INT UNSIGNED,
         amount DECIMAL(10,2),
         FOREIGN KEY (people_id) REFERENCES ${TABLE}(id)
       )`);
    assert(fk.ok, 'tabella "orders" creata con FK');
    const schema = await emit('db:schema', { db: DB });
    assert(schema.ok && schema.collections.some((c) => c.name === 'orders'), 'schema contiene "orders"');
    assert(schema.ok && schema.relations.some((r) => r.from === 'orders' && r.field === 'people_id' && r.to === TABLE),
      'relazione orders.people_id -> people rilevata');

    console.log('12. doc:delete');
    const del = await emit('doc:delete', { db: DB, coll: TABLE, id });
    assert(del.ok && del.deleted === 1, 'riga eliminata');

    console.log('13. collection:watch non disponibile su MySQL');
    const watch = await emit('collection:watch', { db: DB, coll: TABLE });
    assert(!watch.ok, 'watch rifiutato (nessun change stream)');

    console.log('14. db:rename / db:drop');
    const ren = await emit('db:rename', { db: DB, newName: DB2 });
    assert(ren.ok, `database rinominato in "${DB2}" (${ren.ok ? 'ok' : ren.error})`);
    const renCheck = await emit('collection:find', { db: DB2, coll: TABLE, filter: '' });
    assert(renCheck.ok && renCheck.total === 1, 'dati presenti nel database rinominato');
    const dbs = await emit('db:list', {});
    assert(dbs.ok && !dbs.databases.some((d) => d.name === DB), 'il vecchio nome non esiste più');
    const sysDrop = await emit('db:drop', { db: 'mysql' });
    assert(!sysDrop.ok, 'eliminazione di uno schema di sistema rifiutata');
    const drop = await emit('db:drop', { db: DB2 });
    assert(drop.ok, `database "${DB2}" eliminato`);

    console.log('15. mongo:disconnect');
    const disc = await emit('mongo:disconnect', {});
    assert(disc.ok, 'disconnessione pulita');

    console.log(process.exitCode ? '\nALCUNI TEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  } catch (err) {
    console.error('Errore imprevisto:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
