'use strict';

const mysql = require('mysql2');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

/* ---------------------------------------------------------------------------
 * Helpers MySQL
 * ------------------------------------------------------------------------- */

function assertDbName(name) {
  if (!name || /[\r\n]/.test(name) || name.length > 64) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

// Identificatore quotato (` `), con eventuale punto trattato come carattere.
function qid(name) {
  return mysql.escapeId(String(name), true);
}

function qtable(db, table) {
  return `${qid(db)}.${qid(table)}`;
}

// Converte un valore proveniente dal client (già "deserializzato" da EJSON)
// in un parametro SQL sicuro per mysql2: i tipi primitivi, Date e Buffer
// passano invariati, oggetti e array diventano testo JSON (utile per le
// colonne JSON), il tipo BSON Binary torna a essere un Buffer.
function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') {
    if (v._bsontype === 'Binary') return v.buffer;
    return JSON.stringify(v);
  }
  return v;
}

// Il client invia i valori in Extended JSON: relaxed = true produce tipi
// JavaScript nativi (numeri normali, Date per $date), quelli che servono
// come parametri SQL.
function parseClientValue(text) {
  return EJSON.parse(String(text), { relaxed: true });
}

function deserializeClientObject(obj) {
  return EJSON.deserialize(obj || {}, { relaxed: true });
}

// Le righe viaggiano verso il client come Extended JSON relaxed, come per
// MongoDB: le Date diventano { $date: ... } e il frontend le riconosce.
function serializeRow(row) {
  return EJSON.serialize(row, { relaxed: true });
}

// Clausola WHERE per la chiave (virtuale) _id: { col: valore, ... }.
// <=> è l'uguaglianza NULL-safe, necessaria per le chiavi composite di
// fallback che possono contenere NULL.
function whereFromId(id) {
  const cols = Object.keys(id);
  if (!cols.length) throw new Error('Identificatore di riga mancante.');
  const sql = cols.map((c) => `${qid(c)} <=> ?`).join(' AND ');
  const params = cols.map((c) => toSqlValue(id[c]));
  return { sql, params };
}

/* ---------------------------------------------------------------------------
 * Strategia MySQL: un pool dedicato per istanza (cioè per socket)
 * ------------------------------------------------------------------------- */

class MySqlStrategy extends DbStrategy {
  constructor() {
    super();
    this.pool = null; // pool promise-based di mysql2
  }

  get type() { return 'mysql'; }

  requirePool() {
    if (!this.pool) throw new Error('Nessuna connessione attiva al database.');
    return this.pool;
  }

  async connect(cfg) {
    const pool = mysql.createPool({
      host: (cfg.host || 'localhost').trim(),
      port: parseInt(cfg.port, 10) || 3306,
      user: cfg.username || 'root',
      password: cfg.password || '',
      database: (cfg.database || '').trim() || undefined,
      connectTimeout: 6000,
      waitForConnections: true,
      connectionLimit: 4,
      multipleStatements: false,
    }).promise();
    try {
      await pool.query('SELECT 1'); // credenziali sbagliate falliscono qui
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    this.pool = pool;
  }

  async disconnect() {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.end().catch(() => {});
    }
  }

