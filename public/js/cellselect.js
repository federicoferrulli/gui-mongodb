'use strict';

import { state } from './state.js';
import { $, emit, displayValue, toast, showContextMenu, idOf, parseEdited, valueType, isPlainObject } from './utils.js';
import { runQuery } from './grid.js';

// Selezione di celle stile Excel sulla griglia dati: click, trascinamento
// rettangolare, Shift+click (estende dall'ancora), Ctrl+click (aggiunge/toglie),
// Ctrl+click sull'header (seleziona la colonna), frecce (con Shift estendono),
// Ctrl+A, copia negli appunti (Ctrl+C in TSV; dal menu contestuale anche JSON,
// CSV, Markdown, SQL INSERT), incolla da Excel (Ctrl+V, aggiorna i documenti)
// ed esportazione CSV della selezione.
// Lo stato vive per tab in `state.cellSel` (chiavi "riga:colonna" sugli indici
// di state.docs/state.columns), così la selezione sopravvive ai re-render.

function sel() {
  if (!state.cellSel) state.cellSel = { anchor: null, focus: null, cells: new Set() };
  return state.cellSel;
}

const key = (r, c) => `${r}:${c}`;

function cellFromTd(td) {
  return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
}

// Tutte le chiavi del rettangolo con vertici a e b (inclusi).
function rectKeys(a, b) {
  const keys = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
      keys.push(key(r, c));
    }
  }
  return keys;
}

export function clearCellSelection() {
  const s = sel();
  s.anchor = null;
  s.focus = null;
  s.cells.clear();
}

// Ri-applica le classi CSS della selezione dopo un render della griglia,
// scartando le celle ormai fuori dai limiti della pagina corrente.
export function applyCellSelection() {
  const s = sel();
  for (const k of [...s.cells]) {
    const [r, c] = k.split(':').map(Number);
    if (r >= state.docs.length || c >= state.columns.length) s.cells.delete(k);
  }
  if (s.focus && (s.focus.r >= state.docs.length || s.focus.c >= state.columns.length)) {
    s.focus = null;
    s.anchor = null;
  }
  document.querySelectorAll('#grid tbody td[data-c]').forEach((td) => {
    const { r, c } = cellFromTd(td);
    td.classList.toggle('cell-selected', s.cells.has(key(r, c)));
    td.classList.toggle('cell-focus', !!s.focus && s.focus.r === r && s.focus.c === c);
  });
  const info = $('#cell-info');
  if (info) info.textContent = s.cells.size > 1 ? `${s.cells.size} celle selezionate` : '';
}

// Valore testuale della cella come mostrato in griglia.
function cellText(r, c) {
  const doc = state.docs[r];
  const col = state.columns[c];
  if (!doc || col === undefined) return '';
  return doc[col] === undefined ? '' : displayValue(doc[col]).text;
}

// Valore grezzo (forma EJSON) della cella.
function cellRaw(r, c) {
  return state.docs[r]?.[state.columns[c]];
}

// Righe e colonne (ordinate) coinvolte nella selezione.
function selectionGrid() {
  const cells = [...sel().cells].map((k) => k.split(':').map(Number));
  const rows = [...new Set(cells.map(([r]) => r))].sort((a, b) => a - b);
  const cols = [...new Set(cells.map(([, c]) => c))].sort((a, b) => a - b);
  return { rows, cols };
}

// TSV della selezione: le celle non selezionate dentro il rettangolo di
// contorno restano vuote, come farebbe Excel con una selezione sparsa.
function buildTsv(withHeaders) {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const lines = rows.map((r) =>
    cols.map((c) => (has.has(key(r, c)) ? cellText(r, c) : '')).join('\t')
  );
  if (withHeaders) lines.unshift(cols.map((c) => state.columns[c] ?? '').join('\t'));
  return lines.join('\n');
}

// JSON della selezione: una cella sola → il valore; una riga → oggetto;
// più righe → array di oggetti. I valori restano in forma EJSON.
function buildJson() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  if (rows.length === 1 && cols.length === 1) {
    const v = state.docs[rows[0]]?.[state.columns[cols[0]]];
    return typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2);
  }
  const objs = rows.map((r) => {
    const obj = {};
    for (const c of cols) {
      if (has.has(key(r, c))) obj[state.columns[c]] = state.docs[r]?.[state.columns[c]] ?? null;
    }
    return obj;
  });
  return JSON.stringify(objs.length === 1 ? objs[0] : objs, null, 2);
}

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(withHeaders) {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const lines = rows.map((r) =>
    cols.map((c) => (has.has(key(r, c)) ? csvField(cellText(r, c)) : '')).join(',')
  );
  if (withHeaders) lines.unshift(cols.map((c) => csvField(state.columns[c] ?? '')).join(','));
  return lines.join('\n');
}

