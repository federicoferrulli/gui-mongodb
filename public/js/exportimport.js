'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, showError, esc } from './utils.js';
import { collWord, refreshDbTree } from './dbtree.js';

// Export/import di collection e tabelle: l'export scarica il file a blocchi
// (skip/limit) via `collection:export`, l'import invia batch di documenti o
// righe via `collection:import`. Tutte le richieste passano da emit(), che
// inietta il tabId del tab attivo.

const CHUNK = 500;

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// format: 'json' (MongoDB), 'csv' o 'sql' (MySQL).
export async function exportCollection(db, coll, format) {
  const lines = [];
  let skip = 0; // ripiego per tabelle MySQL senza chiave primaria
  let after = null; // cursore keyset (Mongo sempre, MySQL con PK)
  let total = 0;
  let header = null;
  try {
    for (;;) {
      const res = await emit('collection:export', { db, coll, skip, after, limit: CHUNK, format });
      total = res.total;
      if (header == null && res.header != null) header = res.header;
      lines.push(...res.lines);
      skip += res.count;
      after = res.nextAfter != null ? res.nextAfter : after;
      toast(`Esportazione di "${coll}"… ${Math.min(skip, total)}/${total}`);
      if (res.count < CHUNK || skip >= total) break;
    }
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }

  let text;
  let ext;
  let mime;
  if (format === 'csv') {
    text = (header != null ? header + '\n' : '') + lines.join('\n') + (lines.length ? '\n' : '');
    ext = 'csv';
    mime = 'text/csv;charset=utf-8';
  } else if (format === 'sql') {
    text = lines.join('\n') + (lines.length ? '\n' : '');
    ext = 'sql';
    mime = 'text/plain;charset=utf-8';
  } else {
    // MongoDB: array JSON di documenti in Extended JSON (relaxed).
    text = '[\n' + lines.join(',\n') + '\n]\n';
    ext = 'json';
    mime = 'application/json;charset=utf-8';
  }
  downloadBlob(text, `${db}.${coll}.${ext}`, mime);
  toast(`Esportati ${lines.length} ${state.dbType === 'mysql' ? 'righe' : 'documenti'} da "${coll}"`);
}

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------- */

let importTarget = null; // { db, coll }
let importing = false;

// Parser CSV minimale (RFC 4180): gestisce virgolette, virgolette raddoppiate
// e a capo dentro i campi.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Ignora le righe completamente vuote.
  return rows.filter((r) => r.some((v) => v !== ''));
}

// Prepara i batch a partire dal testo incollato/caricato, secondo il dbType.
function buildDocs(text) {
  if (state.dbType === 'mysql') {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSV vuoto o senza righe di dati: serve una riga di intestazione più almeno una riga.');
    const header = rows[0].map((h) => h.trim());
    if (header.some((h) => !h)) throw new Error('La riga di intestazione del CSV contiene colonne senza nome.');
    return rows.slice(1).map((r) => {
      const obj = {};
      header.forEach((col, i) => {
        const v = r[i];
        obj[col] = v === '' || v === undefined ? null : v; // MySQL converte i tipi dalle stringhe
      });
      return obj;
    });
  }
  // MongoDB: array JSON (o singolo oggetto) in Extended JSON.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON non valido: ${err.message}`);
  }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  if (!docs.length) throw new Error('Il file non contiene documenti da importare.');
  for (const d of docs) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw new Error('Ogni elemento dell\'array deve essere un oggetto JSON.');
    }
  }
  return docs;
}