  async listDatabases() {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT s.SCHEMA_NAME AS name,
              COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size
         FROM information_schema.SCHEMATA s
    LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
     GROUP BY s.SCHEMA_NAME
     ORDER BY s.SCHEMA_NAME`
    );
    return rows.map((r) => ({ name: r.name, sizeOnDisk: Number(r.size) || 0 }));
  }

  async createDatabase(db, firstColl) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    const existing = await this.listDatabases();
    if (existing.some((d) => d.name === name)) throw new Error(`Il database "${name}" esiste già.`);
    await pool.query(`CREATE DATABASE ${qid(name)}`);
    // A differenza di MongoDB la prima tabella è facoltativa.
    const table = String(firstColl || '').trim();
    if (table) {
      await pool.query(
        `CREATE TABLE ${qtable(name, table)} (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY)`
      );
    }
  }

  async renameDatabase(db, newName) {
    const pool = this.requirePool();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (SYSTEM_SCHEMAS.has(from.toLowerCase())) {
      throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
    }
    const existing = await this.listDatabases();
    if (existing.some((d) => d.name === to)) throw new Error(`Il database "${to}" esiste già.`);

    // MySQL non supporta RENAME DATABASE: si crea il nuovo schema e si
    // spostano le tabelle con RENAME TABLE (le view non sono spostabili).
    const [tables] = await pool.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [from]
    );
    if (!tables.length) throw new Error('Il database non contiene tabelle da spostare.');
    await pool.query(`CREATE DATABASE ${qid(to)}`);
    for (const t of tables) {
      await pool.query(`RENAME TABLE ${qtable(from, t.name)} TO ${qtable(to, t.name)}`);
    }
    await pool.query(`DROP DATABASE ${qid(from)}`);
  }

  async dropDatabase(db) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    if (SYSTEM_SCHEMAS.has(name.toLowerCase())) {
      throw new Error(`Il database di sistema "${name}" non può essere eliminato.`);
    }
    await pool.query(`DROP DATABASE ${qid(name)}`);
  }

  async listCollections(db) {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS ttype, TABLE_ROWS AS cnt
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
      [db]
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.ttype === 'VIEW' ? 'view' : 'collection',
      count: r.ttype === 'VIEW' ? null : Number(r.cnt) || 0, // stima InnoDB
    }));
  }

  // Colonne della chiave primaria, nell'ordine della definizione.
  async primaryKey(db, table) {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME AS name
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
      [db, table]
    );
    return rows.map((r) => r.name);
  }

  // _id virtuale per il client: la chiave primaria come oggetto
  // { colonna: valore }. Senza chiave primaria si usa l'intera riga come
  // chiave composita di fallback.
  makeId(row, pkCols, allCols) {
    const cols = pkCols.length ? pkCols : allCols;
    const id = {};
    for (const c of cols) id[c] = row[c];
    return id;
  }

  // Risale dalla chiave inviata dal client (JSON.stringify di _id) e la
  // trasforma in clausola WHERE.
  parseRowId(rawId) {
    const id = parseClientValue(rawId);
    if (!id || typeof id !== 'object' || Array.isArray(id)) {
      throw new Error('Identificatore di riga non valido.');
    }
    return whereFromId(id);
  }

  // ORDER BY: accetta sia SQL libero ("name ASC") sia il JSON {"name": 1}
  // prodotto dal click sulle intestazioni di colonna.
  buildOrderBy(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (t.startsWith('{')) {
      let spec;
      try {
        spec = JSON.parse(t);
      } catch {
        throw new Error('Ordinamento non valido: usare SQL (es. name ASC) oppure JSON (es. {"name":1}).');
      }
      const parts = Object.entries(spec).map(([col, dir]) => `${qid(col)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
      return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
    }
    return ` ORDER BY ${t}`;
  }

  async collectionFind(db, coll, payload) {
    const pool = this.requirePool();
    const where = String(payload.filter || '').trim();
    const whereSql = where ? ` WHERE ${where}` : '';
    const orderSql = this.buildOrderBy(payload.sort);
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
    const table = qtable(db, coll);

    const [rows, fields] = await pool.query(
      `SELECT * FROM ${table}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
      [limit, skip]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}${whereSql}`);

    const columns = (fields || []).map((f) => f.name);
    const pk = await this.primaryKey(db, coll);
    const docs = rows.map((r) => {
      const doc = { ...r, _id: this.makeId(r, pk, columns) };
      return serializeRow(doc);
    });
    return { docs, columns, total: Number(total), skip, limit };
  }

