'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');

const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

/* ---------------------------------------------------------------------------
 * Helpers MongoDB (EJSON, URI, schema campionato)
 * ------------------------------------------------------------------------- */

// Builds a MongoDB connection URI from the form fields, unless a full URI
// is provided directly.
function buildUri(cfg) {
  if (cfg.uri && cfg.uri.trim()) return cfg.uri.trim();

  const host = (cfg.host || 'localhost').trim();
  const port = String(cfg.port || 27017).trim();
  let auth = '';
  if (cfg.username) {
    auth = encodeURIComponent(cfg.username);
    if (cfg.password) auth += ':' + encodeURIComponent(cfg.password);
    auth += '@';
  }
  const params = new URLSearchParams();
  if (cfg.username) params.set('authSource', cfg.authSource || 'admin');
  // Connessione diretta a un singolo nodo (es. dietro tunnel SSH): evita la
  // topology discovery verso host del replica set non raggiungibili.
  if (cfg.directConnection) params.set('directConnection', 'true');
  const qs = params.toString();
  return `mongodb://${auth}${host}:${port}/${qs ? '?' + qs : ''}`;
}

// Parses a user supplied filter/sort/projection string. Accepts Extended
// JSON ({"_id": {"$oid": "..."}}) as well as plain JSON. Plain 24-hex
// strings used as _id are promoted to ObjectId automatically.
function parseQueryObject(text, fallback = {}) {
  if (text == null || String(text).trim() === '') return fallback;
  const parsed = EJSON.parse(String(text), { relaxed: false });
  promoteObjectIds(parsed);
  return parsed;
}

function promoteObjectIds(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (key === '_id' && typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val)) {
      obj[key] = new ObjectId(val);
    } else if (val && typeof val === 'object' && !(val instanceof ObjectId)) {
      promoteObjectIds(val);
    }
  }
}

// Parses the _id sent by the client (serialized as relaxed EJSON string).
function parseId(rawId) {
  const val = EJSON.parse(rawId, { relaxed: false });
  if (typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val)) return new ObjectId(val);
  return val;
}

// Relaxed: i numeri restano numeri JSON, ObjectId e Date restano in forma
// estesa ($oid / $date) così il client li riconosce e li preserva.
function serialize(value) {
  return EJSON.serialize(value, { relaxed: true });
}

// Tipi ammessi da $convert per la conversione dei campi.
const MONGO_CONVERT_TYPES = new Set(['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId']);

// Valore "libero" digitato dall'utente: prova il parse EJSON/JSON
// (numeri, booleani, {"$date": ...}), altrimenti è una stringa semplice.
function parseLooseValue(text) {
  try {
    return EJSON.parse(String(text), { relaxed: false });
  } catch {
    return String(text);
  }
}

