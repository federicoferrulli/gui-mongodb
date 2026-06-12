'use strict';

/* global io */

const socket = io();

const $ = (sel) => document.querySelector(sel);

const state = {
  connected: false,
  connLabel: '',
  dbType: 'mongodb',     // 'mongodb' | 'mysql' (dal server alla connessione)
  db: null,
  coll: null,
  skip: 0,
  limit: 50,
  total: 0,
  docs: [],      // documenti in formato Extended JSON (strict)
  columns: [],
  liveTimer: null,
  view: 'data',          // 'data' | 'details' | 'uml'
  expandedDbs: new Set(), // db espansi nella sidebar (preservati al refresh)
  editingDoc: null,       // documento aperto nella modale di modifica riga
  dbSchema: null,         // cache dello schema per la vista UML
  dbSchemaFor: null,      // db a cui si riferisce la cache
};

/* ===========================================================================
 * Helpers per la visualizzazione dei valori Extended JSON
 * ========================================================================= */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Ritorna { text, cls } per la cella della tabella.
function displayValue(v) {
  if (v === null || v === undefined) return { text: 'null', cls: 'type-null' };
  if (typeof v === 'string') return { text: v, cls: '' };
  if (typeof v === 'number') return { text: String(v), cls: 'type-num' };
  if (typeof v === 'boolean') return { text: String(v), cls: 'type-bool' };
  if (Array.isArray(v)) return { text: JSON.stringify(v.map(simplify)), cls: 'type-obj' };

  if (isPlainObject(v)) {
    if ('$oid' in v) return { text: v.$oid, cls: 'type-oid' };
    if ('$date' in v) {
      const d = isPlainObject(v.$date) ? Number(v.$date.$numberLong) : v.$date;
      return { text: new Date(d).toISOString(), cls: 'type-date' };
    }
    if ('$numberInt' in v) return { text: v.$numberInt, cls: 'type-num' };
    if ('$numberLong' in v) return { text: v.$numberLong, cls: 'type-num' };
    if ('$numberDouble' in v) return { text: v.$numberDouble, cls: 'type-num' };
    if ('$numberDecimal' in v) return { text: v.$numberDecimal, cls: 'type-num' };
    if ('$binary' in v) return { text: `Binary(${v.$binary.subType})`, cls: 'type-obj' };
    return { text: JSON.stringify(simplify(v)), cls: 'type-obj' };
  }
  return { text: String(v), cls: '' };
}

// Versione "rilassata" di un valore EJSON, per JSON.stringify leggibile.
function simplify(v) {
  if (Array.isArray(v)) return v.map(simplify);
  if (isPlainObject(v)) {
    if ('$oid' in v) return v.$oid;
    if ('$date' in v) return displayValue(v).text;
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v || '$numberDecimal' in v) {
      return Number(Object.values(v)[0]);
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = simplify(val);
    return out;
  }
  return v;
}

// Tipo "editabile" di un valore EJSON: decide quale controllo usare
// nell'editing inline della cella (vedi startEdit).
function valueType(v) {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (isPlainObject(v)) {
    if ('$date' in v) return 'date';
    if ('$oid' in v) return 'oid';
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v) return 'number';
    if ('$numberDecimal' in v) return 'decimal';
  }
  return 'json'; // array, oggetti, binary, null/undefined: JSON libero
}

// Rappresentazione testuale usata quando si modifica una cella.
function editValue(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// Converte il testo digitato dall'utente in un valore EJSON da inviare.
function parseEdited(text) {
  const t = text.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t); // numeri, booleani, oggetti, EJSON come {"$date": ...}
  } catch {
    return text; // stringa semplice
  }
}