function setImportProgress(pct, label) {
  $('#import-progress').classList.remove('hidden');
  $('#import-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
  $('#import-progress-label').textContent = label || '';
}

export function openImportModal(db, coll) {
  importTarget = { db, coll };
  importing = false;
  const isMysql = state.dbType === 'mysql';
  $('#import-title').textContent = `Importa in "${coll}"`;
  $('#import-subtitle').textContent = isMysql
    ? `Tabella: ${db} ▸ ${coll} — formato CSV con riga di intestazione (nomi colonna).`
    : `Collection: ${db} ▸ ${coll} — formato JSON: array di documenti (Extended JSON supportato, es. {"$oid": ...}).`;
  $('#import-file').value = '';
  $('#import-file').accept = isMysql ? '.csv,text/csv' : '.json,application/json';
  $('#import-text').value = '';
  $('#import-text').placeholder = isMysql
    ? 'id,nome,creato\n1,Mario,2026-01-01 10:00:00'
    : '[\n  { "nome": "Mario", "creato": { "$date": "2026-01-01T10:00:00Z" } }\n]';
  $('#import-progress').classList.add('hidden');
  $('#import-progress-bar').style.width = '0%';
  $('#import-progress-label').textContent = '';
  $('#import-report').classList.add('hidden');
  $('#import-report').innerHTML = '';
  showError('#import-error', '');
  $('#import-run').disabled = false;
  openModal('#import-overlay');
}

async function runImport() {
  if (importing || !importTarget) return;
  showError('#import-error', '');
  $('#import-report').classList.add('hidden');

  const text = $('#import-text').value.trim();
  if (!text) {
    showError('#import-error', 'Nessun contenuto da importare: carica un file o incolla i dati.');
    return;
  }
  let docs;
  try {
    docs = buildDocs(text);
  } catch (err) {
    showError('#import-error', err.message);
    return;
  }

  const { db, coll } = importTarget;
  importing = true;
  $('#import-run').disabled = true;
  let inserted = 0;
  let failed = 0;
  const errors = [];
  try {
    for (let i = 0; i < docs.length; i += CHUNK) {
      const batch = docs.slice(i, i + CHUNK);
      setImportProgress((i / docs.length) * 100, `${i}/${docs.length}…`);
      try {
        const res = await emit('collection:import', { db, coll, docs: batch });
        inserted += res.inserted;
        failed += res.failed;
        for (const e of res.errors || []) {
          if (errors.length < 20) errors.push(e);
        }
      } catch (err) {
        // Blocco interamente fallito (es. connessione persa): conteggia e prosegui.
        failed += batch.length;
        if (errors.length < 20) errors.push(err.message);
      }
    }
  } finally {
    importing = false;
    $('#import-run').disabled = false;
  }
  setImportProgress(100, `${docs.length}/${docs.length}`);

  // Report finale: conteggio ok/errori e prime cause di errore.
  const report = $('#import-report');
  const word = state.dbType === 'mysql' ? 'righe' : 'documenti';
  let html = `<strong>${inserted}</strong> ${word} su ${docs.length} importati` +
    (failed ? `, <strong class="import-failed">${failed}</strong> con errori.` : '.');
  if (errors.length) {
    html += '<ul>' + errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>';
  }
  report.innerHTML = html;
  report.classList.remove('hidden');
  toast(failed ? `Import completato con ${failed} errori` : `Importati ${inserted} ${word} in "${coll}"`, !!failed);

  // Aggiorna griglia (se la collection è aperta) e contatori della sidebar.
  if (inserted && state.db === db && state.coll === coll) {
    import('./grid.js').then(({ runQuery }) => runQuery());
  }
  if (inserted) refreshDbTree();
}

export function initExportImport() {
  $('#import-cancel').addEventListener('click', () => {
    if (!importing) closeModal('#import-overlay');
  });
  $('#import-run').addEventListener('click', runImport);
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('#import-text').value = String(reader.result || ''); };
    reader.onerror = () => showError('#import-error', 'Impossibile leggere il file selezionato.');
    reader.readAsText(file);
  });

  // --- Import di interi database ---------------------------------------------
  $('#dbimport-cancel').addEventListener('click', () => {
    if (!dbImporting) closeModal('#dbimport-overlay');
  });
  $('#dbimport-run').addEventListener('click', runDbImport);
  $('#dbimport-file').addEventListener('change', (e) => {
    dbImportData = null;
    showError('#dbimport-error', '');
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        dbImportData = validateDbExport(String(reader.result || ''));
        if (!$('#dbimport-target').value.trim()) $('#dbimport-target').value = dbImportData.db || '';
        const docs = dbImportData.collections.reduce((s, c) => s + c.docs.length, 0);
        $('#dbimport-subtitle').textContent =
          `File "${file.name}": database "${dbImportData.db}" (${dbImportData.dbType}), ` +
          `${dbImportData.collections.length} ${collWord()}, ${docs} ${state.dbType === 'mysql' ? 'righe' : 'documenti'}.`;
      } catch (err) {
        showError('#dbimport-error', err.message);
      }
    };
    reader.onerror = () => showError('#dbimport-error', 'Impossibile leggere il file selezionato.');
    reader.readAsText(file);
  });
}

// Voci di menu contestuale per un intero database (sidebar).
export function dbExportImportMenuItems(db) {
  return [
    { label: '⤓ Esporta database (JSON)…', action: () => exportDatabase(db) },
    { label: '⤒ Importa database…', action: openDbImportModal },
  ];
}

/* ---------------------------------------------------------------------------
 * Export/import di INTERI database: un unico file .codedb.json auto-contenuto
 * { formato, versione, dbType, db, collections: [{ name, ddl, indexes, docs }] }
 * con i documenti/righe in Extended JSON (relaxed). L'export riusa i blocchi
 * di collection:export (formato json per entrambi i dbType) più il CREATE
 * TABLE (collection:ddl, MySQL) e gli indici (collection:stats, MongoDB);
 * l'import ricrea schema e indici e invia i dati con collection:import.
 * ------------------------------------------------------------------------- */