function assertDbName(name) {
  if (!name || /[\\/. "$*<>:|?]/.test(name)) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

// Tipo BSON "leggibile" di un valore, per lo schema dedotto dal campione.
function bsonTypeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'object') {
    const t = v._bsontype;
    if (t === 'ObjectId') return 'objectId';
    if (t === 'Long') return 'long';
    if (t === 'Int32') return 'int';
    if (t === 'Double') return 'double';
    if (t === 'Decimal128') return 'decimal';
    if (t === 'Binary') return 'binary';
    if (t === 'Timestamp') return 'timestamp';
    if (t) return String(t).toLowerCase();
    return 'object';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return typeof v; // string, boolean
}

// Schema dedotto da un campione di documenti: per ogni campo, tipi e presenza %.
async function sampleSchema(collection, sampleSize = 100) {
  let docs;
  try {
    docs = await collection.aggregate([{ $sample: { size: sampleSize } }]).toArray();
  } catch {
    docs = await collection.find().limit(sampleSize).toArray();
  }
  const fields = new Map();
  for (const doc of docs) {
    for (const [key, val] of Object.entries(doc)) {
      let f = fields.get(key);
      if (!f) fields.set(key, (f = { name: key, types: new Set(), count: 0 }));
      f.count += 1;
      f.types.add(bsonTypeOf(val));
    }
  }
  const out = [...fields.values()].map((f) => ({
    name: f.name,
    types: [...f.types].sort(),
    presence: docs.length ? Math.round((f.count / docs.length) * 100) : 0,
  }));
  out.sort((a, b) =>
    a.name === '_id' ? -1 : b.name === '_id' ? 1 : b.presence - a.presence || a.name.localeCompare(b.name)
  );
  return { fields: out, sampled: docs.length };
}

/* ---------------------------------------------------------------------------
 * Strategia MongoDB: un MongoClient dedicato per istanza (cioè per socket)
 * ------------------------------------------------------------------------- */

class MongoDbStrategy extends DbStrategy {
  constructor() {
    super();
    /** @type {MongoClient|null} */
    this.client = null;
    this.uri = '';
    this.changeStream = null;
  }

  get type() { return 'mongodb'; }

  requireClient() {
    if (!this.client) throw new Error('Nessuna connessione attiva al database.');
    return this.client;
  }

  async connect(cfg) {
    const uri = buildUri(cfg);
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000,
    });
    await client.connect();
    // Force a round-trip so bad credentials fail here and not later.
    await client.db('admin').command({ ping: 1 });
    this.client = client;
    this.uri = uri;
  }

  async disconnect() {
    this.unwatch();
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.close().catch(() => {});
    }
  }

  async listDatabases() {
    const client = this.requireClient();
    try {
      const res = await client.db('admin').admin().listDatabases({ nameOnly: false });
      return res.databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk }));
    } catch {
      // User may lack listDatabases permission: fall back to the db in the URI.
      const dbName = new URL(this.uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
      return dbName ? [{ name: dbName, sizeOnDisk: 0 }] : [];
    }
  }

  async createDatabase(db, firstColl) {
    const client = this.requireClient();
    const name = String(db || '').trim();
    assertDbName(name);
    const collName = String(firstColl || '').trim() || 'collection1';
    const existing = await this.listDatabases();
    if (existing.some((d) => d.name === name)) throw new Error(`Il database "${name}" esiste già.`);
    // In MongoDB un database esiste solo se contiene almeno una collection.
    await client.db(name).createCollection(collName);
  }

  async renameDatabase(db, newName) {
    const client = this.requireClient();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (SYSTEM_DBS.has(from)) throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
    const existing = await this.listDatabases();
    if (existing.some((d) => d.name === to)) throw new Error(`Il database "${to}" esiste già.`);

    // MongoDB non supporta la rinomina diretta: copia ogni collection nel
    // nuovo db ($out cross-database, MongoDB >= 4.4) e poi elimina l'originale.
    const source = client.db(from);
    const colls = (await source.listCollections({}, { nameOnly: true }).toArray())
      .filter((c) => c.type !== 'view');
    if (!colls.length) throw new Error('Il database non contiene collection da copiare.');
    for (const c of colls) {
      await source.collection(c.name)
        .aggregate([{ $match: {} }, { $out: { db: to, coll: c.name } }])
        .toArray();
      const indexes = await source.collection(c.name).indexes().catch(() => []);
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        const { key, name, v, ns, ...opts } = idx;
        await client.db(to).collection(c.name).createIndex(key, { name, ...opts }).catch(() => {});
      }
    }
    await source.dropDatabase();
  }

  async dropDatabase(db) {
    const client = this.requireClient();
    const name = String(db || '').trim();
    assertDbName(name);
    if (SYSTEM_DBS.has(name)) throw new Error(`Il database di sistema "${name}" non può essere eliminato.`);
    await client.db(name).dropDatabase();
  }

  async listCollections(db) {
    const client = this.requireClient();
    const database = client.db(db);
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const result = await Promise.all(
      collections.map(async (c) => {
        let count = null;
        try {
          count = await database.collection(c.name).estimatedDocumentCount();
        } catch { /* views don't support estimatedDocumentCount */ }
        return { name: c.name, type: c.type, count };
      })
    );
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  async createCollection(db, name) {
    const client = this.requireClient();
    const coll = String(name || '').trim();
    if (!coll) throw new Error('Nome della collection mancante.');
    await client.db(db).createCollection(coll);
  }

  async renameCollection(db, coll, newName) {
    const client = this.requireClient();
    const to = String(newName || '').trim();
    if (!to) throw new Error('Nuovo nome della collection mancante.');
    await client.db(db).renameCollection(coll, to);
  }

  async dropCollection(db, coll) {
    const client = this.requireClient();
    const ok = await client.db(db).collection(coll).drop();
    if (!ok) throw new Error(`Impossibile eliminare la collection "${coll}".`);
  }

  /* "Colonne" in MongoDB = campi dei documenti: le operazioni agiscono su
   * tutti i documenti della collection. */

  // Aggiunge il campo (con un eventuale valore iniziale) ai documenti che
  // non lo hanno già.
  async addColumn(db, coll, column) {
    const client = this.requireClient();
    const name = String((column && column.name) || '').trim();
    if (!name) throw new Error('Nome del campo mancante.');
    if (name === '_id') throw new Error('Il campo "_id" esiste già in ogni documento.');
    let value = null;
    if (column.default != null && String(column.default).trim() !== '') {
      value = parseLooseValue(column.default);
    }
    const res = await client.db(db).collection(coll)
      .updateMany({ [name]: { $exists: false } }, { $set: { [name]: value } });
    return { modified: res.modifiedCount };
  }

  // Rinomina il campo ($rename) e/o ne converte il tipo ($convert via update
  // con pipeline, MongoDB >= 4.2). I valori non convertibili restano invariati.
  async alterColumn(db, coll, payload) {
    const client = this.requireClient();
    const oldName = String((payload && payload.oldName) || '').trim();
    const column = (payload && payload.column) || {};
    const newName = String(column.name || '').trim() || oldName;
    if (!oldName) throw new Error('Nome del campo da modificare mancante.');
    if (oldName === '_id' || newName === '_id') throw new Error('Il campo "_id" non può essere modificato.');

    const collection = client.db(db).collection(coll);
    let modified = 0;
    if (newName !== oldName) {
      const res = await collection.updateMany({ [oldName]: { $exists: true } }, { $rename: { [oldName]: newName } });
      modified = Math.max(modified, res.modifiedCount);
    }
    const to = String(column.type || '').trim();
    if (to) {
      if (!MONGO_CONVERT_TYPES.has(to)) {
        throw new Error(`Tipo di conversione non valido: "${to}". Tipi ammessi: ${[...MONGO_CONVERT_TYPES].join(', ')}.`);
      }
      const res = await collection.updateMany(
        { [newName]: { $exists: true } },
        [{ $set: { [newName]: { $convert: { input: `$${newName}`, to, onError: `$${newName}`, onNull: null } } } }]
      );
      modified = Math.max(modified, res.modifiedCount);
    }
    if (newName === oldName && !to) throw new Error('Nessuna modifica da applicare.');
    return { modified };
  }

  // Rimuove il campo da tutti i documenti ($unset).
  async dropColumn(db, coll, name) {
    const client = this.requireClient();
    const field = String(name || '').trim();
    if (!field) throw new Error('Nome del campo da eliminare mancante.');
    if (field === '_id') throw new Error('Il campo "_id" non può essere eliminato.');
    const res = await client.db(db).collection(coll)
      .updateMany({ [field]: { $exists: true } }, { $unset: { [field]: '' } });
    return { modified: res.modifiedCount };
  }

  async createIndex(db, coll, payload) {
    const client = this.requireClient();
    const spec = parseQueryObject(payload.fields, null);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length) {
      throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
    }
    const options = {};
    if (payload.unique) options.unique = true;
    const name = String(payload.name || '').trim();
    if (name) options.name = name;
    const created = await client.db(db).collection(coll).createIndex(spec, options);
    return { name: created };
  }

  async dropIndex(db, coll, name) {
    const client = this.requireClient();
    if (name === '_id_') throw new Error('L\'indice "_id_" non può essere eliminato.');
    await client.db(db).collection(coll).dropIndex(name);
  }

  async collectionStats(db, coll) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    let stats = null;
    try {
      const res = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const s = res[0] && res[0].storageStats;
      if (s) {
        stats = {
          count: s.count,
          size: s.size,
          storageSize: s.storageSize,
          avgObjSize: s.avgObjSize,
          totalIndexSize: s.totalIndexSize,
          nindexes: s.nindexes,
        };
      }
    } catch { /* le view non supportano $collStats */ }
    if (!stats) stats = { count: await collection.countDocuments().catch(() => null) };

    let indexes = [];
    try {
      indexes = (await collection.indexes()).map((i) => ({ name: i.name, key: i.key, unique: !!i.unique }));
    } catch { /* le view non hanno indici */ }

    const schema = await sampleSchema(collection);
    return { stats, indexes, fields: schema.fields, sampled: schema.sampled };
  }

  async dbSchema(db) {
    const client = this.requireClient();
    const database = client.db(db);
    const infos = (await database.listCollections({}, { nameOnly: true }).toArray())
      .filter((c) => c.type !== 'view');
    const collections = [];
    for (const c of infos) {
      const schema = await sampleSchema(database.collection(c.name), 50);
      collections.push({ name: c.name, fields: schema.fields });
    }
    collections.sort((a, b) => a.name.localeCompare(b.name));
    return { collections, relations: DbStrategy.detectRelations(collections) };
  }

  async collectionFind(db, coll, payload) {
    const client = this.requireClient();
    const filter = parseQueryObject(payload.filter, {});
    const sort = parseQueryObject(payload.sort, {});
    const projection = parseQueryObject(payload.projection, {});
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);

    const collection = client.db(db).collection(coll);
    const cursor = collection.find(filter, { projection }).sort(sort).skip(skip).limit(limit);
    const [docs, total] = await Promise.all([
      cursor.toArray(),
      collection.countDocuments(filter),
    ]);

    // Union of the keys of all returned documents -> table columns.
    const columns = [];
    const seen = new Set();
    for (const doc of docs) {
      for (const key of Object.keys(doc)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }

    return { docs: docs.map(serialize), columns, total, skip, limit };
  }

  async collectionAggregate(db, coll, payload) {
    const client = this.requireClient();
    const pipeline = parseQueryObject(payload.pipeline, []);
    if (!Array.isArray(pipeline)) throw new Error('La pipeline deve essere un array JSON.');
    const docs = await client
      .db(db)
      .collection(coll)
      .aggregate(pipeline)
      .limit(500)
      .toArray();
    const columns = [...new Set(docs.flatMap((d) => Object.keys(d)))];
    return { docs: docs.map(serialize), columns, total: docs.length, skip: 0, limit: 500 };
  }

  async docInsert(db, coll, payload) {
    const client = this.requireClient();
    const doc = parseQueryObject(payload.doc, null);
    if (!doc || typeof doc !== 'object') throw new Error('Documento JSON non valido.');
    const res = await client.db(db).collection(coll).insertOne(doc);
    return { insertedId: EJSON.stringify(res.insertedId) };
  }

  async docUpdate(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const update = {};
    if (payload.set && Object.keys(payload.set).length) {
      update.$set = EJSON.deserialize(payload.set, { relaxed: false });
    }
    if (payload.unset && payload.unset.length) {
      update.$unset = Object.fromEntries(payload.unset.map((f) => [f, '']));
    }
    if (!Object.keys(update).length) throw new Error('Nessuna modifica da applicare.');
    const res = await client.db(db).collection(coll).updateOne({ _id }, update);
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async docReplace(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const doc = parseQueryObject(payload.doc, null);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('Documento JSON non valido.');
    }
    delete doc._id; // l'_id non è modificabile
    const res = await client.db(db).collection(coll).replaceOne({ _id }, doc);
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async docDelete(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const res = await client.db(db).collection(coll).deleteOne({ _id });
    return { deleted: res.deletedCount };
  }

  // Change stream: richiede un replica set; su server standalone degrada
  // segnalando onUnavailable.
  watch(db, coll, { onChange, onUnavailable }) {
    const client = this.requireClient();
    this.unwatch();
    this.changeStream = client.db(db).collection(coll).watch([], { fullDocument: 'updateLookup' });
    this.changeStream.on('change', (change) => {
      onChange({
        operationType: change.operationType,
        documentKey: change.documentKey ? serialize(change.documentKey) : null,
      });
    });
    this.changeStream.on('error', () => {
      this.unwatch();
      onUnavailable();
    });
  }

  unwatch() {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
  }
}

module.exports = MongoDbStrategy;