function idOf(doc) {
  return JSON.stringify(doc._id);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function cut(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

/* ===========================================================================
 * UI di base: toast, errori
 * ========================================================================= */

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showQueryError(msg) {
  const el = $('#query-error');
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

/* ===========================================================================
 * Menu contestuale
 * ========================================================================= */

// items: array di { label, action, danger? } oppure '---' come separatore.
function showContextMenu(x, y, items) {
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

function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

/* ===========================================================================
 * Connessione
 * ========================================================================= */

function selectConnTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-fields').classList.toggle('hidden', name !== 'fields');
  $('#tab-uri').classList.toggle('hidden', name !== 'uri');
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => selectConnTab(tab.dataset.tab))
);

// Adatta il form al tipo di database scelto: MySQL non ha authSource né URI,
// ma ha il database/schema iniziale e una porta di default diversa.
function applyDbTypeToForm() {
  const form = $('#connect-form');
  const isMysql = form.elements.dbType.value === 'mysql';
  $('#row-authsource').classList.toggle('hidden', isMysql);
  $('#row-database').classList.toggle('hidden', !isMysql);
  $('#tab-uri-btn').classList.toggle('hidden', isMysql);
  if (isMysql && !$('#tab-uri').classList.contains('hidden')) selectConnTab('fields');
  // Cambia la porta solo se è ancora quella di default dell'altro DBMS.
  const port = form.elements.port;
  if (isMysql && port.value === '27017') port.value = '3306';
  if (!isMysql && port.value === '3306') port.value = '27017';
}

$('#conn-dbtype').addEventListener('change', applyDbTypeToForm);

// Legge la configurazione dal form di connessione (tab attiva inclusa).
function readConnForm() {
  const form = $('#connect-form');
  const isMysql = form.elements.dbType.value === 'mysql';
  const usingUri = !isMysql && !$('#tab-uri').classList.contains('hidden');
  const cfg = usingUri
    ? { uri: form.elements.uri.value }
    : {
        host: form.elements.host.value,
        port: form.elements.port.value,
        username: form.elements.username.value,
        password: form.elements.password.value,
      };
  if (!usingUri) {
    if (isMysql) cfg.database = form.elements.database.value;
    else cfg.authSource = form.elements.authSource.value;
  }
  cfg.dbType = form.elements.dbType.value;
  cfg.saveAs = form.elements.saveAs.value;
  return cfg;
}

// Avvia la connessione (dal form oppure da una connessione salvata) e, se
// riesce, passa dal modale di connessione al layout principale.
function doConnect(cfg) {
  const btn = $('#connect-btn');
  btn.disabled = true;
  btn.textContent = 'Connessione…';
  $('#connect-error').classList.add('hidden');

  socket.emit('mongo:connect', cfg, (res) => {
    btn.disabled = false;
    btn.textContent = 'Connetti';
    if (!res.ok) {
      const err = $('#connect-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    state.connected = true;
    state.connLabel = res.label || '';
    state.dbType = res.dbType || 'mongodb';
    $('#conn-info').textContent = `${dbTypeIcon(state.dbType)} ${state.connLabel}`;
    $('#connect-overlay').classList.add('hidden');
    $('#app').classList.remove('hidden');
    applyDbTypeToWorkspace();
    if (cfg.saveAs) loadSavedConnections();
    renderDbTree(res.databases);
  });
}

function dbTypeIcon(dbType) {
  return dbType === 'mysql' ? '🐬' : '🍃';
}

// Adatta etichette e suggerimenti del workspace al DBMS connesso.
function applyDbTypeToWorkspace() {
  const isMysql = state.dbType === 'mysql';
  // La seconda voce del menu modalità: pipeline Mongo oppure SQL libero.
  $('#query-mode').options[1].textContent = isMysql ? 'SQL Raw' : 'aggregate';
  $('#uml-hint').innerHTML = isMysql
    ? 'Relazioni dalle <b>foreign key</b> dichiarate, più quelle dedotte dai nomi delle colonne (es. <code>user_id</code> → tabella <code>users</code>).'
    : 'Associazioni dedotte dai nomi dei campi (es. <code>user_id</code> → collection <code>users</code>) e dai tipi ObjectId su un campione di documenti.';
  applyQueryPlaceholders();
}

// Placeholder dei campi filtro/ordinamento in base a DBMS e modalità query.
function applyQueryPlaceholders() {
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

$('#connect-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = readConnForm();
  // In modifica con password lasciata vuota: il server riusa quella salvata.
  if (editingConn && !cfg.password) cfg.keepPasswordFrom = editingConn;
  doConnect(cfg);
});

/* ---------- Connessioni salvate (connections.ini lato server) ---------- */

let editingConn = null; // nome della connessione salvata in modifica nel form

function loadSavedConnections() {
  socket.emit('connections:list', {}, (res) => {
    if (res.ok) renderSavedConnections(res.connections);
  });
}

function renderSavedConnections(connections) {
  const list = $('#saved-conns');
  list.innerHTML = '';
  list.classList.toggle('hidden', !connections.length);
  $('#saved-conns-empty').classList.toggle('hidden', !!connections.length);
  $('#conn-export-btn').disabled = !connections.length;
  for (const conn of connections) {
    const li = document.createElement('li');
    li.title = `Connetti a "${conn.name}"`;

    const name = document.createElement('span');
    name.className = 'saved-conn-name';
    name.textContent = `${dbTypeIcon(conn.dbType)} ${conn.name}`;

    const label = document.createElement('span');
    label.className = 'saved-conn-label';
    label.textContent = conn.label;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit-btn';
    edit.title = 'Modifica la connessione salvata';
    edit.textContent = '✎';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditConn(conn.name);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.title = 'Elimina la connessione salvata';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Eliminare la connessione salvata "${conn.name}"?`)) return;
      socket.emit('connections:delete', { name: conn.name }, (res) => {
        if (!res.ok) return toast(res.error, true);
        if (editingConn === conn.name) cancelEditConn();
        loadSavedConnections();
      });
    });

    li.append(name, label, edit, del);
    // La password resta lato server: si invia solo il nome della connessione.
    li.addEventListener('click', () => doConnect({ saved: conn.name }));
    list.appendChild(li);
  }
}

/* ---------- Modifica di una connessione salvata ---------- */

function startEditConn(name) {
  socket.emit('connections:get', { name }, (res) => {
    if (!res.ok) return toast(res.error, true);
    const f = res.fields;
    const form = $('#connect-form');
    const isMysql = (f.dbType || 'mongodb') === 'mysql';
    form.elements.dbType.value = f.dbType || 'mongodb';
    selectConnTab(f.uri && !isMysql ? 'uri' : 'fields');
    form.elements.uri.value = f.uri || '';
    form.elements.host.value = f.host || 'localhost';
    form.elements.port.value = f.port || (isMysql ? '3306' : '27017');
    form.elements.username.value = f.username || '';
    form.elements.password.value = '';
    form.elements.password.placeholder = res.hasPassword ? '(invariata se lasciata vuota)' : '';
    form.elements.authSource.value = f.authSource || 'admin';
    form.elements.database.value = f.database || '';
    form.elements.saveAs.value = name;
    applyDbTypeToForm();
    editingConn = name;
    $('#conn-edit-name').textContent = name;
    $('#conn-edit-banner').classList.remove('hidden');
    $('#conn-save-btn').classList.remove('hidden');
    $('#connect-error').classList.add('hidden');
  });
}

function cancelEditConn() {
  editingConn = null;
  const form = $('#connect-form');
  form.reset();
  form.elements.password.placeholder = '';
  applyDbTypeToForm();
  $('#conn-edit-banner').classList.add('hidden');
  $('#conn-save-btn').classList.add('hidden');
}

$('#conn-edit-cancel').addEventListener('click', cancelEditConn);

// Salva (o rinomina) la connessione in modifica senza connettersi.
$('#conn-save-btn').addEventListener('click', () => {
  const cfg = readConnForm();
  const name = (cfg.saveAs || '').trim();
  if (!name) {
    const err = $('#connect-error');
    err.textContent = 'Indica un nome nel campo "Salva come".';
    err.classList.remove('hidden');
    return;
  }
  socket.emit('connections:save', { name, oldName: editingConn, cfg }, (res) => {
    if (!res.ok) {
      const err = $('#connect-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    toast(`Connessione "${name}" salvata`);
    cancelEditConn();
    loadSavedConnections();
  });
});

/* ---------- Import / export di connections.ini ---------- */

$('#conn-export-btn').addEventListener('click', () => {
  socket.emit('connections:export', {}, (res) => {
    if (!res.ok) return toast(res.error, true);
    const blob = new Blob([res.ini], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'connections.ini';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Connessioni esportate: il file contiene le password in chiaro');
  });
});

$('#conn-import-btn').addEventListener('click', () => $('#conn-import-file').click());

$('#conn-import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // permette di reimportare lo stesso file
  if (!file) return;
  file.text().then((ini) => {
    socket.emit('connections:import', { ini }, (res) => {
      if (!res.ok) return toast(res.error, true);
      const parts = [];
      if (res.imported) parts.push(`${res.imported} importate`);
      if (res.overwritten) parts.push(`${res.overwritten} sovrascritte`);
      toast(`Connessioni: ${parts.join(', ')}`);
      loadSavedConnections();
    });
  });
});

socket.on('connect', () => {
  if (!state.connected) loadSavedConnections();
});

$('#disconnect-btn').addEventListener('click', () => {
  socket.emit('mongo:disconnect', {}, () => {});
  location.reload();
});

socket.on('disconnect', () => {
  if (state.connected) toast('Connessione al server persa, riconnessione…', true);
});

/* ===========================================================================
 * Albero database / collection
 * ========================================================================= */

function renderDbTree(databases) {
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
        { label: '＋ Nuovo database…', action: openCreateDb },
        { label: '✎ Rinomina database…', action: () => renameDb(db.name) },
        { label: '⟳ Aggiorna elenco', action: refreshDbTree },
        '---',
        { label: '🗑 Elimina database…', danger: true, action: () => dropDb(db.name) },
      ]);
    });

    // Ripristina lo stato espanso dopo un refresh dell'albero.
    if (state.expandedDbs.has(db.name)) {
      sub.classList.remove('hidden');
      loadCollections(db.name, sub);
    }

    tree.appendChild(li);
  }
}

function loadCollections(dbName, container) {
  container.innerHTML = '<li class="node-label" style="color:var(--fg-dim)">caricamento…</li>';
  socket.emit('db:collections', { db: dbName }, (res) => {
    container.innerHTML = '';
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    for (const coll of res.collections) {
      const li = document.createElement('li');
      li.className = 'coll';
      const label = document.createElement('div');
      label.className = 'node-label';

      const name = document.createElement('span');
      name.textContent = coll.name;
      label.appendChild(name);

      if (coll.count !== null) {
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
          { label: 'ℹ Dettagli collection', action: () => { selectCollection(dbName, coll.name, label); setView('details'); } },
          { label: '◫ Diagramma UML', action: () => { selectCollection(dbName, coll.name, label); setView('uml'); } },
        ]);
      });
      li.appendChild(label);
      container.appendChild(li);
    }
  });
}

// Menu contestuale sulla parte vuota della sidebar.
$('#sidebar').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.node-label')) return; // gestito dai nodi
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, [
    { label: '＋ Nuovo database…', action: openCreateDb },
    { label: '⟳ Aggiorna elenco', action: refreshDbTree },
  ]);
});

function selectCollection(dbName, collName, labelEl) {
  document.querySelectorAll('.node-label.selected').forEach((el) => el.classList.remove('selected'));
  labelEl.classList.add('selected');

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

/* ===========================================================================
 * Gestione database (crea / rinomina / elimina)
 * ========================================================================= */

function refreshDbTree() {
  socket.emit('db:list', {}, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    renderDbTree(res.databases);
  });
}

function resetWorkspace() {
  socket.emit('collection:unwatch');
  state.db = null;
  state.coll = null;
  $('#workspace').classList.add('hidden');
  $('#placeholder').classList.remove('hidden');
  $('#live-badge').classList.add('hidden');
}

function openCreateDb() {
  const isMysql = state.dbType === 'mysql';
  $('#dbcreate-subtitle').textContent = isMysql
    ? 'In MySQL la prima tabella è facoltativa (verrà creata con una colonna id auto-incrementale).'
    : 'In MongoDB un database esiste solo se contiene almeno una collection.';
  $('#dbcreate-coll-label').textContent = isMysql ? 'Prima tabella' : 'Prima collection';
  $('#dbcreate-coll').placeholder = isMysql ? '(opzionale)' : 'collection1';
  $('#dbcreate-name').value = '';
  $('#dbcreate-coll').value = '';
  $('#dbcreate-error').classList.add('hidden');
  $('#dbcreate-overlay').classList.remove('hidden');
  $('#dbcreate-name').focus();
}

$('#new-db-btn').addEventListener('click', openCreateDb);
$('#dbcreate-cancel').addEventListener('click', () => $('#dbcreate-overlay').classList.add('hidden'));

$('#dbcreate-save').addEventListener('click', () => {
  const db = $('#dbcreate-name').value.trim();
  const coll = $('#dbcreate-coll').value.trim();
  socket.emit('db:create', { db, coll }, (res) => {
    if (!res.ok) {
      const err = $('#dbcreate-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#dbcreate-overlay').classList.add('hidden');
    toast(`Database "${db}" creato`);
    state.expandedDbs.add(db);
    refreshDbTree();
  });
});

for (const sel of ['#dbcreate-name', '#dbcreate-coll']) {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#dbcreate-save').click();
  });
}

function renameDb(name) {
  const input = prompt(`Nuovo nome per il database "${name}":\n(le collection verranno copiate nel nuovo database)`, name);
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === name) return;
  socket.emit('db:rename', { db: name, newName }, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    toast(`Database rinominato in "${newName}"`);
    state.expandedDbs.delete(name);
    state.expandedDbs.add(newName);
    if (state.db === name) {
      state.db = newName;
      state.dbSchema = null;
      state.dbSchemaFor = null;
      $('#breadcrumb').textContent = `${newName} ▸ ${state.coll}`;
      runQuery();
      startWatch();
    }
    refreshDbTree();
  });
}

function dropDb(name) {
  if (!confirm(`Eliminare il database "${name}" e TUTTI i suoi dati?\nL'operazione non è reversibile.`)) return;
  socket.emit('db:drop', { db: name }, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    toast(`Database "${name}" eliminato`);
    state.expandedDbs.delete(name);
    if (state.db === name) resetWorkspace();
    refreshDbTree();
  });
}

/* ===========================================================================
 * Tab di vista del workspace: Dati / Dettagli / UML
 * ========================================================================= */

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-data').classList.toggle('hidden', view !== 'data');
  $('#view-details').classList.toggle('hidden', view !== 'details');
  $('#view-uml').classList.toggle('hidden', view !== 'uml');
  if (view === 'details') loadDetails();
  if (view === 'uml') loadUml(false);
}

document.querySelectorAll('.view-tab').forEach((tab) =>
  tab.addEventListener('click', () => setView(tab.dataset.view))
);

/* ===========================================================================
 * Query ed esecuzione
 * ========================================================================= */

function runQuery() {
  if (!state.db || !state.coll) return;
  showQueryError(null);
  const mode = $('#query-mode').value;

  const done = (res) => {
    if (!res.ok) {
      showQueryError(res.error);
      return;
    }
    state.docs = res.docs;
    state.columns = res.columns;
    state.total = res.total;
    state.skip = res.skip;
    state.limit = res.limit;
    renderGrid();
  };

  if (mode === 'aggregate') {
    socket.emit('collection:aggregate', {
      db: state.db,
      coll: state.coll,
      pipeline: $('#filter-input').value || '[]',
    }, done);
  } else {
    socket.emit('collection:find', {
      db: state.db,
      coll: state.coll,
      filter: $('#filter-input').value,
      sort: $('#sort-input').value,
      limit: $('#page-size').value,
      skip: state.skip,
    }, done);
  }
}

$('#run-btn').addEventListener('click', () => { state.skip = 0; runQuery(); });
$('#refresh-btn').addEventListener('click', runQuery);

for (const sel of ['#filter-input', '#sort-input']) {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.skip = 0;
      runQuery();
    }
  });
}