const DB_EXPORT_FORMAT = 'codedb-database';

// Database di sistema: metadati generati dal server, non dati dell'utente.
// Esportarli produce viste non ricreabili, importarci sopra è distruttivo.
const SYSTEM_DBS = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mongodb: ['admin', 'config', 'local'],
};

function isSystemDb(name) {
  return (SYSTEM_DBS[state.dbType] || []).includes(String(name).toLowerCase());
}

export async function exportDatabase(db) {
  const isMysql = state.dbType === 'mysql';
  if (isSystemDb(db)) {
    toast(`"${db}" è un database di sistema: contiene metadati del server, non è esportabile.`, true);
    return;
  }
  let collections;
  try {
    // Solo collection/tabelle "vere": le view sono derivate.
    collections = (await emit('db:collections', { db })).collections.filter((c) => c.type !== 'view');
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }
  if (!collections.length) {
    toast(`Il database "${db}" non contiene ${collWord()} da esportare.`, true);
    return;
  }

  // Il file viene assemblato come testo per non ri-parsare i blocchi EJSON.
  const parts = [];
  let exported = 0;
  try {
    for (const c of collections) {
      let ddl = null;
      let indexes = null;
      if (isMysql) {
        ddl = (await emit('collection:ddl', { db, coll: c.name })).ddl;
      } else {
        const stats = await emit('collection:stats', { db, coll: c.name });
        indexes = (stats.indexes || []).filter((i) => i.name !== '_id_');
      }
      const lines = [];
      let skip = 0;
      let after = null;
      for (;;) {
        const res = await emit('collection:export', { db, coll: c.name, skip, after, limit: CHUNK, format: 'json' });
        lines.push(...res.lines);
        skip += res.count;
        after = res.nextAfter != null ? res.nextAfter : after;
        toast(`Esportazione di "${db}"… ${c.name}: ${Math.min(skip, res.total)}/${res.total}`);
        if (res.count < CHUNK || skip >= res.total) break;
      }
      exported += lines.length;
      parts.push(
        `  { "name": ${JSON.stringify(c.name)}, "ddl": ${JSON.stringify(ddl)}, ` +
        `"indexes": ${JSON.stringify(indexes)}, "docs": [\n    ` +
        lines.join(',\n    ') + '\n  ] }'
      );
    }
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }

  const text =
    `{ "formato": ${JSON.stringify(DB_EXPORT_FORMAT)}, "versione": 1, ` +
    `"dbType": ${JSON.stringify(state.dbType)}, "db": ${JSON.stringify(db)},\n"collections": [\n` +
    parts.join(',\n') + '\n] }\n';
  downloadBlob(text, `${db}.codedb.json`, 'application/json;charset=utf-8');
  toast(`Esportato il database "${db}": ${collections.length} ${collWord()}, ${exported} ${state.dbType === 'mysql' ? 'righe' : 'documenti'}`);
}

/* --- Import di un intero database ----------------------------------------- */

let dbImportData = null; // contenuto validato del file selezionato
let dbImporting = false;

