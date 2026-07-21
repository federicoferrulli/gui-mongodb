'use strict';

/* ---------------------------------------------------------------------------
 * Motore di backup: dump in streaming di un database (MongoDB o MySQL) in una
 * cartella auto-descritta:
 *
 *   <dest>/<connessione>_<db>/<id>/            id = timestamp_tipo
 *     manifest.json                            metadati + checksum SHA-256
 *     data/<collection>.ndjson[.gz]            una riga EJSON per documento
 *     indexes/<collection>.json                indici (solo MongoDB, solo full)
 *     schema/<tabella>.sql                     CREATE TABLE (solo MySQL)
 *   <dest>/<connessione>_<db>/catalog.json     catalogo dei backup del gruppo
 *
 * Tipi di backup:
 *   full          — tutti i documenti/righe.
 *   incremental   — solo le modifiche dall'ULTIMO backup (di qualsiasi tipo).
 *   differential  — solo le modifiche dall'ultimo backup FULL.
 *
 * Le modifiche sono individuate da un campo data (--since-field, es.
 * updatedAt); senza campo: MongoDB usa il timestamp degli ObjectId (cattura
 * solo i nuovi inserimenti), MySQL cerca colonne canoniche (updated_at, ...)
 * e in mancanza esegue il dump completo della tabella. Le cancellazioni non
 * vengono mai catturate dai backup incrementali/differenziali.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const { ObjectId } = require('mongodb');
const {
  createFileSink, safeName, makeBackupId, readCatalog, appendToCatalog, formatBytes,
} = require('./util');

const TOOL_VERSION = 1;
const MYSQL_SINCE_CANDIDATES = [
  'updated_at', 'updatedAt', 'modified_at', 'last_modified', 'last_updated', 'created_at', 'createdAt',
];

// Determina il backup di partenza per incremental/differential dal catalogo.
function resolveBase(groupDir, type) {
  if (type === 'full') return null;
  const backups = readCatalog(groupDir).backups.filter((b) => b.status === 'ok');
  const base = type === 'differential'
    ? [...backups].reverse().find((b) => b.type === 'full')
    : backups[backups.length - 1];
  if (!base) {
    throw new Error(`Nessun backup ${type === 'differential' ? 'full' : ''} precedente in ${groupDir}: esegui prima un backup full.`);
  }
  return base;
}

/* --- Dump MongoDB --------------------------------------------------------- */

async function dumpMongo({ strategy, db, collections, type, since, sinceField, backupDir, compress, level, log }) {
  const client = strategy.client;
  const files = [];
  const notes = [];

  for (const coll of collections) {
    const collection = client.db(db).collection(coll);
    let filter = {};
    let mode = 'full';
    let sinceColumn = null;
    if (since) {
      mode = 'incremental';
      if (sinceField) {
        sinceColumn = sinceField;
        filter = { [sinceField]: { $gt: new Date(since) } };
      } else {
        sinceColumn = '_id';
        filter = { _id: { $gt: ObjectId.createFromTime(Math.floor(new Date(since).getTime() / 1000)) } };
        notes.push(`"${coll}": modifiche individuate dal timestamp degli ObjectId — solo i nuovi inserimenti, non gli aggiornamenti (usa --since-field per un campo data).`);
      }
    }

    const rel = `data/${safeName(coll)}.ndjson${compress ? '.gz' : ''}`;
    const sink = createFileSink(path.join(backupDir, rel), { compress, level });
    let count = 0;
    const cursor = collection.find(filter);
    for await (const doc of cursor) {
      await sink.writeLine(EJSON.stringify(doc, { relaxed: true }));
      count += 1;
    }
    const { bytes, sha256 } = await sink.close();
    files.push({ path: rel, collection: coll, kind: 'data', mode, sinceColumn, count, bytes, sha256 });
    log.info(`  ${coll}: ${count} documenti → ${rel} (${formatBytes(bytes)})`);

    // Gli indici servono solo al restore del layer full.
    if (type === 'full') {
      const indexes = await collection.indexes().catch(() => []);
      const relIdx = `indexes/${safeName(coll)}.json`;
      fs.mkdirSync(path.join(backupDir, 'indexes'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relIdx), JSON.stringify(EJSON.serialize(indexes, { relaxed: true }), null, 2), 'utf8');
      files.push({ path: relIdx, collection: coll, kind: 'indexes' });
    }
  }
  return { files, notes };
}

/* --- Dump MySQL ----------------------------------------------------------- */

// Sceglie la colonna data per l'incrementale della tabella: quella esplicita
// (--since-field, se esiste) oppure la prima tra le candidate canoniche.
async function mysqlSinceColumn(conn, db, table, sinceField) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dtype FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table]
  );
  const dateCols = new Set(
    cols.filter((c) => ['timestamp', 'datetime', 'date'].includes(String(c.dtype).toLowerCase())).map((c) => c.name)
  );
  if (sinceField) return dateCols.has(sinceField) ? sinceField : null;
  return MYSQL_SINCE_CANDIDATES.find((c) => dateCols.has(c)) || null;
}