  // Modalità "SQL Raw": esegue una query libera nel contesto del database.
  async collectionAggregate(db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    const conn = await pool.getConnection();
    try {
      await conn.query(`USE ${qid(db)}`);
      const [result, fields] = await conn.query(sql);
      if (Array.isArray(result)) {
        const rows = result.slice(0, 500);
        const columns = (fields || []).map((f) => f.name);
        return { docs: rows.map(serializeRow), columns, total: result.length, skip: 0, limit: 500 };
      }
      // Statement senza result set (UPDATE, DELETE, DDL...): riepilogo.
      const summary = { righeCoinvolte: result.affectedRows };
      if (result.insertId) summary.insertId = result.insertId;
      if (result.info) summary.info = result.info;
      return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: 500 };
    } finally {
      conn.release();
    }
  }

  async docInsert(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    const cols = Object.keys(doc);
    const table = qtable(db, coll);
    let res;
    if (!cols.length) {
      [res] = await pool.query(`INSERT INTO ${table} () VALUES ()`);
    } else {
      const sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      [res] = await pool.query(sql, cols.map((c) => toSqlValue(doc[c])));
    }
    return { insertedId: JSON.stringify(res.insertId || null) };
  }

  async docUpdate(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const set = deserializeClientObject(payload.set);
    const assignments = [];
    const params = [];
    for (const [col, val] of Object.entries(set)) {
      assignments.push(`${qid(col)} = ?`);
      params.push(toSqlValue(val));
    }
    for (const col of payload.unset || []) {
      assignments.push(`${qid(col)} = NULL`);
    }
    if (!assignments.length) throw new Error('Nessuna modifica da applicare.');
    const [res] = await pool.query(
      `UPDATE ${qtable(db, coll)} SET ${assignments.join(', ')} WHERE ${where.sql} LIMIT 1`,
      [...params, ...where.params]
    );
    return { matched: res.affectedRows, modified: res.changedRows != null ? res.changedRows : res.affectedRows };
  }

  async docReplace(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    delete doc._id; // chiave virtuale, non è una colonna
    // In SQL "sostituire" la riga equivale ad aggiornare tutte le colonne note.
    return this.docUpdate(db, coll, { id: payload.id, set: EJSON.serialize(doc, { relaxed: true }) });
  }

  async docDelete(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const [res] = await pool.query(
      `DELETE FROM ${qtable(db, coll)} WHERE ${where.sql} LIMIT 1`,
      where.params
    );
    return { deleted: res.affectedRows };
  }

  async tableFields(db, table) {
    const pool = this.requirePool();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
      [db, table]
    );
    return cols.map((c) => ({
      name: c.name,
      types: [String(c.ctype)],
      presence: c.nullable === 'YES' ? 0 : 100, // 100 = NOT NULL
    }));
  }

  async collectionStats(db, coll) {
    const pool = this.requirePool();
    const [[t]] = await pool.query(
      `SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AVG_ROW_LENGTH
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [db, coll]
    );
    if (!t) throw new Error(`Tabella "${coll}" non trovata in "${db}".`);

    let indexes = [];
    try {
      const [idx] = await pool.query(`SHOW INDEX FROM ${qtable(db, coll)}`);
      const byName = new Map();
      for (const i of idx) {
        let entry = byName.get(i.Key_name);
        if (!entry) byName.set(i.Key_name, (entry = { name: i.Key_name, key: {}, unique: !Number(i.Non_unique) }));
        entry.key[i.Column_name] = 1;
      }
      indexes = [...byName.values()];
    } catch { /* le view non hanno indici */ }

    const fields = await this.tableFields(db, coll);
    return {
      stats: {
        count: Number(t.TABLE_ROWS) || 0, // stima InnoDB
        size: Number(t.DATA_LENGTH) || 0,
        storageSize: (Number(t.DATA_LENGTH) || 0) + (Number(t.INDEX_LENGTH) || 0),
        avgObjSize: Number(t.AVG_ROW_LENGTH) || 0,
        totalIndexSize: Number(t.INDEX_LENGTH) || 0,
        nindexes: indexes.length,
      },
      indexes,
      fields,
      sampled: Number(t.TABLE_ROWS) || 0,
    };
  }

  async dbSchema(db) {
    const pool = this.requirePool();
    const [cols] = await pool.query(
      `SELECT TABLE_NAME AS tname, COLUMN_NAME AS name, COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db]
    );
    const byTable = new Map();
    for (const c of cols) {
      let t = byTable.get(c.tname);
      if (!t) byTable.set(c.tname, (t = { name: c.tname, fields: [] }));
      t.fields.push({ name: c.name, types: [String(c.ctype)], presence: c.nullable === 'YES' ? 0 : 100 });
    }
    const collections = [...byTable.values()].sort((a, b) => a.name.localeCompare(b.name));

    // Relazioni reali dalle foreign key dichiarate...
    const [fks] = await pool.query(
      `SELECT TABLE_NAME AS tname, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS ref
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [db]
    );
    const relations = fks.map((f) => ({ from: f.tname, field: f.col, to: f.ref, many: false }));

    // ...più le euristiche di denominazione per quelle non formalizzate.
    const known = new Set(relations.map((r) => `${r.from} ${r.field}`));
    for (const r of DbStrategy.detectRelations(collections)) {
      if (!known.has(`${r.from} ${r.field}`)) relations.push(r);
    }
    return { collections, relations };
  }
}

module.exports = MySqlStrategy;