$('#query-mode').addEventListener('change', applyQueryPlaceholders);

/* --------------------------- Paginazione --------------------------- */

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

/* ===========================================================================
 * Rendering della griglia
 * ========================================================================= */

function renderGrid() {
  const thead = $('#grid thead');
  const tbody = $('#grid tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // Intestazioni: click per ordinare
  const headRow = document.createElement('tr');
  const actionsTh = document.createElement('th');
  actionsTh.style.width = '56px';
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

  // Righe
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

  // Statusbar
  const from = state.total === 0 ? 0 : state.skip + 1;
  const to = Math.min(state.skip + state.docs.length, state.skip + state.limit);
  $('#result-info').textContent = `${state.total} documenti — ${state.docs.length} mostrati`;
  $('#page-info').textContent = `${from}–${Math.min(to, state.total) || state.docs.length}`;
  $('#prev-btn').disabled = state.skip === 0;
  $('#next-btn').disabled = state.skip + state.limit >= state.total;
}

/* ===========================================================================
 * Editing inline delle celle
 * ========================================================================= */

// Crea il controllo di editing adatto al tipo del valore corrente.
// Ritorna { input, original, buildValue } dove buildValue produce il valore
// EJSON da inviare al server (o lancia un Error con il messaggio per l'utente).
function buildEditor(current) {
  const type = valueType(current);

  if (type === 'date') {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.step = '0.001'; // millisecondi
    const raw = isPlainObject(current.$date) ? Number(current.$date.$numberLong) : current.$date;
    const d = new Date(raw);
    // Le date sono mostrate e inserite in UTC, come nella griglia.
    if (!Number.isNaN(d.getTime())) input.value = d.toISOString().slice(0, 23);
    return {
      input,
      original: input.value,
      buildValue: () => {
        const d2 = new Date(input.value + 'Z'); // input interpretato come UTC
        if (input.value === '' || Number.isNaN(d2.getTime())) throw new Error('Data non valida');
        return { $date: d2.toISOString() };
      },
    };
  }

  if (type === 'bool') {
    const input = document.createElement('select');
    for (const v of ['true', 'false']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      input.appendChild(opt);
    }
    input.value = String(current);
    return { input, original: input.value, buildValue: () => input.value === 'true' };
  }

  if (type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = displayValue(current).text;
    return {
      input,
      original: input.value,
      buildValue: () => {
        const n = Number(input.value);
        if (input.value.trim() === '' || Number.isNaN(n)) throw new Error('Numero non valido');
        return n;
      },
    };
  }

  if (type === 'decimal') {
    const input = document.createElement('input');
    input.value = current.$numberDecimal;
    return {
      input,
      original: input.value,
      // Decimal128 resta stringa per non perdere precisione.
      buildValue: () => ({ $numberDecimal: input.value.trim() }),
    };
  }

  if (type === 'oid') {
    const input = document.createElement('input');
    input.value = current.$oid;
    return {
      input,
      original: input.value,
      buildValue: () => {
        const t = input.value.trim();
        if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new Error('ObjectId non valido: servono 24 caratteri esadecimali');
        return { $oid: t };
      },
    };
  }

  // string e json: testo libero come prima (per cambiare tipo usare la modale ✎)
  const input = document.createElement('input');
  input.value = editValue(current);
  return { input, original: input.value, buildValue: () => parseEdited(input.value) };
}

function startEdit(td, doc, field) {
  if (td.classList.contains('editing')) return;
  const { input, original, buildValue } = buildEditor(doc[field]);

  td.classList.add('editing');
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();

  let finished = false;

  const cancel = () => {
    if (finished) return;
    finished = true;
    renderGrid();
  };

  const save = () => {
    if (finished) return;
    finished = true;
    if (input.value === original) {
      renderGrid();
      return;
    }
    let value;
    try {
      value = buildValue();
    } catch (err) {
      toast(err.message, true);
      renderGrid();
      return;
    }
    socket.emit('doc:update', {
      db: state.db,
      coll: state.coll,
      id: idOf(doc),
      set: { [field]: value },
    }, (res) => {
      if (!res.ok) {
        toast(res.error, true);
        renderGrid();
        return;
      }
      toast(`Campo "${field}" aggiornato`);
      runQuery();
    });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', save);
  if (input.tagName === 'SELECT') input.addEventListener('change', save);
}

/* ===========================================================================
 * Modifica della riga intera (modale JSON)
 * ========================================================================= */

function openEditDoc(doc) {
  state.editingDoc = doc;
  const copy = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== '_id') copy[k] = v;
  }
  $('#editdoc-id').textContent = `_id: ${displayValue(doc._id).text} (non modificabile)`;
  $('#editdoc-json').value = JSON.stringify(copy, null, 2);
  $('#editdoc-error').classList.add('hidden');
  $('#editdoc-overlay').classList.remove('hidden');
  $('#editdoc-json').focus();
}

