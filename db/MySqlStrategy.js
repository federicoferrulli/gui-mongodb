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

// DEFAULT di colonna: numeri e parole chiave (NULL, CURRENT_TIMESTAMP...)
// passano così come sono, il resto viene quotato come stringa.
function defaultSql(v) {
  const t = String(v).trim();
  if (/^(NULL|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|TRUE|FALSE)$/i.test(t)) return t.toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return mysql.escape(t);
}

// Definizione SQL di una colonna a partire dall'oggetto del form:
// { name, type, nullable, default, autoIncrement }.
function columnSql(c) {
  const name = String((c && c.name) || '').trim();
  const type = String((c && c.type) || '').trim();
  if (!name || !type) throw new Error('Ogni colonna deve avere nome e tipo.');
  let s = `${qid(name)} ${type}`;
  if (c.nullable === false) s += ' NOT NULL';
  if (c.default != null && String(c.default).trim() !== '') s += ` DEFAULT ${defaultSql(c.default)}`;
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  return s;
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
    try {
      await pool.query(`CREATE DATABASE ${qid(name)}`);
    } catch (err) {
      // Niente check preventivo via listDatabases() (costoso e soggetto a
      // TOCTOU): si lascia decidere al motore e si traduce il suo errore.
      if (err && err.code === 'ER_DB_CREATE_EXISTS') throw new Error(`Il database "${name}" esiste già.`);
      throw err;
    }
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

    // MySQL non supporta RENAME DATABASE: si crea il nuovo schema e si
    // spostano le tabelle con RENAME TABLE (le view non sono spostabili).
    const [tables] = await pool.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [from]
    );
    if (!tables.length) throw new Error('Il database non contiene tabelle da spostare.');
    try {
      await pool.query(`CREATE DATABASE ${qid(to)}`);
    } catch (err) {
      // Niente check preventivo via listDatabases() (costoso e soggetto a
      // TOCTOU): si lascia decidere al motore e si traduce il suo errore.
      if (err && err.code === 'ER_DB_CREATE_EXISTS') throw new Error(`Il database "${to}" esiste già.`);
      throw err;
    }
    if (tables.length > 0) {
      const renameParts = tables.map((t) => `${qtable(from, t.name)} TO ${qtable(to, t.name)}`);
      await pool.query(`RENAME TABLE ${renameParts.join(', ')}`);
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
    // TABLE_TYPE: 'BASE TABLE', 'VIEW' oppure 'SYSTEM VIEW' (information_schema).
    return rows.map((r) => {
      const isView = String(r.ttype || '').toUpperCase().includes('VIEW');
      return {
        name: r.name,
        type: isView ? 'view' : 'collection',
        count: isView ? null : Number(r.cnt) || 0, // stima InnoDB
      };
    });
  }

  async search(query) {
    this.requirePool();
    const term = `%${(query || '').toLowerCase()}%`;
    const sql = `
      SELECT table_schema as db, table_name as coll
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        AND (LOWER(table_schema) LIKE ? OR LOWER(table_name) LIKE ?)
    `;
    const [rows] = await this.pool.query(sql, [term, term]);
    const dbs = new Map();
    for (const r of rows) {
      if (!dbs.has(r.db)) dbs.set(r.db, []);
      dbs.get(r.db).push({ name: r.coll });
    }
    return Array.from(dbs.entries()).map(([name, collections]) => ({ name, collections }));
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

  // Pezzi comuni di una SELECT su filter/sort/limit/skip liberi (usati sia
  // dalla query dati vera e propria sia dal suo EXPLAIN).
  buildSelect(db, coll, payload) {
    const where = String(payload.filter || '').trim();
    const whereSql = where ? ` WHERE ${where}` : '';
    const orderSql = this.buildOrderBy(payload.sort);
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
    const table = qtable(db, coll);
    return { table, whereSql, orderSql, limit, skip };
  }

  async collectionFind(db, coll, payload) {
    const pool = this.requirePool();
    const { table, whereSql, orderSql, limit, skip } = this.buildSelect(db, coll, payload);

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
  // payload.readOnly (usato dal gateway MCP): esegue dentro una transazione
  // READ ONLY — il motore rifiuta qualsiasi scrittura, comprese quelle
  // annidate in CTE o EXPLAIN ANALYZE — e con un timeout di 30 secondi.
  async collectionAggregate(db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    const readOnly = !!payload.readOnly;
    const conn = await pool.getConnection();
    try {
      await conn.query(`USE ${qid(db)}`);
      if (readOnly) await conn.query('START TRANSACTION READ ONLY');
      try {
        const [result, fields] = await conn.query(readOnly ? { sql, timeout: 30000 } : sql);
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
        if (readOnly) await conn.query('ROLLBACK').catch(() => {});
      }
    } finally {
      conn.release();
    }
  }

  // Piano di esecuzione: EXPLAIN sulla SELECT costruita da filter/sort correnti
  // (modalità find) o sulla SQL Raw (modalità aggregate). Prova prima
  // EXPLAIN FORMAT=JSON, con ripiego sull'EXPLAIN classico tabellare
  // (versioni vecchie o statement non supportati dal formato JSON).
  async collectionExplain(db, coll, payload) {
    const pool = this.requirePool();
    let sql;
    if (payload.mode === 'aggregate') {
      sql = String(payload.pipeline || '').trim();
      if (!sql) throw new Error('Inserisci una query SQL di cui mostrare il piano.');
    } else {
      const { table, whereSql, orderSql, limit, skip } = this.buildSelect(db, coll, payload);
      sql = `SELECT * FROM ${table}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${skip}`;
    }

    const conn = await pool.getConnection();
    try {
      await conn.query(`USE ${qid(db)}`);
      try {
        const [rows] = await conn.query(`EXPLAIN FORMAT=JSON ${sql}`);
        const raw = rows && rows[0] && (rows[0].EXPLAIN || rows[0][Object.keys(rows[0])[0]]);
        return { format: 'json', plan: JSON.parse(String(raw)), query: sql };
      } catch (err) {
        // Ripiego: EXPLAIN classico in forma tabellare.
        const [rows, fields] = await conn.query(`EXPLAIN ${sql}`);
        if (!Array.isArray(rows)) throw err;
        const columns = (fields || []).map((f) => f.name);
        return { format: 'table', rows: rows.map(serializeRow), columns, query: sql };
      }
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

  async collectionDeleteMany(db, coll, payload) {
    const pool = this.requirePool();
    const filter = String(payload.filter || '').trim();
    // Senza filtro svuota la tabella (come deleteMany({}) su MongoDB):
    // la conferma rafforzata è responsabilità del frontend.
    const [res] = await pool.query(
      `DELETE FROM ${qtable(db, coll)}${filter ? ` WHERE ${filter}` : ''}`
    );
    return { deleted: res.affectedRows };
  }

  // Valore di cella per l'export CSV: date in ISO, BLOB in base64,
  // oggetti/array come JSON; quoting RFC 4180 dove serve.
  static csvCell(v) {
    if (v === null || v === undefined) return '';
    let s;
    if (v instanceof Date) s = isNaN(v.getTime()) ? '' : v.toISOString();
    else if (Buffer.isBuffer(v)) s = v.toString('base64');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // CREATE TABLE della tabella: usato dall'export di interi database per
  // ricreare lo schema all'import.
  async tableDdl(db, coll) {
    const pool = this.requirePool();
    const [[row]] = await pool.query(`SHOW CREATE TABLE ${qtable(db, coll)}`);
    // Le view (anche di sistema) restituiscono 'Create View': niente DDL da
    // esportare, il chiamante le tratta come le collection senza schema.
    const ddl = row && row['Create Table'];
    return ddl == null ? null : String(ddl);
  }

  // Esporta un blocco di righe come CSV (format: 'csv', header a parte),
  // come statement INSERT (format: 'sql') o come righe Extended JSON
  // (format: 'json', una riga-oggetto per riga di tabella: è il formato
  // dell'export di interi database, reimportabile con collectionImport).
  // Paginazione keyset sulla chiave primaria (evita l'O(n²) di OFFSET su
  // tabelle grandi): payload.after = EJSON dei valori PK dell'ultima riga
  // ricevuta. Senza chiave primaria non esiste un ordinamento stabile su cui
  // costruire un cursore, quindi si ripiega su skip/offset (comportamento
  // precedente, invariato per questo caso).
  async collectionExport(db, coll, payload) {
    const pool = this.requirePool();
    const format = ['sql', 'json'].includes(payload.format) ? payload.format : 'csv';
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
    const table = qtable(db, coll);
    const pk = await this.primaryKey(db, coll);

    let rows;
    let fields;
    let nextAfter = null;
    if (pk.length) {
      const pkCols = pk.map(qid).join(', ');
      let whereSql = '';
      let params = [];
      if (payload.after != null && payload.after !== '') {
        let afterVals;
        try {
          afterVals = parseClientValue(payload.after);
        } catch {
          throw new Error('Cursore di paginazione non valido.');
        }
        if (!Array.isArray(afterVals) || afterVals.length !== pk.length) {
          throw new Error('Cursore di paginazione non valido.');
        }
        whereSql = ` WHERE (${pkCols}) > (${pk.map(() => '?').join(', ')})`;
        params = afterVals.map(toSqlValue);
      }
      [rows, fields] = await pool.query(
        `SELECT * FROM ${table}${whereSql} ORDER BY ${pkCols} LIMIT ?`,
        [...params, limit]
      );
      if (rows.length) {
        const last = rows[rows.length - 1];
        nextAfter = EJSON.stringify(pk.map((c) => last[c]), { relaxed: true });
      }
    } else {
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      [rows, fields] = await pool.query(`SELECT * FROM ${table} LIMIT ? OFFSET ?`, [limit, skip]);
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    const columns = (fields || []).map((f) => f.name);

    let lines;
    if (format === 'sql') {
      lines = rows.map((r) => {
        const vals = columns.map((c) => mysql.escape(r[c]));
        return `INSERT INTO ${table} (${columns.map(qid).join(', ')}) VALUES (${vals.join(', ')});`;
      });
    } else if (format === 'json') {
      // EJSON relaxed: le DATETIME diventano { $date } e il roundtrip
      // export → import preserva i tipi (vedi collectionImport).
      lines = rows.map((r) => EJSON.stringify(r, { relaxed: true }));
    } else {
      lines = rows.map((r) => columns.map((c) => MySqlStrategy.csvCell(r[c])).join(','));
    }
    return {
      lines,
      count: rows.length,
      total: Number(total),
      format,
      header: format === 'csv' ? columns.map(MySqlStrategy.csvCell).join(',') : null,
      nextAfter,
    };
  }

  // Importa un blocco di righe (payload.docs = array di oggetti Extended JSON
  // serializzati: relaxed = true produce i tipi JS nativi per i parametri
  // SQL). Le righe con lo stesso insieme di colonne (stesso ordine, il caso
  // comune quando arrivano da un export della stessa tabella) vengono
  // raggruppate in un unico INSERT multi-VALUES, come già fa il restore dei
  // backup; un batch che fallisce viene ripetuto riga per riga per isolare
  // l'errore e non perdere le righe valide, mantenendo il report ok/errori.
  async collectionImport(db, coll, payload) {
    const pool = this.requirePool();
    const raw = Array.isArray(payload.docs) ? payload.docs : [];
    if (!raw.length) throw new Error('Nessuna riga da importare nel blocco.');
    const table = qtable(db, coll);
    let inserted = 0;
    const errors = [];

    const parsed = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        const row = EJSON.deserialize(raw[i], { relaxed: true });
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('la riga deve essere un oggetto { "colonna": valore }');
        }
        const cols = Object.keys(row);
        if (!cols.length) throw new Error('riga vuota');
        parsed.push({ i, cols, values: cols.map((c) => toSqlValue(row[c])) });
      } catch (err) {
        if (errors.length < 10) errors.push(`Riga ${i + 1}: ${(err && err.message) || err}`);
      }
    }

    const BATCH_SIZE = 500;
    const groups = [];
    let cur = null;
    for (const p of parsed) {
      const sig = p.cols.join(' ');
      if (cur && cur.sig === sig && cur.rows.length < BATCH_SIZE) {
        cur.rows.push(p);
      } else {
        cur = { sig, cols: p.cols, rows: [p] };
        groups.push(cur);
      }
    }

    for (const g of groups) {
      try {
        const [res] = await pool.query(
          `INSERT INTO ${table} (${g.cols.map(qid).join(', ')}) VALUES ?`,
          [g.rows.map((r) => r.values)]
        );
        inserted += res.affectedRows;
      } catch {
        // Un vincolo violato da una sola riga fa fallire tutto il batch:
        // si ripete riga per riga per isolare quale e non perdere le altre.
        for (const r of g.rows) {
          try {
            await pool.query(
              `INSERT INTO ${table} (${g.cols.map(qid).join(', ')}) VALUES (${g.cols.map(() => '?').join(', ')})`,
              r.values
            );
            inserted += 1;
          } catch (err) {
            if (errors.length < 10) errors.push(`Riga ${r.i + 1}: ${(err && err.message) || err}`);
          }
        }
      }
    }

    return { inserted, failed: raw.length - inserted, errors };
  }

  async createCollection(db, name, payload = {}) {
    const pool = this.requirePool();
    const table = String(name || '').trim();
    if (!table) throw new Error('Nome della tabella mancante.');
    const cols = Array.isArray(payload.columns) ? payload.columns : [];
    let defs;
    if (!cols.length) {
      defs = [`${qid('id')} INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`];
    } else {
      defs = cols.map(columnSql);
      const pk = cols.filter((c) => c.primaryKey).map((c) => qid(String(c.name).trim()));
      if (pk.length) defs.push(`PRIMARY KEY (${pk.join(', ')})`);
    }
    await pool.query(`CREATE TABLE ${qtable(db, table)} (${defs.join(', ')})`);
  }

  async renameCollection(db, coll, newName) {
    const pool = this.requirePool();
    const to = String(newName || '').trim();
    if (!to) throw new Error('Nuovo nome della tabella mancante.');
    await pool.query(`RENAME TABLE ${qtable(db, coll)} TO ${qtable(db, to)}`);
  }

  async dropCollection(db, coll) {
    const pool = this.requirePool();
    await pool.query(`DROP TABLE ${qtable(db, coll)}`);
  }

  async addColumn(db, coll, column) {
    const pool = this.requirePool();
    await pool.query(`ALTER TABLE ${qtable(db, coll)} ADD COLUMN ${columnSql(column || {})}`);
  }

  // payload: { oldName, column: { name, type, nullable, default } }
  async alterColumn(db, coll, payload) {
    const pool = this.requirePool();
    const oldName = String((payload && payload.oldName) || '').trim();
    if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
    await pool.query(
      `ALTER TABLE ${qtable(db, coll)} CHANGE COLUMN ${qid(oldName)} ${columnSql(payload.column || {})}`
    );
  }

  async dropColumn(db, coll, name) {
    const pool = this.requirePool();
    const column = String(name || '').trim();
    if (!column) throw new Error('Nome della colonna da eliminare mancante.');
    await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP COLUMN ${qid(column)}`);
  }

  async createIndex(db, coll, payload) {
    const pool = this.requirePool();
    let spec;
    try {
      spec = JSON.parse(String(payload.fields || ''));
    } catch {
      throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length) {
      throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
    }
    const cols = Object.entries(spec).map(([c, dir]) => `${qid(c)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
    const name = String(payload.name || '').trim() || `${Object.keys(spec).join('_')}_idx`;
    await pool.query(
      `CREATE ${payload.unique ? 'UNIQUE ' : ''}INDEX ${qid(name)} ON ${qtable(db, coll)} (${cols.join(', ')})`
    );
    return { name };
  }

  async dropIndex(db, coll, name) {
    const pool = this.requirePool();
    const idx = String(name || '').trim();
    if (!idx) throw new Error('Nome dell\'indice da eliminare mancante.');
    if (idx.toUpperCase() === 'PRIMARY') {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP PRIMARY KEY`);
    } else {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP INDEX ${qid(idx)}`);
    }
  }

  async tableFields(db, table) {
    const pool = this.requirePool();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS cdefault, EXTRA AS extra, COLUMN_KEY AS ckey
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
      [db, table]
    );
    return cols.map((c) => ({
      name: c.name,
      types: [String(c.ctype)],
      presence: c.nullable === 'YES' ? 0 : 100, // 100 = NOT NULL
      nullable: c.nullable === 'YES',
      default: c.cdefault == null ? null : String(c.cdefault),
      autoIncrement: /auto_increment/i.test(String(c.extra || '')),
      key: String(c.ckey || ''),
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
