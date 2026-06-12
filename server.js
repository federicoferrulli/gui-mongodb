'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const DbFactory = require('./db/DbFactory');

const PORT = process.env.PORT || 3030;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function errMsg(err) {
  return (err && err.message) || String(err);
}

/* ---------------------------------------------------------------------------
 * Connessioni salvate (connections.ini)
 * ------------------------------------------------------------------------- */

const CONNECTIONS_FILE = path.join(__dirname, 'connections.ini');
const CONN_FIELDS = ['dbType', 'uri', 'host', 'port', 'username', 'password', 'authSource', 'database'];

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

// dbType assente nelle connessioni salvate prima del supporto multi-db.
function connDbType(cfg) {
  return String(cfg.dbType || 'mongodb').trim().toLowerCase();
}

// Etichetta mostrata in UI: eventuali credenziali nella URI vengono mascherate.
function connLabel(cfg) {
  if (cfg.uri && cfg.uri.trim()) return cfg.uri.trim().replace(/\/\/[^@]+@/, '//***@');
  const defaultPort = connDbType(cfg) === 'mysql' ? 3306 : 27017;
  return `${(cfg.host || 'localhost').trim()}:${String(cfg.port || defaultPort).trim()}`;
}

/* ---------------------------------------------------------------------------
 * Socket handling — una strategia (e quindi una connessione DB) per socket
 * ------------------------------------------------------------------------- */

io.on('connection', (socket) => {
  /** @type {import('./db/DbStrategy')|null} */
  let strategy = null;

  async function closeStrategy() {
    if (strategy) {
      const s = strategy;
      strategy = null;
      await s.disconnect().catch(() => {});
    }
  }

  function requireStrategy(cb) {
    if (!strategy) {
      cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
      return false;
    }
    return true;
  }

  // Registra un evento che delega alla strategia attiva e adatta il risultato
  // (o l'errore) al formato di risposta { ok, ... } usato dal frontend.
  function delegate(event, fn) {
    socket.on(event, async (payload, cb) => {
      if (!requireStrategy(cb)) return;
      try {
        cb({ ok: true, ...(await fn(payload || {})) });
      } catch (err) {
        cb({ ok: false, error: errMsg(err) });
      }
    });
  }

  // --- Connection -----------------------------------------------------------

  socket.on('mongo:connect', async (cfg, cb) => {
    try {
      await closeStrategy();
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
      const dbType = connDbType(effective);
      const newStrategy = DbFactory.getStrategy(dbType);
      await newStrategy.connect(effective);
      strategy = newStrategy;
      // cfg.saveAs = salva (o aggiorna) la connessione, solo se funzionante.
      const saveAs = String(cfg.saveAs || '').trim();
      if (saveAs) {
        assertConnName(saveAs);
        const conns = loadConnections();
        conns[saveAs] = sanitizeConnCfg(effective);
        saveConnections(conns);
      }
      cb({
        ok: true,
        label: connLabel(effective),
        dbType,
        databases: await strategy.listDatabases(),
      });
    } catch (err) {
      await closeStrategy();
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('mongo:disconnect', async (_payload, cb) => {
    await closeStrategy();
    if (cb) cb({ ok: true });
  });

  // --- Connessioni salvate ----------------------------------------------------
  // Non richiedono una connessione DB attiva: servono proprio prima di averla.

  socket.on('connections:list', (_payload, cb) => {
    try {
      const connections = Object.entries(loadConnections())
        .map(([name, c]) => ({ name, label: connLabel(c), dbType: connDbType(c) }));
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

  // --- Esplorazione e gestione database (delegati alla strategia) ------------

  delegate('db:list', async () => ({ databases: await strategy.listDatabases() }));
  delegate('db:collections', async ({ db }) => ({ collections: await strategy.listCollections(db) }));
  delegate('db:create', async ({ db, coll }) => { await strategy.createDatabase(db, coll); return {}; });
  delegate('db:rename', async ({ db, newName }) => { await strategy.renameDatabase(db, newName); return {}; });
  delegate('db:drop', async ({ db }) => { await strategy.dropDatabase(db); return {}; });
  delegate('db:schema', ({ db }) => strategy.dbSchema(db));

  // --- Query, dettagli e mutazioni --------------------------------------------

  delegate('collection:stats', ({ db, coll }) => strategy.collectionStats(db, coll));
  delegate('collection:find', (p) => strategy.collectionFind(p.db, p.coll, p));
  delegate('collection:aggregate', (p) => strategy.collectionAggregate(p.db, p.coll, p));
  delegate('doc:insert', (p) => strategy.docInsert(p.db, p.coll, p));
  delegate('doc:update', (p) => strategy.docUpdate(p.db, p.coll, p));
  delegate('doc:replace', (p) => strategy.docReplace(p.db, p.coll, p));
  delegate('doc:delete', (p) => strategy.docDelete(p.db, p.coll, p));

  // --- Aggiornamenti in tempo reale -------------------------------------------
  // I DBMS senza change stream (MySQL) falliscono qui: il frontend nasconde
  // semplicemente il badge LIVE.

  socket.on('collection:watch', ({ db, coll }, cb) => {
    if (!requireStrategy(cb)) return;
    try {
      strategy.watch(db, coll, {
        onChange: (change) => socket.emit('collection:changed', { db, coll, ...change }),
        onUnavailable: () => socket.emit('watch:unavailable', { db, coll }),
      });
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('collection:unwatch', () => {
    if (strategy) strategy.unwatch();
  });

  socket.on('disconnect', () => {
    closeStrategy();
  });
});

server.listen(PORT, () => {
  console.log(`Mongo Web GUI in ascolto su http://localhost:${PORT}`);
});