$('#editdoc-cancel').addEventListener('click', () => $('#editdoc-overlay').classList.add('hidden'));

$('#editdoc-save').addEventListener('click', () => {
  if (!state.editingDoc) return;
  socket.emit('doc:replace', {
    db: state.db,
    coll: state.coll,
    id: idOf(state.editingDoc),
    doc: $('#editdoc-json').value,
  }, (res) => {
    if (!res.ok) {
      const err = $('#editdoc-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#editdoc-overlay').classList.add('hidden');
    toast('Documento aggiornato');
    runQuery();
  });
});

/* ===========================================================================
 * Inserimento / eliminazione documenti
 * ========================================================================= */

$('#insert-btn').addEventListener('click', () => {
  $('#insert-json').value = '{\n  \n}';
  $('#insert-error').classList.add('hidden');
  $('#insert-overlay').classList.remove('hidden');
  $('#insert-json').focus();
});

$('#insert-cancel').addEventListener('click', () => $('#insert-overlay').classList.add('hidden'));

$('#insert-save').addEventListener('click', () => {
  socket.emit('doc:insert', {
    db: state.db,
    coll: state.coll,
    doc: $('#insert-json').value,
  }, (res) => {
    if (!res.ok) {
      const err = $('#insert-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#insert-overlay').classList.add('hidden');
    toast('Documento inserito');
    runQuery();
  });
});

function deleteDoc(doc) {
  const { text } = displayValue(doc._id);
  if (!confirm(`Eliminare il documento con _id = ${text}?`)) return;
  socket.emit('doc:delete', {
    db: state.db,
    coll: state.coll,
    id: idOf(doc),
  }, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    toast('Documento eliminato');
    runQuery();
  });
}

/* ===========================================================================
 * Vista dettagli collection
 * ========================================================================= */

function loadDetails() {
  if (!state.db || !state.coll) return;
  socket.emit('collection:stats', { db: state.db, coll: state.coll }, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    renderDetails(res);
  });
}

