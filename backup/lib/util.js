'use strict';

/* ---------------------------------------------------------------------------
 * Utility condivise di backup/restore: scrittura NDJSON in streaming con
 * gzip + checksum SHA-256, lettura riga per riga, catalogo dei backup.
 * Tutto in streaming: nessun file viene mai caricato per intero in memoria.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { Transform } = require('stream');
const { once } = require('events');
const { finished } = require('stream/promises');

// Sink su file: le righe scritte passano (opzionalmente) da gzip, poi da un
// contatore che calcola SHA-256 e dimensione sui byte effettivi del file.
function createFileSink(filePath, { compress = true, level = 6 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  counter.pipe(out);
  let entry = counter;
  if (compress) {
    entry = zlib.createGzip({ level });
    entry.pipe(counter);
  }
  return {
    writeLine(line) {
      if (!entry.write(line + '\n')) return once(entry, 'drain');
    },
    async close() {
      entry.end();
      await finished(out);
      return { bytes, sha256: hash.digest('hex') };
    },
  };
}

// Itera le righe non vuote di un file NDJSON, decomprimendo se .gz.
async function* readLines(filePath) {
  let input = fs.createReadStream(filePath);
  if (filePath.endsWith('.gz')) {
    const gunzip = zlib.createGunzip();
    input.pipe(gunzip);
    input = gunzip;
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Nome file/cartella sicuro a partire da nomi di connessione/db arbitrari.
function safeName(name) {
  return String(name).replace(/[^\w.-]+/g, '_');
}

// Id del backup: timestamp ordinabile + tipo (es. 20260714-103000_full).
function makeBackupId(type) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}_${type}`;
}

/* --- Catalogo: <dest>/<conn>_<db>/catalog.json -------------------------- */

function readCatalog(groupDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(groupDir, 'catalog.json'), 'utf8'));
  } catch {
    return { backups: [] };
  }
}

// Lock a file (creazione esclusiva, atomica su tutti gli OS supportati) per
// serializzare le scritture concorrenti al catalogo: un backup via CLI e uno
// via MCP sullo stesso gruppo altrimenti possono leggere lo stesso catalogo
// prima l'uno della scrittura dell'altro e perdersi una voce (read-modify-write).
function acquireCatalogLock(groupDir, timeoutMs = 5000) {
  fs.mkdirSync(groupDir, { recursive: true });
  const lockFile = path.join(groupDir, '.catalog.lock');
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      return lockFile;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        // Lock stantio (processo terminato senza rilasciarlo): lo forza.
        try { fs.unlinkSync(lockFile); } catch { /* già rimosso da un altro */ }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function releaseCatalogLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* già rilasciato */ }
}

function appendToCatalog(groupDir, entry) {
  const lockFile = acquireCatalogLock(groupDir);
  try {
    const catalog = readCatalog(groupDir);
    catalog.backups.push(entry);
    fs.writeFileSync(path.join(groupDir, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  } finally {
    releaseCatalogLock(lockFile);
  }
}

function readManifest(backupDir) {
  const file = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`Manifest non trovato: ${file} (la cartella non è un backup valido).`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = {
  createFileSink,
  readLines,
  sha256File,
  safeName,
  makeBackupId,
  readCatalog,
  appendToCatalog,
  readManifest,
  formatBytes,
};
