import { state } from './state.js';
import { $, emit, showContextMenu, toast } from './utils.js';
import { setView } from './main.js'; // or grid.js
import { selectCollection } from './grid.js';
import { openCreateColl, openCreateDb, renameDb, dropDb, renameColl, dropColl } from './schema-ops.js';
import { exportImportMenuItems } from './exportimport.js';

export function collWord(capital) {
  const w = state.dbType === 'mysql' ? 'tabella' : 'collection';
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

export function renderDbTree(databases) {
  state.databases = databases; // cache per il ri-render al cambio tab
  const tree = $('#db-tree');
  tree.innerHTML = '';
  for (const db of databases) {
    const li = document.createElement('li');
    li.className = 'db';
    const label = document.createElement('div');
    label.className = 'node-label';
    label.textContent = db.name;
    li.appendChild(label);

    const sub = document.createElement('ul');
    sub.classList.add('hidden');
    li.appendChild(sub);

    label.addEventListener('click', () => {
      if (!sub.classList.contains('hidden')) {
        sub.classList.add('hidden');
        state.expandedDbs.delete(db.name);
        return;
      }
      sub.classList.remove('hidden');
      state.expandedDbs.add(db.name);
      if (sub.childElementCount === 0) loadCollections(db.name, sub);
    });

    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: `＋ Nuova ${collWord()}…`, action: () => openCreateColl(db.name) },
        { label: '＋ Nuovo database…', action: openCreateDb },
        { label: '✎ Rinomina database…', action: () => renameDb(db.name) },
        { label: '⟳ Aggiorna elenco', action: refreshDbTree },
        '---',
        { label: '🗑 Elimina database…', danger: true, action: () => dropDb(db.name) },
      ]);
    });

    if (db.collections) {
      sub.classList.remove('hidden');
      state.expandedDbs.add(db.name);
      renderCollectionsList(db.name, sub, db.collections);
    } else {
      if (state.expandedDbs.has(db.name)) {
        sub.classList.remove('hidden');
        loadCollections(db.name, sub);
      }
    }

    tree.appendChild(li);
  }
}

export function renderCollectionsList(dbName, container, collections) {
  container.innerHTML = '';
  for (const coll of collections) {
    const li = document.createElement('li');
    li.className = 'coll';
    const label = document.createElement('div');
    label.className = 'node-label';

    const name = document.createElement('span');
    name.textContent = coll.name;
    label.appendChild(name);
    label.dataset.db = dbName;
    label.dataset.coll = coll.name;
    if (dbName === state.db && coll.name === state.coll) label.classList.add('selected');

    if (coll.count !== null && coll.count !== undefined) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = coll.count;
      label.appendChild(count);
    }

    label.addEventListener('click', () => selectCollection(dbName, coll.name, label));
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '▤ Apri dati', action: () => selectCollection(dbName, coll.name, label) },
        { label: `ℹ Dettagli ${collWord()}`, action: () => { selectCollection(dbName, coll.name, label); setView('details'); } },
        { label: '◫ Diagramma UML', action: () => { selectCollection(dbName, coll.name, label); setView('uml'); } },
        '---',
        ...exportImportMenuItems(dbName, coll.name),
        '---',
        { label: `✎ Rinomina ${collWord()}…`, action: () => renameColl(dbName, coll.name) },
        { label: `🗑 Elimina ${collWord()}…`, danger: true, action: () => dropColl(dbName, coll.name) },
      ]);
    });
    li.appendChild(label);
    container.appendChild(li);
  }
}

export function loadCollections(dbName, container) {
  container.innerHTML = '<li class="node-label loading">caricamento…</li>';
  emit('db:collections', { db: dbName }).then((res) => {
    renderCollectionsList(dbName, container, res.collections);
  }).catch((err) => {
    container.innerHTML = '';
    toast(err.message, true);
  });
}

export function refreshDbTree() {
  emit('db:list', {}).then((res) => {
    renderDbTree(res.databases);
  }).catch((err) => toast(err.message, true));
}

export function initDbTree() {
  $('#sidebar').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.node-label') || e.target.closest('.sidebar-search')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: '＋ Nuovo database…', action: openCreateDb },
      { label: '⟳ Aggiorna elenco', action: refreshDbTree },
    ]);
  });
  $('#new-db-btn').addEventListener('click', openCreateDb);

  let searchTimer = null;
  $('#db-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!q) {
        refreshDbTree();
        return;
      }
      $('#db-tree').innerHTML = '<li class="node-label loading">ricerca in corso…</li>';
      emit('db:search', { query: q }).then((res) => {
        renderDbTree(res.databases);
      }).catch((err) => toast(err.message, true));
    }, 300);
  });
}
