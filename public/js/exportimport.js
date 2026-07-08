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
  let skip = 0;
  let total = 0;
  let header = null;
  try {
    for (;;) {
      const res = await emit('collection:export', { db, coll, skip, limit: CHUNK, format });
      total = res.total;
      if (header == null && res.header != null) header = res.header;
      lines.push(...res.lines);
      skip += res.count;
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
