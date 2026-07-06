import { state } from './state.js';
import { $, emit, displayValue, idOf, toast, showQueryError } from './utils.js';
import { openCollTab } from './colltabs.js';
import { startEdit, openEditDoc } from './inlineEdit.js';
import { attachAutocomplete } from './autocomplete.js';
import { applyCellSelection, clearCellSelection } from './cellselect.js';

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

// Apre la collection in un coll-tab (o attiva quello già aperto).
export function selectCollection(dbName, collName) {
  openCollTab(dbName, collName);
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
    // Mantiene selezionati solo i documenti ancora presenti nella pagina:
    // la selezione sopravvive ai refresh (live/polling) ma si svuota al
    // cambio di pagina o di filtro.
    const visible = new Set(res.docs.filter((d) => '_id' in d).map(idOf));
    for (const id of [...state.selectedDocs]) {
      if (!visible.has(id)) state.selectedDocs.delete(id);
    }
    renderGrid();
  }).catch((err) => showQueryError(err.message));
}

export function renderGrid() {
  const thead = $('#grid thead');
  const tbody = $('#grid tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // In aggregate/SQL Raw i risultati non sono documenti reali (es. output di
  // $group): niente selezione né bulk delete, gli _id sarebbero fuorvianti.
  const canSelect = $('#query-mode').value !== 'aggregate';

  const headRow = document.createElement('tr');
  const selectTh = document.createElement('th');
  selectTh.className = 'grid-select-col';
  if (canSelect && state.docs.some((d) => '_id' in d)) {
    const checkAll = document.createElement('input');
    checkAll.type = 'checkbox';
    checkAll.title = 'Seleziona/deseleziona tutti i documenti della pagina';

    // Sincronizza lo stato del checkbox con le selezioni attuali
    const docsWithId = state.docs.filter(d => '_id' in d);
    checkAll.checked = docsWithId.length > 0 && docsWithId.every(doc => state.selectedDocs.has(idOf(doc)));
    checkAll.indeterminate = !checkAll.checked && docsWithId.some(doc => state.selectedDocs.has(idOf(doc)));

    checkAll.addEventListener('change', () => {
      checkAll.indeterminate = false;
      if (checkAll.checked) {
        state.docs.forEach((doc) => {
          if ('_id' in doc) state.selectedDocs.add(idOf(doc));
        });
      } else {
        state.docs.forEach((doc) => {
          if ('_id' in doc) state.selectedDocs.delete(idOf(doc));
        });
      }
      document.querySelectorAll('#grid tbody tr td.grid-select-col input[type="checkbox"]').forEach(cb => {
        cb.checked = checkAll.checked;
      });
      updateBulkDeleteUI();
    });
    selectTh.appendChild(checkAll);
  }
  headRow.appendChild(selectTh);

  const actionsTh = document.createElement('th');
  actionsTh.className = 'grid-actions-col';
  headRow.appendChild(actionsTh);

  let currentSort = {};
  try { currentSort = JSON.parse($('#sort-input').value || '{}'); } catch { /* ignore */ }

  state.columns.forEach((col, colIdx) => {
    const th = document.createElement('th');
    th.dataset.c = colIdx; // per la selezione di colonna (cellselect.js)
    const dir = currentSort[col];
    th.textContent = col + (dir === 1 ? ' ▲' : dir === -1 ? ' ▼' : '');
    th.title = 'Clicca per ordinare, Ctrl+clic per selezionare la colonna';
    th.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return; // selezione colonna, non sort
      const next = dir === 1 ? -1 : 1;
      $('#sort-input').value = JSON.stringify({ [col]: next });
      state.skip = 0;
      runQuery();
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  state.docs.forEach((doc, rowIdx) => {
    const tr = document.createElement('tr');

    const selectTd = document.createElement('td');
    selectTd.className = 'grid-select-col';
    if (canSelect && '_id' in doc) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const docId = idOf(doc);
      checkbox.checked = state.selectedDocs.has(docId);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.selectedDocs.add(docId);
        } else {
          state.selectedDocs.delete(docId);
        }
        // Sincronizza il checkbox "select all"
        const docsWithId = state.docs.filter(d => '_id' in d);
        const allSelected = docsWithId.length > 0 && docsWithId.every(d => state.selectedDocs.has(idOf(d)));
        const selectAllCheckbox = document.querySelector('#grid thead th.grid-select-col input[type="checkbox"]');
        if (selectAllCheckbox) {
          selectAllCheckbox.checked = allSelected;
          selectAllCheckbox.indeterminate = !allSelected && docsWithId.some((d) => state.selectedDocs.has(idOf(d)));
        }
        updateBulkDeleteUI();
      });
      selectTd.appendChild(checkbox);
    }
    tr.appendChild(selectTd);

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

    state.columns.forEach((col, colIdx) => {
      const td = document.createElement('td');
      // Coordinate per la selezione celle stile Excel (vedi cellselect.js).
      td.dataset.r = rowIdx;
      td.dataset.c = colIdx;
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
    });
    tbody.appendChild(tr);
  });

  const from = state.total === 0 ? 0 : state.skip + 1;
  const to = Math.min(state.skip + state.docs.length, state.skip + state.limit);
  const docWord = state.dbType === 'mysql' ? 'righe' : 'documenti';

  $('#result-info').textContent = `${state.total} ${docWord} — ${state.docs.length} mostrati`;
  $('#page-info').textContent = `${from}–${Math.min(to, state.total) || state.docs.length}`;
  $('#prev-btn').disabled = state.skip === 0;
  $('#next-btn').disabled = state.skip + state.limit >= state.total;

  $('.bulk-delete-toolbar').classList.toggle('hidden', !canSelect || state.total === 0);
  updateBulkDeleteUI();
  applyCellSelection();
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

