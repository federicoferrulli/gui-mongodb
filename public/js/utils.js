import { socket } from './socket.js';
import { state } from './state.js';
import { tabs, activeTab } from './tabs.js';

export const $ = (sel) => document.querySelector(sel);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function ejsonKind(v) {
  if (isPlainObject(v)) {
    if ('$oid' in v) return 'oid';
    if ('$date' in v) return 'date';
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v) return 'number';
    if ('$numberDecimal' in v) return 'decimal';
    if ('$binary' in v) return 'binary';
    return 'object';
  }
  return typeof v; // string, number, boolean, object (null/array)
}

export function displayValue(v) {
  if (v === null || v === undefined) return { text: 'null', cls: 'type-null' };
  if (Array.isArray(v)) return { text: JSON.stringify(v.map(simplify)), cls: 'type-obj' };

  const kind = ejsonKind(v);
  if (kind === 'oid') return { text: v.$oid, cls: 'type-oid' };
  if (kind === 'date') {
    const d = isPlainObject(v.$date) ? Number(v.$date.$numberLong) : v.$date;
    const date = new Date(d);
    // Data invalida (es. DATETIME azzerati): non deve far saltare il render
    // dell'intera griglia con il RangeError di toISOString().
    if (isNaN(date.getTime())) return { text: String(d), cls: 'type-date' };
    return { text: date.toISOString(), cls: 'type-date' };
  }
  if (kind === 'number') {
    // 'number' copre sia le forme EJSON canoniche ({"$numberLong": "..."})
    // sia i numeri JS puri (il server serializza relaxed): vanno distinti.
    const text = isPlainObject(v)
      ? String(v.$numberInt ?? v.$numberLong ?? v.$numberDouble)
      : String(v);
    return { text, cls: 'type-num' };
  }
  if (kind === 'decimal') return { text: String(v.$numberDecimal), cls: 'type-num' };
  if (kind === 'binary') {
    const b64 = v.$binary.base64 || '';
    const size = Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
    let hex = '';
    if (size > 0) {
      const header = atob(b64.slice(0, 16)).substring(0, 8);
      for (let i = 0; i < Math.min(header.length, 8); i++) {
        hex += header.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase() + ' ';
      }
      if (size > 8) hex += '...';
    }
    return { text: `[BLOB ${fmtBytes(size)}] ${hex.trim()}`, cls: 'type-obj' };
  }
  if (kind === 'object') return { text: JSON.stringify(simplify(v)), cls: 'type-obj' };
  if (kind === 'boolean') return { text: String(v), cls: 'type-bool' };
  return { text: String(v), cls: '' };
}

export function simplify(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(simplify);
  const kind = ejsonKind(v);
  if (kind === 'oid') return v.$oid;
  if (kind === 'date') return displayValue(v).text;
  if (kind === 'number') return isPlainObject(v) ? Number(Object.values(v)[0]) : v;
  if (kind === 'decimal') return Number(v.$numberDecimal);
  if (kind === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = simplify(val);
    return out;
  }
  return v;
}

export function valueType(v) {
  const kind = ejsonKind(v);
  if (kind === 'oid' || kind === 'date' || kind === 'number' || kind === 'decimal') return kind;
  if (kind === 'string' || kind === 'boolean') return kind === 'boolean' ? 'bool' : kind;
  return 'json';
}

export function editValue(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function parseEdited(text) {
  const t = text.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

export function idOf(doc) {
  return JSON.stringify(doc._id);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export function cut(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

export function showQueryError(msg) {
  const el = $('#query-error');
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

export function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item === '---') {
      li.className = 'separator';
    } else {
      li.textContent = item.label;
      if (item.danger) li.classList.add('danger');
      li.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
    }
    menu.appendChild(li);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}

export function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

// Riordino via drag & drop di una barra di tab. `el` è l'elemento tab, `id` la
// sua chiave stabile (il tabId o l'id del coll-tab) e `onReorder(fromId, toId)`
// riordina l'array sottostante e ri-renderizza. Si lavora per id, non per
// indice: la barra di connessione salta i tab non connessi, quindi la posizione
// visiva non coincide con l'indice nell'array.
export function makeDraggable(el, id, onReorder) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!el.classList.contains('dragging')) el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const fromId = e.dataTransfer.getData('text/plain');
    if (fromId && fromId !== id) onReorder(fromId, id);
  });
}

// Sposta l'elemento con `fromId` nella posizione di quello con `toId`.
// Ritorna true se qualcosa è cambiato.
export function reorderById(list, fromId, toId, key = 'id') {
  const from = list.findIndex((x) => x[key] === fromId);
  const to = list.findIndex((x) => x[key] === toId);
  if (from < 0 || to < 0 || from === to) return false;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return true;
}

export const openModal = (id) => $(id).classList.remove('hidden');
export const closeModal = (id) => $(id).classList.add('hidden');

export function showError(id, msg) {
  const el = $(id);
  if (el) {
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
}

// Richiesta con acknowledgment: inietta il tabId del tab attivo, catturato al
// momento della chiamata (non alla risposta: l'utente può cambiare tab mentre
// la query è in volo). La risposta porta il tab di origine in `_tab`; se nel
// frattempo il tab è stato chiuso, la risposta viene scartata.
export function emit(event, payload) {
  const tab = activeTab();
  return new Promise((resolve, reject) => {
    socket.emit(event, { tabId: tab ? tab.id : undefined, ...(payload || {}) }, (res) => {
      if (tab && !tabs.list.includes(tab)) return; // tab chiuso: risposta orfana
      res.ok ? resolve(Object.assign(res, { _tab: tab })) : reject(new Error(res.error));
    });
  });
}

// Evento senza risposta (fire-and-forget), sempre col tabId del tab attivo.
export function notify(event, payload) {
  const tab = activeTab();
  socket.emit(event, { tabId: tab ? tab.id : undefined, ...(payload || {}) });
}

export function invalidateSchema() {
  state.dbSchema = null;
}

export function colDone(verb) {
  return verb + 'a';
}

export function dbTypeIcon(dbType) {
  return dbType === 'mysql' ? '🐬' : '🍃';
}
