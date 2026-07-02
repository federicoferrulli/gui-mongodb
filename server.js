'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');
const readline = require('readline');
const DbFactory = require('./db/DbFactory');
const { openSshTunnel } = require('./db/SshTunnel');

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
const CONN_FIELDS = [
  'dbType', 'uri', 'host', 'port', 'username', 'password', 'authSource', 'database',
  // Cartella/gruppo di appartenenza nella sidebar del connection manager.
  'folder',
  // Tunnel SSH (ortogonale al dbType): 'ssh' = "true" per abilitarlo.
  'ssh', 'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshKeyFile', 'sshPassphrase',
];
// Campi segreti: mai rimandati al browser, riusati dal valore salvato se il form
// li lascia vuoti (vedi connections:get/save e mongo:connect con keepPasswordFrom).
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];

let encryptionKey = null;

function encryptSecret(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.startsWith('ENC:')) return text; // già cifrato
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `ENC:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptSecret(text) {
  if (!text || typeof text !== 'string') return text;
  if (!text.startsWith('ENC:')) return text; // non cifrato (plain text)
  try {
    const parts = text.split(':');
    if (parts.length !== 4) return text;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error("Errore decrittazione segreto:", e.message);
    return "";
  }
}

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
    const sections = parseIni(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
    for (const sec of Object.values(sections)) {
      for (const f of SECRET_FIELDS) {
        if (sec[f]) sec[f] = decryptSecret(sec[f]);
      }
    }
    return sections;
  } catch {
    return {}; // file assente o illeggibile: nessuna connessione salvata
  }
}

function saveConnections(sections) {
  const toSave = JSON.parse(JSON.stringify(sections));
  for (const sec of Object.values(toSave)) {
    for (const f of SECRET_FIELDS) {
      if (sec[f]) sec[f] = encryptSecret(sec[f]);
    }
  }
  fs.writeFileSync(CONNECTIONS_FILE, stringifyIni(toSave), 'utf8');
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

function sshEnabled(cfg) {
  return String(cfg.ssh || '').trim().toLowerCase() === 'true';
}

// Etichetta mostrata in UI: eventuali credenziali nella URI vengono mascherate.
function connLabel(cfg) {
  let base;
  if (cfg.uri && cfg.uri.trim()) {
    base = cfg.uri.trim().replace(/\/\/[^@]+@/, '//***@');
  } else {
    const defaultPort = connDbType(cfg) === 'mysql' ? 3306 : 27017;
    base = `${(cfg.host || 'localhost').trim()}:${String(cfg.port || defaultPort).trim()}`;
  }
  return sshEnabled(cfg) ? `${base} (via SSH)` : base;
}

/* ---------------------------------------------------------------------------
 * Apertura di una connessione DB (comune a mongo:connect e connections:test)
 * ------------------------------------------------------------------------- */

// Risolve la configurazione effettiva: cfg.saved = usa una connessione salvata
// (i parametri, password inclusa, restano lato server); cfg.keepPasswordFrom =
// riusa i segreti di una connessione salvata quando il form li lascia vuoti
// (non vengono mai rimandati al browser, quindi il client non può reinviarli).
function resolveEffectiveCfg(cfg) {
  let effective = cfg;
  if (cfg.saved) {
    const saved = loadConnections()[cfg.saved];
    if (!saved) throw new Error(`Connessione salvata "${cfg.saved}" non trovata.`);
    effective = saved;
  }
  if (cfg.keepPasswordFrom) {
    const prev = loadConnections()[cfg.keepPasswordFrom];
    if (prev) {
      const merged = { ...effective };
      for (const f of SECRET_FIELDS) {
        if (!merged[f] && prev[f]) merged[f] = prev[f];
      }
      effective = merged;
    }
  }
  return effective;
}

// Apre tunnel SSH (se richiesto) e connette la strategia. In caso di errore
// chiude quanto già aperto e rilancia; altrimenti restituisce le risorse
// aperte, la cui chiusura è a carico del chiamante (teardownConnection).
async function establishConnection(cfg) {
  const effective = resolveEffectiveCfg(cfg);
  const dbType = connDbType(effective);
  let tunnel = null;
  try {
    // Tunnel SSH (solo in modalità "Parametri"): la strategia si connette al
    // capo locale del tunnel anziché direttamente all'host del database.
    let connectCfg = effective;
    if (sshEnabled(effective)) {
      if (effective.uri && effective.uri.trim()) {
        throw new Error('Il tunnel SSH è disponibile solo in modalità "Parametri", non con URI completa.');
      }
      const defaultPort = dbType === 'mysql' ? 3306 : 27017;
      const target = {
        host: (effective.host || 'localhost').trim(),
        port: parseInt(effective.port, 10) || defaultPort,
      };
      tunnel = await openSshTunnel(effective, target);
      connectCfg = { ...effective, host: tunnel.host, port: String(tunnel.port) };
      // Per MongoDB dietro tunnel: evita la topology discovery verso host del
      // replica set non raggiungibili attraverso il tunnel.
      if (dbType === 'mongodb') connectCfg.directConnection = true;
    }
    const strategy = DbFactory.getStrategy(dbType);
    await strategy.connect(connectCfg);
    return { strategy, tunnel, effective, dbType };
  } catch (err) {
    if (tunnel) try { tunnel.close(); } catch { /* ignora */ }
    throw err;
  }
}

async function teardownConnection({ strategy, tunnel }) {
  await strategy.disconnect().catch(() => {});
  // Il tunnel va chiuso dopo la strategia, che lo usa per il traffico DB.
  if (tunnel) {
    try { tunnel.close(); } catch { /* ignora */ }
  }
}

/* ---------------------------------------------------------------------------
 * Socket handling — una sessione (strategia + eventuale tunnel) per ogni tab
 * aperto nel browser; il tabId viaggia in ogni payload. Client storici senza
 * tabId ricadono sulla sessione "default" (stesso comportamento di prima).
 * ------------------------------------------------------------------------- */

// Limiti di sicurezza e prevenzione esaurimento risorse
const MAX_SESSIONS_PER_SOCKET = 8;
const MAX_GLOBAL_SESSIONS = 100;
const MAX_GLOBAL_SOCKETS = 500;
const MAX_SOCKETS_PER_IP = 20;

let activeGlobalSessions = 0;
const ipConnections = new Map();

// Normalizza il tabId ricevuto dal client (input non fidato): è solo la chiave
// della mappa di sessioni del proprio socket, mai usato per accedere ad altro.
function normTabId(tabId) {
  const id = String(tabId == null ? '' : tabId).trim();
  return id || 'default';
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const currentSocketsForIp = ipConnections.get(ip) || 0;

  // Controllo limiti connessioni WebSocket
  if (io.engine.clientsCount > MAX_GLOBAL_SOCKETS) {
    console.warn(`Rifiutata connessione WebSocket: raggiunto limite globale di ${MAX_GLOBAL_SOCKETS}.`);
    socket.disconnect(true);
    return;
  }
  if (currentSocketsForIp >= MAX_SOCKETS_PER_IP) {
    console.warn(`Rifiutata connessione WebSocket da IP ${ip}: raggiunto limite per IP di ${MAX_SOCKETS_PER_IP}.`);
    socket.disconnect(true);
    return;
  }
  ipConnections.set(ip, currentSocketsForIp + 1);

  /** @type {Map<string, { strategy: import('./db/DbStrategy'), tunnel: { close: () => void }|null }>} */
  const sessions = new Map();

  async function closeSession(tabId) {
    const sess = sessions.get(tabId);
    if (!sess) return;
    // Rimuovi prima di await: evita doppie chiusure su chiamate concorrenti.
    sessions.delete(tabId);
    activeGlobalSessions--;
    await teardownConnection(sess);
  }

  async function closeAllSessions() {
    for (const tabId of [...sessions.keys()]) await closeSession(tabId);
  }

  // Registra un evento che delega alla strategia della sessione indicata dal
  // tabId nel payload e adatta il risultato (o l'errore) al formato di
  // risposta { ok, ... } usato dal frontend.
  function delegate(event, fn) {
    socket.on(event, async (payload, cb) => {
      payload = payload || {};
      const sess = sessions.get(normTabId(payload.tabId));
      if (!sess) {
        cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
        return;
      }
      try {
        cb({ ok: true, ...(await fn(sess.strategy, payload)) });
      } catch (err) {
        cb({ ok: false, error: errMsg(err) });
      }
    });
  }

  // --- Connection -----------------------------------------------------------

  socket.on('mongo:connect', async (cfg, cb) => {
    try {
      cfg = cfg || {};
      if (cfg.tabId != null && String(cfg.tabId).length > 100) {
        throw new Error('tabId non valido.');
      }
      const tabId = normTabId(cfg.tabId);
      if (!sessions.has(tabId) && sessions.size >= MAX_SESSIONS_PER_SOCKET) {
        throw new Error(`Raggiunto il limite di ${MAX_SESSIONS_PER_SOCKET} connessioni contemporanee: chiudi un tab.`);
      }
      if (!sessions.has(tabId) && activeGlobalSessions >= MAX_GLOBAL_SESSIONS) {
        throw new Error(`Raggiunto il limite globale di ${MAX_GLOBAL_SESSIONS} connessioni al database.`);
      }
      // Riconnessione sullo stesso tab: chiudi prima la sessione precedente.
      await closeSession(tabId);
      const conn = await establishConnection(cfg);
      sessions.set(tabId, { strategy: conn.strategy, tunnel: conn.tunnel });
      activeGlobalSessions++;
      try {
        // cfg.saveAs = salva (o aggiorna) la connessione, solo se funzionante.
        const saveAs = String(cfg.saveAs || '').trim();
        if (saveAs) {
          assertConnName(saveAs);
          const conns = loadConnections();
          conns[saveAs] = sanitizeConnCfg(conn.effective);
          saveConnections(conns);
        }
        cb({
          ok: true,
          tabId,
          label: connLabel(conn.effective),
          dbType: conn.dbType,
          databases: await conn.strategy.listDatabases(),
        });
      } catch (err) {
        await closeSession(tabId);
        throw err;
      }
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('mongo:disconnect', async (payload, cb) => {
    await closeSession(normTabId(payload && payload.tabId));
    if (cb) cb({ ok: true });
  });

  // Prova una configurazione (o una connessione salvata) senza tenere aperto
  // nulla: connect + listDatabases + disconnect. Serve al pulsante "Testa".
  socket.on('connections:test', async (cfg, cb) => {
    let conn = null;
    let sessionIncremented = false;
    try {
      if (activeGlobalSessions >= MAX_GLOBAL_SESSIONS) {
        throw new Error(`Raggiunto il limite globale di ${MAX_GLOBAL_SESSIONS} connessioni al database.`);
      }
      activeGlobalSessions++;
      sessionIncremented = true;
      conn = await establishConnection(cfg || {});
      const databases = await conn.strategy.listDatabases();
      cb({ ok: true, dbType: conn.dbType, label: connLabel(conn.effective), databases: databases.length });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    } finally {
      if (conn) await teardownConnection(conn);
      if (sessionIncremented) activeGlobalSessions--;
    }
  });

  // --- Connessioni salvate ----------------------------------------------------
  // Non richiedono una connessione DB attiva: servono proprio prima di averla.

  socket.on('connections:list', (_payload, cb) => {
    try {
      const connections = Object.entries(loadConnections())
        .map(([name, c]) => ({ name, label: connLabel(c), dbType: connDbType(c), folder: c.folder || '' }));
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
      const fields = { ...conn };
      const has = (f) => conn[f] != null && conn[f] !== '';
      const flags = { hasPassword: has('password'), hasSshPassword: has('sshPassword'), hasSshPassphrase: has('sshPassphrase') };
      for (const f of SECRET_FIELDS) delete fields[f];
      cb({ ok: true, fields, ...flags });
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
      if (previous) {
        for (const f of SECRET_FIELDS) {
          if (!next[f] && previous[f]) next[f] = previous[f];
        }
      }
      if (oldName && oldName !== name) delete conns[oldName];
      conns[name] = next;
      saveConnections(conns);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  // Esporta il file .ini completo (password incluse, ma cifrate).
  socket.on('connections:export', (_payload, cb) => {
    try {
      const conns = loadConnections();
      if (!Object.keys(conns).length) throw new Error('Nessuna connessione salvata da esportare.');
      const toSave = JSON.parse(JSON.stringify(conns));
      for (const sec of Object.values(toSave)) {
        for (const f of SECRET_FIELDS) {
          if (sec[f]) sec[f] = encryptSecret(sec[f]);
        }
      }
      cb({ ok: true, ini: stringifyIni(toSave) });
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

  delegate('db:list', async (strategy) => ({ databases: await strategy.listDatabases() }));
  delegate('db:search', async (strategy, { query }) => ({ databases: await strategy.search(query) }));
  delegate('db:collections', async (strategy, { db }) => ({ collections: await strategy.listCollections(db) }));
  delegate('db:create', async (strategy, { db, coll }) => { await strategy.createDatabase(db, coll); return {}; });
  delegate('db:rename', async (strategy, { db, newName }) => { await strategy.renameDatabase(db, newName); return {}; });
  delegate('db:drop', async (strategy, { db }) => { await strategy.dropDatabase(db); return {}; });
  delegate('db:schema', (strategy, { db }) => strategy.dbSchema(db));

  // --- Gestione collection/tabelle, colonne e indici ---------------------------

  delegate('collection:create', async (strategy, p) => { await strategy.createCollection(p.db, p.name, p); return {}; });
  delegate('collection:rename', async (strategy, p) => { await strategy.renameCollection(p.db, p.coll, p.newName); return {}; });
  delegate('collection:drop', async (strategy, p) => { await strategy.dropCollection(p.db, p.coll); return {}; });
  delegate('column:add', (strategy, p) => strategy.addColumn(p.db, p.coll, p.column));
  delegate('column:alter', (strategy, p) => strategy.alterColumn(p.db, p.coll, p));
  delegate('column:drop', (strategy, p) => strategy.dropColumn(p.db, p.coll, p.name));
  delegate('index:create', (strategy, p) => strategy.createIndex(p.db, p.coll, p));
  delegate('index:drop', async (strategy, p) => { await strategy.dropIndex(p.db, p.coll, p.name); return {}; });

  // --- Query, dettagli e mutazioni --------------------------------------------

  delegate('collection:stats', (strategy, { db, coll }) => strategy.collectionStats(db, coll));
  delegate('collection:find', (strategy, p) => strategy.collectionFind(p.db, p.coll, p));
  delegate('collection:aggregate', (strategy, p) => strategy.collectionAggregate(p.db, p.coll, p));
  delegate('doc:insert', (strategy, p) => strategy.docInsert(p.db, p.coll, p));
  delegate('doc:update', (strategy, p) => strategy.docUpdate(p.db, p.coll, p));
  delegate('doc:replace', (strategy, p) => strategy.docReplace(p.db, p.coll, p));
  delegate('doc:delete', (strategy, p) => strategy.docDelete(p.db, p.coll, p));

  // --- Aggiornamenti in tempo reale -------------------------------------------
  // I DBMS senza change stream (MySQL) falliscono qui: il frontend nasconde
  // semplicemente il badge LIVE.

  socket.on('collection:watch', (payload, cb) => {
    const { db, coll } = payload || {};
    const tabId = normTabId(payload && payload.tabId);
    const sess = sessions.get(tabId);
    if (!sess) {
      cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
      return;
    }
    try {
      // Gli eventi push sono taggati col tabId: il frontend li instrada al tab.
      sess.strategy.watch(db, coll, {
        onChange: (change) => socket.emit('collection:changed', { tabId, db, coll, ...change }),
        onUnavailable: () => socket.emit('watch:unavailable', { tabId, db, coll }),
      });
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: errMsg(err) });
    }
  });

  socket.on('collection:unwatch', (payload) => {
    const sess = sessions.get(normTabId(payload && payload.tabId));
    if (sess) sess.strategy.unwatch();
  });

  socket.on('disconnect', () => {
    closeAllSessions();

    const count = ipConnections.get(ip);
    if (count > 1) {
      ipConnections.set(ip, count - 1);
    } else {
      ipConnections.delete(ip);
    }
  });
});

async function startServer() {
  let passphrase = process.env.GUI_MONGO_PASSPHRASE;
  
  if (!passphrase) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    passphrase = await new Promise(resolve => {
      rl.question('Inserisci la passphrase per cifrare/decifrare i segreti: ', (ans) => {
        rl.close();
        resolve(ans);
      });
    });
  }

  encryptionKey = crypto.createHash('sha256').update(passphrase).digest();
  
  // Migrazione automatica: decifra (o legge in chiaro) e risalva cifrando tutto
  const conns = loadConnections();
  if (Object.keys(conns).length > 0) {
    saveConnections(conns);
  }

  const HOST = process.env.HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(`Mongo Web GUI in ascolto su http://${HOST}:${PORT}`);
  });
}

startServer();
