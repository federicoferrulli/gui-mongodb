import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, displayValue, idOf, toast, showQueryError } from './utils.js';
import { setView } from './main.js';
import { startWatch } from './live.js';
import { startEdit, openEditDoc } from './inlineEdit.js';
import { attachAutocomplete } from './autocomplete.js';

export function applyDbTypeToWorkspace() {
  const isMysql = state.dbType === 'mysql';
  // Fix per non usare l'indice magico
  const aggOpt = $('#query-mode').querySelector('option[value="aggregate"]');
  if (aggOpt) aggOpt.textContent = isMysql ? 'SQL Raw' : 'aggregate';
  
  $('#uml-hint').innerHTML = isMysql
    ? 'Relazioni dalle <b>foreign key</b> dichiarate, più quelle dedotte dai nomi delle colonne (es. <code>user_id</code> → tabella <code>users</code>).'
    : 'Associazioni dedotte dai nomi dei campi (es. <code>user_id</code> → collection <code>users</code>) e dai tipi ObjectId su un campione di documenti.';
  applyQueryPlaceholders();
}

export function applyQueryPlaceholders() {
  const isMysql = state.dbType === 'mysql';
  const aggregate = $('#query-mode').value === 'aggregate';
  if (isMysql) {
    $('#filter-input').placeholder = aggregate
      ? 'Query SQL, es. SELECT city, COUNT(*) AS n FROM users GROUP BY city'
      : 'Clausola WHERE, es. age > 30';
    $('#sort-input').placeholder = 'Ordinamento, es. name ASC oppure {"name":1}';
  } else {
    $('#filter-input').placeholder = aggregate
      ? 'Pipeline, es. [ { "$group": { "_id": "$city", "n": { "$sum": 1 } } } ]'
      : 'Filtro, es. { "age": { "$gt": 30 } }';
    $('#sort-input').placeholder = 'Sort, es. { "name": 1 }';
  }
  $('#sort-input').classList.toggle('hidden', aggregate);
}

export function selectCollection(dbName, collName, labelEl) {
  document.querySelectorAll('.node-label.selected').forEach((el) => el.classList.remove('selected'));
  if (labelEl) labelEl.classList.add('selected');

  state.db = dbName;
  state.coll = collName;
  state.skip = 0;
  $('#filter-input').value = '';
  $('#sort-input').value = '';
  $('#query-mode').value = 'find';
  applyQueryPlaceholders();
  $('#breadcrumb').textContent = `${dbName} ▸ ${collName}`;
  $('#placeholder').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  setView('data');

  runQuery();
  startWatch();
}

export function runQuery() {
  if (!state.db || !state.coll) return;
  showQueryError(null);
  const mode = $('#query-mode').value;

  const payload = mode === 'aggregate'
    ? {
        db: state.db,
        coll: state.coll,
        pipeline: $('#filter-input').value || '[]',
      }
    : {
        db: state.db,
        coll: state.coll,
        filter: $('#filter-input').value,
        sort: $('#sort-input').value,
        limit: $('#page-size').value,
        skip: state.skip,
      };

  emit(`collection:${mode}`, payload).then((res) => {
    state.docs = res.docs;
    state.columns = res.columns;
    state.total = res.total;
    state.skip = res.skip;
    state.limit = res.limit;
    renderGrid();
  }).catch((err) => showQueryError(err.message));
}

export function renderGrid() {
  const thead = $('#grid thead');
  const tbody = $('#grid tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  const headRow = document.createElement('tr');
  const actionsTh = document.createElement('th');
  actionsTh.className = 'grid-actions-col';
  headRow.appendChild(actionsTh);

  let currentSort = {};
  try { currentSort = JSON.parse($('#sort-input').value || '{}'); } catch { /* ignore */ }

  for (const col of state.columns) {
    const th = document.createElement('th');
    const dir = currentSort[col];
    th.textContent = col + (dir === 1 ? ' ▲' : dir === -1 ? ' ▼' : '');
    th.title = 'Clicca per ordinare';
    th.addEventListener('click', () => {
      const next = dir === 1 ? -1 : 1;
      $('#sort-input').value = JSON.stringify({ [col]: next });
      state.skip = 0;
      runQuery();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  for (const doc of state.docs) {
    const tr = document.createElement('tr');

    const actions = document.createElement('td');
    actions.className = 'row-actions';
    if ('_id' in doc) {
      const edit = document.createElement('button');
      edit.className = 'edit-btn';
      edit.textContent = '✎';
      edit.title = 'Modifica documento (riga intera)';
      edit.addEventListener('click', () => openEditDoc(doc));
      actions.appendChild(edit);

      const del = document.createElement('button');
      del.className = 'del-btn';
      del.textContent = '✕';
      del.title = 'Elimina documento';
      del.addEventListener('click', () => deleteDoc(doc));
      actions.appendChild(del);
    }
    tr.appendChild(actions);

    for (const col of state.columns) {
      const td = document.createElement('td');
      const { text, cls } = displayValue(doc[col]);
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = doc[col] === undefined ? '' : text;
      td.title = text;
      td.appendChild(span);

      if (col !== '_id' && '_id' in doc) {
        td.classList.add('editable');
        td.addEventListener('dblclick', () => startEdit(td, doc, col));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const from = state.total === 0 ? 0 : state.skip + 1;
  const to = Math.min(state.skip + state.docs.length, state.skip + state.limit);
  const docWord = state.dbType === 'mysql' ? 'righe' : 'documenti';
  
  $('#result-info').textContent = `${state.total} ${docWord} — ${state.docs.length} mostrati`;
  $('#page-info').textContent = `${from}–${Math.min(to, state.total) || state.docs.length}`;
  $('#prev-btn').disabled = state.skip === 0;
  $('#next-btn').disabled = state.skip + state.limit >= state.total;
}

export function deleteDoc(doc) {
  const { text } = displayValue(doc._id);
  if (!confirm(`Eliminare il documento con _id = ${text}?`)) return;
  emit('doc:delete', {
    db: state.db,
    coll: state.coll,
    id: idOf(doc),
  }).then(() => {
    toast('Documento eliminato');
    runQuery();
  }).catch((err) => toast(err.message, true));
}

export function initGrid() {
  $('#run-btn').addEventListener('click', () => { state.skip = 0; runQuery(); });
  $('#refresh-btn').addEventListener('click', runQuery);

  attachAutocomplete($('#filter-input'));
  attachAutocomplete($('#sort-input'), { keywords: false });

  for (const sel of ['#filter-input', '#sort-input']) {
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.skip = 0;
        runQuery();
      }
    });
  }

  $('#query-mode').addEventListener('change', applyQueryPlaceholders);

  $('#prev-btn').addEventListener('click', () => {
    state.skip = Math.max(0, state.skip - state.limit);
    runQuery();
  });

  $('#next-btn').addEventListener('click', () => {
    if (state.skip + state.limit < state.total) {
      state.skip += state.limit;
      runQuery();
    }
  });

  $('#page-size').addEventListener('change', () => {
    state.skip = 0;
    runQuery();
  });
}