function setDbImportProgress(pct, label) {
  $('#dbimport-progress').classList.remove('hidden');
  $('#dbimport-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
  $('#dbimport-progress-label').textContent = label || '';
}

function validateDbExport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON non valido: ${err.message}`);
  }
  if (!parsed || parsed.formato !== DB_EXPORT_FORMAT || !Array.isArray(parsed.collections)) {
    throw new Error('Il file non è un export di database di CodeDB (atteso "formato": "codedb-database").');
  }
  if (parsed.dbType !== state.dbType) {
    throw new Error(`Il file è un export ${parsed.dbType}, ma questa connessione è ${state.dbType}.`);
  }
  for (const c of parsed.collections) {
    if (!c || typeof c.name !== 'string' || !Array.isArray(c.docs)) {
      throw new Error('File malformato: ogni collection deve avere "name" e l\'array "docs".');
    }
  }
  return parsed;
}

export function openDbImportModal() {
  dbImportData = null;
  dbImporting = false;
  $('#dbimport-subtitle').textContent = state.dbType === 'mysql'
    ? 'Ricrea tabelle (CREATE TABLE del file) e righe in uno schema di destinazione.'
    : 'Ricrea collection, documenti e indici in un database di destinazione.';
  $('#dbimport-file').value = '';
  $('#dbimport-target').value = '';
  $('#dbimport-drop').checked = false;
  $('#dbimport-progress').classList.add('hidden');
  $('#dbimport-progress-bar').style.width = '0%';
  $('#dbimport-progress-label').textContent = '';
  $('#dbimport-report').classList.add('hidden');
  $('#dbimport-report').innerHTML = '';
  showError('#dbimport-error', '');
  $('#dbimport-run').disabled = false;
  openModal('#dbimport-overlay');
}

async function runDbImport() {
  if (dbImporting) return;
  showError('#dbimport-error', '');
  $('#dbimport-report').classList.add('hidden');
  if (!dbImportData) {
    showError('#dbimport-error', 'Seleziona prima un file .codedb.json valido.');
    return;
  }
  const target = $('#dbimport-target').value.trim();
  if (!target) {
    showError('#dbimport-error', 'Indica il database di destinazione.');
    return;
  }
  if (isSystemDb(target)) {
    showError('#dbimport-error', `"${target}" è un database di sistema: scegli un'altra destinazione.`);
    return;
  }
  const drop = $('#dbimport-drop').checked;
  const isMysql = state.dbType === 'mysql';
  const totalDocs = dbImportData.collections.reduce((s, c) => s + c.docs.length, 0) || 1;

  dbImporting = true;
  $('#dbimport-run').disabled = true;
  let inserted = 0;
  let failed = 0;
  let done = 0;
  const errors = [];
  const pushErr = (msg) => { if (errors.length < 20) errors.push(msg); };
  try {
    // MySQL: lo schema di destinazione deve esistere (MongoDB lo crea da solo
    // al primo insert). "esiste già" non è un errore.
    if (isMysql) {
      try {
        await emit('db:create', { db: target });
      } catch (err) {
        if (!/esiste già/i.test(err.message)) throw err;
      }
    }

    for (const c of dbImportData.collections) {
      setDbImportProgress((done / totalDocs) * 100, `${c.name}…`);
      try {
        if (drop) {
          await emit('collection:drop', { db: target, coll: c.name }).catch(() => { /* non esisteva */ });
        }
        if (isMysql && c.ddl) {
          // CREATE TABLE dal file; se la tabella esiste già (senza drop) si
          // prosegue con il solo inserimento delle righe.
          await emit('collection:aggregate', { db: target, coll: c.name, pipeline: c.ddl })
            .catch((err) => {
              if (!/already exists/i.test(err.message)) throw err;
            });
        }
      } catch (err) {
        failed += c.docs.length;
        done += c.docs.length;
        pushErr(`${c.name}: ${err.message}`);
        continue;
      }

      for (let i = 0; i < c.docs.length; i += CHUNK) {
        const batch = c.docs.slice(i, i + CHUNK);
        setDbImportProgress((done / totalDocs) * 100, `${c.name}: ${i}/${c.docs.length}…`);
        try {
          const res = await emit('collection:import', { db: target, coll: c.name, docs: batch });
          inserted += res.inserted;
          failed += res.failed;
          for (const e of res.errors || []) pushErr(`${c.name}: ${e}`);
        } catch (err) {
          failed += batch.length;
          pushErr(`${c.name}: ${err.message}`);
        }
        done += batch.length;
      }

      // MongoDB: ricrea gli indici della collection (dopo i dati).
      await Promise.all((c.indexes || []).map(async (idx) => {
        try {
          await emit('index:create', {
            db: target, coll: c.name,
            fields: JSON.stringify(idx.key), unique: !!idx.unique, name: idx.name,
          });
        } catch (err) {
          pushErr(`${c.name}, indice "${idx.name}": ${err.message}`);
        }
      }));
    }
  } catch (err) {
    pushErr(err.message);
  } finally {
    dbImporting = false;
    $('#dbimport-run').disabled = false;
  }
  setDbImportProgress(100, 'completato');

  const report = $('#dbimport-report');
  const word = isMysql ? 'righe' : 'documenti';
  let html = `<strong>${inserted}</strong> ${word} importati in "${esc(target)}"` +
    (failed ? `, <strong class="import-failed">${failed}</strong> con errori.` : '.');
  if (errors.length) {
    html += '<ul>' + errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>';
  }
  report.innerHTML = html;
  report.classList.remove('hidden');
  toast(failed || errors.length ? 'Import del database completato con errori' : `Database "${target}" importato`, !!(failed || errors.length));
  refreshDbTree();
}

// Voci di menu contestuale per una collection/tabella, condivise tra la
// sidebar (dbtree) e i coll-tab.
export function exportImportMenuItems(db, coll) {
  const items = state.dbType === 'mysql'
    ? [
        { label: '⤓ Esporta CSV', action: () => exportCollection(db, coll, 'csv') },
        { label: '⤓ Esporta SQL (INSERT)', action: () => exportCollection(db, coll, 'sql') },
      ]
    : [{ label: '⤓ Esporta JSON', action: () => exportCollection(db, coll, 'json') }];
  items.push({ label: `⤒ Importa nella ${collWord()}…`, action: () => openImportModal(db, coll) });
  return items;
}