function renderDetails({ stats, indexes, fields, sampled }) {
  const rows = [
    ['Documenti', stats.count == null ? '—' : stats.count],
    ['Dimensione dati', fmtBytes(stats.size)],
    ['Dimensione su disco', fmtBytes(stats.storageSize)],
    ['Media per documento', fmtBytes(stats.avgObjSize)],
    ['Dimensione indici', fmtBytes(stats.totalIndexSize)],
    ['Numero di indici', stats.nindexes == null ? indexes.length : stats.nindexes],
  ];
  $('#stats-table tbody').innerHTML = rows
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');

  $('#index-table thead').innerHTML = '<tr><th>Nome</th><th>Chiavi</th><th>Unico</th></tr>';
  $('#index-table tbody').innerHTML = indexes.length
    ? indexes
        .map((i) => `<tr><td>${esc(i.name)}</td><td class="mono">${esc(JSON.stringify(i.key))}</td><td>${i.unique ? 'sì' : ''}</td></tr>`)
        .join('')
    : '<tr><td colspan="3" class="dim">Nessun indice</td></tr>';

  $('#schema-note').textContent = `(campione di ${sampled} documenti)`;
  $('#schema-table thead').innerHTML = '<tr><th>Campo</th><th>Tipi</th><th>Presenza</th></tr>';
  $('#schema-table tbody').innerHTML = fields.length
    ? fields
        .map((f) => `<tr><td class="mono">${esc(f.name)}</td><td>${esc(f.types.join(', '))}</td><td>${f.presence}%</td></tr>`)
        .join('')
    : '<tr><td colspan="3" class="dim">Collection vuota</td></tr>';
}