async function dumpMySql({ strategy, db, collections, since, sinceField, backupDir, compress, level, log }) {
  const mysql = require('mysql2');
  const pool = strategy.pool;
  const conn = await pool.getConnection();
  const files = [];
  const notes = [];
  try {
    for (const table of collections) {
      // Definizione della tabella, per ricrearla al restore.
      const [[create]] = await conn.query(`SHOW CREATE TABLE ${mysql.escapeId(db, true)}.${mysql.escapeId(table, true)}`);
      const relSchema = `schema/${safeName(table)}.sql`;
      fs.mkdirSync(path.join(backupDir, 'schema'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relSchema), String(create['Create Table']) + ';\n', 'utf8');
      files.push({ path: relSchema, collection: table, kind: 'schema' });

      let mode = 'full';
      let sinceColumn = null;
      let where = '';
      const params = [];
      if (since) {
        sinceColumn = await mysqlSinceColumn(conn, db, table, sinceField);
        if (sinceColumn) {
          mode = 'incremental';
          // FROM_UNIXTIME confronta l'istante assoluto: passare una Date
          // farebbe serializzare a mysql2 l'ora locale del client, sbagliata
          // quando il server è in un altro fuso orario.
          where = ` WHERE ${mysql.escapeId(sinceColumn, true)} > FROM_UNIXTIME(?)`;
          params.push(Math.floor(new Date(since).getTime() / 1000));
        } else {
          notes.push(`"${table}": nessuna colonna data utilizzabile — inclusa per intero nel backup incrementale.`);
        }
      }

      const rel = `data/${safeName(table)}.ndjson${compress ? '.gz' : ''}`;
      const sink = createFileSink(path.join(backupDir, rel), { compress, level });
      let count = 0;
      // Streaming riga per riga sulla connessione non-promise: nessun
      // caricamento in memoria dell'intera tabella.
      const stream = conn.connection
        .query({ sql: `SELECT * FROM ${mysql.escapeId(db, true)}.${mysql.escapeId(table, true)}${where}`, values: params })
        .stream();
      for await (const row of stream) {
        await sink.writeLine(EJSON.stringify(row, { relaxed: true }));
        count += 1;
      }
      const { bytes, sha256 } = await sink.close();
      files.push({ path: rel, collection: table, kind: 'data', mode, sinceColumn, count, bytes, sha256 });
      log.info(`  ${table}: ${count} righe → ${rel} (${formatBytes(bytes)})`);
    }
  } finally {
    conn.release();
  }
  return { files, notes };
}

/* --- Backup completo di un database --------------------------------------- */

async function runBackup({ session, connName, db, type, onlyCollections, sinceField, destRoot, compress, level, log }) {
  const { strategy, dbType } = session;
  const groupDir = path.join(destRoot, `${safeName(connName)}_${safeName(db)}`);
  const base = resolveBase(groupDir, type);
  const since = base ? base.startedAt : null;
  const id = makeBackupId(type);
  const backupDir = path.join(groupDir, id);
  if (fs.existsSync(backupDir)) throw new Error(`La cartella di backup esiste già: ${backupDir}`);

  // startedAt è catturato PRIMA di leggere i dati: il prossimo incrementale
  // ripartirà da qui e non perderà le scritture avvenute durante il dump.
  const startedAt = new Date().toISOString();
  if (base) log.info(`Backup ${type} basato su ${base.id} (modifiche dal ${since}).`);

  // Solo collection/tabelle "vere": le view sono derivate e non si ripristinano.
  const all = (await strategy.listCollections(db)).filter((c) => c.type !== 'view').map((c) => c.name);
  const collections = onlyCollections
    ? all.filter((c) => onlyCollections.includes(c))
    : all;
  if (onlyCollections) {
    for (const c of onlyCollections) {
      if (!all.includes(c)) throw new Error(`Collection/tabella "${c}" non trovata nel database "${db}".`);
    }
  }
  if (!collections.length) throw new Error(`Il database "${db}" non contiene collection/tabelle da salvare.`);

  fs.mkdirSync(backupDir, { recursive: true });
  let result;
  try {
    const args = { strategy, db, collections, type, since, sinceField, backupDir, compress, level, log };
    result = dbType === 'mysql' ? await dumpMySql(args) : await dumpMongo(args);

    const manifest = {
      tool: 'codedb-backup',
      version: TOOL_VERSION,
      id,
      type,
      baseId: base ? base.id : null,
      connection: connName,
      dbType,
      db,
      compress,
      startedAt,
      endedAt: new Date().toISOString(),
      notes: result.notes,
      files: result.files,
    };
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    appendToCatalog(groupDir, {
      id, type, baseId: manifest.baseId, db, dbType, startedAt, endedAt: manifest.endedAt, status: 'ok',
    });
  } catch (err) {
    // Backup incompleto: la cartella parziale viene rimossa e il catalogo
    // resta intatto, così non potrà mai fare da base a un incrementale.
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignora */ }
    throw err;
  }

  const dataFiles = result.files.filter((f) => f.kind === 'data');
  const totalDocs = dataFiles.reduce((s, f) => s + f.count, 0);
  const totalBytes = dataFiles.reduce((s, f) => s + f.bytes, 0);
  for (const n of result.notes) log.info(`  Nota: ${n}`);
  return { backupDir, id, collections: dataFiles.length, totalDocs, totalBytes };
}

module.exports = { runBackup };