function buildMarkdown() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const mdEsc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (vals) => '| ' + vals.join(' | ') + ' |';
  const out = [
    line(cols.map((c) => mdEsc(state.columns[c] ?? ''))),
    line(cols.map(() => '---')),
    ...rows.map((r) => line(cols.map((c) => (has.has(key(r, c)) ? mdEsc(cellText(r, c)) : '')))),
  ];
  return out.join('\n');
}

function sqlString(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Letterale SQL (dialetto MySQL) da un valore EJSON.
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return sqlString(v);
  if (isPlainObject(v)) {
    if (v.$oid) return sqlString(v.$oid);
    if (v.$date !== undefined) {
      const iso = displayValue(v).text; // ISO oppure valore grezzo se data invalida
      return sqlString(/^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) + ' ' + iso.slice(11, 19) : iso);
    }
    if (v.$numberInt !== undefined || v.$numberLong !== undefined || v.$numberDouble !== undefined) {
      return String(v.$numberInt ?? v.$numberLong ?? v.$numberDouble);
    }
    if (v.$numberDecimal !== undefined) return String(v.$numberDecimal);
  }
  return sqlString(JSON.stringify(v)); // oggetti/array → JSON come stringa
}

function buildSqlInsert() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`';
  const values = rows.map((r) =>
    '(' + cols.map((c) => (has.has(key(r, c)) ? sqlLiteral(cellRaw(r, c)) : 'NULL')).join(', ') + ')'
  );
  return `INSERT INTO ${ident(state.coll || 'tabella')} (${cols.map((c) => ident(state.columns[c])).join(', ')}) VALUES\n`
    + values.join(',\n') + ';';
}

function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function copyToClipboard(text) {
  const done = () => {
    const n = sel().cells.size;
    toast(n === 1 ? 'Cella copiata' : `${n} celle copiate`);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => toast('Copia non riuscita', true));
  } else {
    // Fallback per contesti senza API clipboard (es. http non-localhost).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  }
}

function inputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function gridVisible() {
  return !$('#view-data').classList.contains('hidden') && state.docs.length > 0;
}

// Selezione al mousedown, in base ai modificatori.
function selectFrom(cell, { shift, ctrl }) {
  const s = sel();
  if (shift && s.anchor) {
    s.cells = new Set(rectKeys(s.anchor, cell));
  } else if (ctrl) {
    const k = key(cell.r, cell.c);
    if (s.cells.has(k)) s.cells.delete(k);
    else s.cells.add(k);
    s.anchor = cell;
  } else {
    s.cells = new Set([key(cell.r, cell.c)]);
    s.anchor = cell;
  }
  s.focus = cell;
}

// --- Incolla da Excel -------------------------------------------------------

function parseClipboardGrid(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

// Converte il testo incollato provando a rispettare il tipo del valore
// attuale della cella (numero, data, bool, ObjectId...); altrimenti la
// semantica è quella dell'editor inline generico (parseEdited).
function coercePasted(current, text) {
  const type = valueType(current);
  const t = text.trim();
  if (type === 'number' && t !== '' && !Number.isNaN(Number(t))) return Number(t);
  if (type === 'decimal' && t !== '' && !Number.isNaN(Number(t))) return { $numberDecimal: t };
  if (type === 'bool') {
    if (['true', '1', 'sì', 'si', 'vero'].includes(t.toLowerCase())) return true;
    if (['false', '0', 'no', 'falso'].includes(t.toLowerCase())) return false;
  }
  if (type === 'date') {
    const d = new Date(t);
    if (t !== '' && !Number.isNaN(d.getTime())) return { $date: d.toISOString() };
  }
  if (type === 'oid' && /^[0-9a-fA-F]{24}$/.test(t)) return { $oid: t };
  return parseEdited(text);
}

// Incolla una griglia TSV (formato appunti di Excel) a partire dall'angolo in
// alto a sinistra della selezione, aggiornando i documenti sottostanti.
function pasteIntoGrid(text) {
  const grid = parseClipboardGrid(text || '');
  if (!grid.length) return;
  if ($('#query-mode').value === 'aggregate') {
    toast('Incolla non disponibile in modalità aggregate/SQL Raw', true);
    return;
  }
  const s = sel();
  const { rows: selRows, cols: selCols } = selectionGrid();
  const start = selRows.length ? { r: selRows[0], c: selCols[0] } : s.focus;
  if (!start) {
    toast('Seleziona prima la cella di partenza', true);
    return;
  }

  const updates = [];
  let cellsCount = 0;
  let skipped = 0; // celle fuori pagina, su _id o su righe senza _id
  grid.forEach((line, i) => {
    const doc = state.docs[start.r + i];
    if (!doc || !('_id' in doc)) {
      skipped += line.length;
      return;
    }
    const set = {};
    let any = false;
    line.forEach((value, j) => {
      const col = state.columns[start.c + j];
      if (col === undefined || col === '_id') {
        skipped++;
        return;
      }
      set[col] = coercePasted(doc[col], value);
      any = true;
      cellsCount++;
    });
    if (any) updates.push({ id: idOf(doc), set });
  });

  if (!updates.length) {
    toast('Nessuna cella aggiornabile a partire da qui', true);
    return;
  }
  const docWord = state.dbType === 'mysql' ? 'righe' : 'documenti';
  let msg = `Incollare ${cellsCount} celle in ${updates.length} ${docWord}?`;
  if (skipped) msg += `\n(${skipped} celle verranno ignorate: fuori pagina o sulla colonna _id)`;
  if (!confirm(msg)) return;

  Promise.allSettled(updates.map((u) =>
    emit('doc:update', { db: state.db, coll: state.coll, id: u.id, set: u.set })
  )).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) toast(`${results.length - failed.length} aggiornati, ${failed.length} falliti: ${failed[0].reason.message}`, true);
    else toast(`${cellsCount} celle incollate in ${updates.length} ${docWord}`);
    // Lascia selezionata l'area incollata (ri-applicata dal render di runQuery).
    const width = Math.max(...grid.map((l) => l.length));
    s.anchor = { r: start.r, c: start.c };
    s.focus = {
      r: Math.min(start.r + grid.length - 1, state.docs.length - 1),
      c: Math.min(start.c + width - 1, state.columns.length - 1),
    };
    s.cells = new Set(rectKeys(s.anchor, s.focus));
    runQuery();
  });
}

// --- Selezione di intere colonne dall'header --------------------------------

function selectColumn(c, { ctrl, shift }) {
  const s = sel();
  const lastRow = state.docs.length - 1;
  if (lastRow < 0) return;
  const colKeys = rectKeys({ r: 0, c }, { r: lastRow, c });
  if (shift && s.anchor) {
    s.cells = new Set(rectKeys(
      { r: 0, c: Math.min(s.anchor.c, c) },
      { r: lastRow, c: Math.max(s.anchor.c, c) }
    ));
  } else if (ctrl) {
    // Toggle: se la colonna è già tutta selezionata la deseleziona.
    if (colKeys.every((k) => s.cells.has(k))) colKeys.forEach((k) => s.cells.delete(k));
    else colKeys.forEach((k) => s.cells.add(k));
    s.anchor = { r: 0, c };
  } else {
    s.cells = new Set(colKeys);
    s.anchor = { r: 0, c };
  }
  s.focus = { r: 0, c };
}

function focusCellIntoView() {
  const f = sel().focus;
  if (!f) return;
  const td = document.querySelector(`#grid tbody td[data-r="${f.r}"][data-c="${f.c}"]`);
  td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function initCellSelect() {
  const tbody = $('#grid tbody');

  let dragging = false;
  let dragBase = null; // celle già selezionate prima del drag (Ctrl+trascina = aggiunge)

  tbody.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest('td[data-c]');
    if (!td || td.classList.contains('editing')) return;
    const cell = cellFromTd(td);
    const ctrl = e.ctrlKey || e.metaKey;
    selectFrom(cell, { shift: e.shiftKey, ctrl });
    dragging = true;
    dragBase = ctrl ? new Set(sel().cells) : null;
    applyCellSelection();
  });

  tbody.addEventListener('mouseover', (e) => {
    if (!dragging) return;
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    const s = sel();
    if (!s.anchor) return;
    const cell = cellFromTd(td);
    s.focus = cell;
    const rect = rectKeys(s.anchor, cell);
    s.cells = dragBase ? new Set([...dragBase, ...rect]) : new Set(rect);
    applyCellSelection();
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    dragBase = null;
  });

  // Ctrl/Shift+click sull'header: selezione dell'intera colonna (il click
  // semplice continua a ordinare, vedi renderGrid).
  $('#grid thead').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const th = e.target.closest('th[data-c]');
    if (!th) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.shiftKey) return;
    e.preventDefault();
    selectColumn(Number(th.dataset.c), { ctrl, shift: e.shiftKey });
    applyCellSelection();
  });

  tbody.addEventListener('contextmenu', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    e.preventDefault();
    const cell = cellFromTd(td);
    // Tasto destro fuori dalla selezione: seleziona la cella cliccata.
    if (!sel().cells.has(key(cell.r, cell.c))) {
      selectFrom(cell, { shift: false, ctrl: false });
      applyCellSelection();
    }
    const { x, y } = { x: e.clientX, y: e.clientY };
    // Sotto-menu drill-down: riapre il menu contestuale con i formati.
    // (setTimeout: il click che chiude il menu padre non deve chiudere anche questo)
    const advanced = () => setTimeout(() => showContextMenu(x, y, [
      { label: 'JSON', action: () => copyToClipboard(buildJson()) },
      { label: 'CSV (con intestazioni)', action: () => copyToClipboard(buildCsv(true)) },
      { label: 'TSV con intestazioni', action: () => copyToClipboard(buildTsv(true)) },
      { label: 'Markdown', action: () => copyToClipboard(buildMarkdown()) },
      { label: 'SQL INSERT (MySQL)', action: () => copyToClipboard(buildSqlInsert()) },
    ]), 0);
    showContextMenu(x, y, [
      { label: 'Copia (Ctrl+C)', action: () => copyToClipboard(buildTsv(false)) },
      { label: 'Copia con intestazioni', action: () => copyToClipboard(buildTsv(true)) },
      { label: 'Copia avanzato ▸', action: advanced },
      '---',
      {
        label: 'Incolla (Ctrl+V)',
        action: () => navigator.clipboard?.readText
          ? navigator.clipboard.readText().then(pasteIntoGrid).catch(() => toast('Appunti non accessibili: usa Ctrl+V', true))
          : toast('Appunti non accessibili: usa Ctrl+V', true),
      },
      '---',
      { label: 'Esporta selezione in CSV…', action: () => downloadFile(`${state.coll || 'selezione'}.csv`, buildCsv(true), 'text/csv') },
    ]);
  });

  // Incolla da Excel: l'evento 'paste' dà accesso agli appunti senza permessi.
  document.addEventListener('paste', (e) => {
    if (inputFocused() || !gridVisible()) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    pasteIntoGrid(text);
  });

  document.addEventListener('keydown', (e) => {
    if (inputFocused() || !gridVisible()) return;
    const s = sel();

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      // Una selezione di testo nativa (es. nella statusbar) ha la precedenza.
      if (s.cells.size === 0 || !document.getSelection().isCollapsed) return;
      e.preventDefault();
      copyToClipboard(buildTsv(false));
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      s.cells = new Set(rectKeys({ r: 0, c: 0 }, { r: state.docs.length - 1, c: state.columns.length - 1 }));
      s.anchor = { r: 0, c: 0 };
      s.focus = { r: state.docs.length - 1, c: state.columns.length - 1 };
      applyCellSelection();
      return;
    }

    if (e.key === 'Escape' && s.cells.size > 0) {
      clearCellSelection();
      applyCellSelection();
      return;
    }

    const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key in deltas && s.focus) {
      e.preventDefault();
      const [dr, dc] = deltas[e.key];
      const next = {
        r: Math.min(Math.max(s.focus.r + dr, 0), state.docs.length - 1),
        c: Math.min(Math.max(s.focus.c + dc, 0), state.columns.length - 1),
      };
      if (e.shiftKey && s.anchor) {
        s.focus = next;
        s.cells = new Set(rectKeys(s.anchor, next));
      } else {
        selectFrom(next, { shift: false, ctrl: false });
      }
      applyCellSelection();
      focusCellIntoView();
    }
  });
}
