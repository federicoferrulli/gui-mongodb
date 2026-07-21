'use strict';

/* ---------------------------------------------------------------------------
 * Log delle attività di backup/restore: ogni riga su file (append) e in
 * console. Il file registra inizio/fine, stato, durata ed eventuali errori.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024; // oltre, si ruota un file .1 per non crescere indefinitamente

function createLogger(logFile, { quiet = false } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  function write(level, msg) {
    const line = `[${new Date().toISOString()}] ${level} ${msg}`;
    try {
      let stats = null;
      try { stats = fs.statSync(logFile); } catch { /* non esiste ancora */ }
      if (stats && stats.size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch { /* il log non deve mai far fallire l'operazione */ }
    if (!quiet) {
      // eslint-disable-next-line no-console
      (level === 'ERRORE' ? console.error : console.log)(line);
    }
  }

  return {
    file: logFile,
    info: (msg) => write('INFO  ', msg),
    error: (msg) => write('ERRORE', msg),

    // Traccia un'operazione completa: INIZIO ... FINE con stato e durata.
    async run(label, fn) {
      const t0 = Date.now();
      write('INFO  ', `INIZIO ${label}`);
      try {
        const result = await fn();
        write('INFO  ', `FINE ${label} — stato=SUCCESSO durata=${formatDuration(Date.now() - t0)}`);
        return result;
      } catch (err) {
        const msg = (err && err.message) || String(err);
        write('ERRORE', `FINE ${label} — stato=FALLITO durata=${formatDuration(Date.now() - t0)} errore=${msg}`);
        throw err;
      }
    },
  };
}

module.exports = { createLogger, formatDuration };