/* ===========================================================================
 * Vista UML
 * ========================================================================= */

const UML = { W: 230, ROW: 17, HEAD: 26, PAD: 10, GAP: 30, COLGAP: 140, MAXF: 11 };

function loadUml(force) {
  if (!state.db || !state.coll) return;
  if (!force && state.dbSchema && state.dbSchemaFor === state.db) {
    renderUml();
    return;
  }
  $('#uml-canvas').innerHTML = '<div class="uml-msg">Analisi dello schema del database…</div>';
  socket.emit('db:schema', { db: state.db }, (res) => {
    if (!res.ok) {
      $('#uml-canvas').innerHTML = `<div class="error">${esc(res.error)}</div>`;
      return;
    }
    state.dbSchema = res;
    state.dbSchemaFor = state.db;
    renderUml();
  });
}

$('#uml-refresh').addEventListener('click', () => loadUml(true));

function umlBoxHeight(c) {
  const rows = Math.min(c.fields.length, UML.MAXF) + (c.fields.length > UML.MAXF ? 1 : 0);
  return UML.HEAD + UML.PAD + Math.max(rows, 1) * UML.ROW;
}

function umlBoxSvg(c, p, isFocal) {
  let s = `<g class="uml-box${isFocal ? ' focal' : ''}">`;
  s += `<rect x="${p.x}" y="${p.y}" width="${UML.W}" height="${p.h}" rx="6"></rect>`;
  s += `<rect x="${p.x}" y="${p.y}" width="${UML.W}" height="${UML.HEAD}" rx="6" class="uml-head"></rect>`;
  s += `<text x="${p.x + UML.W / 2}" y="${p.y + 17}" text-anchor="middle" class="uml-title">${esc(cut(c.name, 26))}</text>`;
  let fy = p.y + UML.HEAD + 14;
  for (const f of c.fields.slice(0, UML.MAXF)) {
    s += `<text x="${p.x + 10}" y="${fy}" class="uml-field">${esc(cut(f.name, 18))}</text>`;
    s += `<text x="${p.x + UML.W - 10}" y="${fy}" text-anchor="end" class="uml-type">${esc(cut(f.types.join('|'), 14))}</text>`;
    fy += UML.ROW;
  }
  if (c.fields.length > UML.MAXF) {
    s += `<text x="${p.x + 10}" y="${fy}" class="uml-field dim">… altri ${c.fields.length - UML.MAXF} campi</text>`;
  }
  return s + '</g>';
}

