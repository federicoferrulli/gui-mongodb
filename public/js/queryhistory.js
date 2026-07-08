// Storico query persistente in localStorage.
//
// Ogni voce registra modalità (find/aggregate), filtro e sort al momento
// dell'esecuzione. La chiave è per connessione salvata + database +
// collection, così lo storico "segue" la collection anche tra sessioni.
// Massimo MAX_ENTRIES voci per chiave; le esecuzioni identiche consecutive
// non vengono duplicate. Il click su una voce ripristina la query nei campi
// SENZA eseguirla: l'utente conferma con ▶ Esegui (o Invio).

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, cut, toast } from './utils.js';

const MAX_ENTRIES = 50;
const PREFIX = 'queryHistory:';

// Chiave localStorage per la collection corrente del tab attivo.
function historyKey() {
  if (!state.db || !state.coll) return null;
  const tab = activeTab();
  const conn = (tab && (tab.connName || tab.label)) || 'anonima';
  return `${PREFIX}${conn}:${state.db}:${state.coll}`;
}

function loadHistory(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(key, entries) {
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage pieno o non disponibile: lo storico è best-effort.
  }
}

// Registra una query eseguita (chiamata da runQuery in grid.js).
// Le voci sono ordinate dalla più recente; niente dedup globale, solo
// delle esecuzioni identiche consecutive.
export function recordQuery({ mode, filter, sort }) {
  const key = historyKey();
  if (!key) return;
  const entry = { mode, filter: filter || '', sort: sort || '', ts: Date.now() };
  // Query completamente vuota: inutile in uno storico.
  if (!entry.filter && !entry.sort) return;

  const entries = loadHistory(key);
  const last = entries[0];
  if (last && last.mode === entry.mode && last.filter === entry.filter && last.sort === entry.sort) {
    last.ts = entry.ts; // aggiorna solo il timestamp
  } else {
    entries.unshift(entry);
  }
  saveHistory(key, entries);
}

function fmtTs(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('it-IT')} ${time}`;
}

function hidePanel() {
  const panel = $('#query-history-panel');
  if (panel) panel.classList.add('hidden');
}

// Ripristina una voce nei campi query (senza eseguirla).
function restoreEntry(entry) {
  $('#query-mode').value = entry.mode;
  // Il change aggiorna placeholder e visibilità del campo sort
  // (applyQueryPlaceholders è già registrato come listener in grid.js).
  $('#query-mode').dispatchEvent(new Event('change'));
  $('#filter-input').value = entry.filter;
  $('#sort-input').value = entry.sort;
  hidePanel();
  $('#filter-input').focus();
  toast('Query ripristinata: premi ▶ Esegui per lanciarla');
}

function renderPanel() {
  const panel = $('#query-history-panel');
  panel.innerHTML = '';

  const key = historyKey();
  const entries = key ? loadHistory(key) : [];

  const header = document.createElement('div');
  header.className = 'query-history-header';
  const title = document.createElement('span');
  title.textContent = state.coll ? `Query recenti — ${state.coll}` : 'Query recenti';
  header.appendChild(title);
  if (entries.length) {
    const clear = document.createElement('button');
    clear.textContent = 'Svuota';
    clear.title = 'Elimina lo storico di questa collection';
    clear.addEventListener('click', () => {
      localStorage.removeItem(key);
      renderPanel();
    });
    header.appendChild(clear);
  }
  panel.appendChild(header);

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'query-history-empty';
    empty.textContent = 'Nessuna query recente per questa collection.';
    panel.appendChild(empty);
    return;
  }

  const isMysql = state.dbType === 'mysql';
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'query-history-item';
    item.title = 'Clicca per ripristinare la query nei campi (senza eseguirla)';

    const top = document.createElement('div');
    top.className = 'query-history-item-top';
    const mode = document.createElement('span');
    mode.className = 'query-history-mode';
    mode.textContent = entry.mode === 'aggregate' ? (isMysql ? 'SQL' : 'aggregate') : 'find';
    const ts = document.createElement('span');
    ts.className = 'query-history-ts';
    ts.textContent = fmtTs(entry.ts);
    top.appendChild(mode);
    top.appendChild(ts);
    item.appendChild(top);

    const text = document.createElement('div');
    text.className = 'query-history-text';
    text.textContent = cut(entry.filter || '(nessun filtro)', 120);
    item.appendChild(text);

    if (entry.sort) {
      const sort = document.createElement('div');
      sort.className = 'query-history-sort';
      sort.textContent = `sort: ${cut(entry.sort, 60)}`;
      item.appendChild(sort);
    }

    item.addEventListener('click', () => restoreEntry(entry));
    panel.appendChild(item);
  }
}

export function initQueryHistory() {
  const btn = $('#query-history-btn');
  const panel = $('#query-history-panel');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) {
      renderPanel();
      panel.classList.remove('hidden');
    } else {
      hidePanel();
    }
  });

  // Chiusura al click fuori dal pannello e con Escape.
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target)) hidePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePanel();
  });
}