export function deleteSelectedDocs() {
  // Elimina solo i documenti realmente presenti in pagina: protegge da
  // selezioni rimaste orfane dopo un refresh o un cambio di risultati.
  const visible = new Set(state.docs.filter((d) => '_id' in d).map(idOf));
  const ids = [...state.selectedDocs].filter((id) => visible.has(id));
  if (ids.length === 0) {
    toast('Nessun documento selezionato', true);
    return;
  }
  if (!confirm(`Eliminare i ${ids.length} documenti selezionati? Questa azione non si può annullare.`)) return;

  Promise.allSettled(ids.map((id) =>
    emit('doc:delete', {
      db: state.db,
      coll: state.coll,
      id,
    })
  )).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    const ok = results.length - failed.length;
    state.selectedDocs.clear();
    if (failed.length) toast(`${ok} eliminati, ${failed.length} non eliminati: ${failed[0].reason.message}`, true);
    else toast(`${ok} documenti eliminati`);
    runQuery();
  });
}

export function deleteAllWithFilter() {
  if ($('#query-mode').value === 'aggregate') return; // solo in modalità find
  const filter = $('#filter-input').value.trim();
  const total = state.total;
  const isMysql = state.dbType === 'mysql';
  if (total === 0) {
    toast(isMysql ? 'Nessuna riga da eliminare' : 'Nessun documento da eliminare', true);
    return;
  }
  const msg = filter
    ? `Eliminare ${isMysql ? `le ${total} righe` : `i ${total} documenti`} con questo filtro? Questa azione non si può annullare.`
    : `Nessun filtro impostato: eliminare ${isMysql ? `TUTTE le ${total} righe` : `TUTTI i ${total} documenti`} di "${state.coll}"? Questa azione non si può annullare.`;
  if (!confirm(msg)) return;

  emit('collection:deleteMany', {
    db: state.db,
    coll: state.coll,
    filter,
  }).then((res) => {
    state.selectedDocs.clear();
    toast(isMysql ? `${res.deleted} righe eliminate` : `${res.deleted} documenti eliminati`);
    runQuery();
  }).catch((err) => toast(err.message, true));
}

export function updateBulkDeleteUI() {
  const selected = state.selectedDocs.size;
  const deleteSelectedBtn = $('#delete-selected-btn');
  const deleteAllBtn = $('#delete-all-btn');

  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = selected === 0;
    deleteSelectedBtn.textContent = `🗑 Elimina (${selected})`;
  }

  if (deleteAllBtn) {
    deleteAllBtn.disabled = state.total === 0;
  }
}

export function initGrid() {
  $('#run-btn').addEventListener('click', () => { state.skip = 0; clearCellSelection(); runQuery(); });
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
    state.selectedDocs.clear(); // reset selezione al cambio pagina
    clearCellSelection();
    runQuery();
  });

  $('#next-btn').addEventListener('click', () => {
    if (state.skip + state.limit < state.total) {
      state.skip += state.limit;
      state.selectedDocs.clear(); // reset selezione al cambio pagina
      clearCellSelection();
      runQuery();
    }
  });

  $('#page-size').addEventListener('change', () => {
    state.skip = 0;
    clearCellSelection();
    runQuery();
  });

  $('#delete-selected-btn').addEventListener('click', deleteSelectedDocs);
  $('#delete-all-btn').addEventListener('click', deleteAllWithFilter);
}