function renderUml() {
  const canvas = $('#uml-canvas');
  const schema = state.dbSchema;
  const focal = schema && schema.collections.find((c) => c.name === state.coll);
  if (!focal) {
    canvas.innerHTML = '<div class="uml-msg">Schema non disponibile per questa collection.</div>';
    return;
  }

  // Archi che coinvolgono la collection corrente e relative collection vicine.
  const edges = schema.relations.filter(
    (r) => r.from !== r.to && (r.from === focal.name || r.to === focal.name)
  );
  const neighborNames = [...new Set(edges.map((r) => (r.from === focal.name ? r.to : r.from)))];
  const neighbors = neighborNames
    .map((n) => schema.collections.find((c) => c.name === n))
    .filter(Boolean);

  // Vicini alternati su due colonne, collection corrente al centro.
  const right = neighbors.filter((_, i) => i % 2 === 0);
  const left = neighbors.filter((_, i) => i % 2 === 1);
  const stackH = (list) => list.reduce((h, c) => h + umlBoxHeight(c) + UML.GAP, list.length ? -UML.GAP : 0);

  const totalH = Math.max(umlBoxHeight(focal), stackH(left), stackH(right)) + 50;
  const leftX = 20;
  const centerX = left.length ? leftX + UML.W + UML.COLGAP : leftX;
  const rightX = centerX + UML.W + UML.COLGAP;
  const width = (right.length ? rightX : centerX) + UML.W + 20;

  const pos = new Map();
  pos.set(focal.name, {
    x: centerX,
    y: Math.max(25, (totalH - umlBoxHeight(focal)) / 2),
    h: umlBoxHeight(focal),
  });
  for (const [list, x] of [[left, leftX], [right, rightX]]) {
    let y = Math.max(25, (totalH - stackH(list)) / 2);
    for (const c of list) {
      pos.set(c.name, { x, y, h: umlBoxHeight(c) });
      y += umlBoxHeight(c) + UML.GAP;
    }
  }

  // Archi: linea con freccia verso la collection referenziata + etichetta campo.
  const pf = pos.get(focal.name);
  let svgEdges = '';
  for (const side of ['left', 'right']) {
    const sideEdges = edges.filter((r) => {
      const po = pos.get(r.from === focal.name ? r.to : r.from);
      return po && (side === 'left' ? po.x < pf.x : po.x > pf.x);
    });
    const perNeighbor = new Map();
    sideEdges.forEach((r, j) => {
      const other = r.from === focal.name ? r.to : r.from;
      const po = pos.get(other);
      const k = perNeighbor.get(other) || 0;
      perNeighbor.set(other, k + 1);

      const x1 = side === 'left' ? pf.x : pf.x + UML.W;
      const x2 = side === 'left' ? po.x + UML.W : po.x;
      const y1 = pf.y + (pf.h * (j + 1)) / (sideEdges.length + 1);
      const y2 = po.y + Math.min(po.h / 2 + k * 14, po.h - 8);

      const outgoing = r.from === focal.name;
      const [sx, sy, ex, ey] = outgoing ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
      svgEdges += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" class="uml-edge" marker-end="url(#uml-arrow)"></line>`;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 - 6;
      svgEdges += `<text x="${mx}" y="${my}" text-anchor="middle" class="uml-edge-label">${esc(r.field)}${r.many ? ' [N]' : ''}</text>`;
    });
  }

  let svgBoxes = umlBoxSvg(focal, pf, true);
  for (const c of neighbors) svgBoxes += umlBoxSvg(c, pos.get(c.name), false);

  const note = edges.length
    ? ''
    : '<div class="uml-msg">Nessuna associazione rilevata: il diagramma mostra solo la collection corrente.</div>';
  canvas.innerHTML = `${note}<svg width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="uml-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 z"></path>
      </marker>
    </defs>
    ${svgEdges}${svgBoxes}</svg>`;
}

/* ===========================================================================
 * Aggiornamenti in tempo reale (change stream)
 * ========================================================================= */

function startWatch() {
  socket.emit('collection:watch', { db: state.db, coll: state.coll }, (res) => {
    $('#live-badge').classList.toggle('hidden', !res.ok);
  });
}

socket.on('collection:changed', (change) => {
  if (change.db !== state.db || change.coll !== state.coll) return;
  // Debounce: più modifiche ravvicinate causano un solo refresh.
  clearTimeout(state.liveTimer);
  state.liveTimer = setTimeout(runQuery, 300);
});

socket.on('watch:unavailable', () => {
  $('#live-badge').classList.add('hidden');
});
