'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const { EJSON } = require('bson');

const PORT = process.env.PORT || 3030;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------------------
 * Helpers
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

function errMsg(err) {
  return (err && err.message) || String(err);
}

/* ---------------------------------------------------------------------------
 * Connessioni salvate (connections.ini)
 * ------------------------------------------------------------------------- */

const CONNECTIONS_FILE = path.join(__dirname, 'connections.ini');
const CONN_FIELDS = ['uri', 'host', 'port', 'username', 'password', 'authSource'];

function parseIni(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = sections[header[1]] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

function stringifyIni(sections) {
  const lines = ['; Connessioni salvate da Mongo Web GUI. Attenzione: le password sono in chiaro.'];
  for (const [name, values] of Object.entries(sections)) {
    lines.push('', `[${name}]`);
    for (const [key, val] of Object.entries(values)) {
      if (val != null && String(val).trim() !== '') lines.push(`${key}=${String(val).trim()}`);
    }
  }
  return lines.join('\n') + '\n';
}

function loadConnections() {
  try {
    return parseIni(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
  } catch {
    return {}; // file assente o illeggibile: nessuna connessione salvata
  }
}

function saveConnections(sections) {
  fs.writeFileSync(CONNECTIONS_FILE, stringifyIni(sections), 'utf8');
}

function assertConnName(name) {
  if (!name || /[\[\]\r\n]/.test(name)) {
    throw new Error(`Nome di connessione non valido: "${name}"`);
  }
}

// Tiene solo i campi noti e non vuoti di una configurazione di connessione.
function sanitizeConnCfg(cfg) {
  return Object.fromEntries(
    CONN_FIELDS
      .filter((f) => cfg[f] != null && String(cfg[f]).trim() !== '')
      .map((f) => [f, String(cfg[f]).trim()])
  );
}

// Etichetta mostrata in UI: eventuali credenziali nella URI vengono mascherate.
function connLabel(cfg) {
  if (cfg.uri && cfg.uri.trim()) return cfg.uri.trim().replace(/\/\/[^@]+@/, '//***@');
  return `${(cfg.host || 'localhost').trim()}:${String(cfg.port || 27017).trim()}`;
}

const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

function assertDbName(name) {
  if (!name || /[\\/. "$*<>:|?]/.test(name)) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

async function listDatabases(client, uri) {
  try {
    const res = await client.db('admin').admin().listDatabases({ nameOnly: false });
    return res.databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk }));
  } catch {
    // User may lack listDatabases permission: fall back to the db in the URI.
    const dbName = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
    return dbName ? [{ name: dbName, sizeOnDisk: 0 }] : [];
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

function singular(s) {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

// Euristica per l'UML: un campo "user_id" / "userId" / "user_ids" (oppure di
// tipo ObjectId con nome corrispondente a una collection, anche al plurale)
// viene considerato un riferimento verso quella collection.
function detectRelations(collections) {
  const byName = new Map();
  for (const c of collections) {
    const low = c.name.toLowerCase();
    byName.set(low, c.name);
    byName.set(singular(low), c.name);
  }
  const resolve = (base) => byName.get(base) || byName.get(base + 's') || byName.get(singular(base));

  const relations = [];
  for (const c of collections) {
    for (const f of c.fields) {
      if (f.name === '_id') continue;
      const low = f.name.toLowerCase();
      const m = low.match(/^(.+?)_?ids?$/);
      if (!m && !f.types.includes('objectId')) continue;
      const base = m ? m[1] : low;
      const target = resolve(base);
      if (!target || target === c.name) continue;
      relations.push({
        from: c.name,
        field: f.name,
        to: target,
        many: f.types.includes('array') || /ids$/.test(low),
      });
    }
  }
  return relations;
}

/* ---------------------------------------------------------------------------
 * Socket handling — one MongoClient per connected browser tab
 * ------------------------------------------------------------------------- */

io.on('connection', (socket) => {
  /** @type {MongoClient|null} */
  let client = null;
  let changeStream = null;
  let connUri = '';

  function closeChangeStream() {
    if (changeStream) {
      changeStream.close().catch(() => {});
      changeStream = null;
    }
  }

  async function closeClient() {
    closeChangeStream();
    if (client) {
      const c = client;
      client = null;
      await c.close().catch(() => {});
    }
  }

  function requireClient(cb) {
    if (!client) {
      cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
      return false;
    }
    return true;
  }

  // --- Connection -----------------------------------------------------------

  socket.on('mongo:connect', async (cfg, cb) => {
    try {
      await closeClient();
      cfg = cfg || {};
      // cfg.saved = nome di una connessione salvata in connections.ini:
      // i parametri (password inclusa) restano lato server.
      let effective = cfg;
      if (cfg.saved) {
        const saved = loadConnections()[cfg.saved];
        if (!saved) throw new Error(`Connessione salvata "${cfg.saved}" non trovata.`);
        effective = saved;
      }
      // cfg.keepPasswordFrom = nome di una connessione salvata da cui riusare la
      // password quando il form di modifica la lascia vuota (non viene mai
      // rimandata al browser, quindi il client non può reinviarla).
      if (!effective.password && cfg.keepPasswordFrom) {
        const prev = loadConnections()[cfg.keepPasswordFrom];
        if (prev && prev.password) effective = { ...effective, password: prev.password };
      }
      const uri = buildUri(effective);
      const newClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 6000,
        connectTimeoutMS: 6000,
      });
      await newClient.connect();
      // Force a round-trip so bad credentials fail here and not later.
      await newClient.db('admin').command({ ping: 1 });
      client = newClient;
      connUri = uri;
      // cfg.saveAs = salva (o aggiorna) la connessione, solo se funzionante.
      const saveAs = String(cfg.saveAs || '').trim();
      if (saveAs) {
        assertConnName(saveAs);
        const conns = loadConnections();
        conns[saveAs] = sanitizeConnCfg(effective);
        saveConnections(conns);
      }
      cb({ ok: true, label: connLabel(effective), databases: await listDatabases(client, uri) });
    } catch (err) {
      await closeClient();
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('mongo:disconnect', async (_payload, cb) => {
    await closeClient();
    if (cb) cb({ ok: true });
  });

  // --- Connessioni salvate ----------------------------------------------------
  // Non richiedono una connessione Mongo attiva: servono proprio prima di averla.

  socket.on('connections:list', (_payload, cb) => {
    try {
      const connections = Object.entries(loadConnections())
        .map(([name, c]) => ({ name, label: connLabel(c) }));
      cb({ ok: true, connections });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('connections:delete', ({ name }, cb) => {
    try {
      const conns = loadConnections();
      if (!conns[name]) throw new Error(`Connessione salvata "${name}" non trovata.`);
      delete conns[name];
      saveConnections(conns);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // Campi di una connessione salvata per popolarne il form di modifica.
  // La password non viene mai rimandata al browser: si segnala solo se esiste.
  socket.on('connections:get', ({ name }, cb) => {
    try {
      const conn = loadConnections()[name];
      if (!conn) throw new Error(`Connessione salvata "${name}" non trovata.`);
      const { password, ...fields } = conn;
      cb({ ok: true, fields, hasPassword: password != null && password !== '' });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // Crea o aggiorna una connessione salvata senza connettersi. oldName, se
  // diverso da name, rinomina la connessione. Password vuota nel form =
  // mantieni quella già salvata.
  socket.on('connections:save', ({ name, oldName, cfg }, cb) => {
    try {
      name = String(name || '').trim();
      assertConnName(name);
      const conns = loadConnections();
      const previous = oldName ? conns[oldName] : conns[name];
      if (oldName && !previous) throw new Error(`Connessione salvata "${oldName}" non trovata.`);
      const next = sanitizeConnCfg(cfg || {});
      if (!next.password && previous && previous.password) next.password = previous.password;
      if (oldName && oldName !== name) delete conns[oldName];
      conns[name] = next;
      saveConnections(conns);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // Esporta il file .ini completo (password incluse: serve per backup/migrazione).
  socket.on('connections:export', (_payload, cb) => {
    try {
      const conns = loadConnections();
      if (!Object.keys(conns).length) throw new Error('Nessuna connessione salvata da esportare.');
      cb({ ok: true, ini: stringifyIni(conns) });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // Importa connessioni da un file .ini: le sezioni con lo stesso nome di una
  // connessione esistente vengono sovrascritte, le altre aggiunte.
  socket.on('connections:import', ({ ini }, cb) => {
    try {
      const incoming = parseIni(String(ini || ''));
      const names = Object.keys(incoming);
      if (!names.length) throw new Error('Nessuna connessione trovata nel file importato.');
      const conns = loadConnections();
      let imported = 0;
      let overwritten = 0;
      for (const name of names) {
        assertConnName(name);
        const cfg = sanitizeConnCfg(incoming[name]);
        if (!Object.keys(cfg).length) continue; // sezione senza campi utili
        if (conns[name]) overwritten += 1; else imported += 1;
        conns[name] = cfg;
      }
      if (!imported && !overwritten) throw new Error('Il file non contiene connessioni valide.');
      saveConnections(conns);
      cb({ ok: true, imported, overwritten });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // --- Exploration ----------------------------------------------------------

  socket.on('db:collections', async ({ db }, cb) => {
    if (!requireClient(cb)) return;
    try {
      const database = client.db(db);
      const collections = await database.listCollections({}, { nameOnly: true }).toArray();
      const result = await Promise.all(
        collections
          .filter((c) => c.type !== 'view' || true)
          .map(async (c) => {
            let count = null;
            try {
              count = await database.collection(c.name).estimatedDocumentCount();
            } catch { /* views don't support estimatedDocumentCount */ }
            return { name: c.name, type: c.type, count };
          })
      );
      result.sort((a, b) => a.name.localeCompare(b.name));
      cb({ ok: true, collections: result });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // --- Gestione database ------------------------------------------------------

  socket.on('db:list', async (_payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      cb({ ok: true, databases: await listDatabases(client, connUri) });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('db:create', async ({ db, coll }, cb) => {
    if (!requireClient(cb)) return;
    try {
      const name = String(db || '').trim();
      assertDbName(name);
      const collName = String(coll || '').trim() || 'collection1';
      const existing = await listDatabases(client, connUri);
      if (existing.some((d) => d.name === name)) throw new Error(`Il database "${name}" esiste già.`);
      // In MongoDB un database esiste solo se contiene almeno una collection.
      await client.db(name).createCollection(collName);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('db:rename', async ({ db, newName }, cb) => {
    if (!requireClient(cb)) return;
    try {
      const from = String(db || '').trim();
      const to = String(newName || '').trim();
      assertDbName(from);
      assertDbName(to);
      if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
      if (SYSTEM_DBS.has(from)) throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
      const existing = await listDatabases(client, connUri);
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
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('db:drop', async ({ db }, cb) => {
    if (!requireClient(cb)) return;
    try {
      const name = String(db || '').trim();
      assertDbName(name);
      if (SYSTEM_DBS.has(name)) throw new Error(`Il database di sistema "${name}" non può essere eliminato.`);
      await client.db(name).dropDatabase();
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // --- Dettagli collection e schema -------------------------------------------

  socket.on('collection:stats', async ({ db, coll }, cb) => {
    if (!requireClient(cb)) return;
    try {
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
      cb({ ok: true, stats, indexes, fields: schema.fields, sampled: schema.sampled });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('db:schema', async ({ db }, cb) => {
    if (!requireClient(cb)) return;
    try {
      const database = client.db(db);
      const infos = (await database.listCollections({}, { nameOnly: true }).toArray())
        .filter((c) => c.type !== 'view');
      const collections = [];
      for (const c of infos) {
        const schema = await sampleSchema(database.collection(c.name), 50);
        collections.push({ name: c.name, fields: schema.fields });
      }
      collections.sort((a, b) => a.name.localeCompare(b.name));
      cb({ ok: true, collections, relations: detectRelations(collections) });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // --- Query ----------------------------------------------------------------

  socket.on('collection:find', async (payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      const { db, coll } = payload;
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

      cb({ ok: true, docs: docs.map(serialize), columns, total, skip, limit });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('collection:aggregate', async (payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      const pipeline = parseQueryObject(payload.pipeline, []);
      if (!Array.isArray(pipeline)) throw new Error('La pipeline deve essere un array JSON.');
      const docs = await client
        .db(payload.db)
        .collection(payload.coll)
        .aggregate(pipeline)
        .limit(500)
        .toArray();
      const columns = [...new Set(docs.flatMap((d) => Object.keys(d)))];
      cb({ ok: true, docs: docs.map(serialize), columns, total: docs.length, skip: 0, limit: 500 });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // --- Mutations ------------------------------------------------------------

  socket.on('doc:update', async (payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      const _id = parseId(payload.id);
      const update = {};
      if (payload.set && Object.keys(payload.set).length) {
        update.$set = EJSON.deserialize(payload.set, { relaxed: false });
      }
      if (payload.unset && payload.unset.length) {
        update.$unset = Object.fromEntries(payload.unset.map((f) => [f, '']));
      }
      if (!Object.keys(update).length) throw new Error('Nessuna modifica da applicare.');
      const res = await client.db(payload.db).collection(payload.coll).updateOne({ _id }, update);
      cb({ ok: true, matched: res.matchedCount, modified: res.modifiedCount });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('doc:replace', async (payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      const _id = parseId(payload.id);
      const doc = parseQueryObject(payload.doc, null);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('Documento JSON non valido.');
      }
      delete doc._id; // l'_id non è modificabile
      const res = await client.db(payload.db).collection(payload.coll).replaceOne({ _id }, doc);
      cb({ ok: true, matched: res.matchedCount, modified: res.modifiedCount });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('doc:insert', async (payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      const doc = parseQueryObject(payload.doc, null);
      if (!doc || typeof doc !== 'object') throw new Error('Documento JSON non valido.');
      const res = await client.db(payload.db).collection(payload.coll).insertOne(doc);
      cb({ ok: true, insertedId: EJSON.stringify(res.insertedId) });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('doc:delete', async (payload, cb) => {
    if (!requireClient(cb)) return;
    try {
      const _id = parseId(payload.id);
      const res = await client.db(payload.db).collection(payload.coll).deleteOne({ _id });
      cb({ ok: true, deleted: res.deletedCount });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // --- Live updates (change streams; require a replica set) ------------------

  socket.on('collection:watch', ({ db, coll }, cb) => {
    if (!requireClient(cb)) return;
    closeChangeStream();
    try {
      changeStream = client.db(db).collection(coll).watch([], { fullDocument: 'updateLookup' });
      changeStream.on('change', (change) => {
        socket.emit('collection:changed', {
          db,
          coll,
          operationType: change.operationType,
          documentKey: change.documentKey ? serialize(change.documentKey) : null,
        });
      });
      changeStream.on('error', () => {
        // Standalone servers don't support change streams: silently degrade.
        closeChangeStream();
        socket.emit('watch:unavailable', { db, coll });
      });
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('collection:unwatch', () => closeChangeStream());

  socket.on('disconnect', () => {
    closeClient();
  });
});

server.listen(PORT, () => {
  console.log(`Mongo Web GUI in ascolto su http://localhost:${PORT}`);
});
