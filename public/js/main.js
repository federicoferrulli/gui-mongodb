'use strict';

import { state } from './state.js';
import { socket } from './socket.js';
import { $, isPlainObject, displayValue, simplify, valueType, editValue, parseEdited, idOf, esc, cut, fmtBytes, toast, showQueryError, showContextMenu, hideContextMenu } from './utils.js';
import { loadUml, renderUml, initUml } from './uml.js';

initUml();


/* ===========================================================================
 * Connessione
 * ========================================================================= */

function selectConnTab(name) {
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-fields').classList.toggle('hidden', name !== 'fields');
  $('#tab-uri').classList.toggle('hidden', name !== 'uri');
}

document.querySelectorAll('.tab[data-tab]').forEach((tab) =>
  tab.addEventListener('click', () => selectConnTab(tab.dataset.tab))
);

// Adatta il form al tipo di database scelto: MySQL non ha authSource né URI,
// ma ha il database/schema iniziale e una porta di default diversa.
function applyDbTypeToForm() {
  const form = $('#connect-form');
  const isMysql = form.elements.dbType.value === 'mysql';
  $('#row-authsource').classList.toggle('hidden', isMysql);
  $('#row-database').classList.toggle('hidden', !isMysql);
  // L'URI completa non è disponibile per MySQL né col tunnel SSH attivo.
  $('#tab-uri-btn').classList.toggle('hidden', isMysql || form.elements.ssh.checked);
  if (isMysql && !$('#tab-uri').classList.contains('hidden')) selectConnTab('fields');
  // Cambia la porta solo se è ancora quella di default dell'altro DBMS.
  const port = form.elements.port;
  if (isMysql && port.value === '27017') port.value = '3306';
  if (!isMysql && port.value === '3306') port.value = '27017';
}

$('#conn-dbtype').addEventListener('change', applyDbTypeToForm);

// Mostra/nasconde i campi SSH; col tunnel attivo l'URI completa non è
// supportata, quindi torna ai Parametri e nasconde il relativo tab.
function applySshToForm() {
  const form = $('#connect-form');
  const on = form.elements.ssh.checked;
  $('#ssh-fields').classList.toggle('hidden', !on);
  if (on && !$('#tab-uri').classList.contains('hidden')) selectConnTab('fields');
  applyDbTypeToForm();
}

$('#conn-ssh-toggle').addEventListener('change', applySshToForm);

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
  // Tunnel SSH: 'ssh' vale "true"/"" così da essere serializzato nell'.ini.
  const sshOn = form.elements.ssh.checked;
  cfg.ssh = sshOn ? 'true' : '';
  if (sshOn) {
    cfg.sshHost = form.elements.sshHost.value;
    cfg.sshPort = form.elements.sshPort.value;
    cfg.sshUser = form.elements.sshUser.value;
    cfg.sshPassword = form.elements.sshPassword.value;
    cfg.sshKeyFile = form.elements.sshKeyFile.value;
    cfg.sshPassphrase = form.elements.sshPassphrase.value;
  }
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

// Termine usato in UI per le collection/tabelle, in base al DBMS connesso.
function collWord() {
  return state.dbType === 'mysql' ? 'tabella' : 'collection';
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
  // In modifica: il server riusa i segreti salvati (password DB e credenziali
  // SSH) per i campi lasciati vuoti.
  if (editingConn) cfg.keepPasswordFrom = editingConn;
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
    // Tunnel SSH: i segreti restano lato server, si segnala solo se esistono.
    form.elements.ssh.checked = (f.ssh || '').toLowerCase() === 'true';
    form.elements.sshHost.value = f.sshHost || '';
    form.elements.sshPort.value = f.sshPort || '22';
    form.elements.sshUser.value = f.sshUser || '';
    form.elements.sshPassword.value = '';
    form.elements.sshPassword.placeholder = res.hasSshPassword ? '(invariata se lasciata vuota)' : '(vuoto se usi una chiave)';
    form.elements.sshKeyFile.value = f.sshKeyFile || '';
    form.elements.sshPassphrase.value = '';
    form.elements.sshPassphrase.placeholder = res.hasSshPassphrase ? '(invariata se lasciata vuota)' : '(se la chiave è protetta)';
    form.elements.saveAs.value = name;
    applyDbTypeToForm();
    applySshToForm();
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
  form.elements.sshPassword.placeholder = '(vuoto se usi una chiave)';
  form.elements.sshPassphrase.placeholder = '(se la chiave è protetta)';
  applyDbTypeToForm();
  applySshToForm();
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
        { label: `＋ Nuova ${collWord()}…`, action: () => openCreateColl(db.name) },
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
          { label: `ℹ Dettagli ${collWord()}`, action: () => { selectCollection(dbName, coll.name, label); setView('details'); } },
          { label: '◫ Diagramma UML', action: () => { selectCollection(dbName, coll.name, label); setView('uml'); } },
          '---',
          { label: `✎ Rinomina ${collWord()}…`, action: () => renameColl(dbName, coll.name) },
          { label: `🗑 Elimina ${collWord()}…`, danger: true, action: () => dropColl(dbName, coll.name) },
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
  $('#polling-toggle').classList.add('hidden');
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
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
 * Gestione collection / tabelle (crea con schema, rinomina, elimina)
 * ========================================================================= */

let creatingCollDb = null; // database di destinazione della collection in creazione

// Aggiunge una riga all'editor di colonne del modale di creazione (solo MySQL).
function addColRow(values = {}) {
  const tr = document.createElement('tr');
  const cell = (el) => {
    const td = document.createElement('td');
    td.appendChild(el);
    return td;
  };
  const text = (cls, value, placeholder, list) => {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = cls;
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    if (list) i.setAttribute('list', list);
    i.spellcheck = false;
    return i;
  };
  const check = (cls, checked) => {
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.className = cls;
    i.checked = !!checked;
    return i;
  };
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del-btn';
  del.textContent = '✕';
  del.title = 'Rimuovi colonna';
  del.addEventListener('click', () => tr.remove());

  tr.append(
    cell(text('col-name', values.name, 'nome')),
    cell(text('col-type', values.type, 'es. VARCHAR(255)', 'mysql-types')),
    cell(check('col-null', values.nullable !== false)),
    cell(text('col-default', values.default, '')),
    cell(check('col-ai', values.autoIncrement)),
    cell(check('col-pk', values.primaryKey)),
    cell(del)
  );
  $('#collcreate-cols tbody').appendChild(tr);
}

function readColRows() {
  return [...$('#collcreate-cols tbody').querySelectorAll('tr')]
    .map((tr) => ({
      name: tr.querySelector('.col-name').value.trim(),
      type: tr.querySelector('.col-type').value.trim(),
      nullable: tr.querySelector('.col-null').checked,
      default: tr.querySelector('.col-default').value,
      autoIncrement: tr.querySelector('.col-ai').checked,
      primaryKey: tr.querySelector('.col-pk').checked,
    }))
    .filter((c) => c.name || c.type); // le righe lasciate vuote vengono ignorate
}

function openCreateColl(dbName) {
  creatingCollDb = dbName;
  const isMysql = state.dbType === 'mysql';
  $('#collcreate-title').textContent = isMysql ? 'Nuova tabella' : 'Nuova collection';
  $('#collcreate-subtitle').textContent = `Database: ${dbName}`;
  $('#collcreate-name').value = '';
  $('#collcreate-schema').classList.toggle('hidden', !isMysql);
  $('#collcreate-cols tbody').innerHTML = '';
  if (isMysql) addColRow({ name: 'id', type: 'INT UNSIGNED', nullable: false, autoIncrement: true, primaryKey: true });
  $('#collcreate-error').classList.add('hidden');
  $('#collcreate-overlay').classList.remove('hidden');
  $('#collcreate-name').focus();
}

$('#collcreate-addcol').addEventListener('click', () => addColRow());
$('#collcreate-cancel').addEventListener('click', () => $('#collcreate-overlay').classList.add('hidden'));

$('#collcreate-save').addEventListener('click', () => {
  const name = $('#collcreate-name').value.trim();
  const payload = { db: creatingCollDb, name };
  if (state.dbType === 'mysql') payload.columns = readColRows();
  socket.emit('collection:create', payload, (res) => {
    if (!res.ok) {
      const err = $('#collcreate-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#collcreate-overlay').classList.add('hidden');
    toast(`${state.dbType === 'mysql' ? 'Tabella' : 'Collection'} "${name}" creata`);
    state.expandedDbs.add(creatingCollDb);
    state.dbSchema = null;
    refreshDbTree();
  });
});

$('#collcreate-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#collcreate-save').click();
});

function renameColl(dbName, collName) {
  const input = prompt(`Nuovo nome per la ${collWord()} "${collName}":`, collName);
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === collName) return;
  socket.emit('collection:rename', { db: dbName, coll: collName, newName }, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    toast(`Rinominata in "${newName}"`);
    state.dbSchema = null;
    if (state.db === dbName && state.coll === collName) {
      state.coll = newName;
      $('#breadcrumb').textContent = `${dbName} ▸ ${newName}`;
      runQuery();
      startWatch();
    }
    refreshDbTree();
  });
}

function dropColl(dbName, collName) {
  if (!confirm(`Eliminare la ${collWord()} "${collName}" e TUTTI i suoi dati?\nL'operazione non è reversibile.`)) return;
  socket.emit('collection:drop', { db: dbName, coll: collName }, (res) => {
    if (!res.ok) {
      toast(res.error, true);
      return;
    }
    toast(`"${collName}" eliminata`);
    state.dbSchema = null;
    if (state.db === dbName && state.coll === collName) resetWorkspace();
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

/* ---------- Modulo di inserimento guidato dallo schema ---------- */

let insertRows = [];           // righe del modulo: { tr, kind, input, nameInput, fixedName, auto, required }
let insertJsonTouched = false; // il tab JSON è stato modificato a mano: non rigenerarlo dal modulo

// Tipo di controllo del modulo a partire dal tipo dichiarato (MySQL) o
// campionato (BSON) del campo.
function insertKindOf(typeName) {
  const t = String(typeName || '').toLowerCase();
  if (state.dbType === 'mysql') {
    if (/^tinyint\(1\)|^bool/.test(t)) return 'bool';
    if (/^decimal/.test(t)) return 'decimal';
    if (/int|float|double|year/.test(t)) return 'number';
    if (/^datetime|^timestamp/.test(t)) return 'datetime';
    if (/^date$/.test(t)) return 'date';
    if (/^json/.test(t)) return 'json';
    return 'text';
  }
  if (t === 'int' || t === 'double' || t === 'long') return 'number';
  if (t === 'decimal') return 'decimal';
  if (t === 'date') return 'datetime';
  if (t === 'boolean') return 'bool';
  if (t === 'objectid') return 'oid';
  if (t === 'array' || t === 'object') return 'json';
  return 'text';
}

function insertInputFor(kind) {
  if (kind === 'bool') {
    const s = document.createElement('select');
    for (const v of ['', 'true', 'false']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === '' ? '(vuoto)' : v;
      s.appendChild(o);
    }
    return s;
  }
  const i = document.createElement('input');
  if (kind === 'number') { i.type = 'number'; i.step = 'any'; }
  else if (kind === 'datetime') { i.type = 'datetime-local'; i.step = '0.001'; }
  else if (kind === 'date') { i.type = 'date'; }
  else {
    i.type = 'text';
    if (kind === 'oid') i.placeholder = '24 caratteri esadecimali';
    if (kind === 'json') i.placeholder = 'JSON, es. {"a": 1} oppure [1, 2]';
  }
  i.spellcheck = false;
  return i;
}

function addInsertRow(opts) {
  const tr = document.createElement('tr');
  const row = {
    tr,
    kind: opts.kind || 'text',
    input: null,
    nameInput: null,
    fixedName: opts.name || null,
    auto: !!opts.auto,
    required: !!opts.required,
  };

  const nameTd = document.createElement('td');
  if (opts.nameEditable) {
    row.nameInput = document.createElement('input');
    row.nameInput.type = 'text';
    row.nameInput.placeholder = 'nome campo';
    row.nameInput.spellcheck = false;
    nameTd.appendChild(row.nameInput);
  } else {
    nameTd.innerHTML = `<span class="mono">${esc(opts.name)}</span>` +
      (opts.required ? '<span class="req" title="Obbligatorio: NOT NULL senza default"> *</span>' : '');
  }
  tr.appendChild(nameTd);

  const typeTd = document.createElement('td');
  typeTd.className = 'insert-type';
  if (opts.nameEditable) {
    // Campo aggiunto a mano (MongoDB): il tipo lo sceglie l'utente.
    const sel = document.createElement('select');
    const kinds = [['text', 'testo'], ['number', 'numero'], ['bool', 'booleano'],
                   ['datetime', 'data'], ['oid', 'ObjectId'], ['json', 'JSON']];
    for (const [v, label] of kinds) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      row.kind = sel.value;
      const fresh = insertInputFor(row.kind);
      row.input.replaceWith(fresh);
      row.input = fresh;
    });
    typeTd.appendChild(sel);
  } else {
    typeTd.innerHTML = `<span class="dim">${esc(opts.typeLabel || '')}</span>`;
  }
  tr.appendChild(typeTd);

  const valTd = document.createElement('td');
  valTd.className = 'insert-value';
  if (row.auto) {
    const i = document.createElement('input');
    i.type = 'text';
    i.disabled = true;
    i.placeholder = '(auto)';
    row.input = i;
  } else {
    row.input = insertInputFor(row.kind);
  }
  valTd.appendChild(row.input);
  tr.appendChild(valTd);

  const delTd = document.createElement('td');
  delTd.className = 'row-actions';
  if (opts.removable) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.textContent = '✕';
    del.title = 'Rimuovi campo';
    del.addEventListener('click', () => {
      tr.remove();
      insertRows = insertRows.filter((r) => r !== row);
    });
    delTd.appendChild(del);
  }
  tr.appendChild(delTd);

  $('#insert-form tbody').appendChild(tr);
  insertRows.push(row);
  return row;
}

// Valore EJSON di una riga del modulo; undefined = campo lasciato vuoto (omesso).
function insertRowValue(row) {
  const raw = row.input.value;
  const t = String(raw == null ? '' : raw).trim();
  if (t === '') return undefined;
  switch (row.kind) {
    case 'number': {
      const n = Number(t);
      if (Number.isNaN(n)) throw new Error('numero non valido');
      return n;
    }
    case 'decimal':
      return state.dbType === 'mysql' ? t : { $numberDecimal: t };
    case 'bool':
      return t === 'true';
    case 'datetime': {
      const d = new Date(t + 'Z'); // input interpretato come UTC, come l'editing inline
      if (Number.isNaN(d.getTime())) throw new Error('data non valida');
      return { $date: d.toISOString() };
    }
    case 'date':
      return t; // YYYY-MM-DD per le colonne DATE di MySQL
    case 'oid':
      if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new Error('ObjectId non valido (24 caratteri esadecimali)');
      return { $oid: t };
    case 'json':
      try { return JSON.parse(t); } catch { throw new Error('JSON non valido'); }
    default:
      return raw; // testo: si preserva anche con spazi iniziali/finali
  }
}

function buildInsertDoc() {
  const doc = {};
  for (const row of insertRows) {
    if (row.auto) continue;
    const name = row.nameInput ? row.nameInput.value.trim() : row.fixedName;
    if (!name) {
      if (String(row.input.value).trim() !== '') throw new Error('C\'è un campo con un valore ma senza nome.');
      continue; // riga aggiunta e lasciata vuota: ignorata
    }
    let value;
    try {
      value = insertRowValue(row);
    } catch (err) {
      throw new Error(`Campo "${name}": ${err.message}`);
    }
    if (value === undefined) {
      if (row.required) throw new Error(`Il campo "${name}" è obbligatorio (NOT NULL senza default).`);
      continue;
    }
    if (name in doc) throw new Error(`Campo duplicato: "${name}".`);
    doc[name] = value;
  }
  return doc;
}

function selectInsertTab(name) {
  // Passando al tab JSON lo si rigenera dal modulo, ma solo se l'utente non
  // lo ha già modificato a mano.
  if (name === 'json' && !insertJsonTouched && !$('#insert-tab-form').classList.contains('hidden')) {
    try {
      $('#insert-json').value = JSON.stringify(buildInsertDoc(), null, 2);
    } catch { /* modulo incompleto: il JSON resta com'è */ }
  }
  document.querySelectorAll('[data-instab]').forEach((t) => t.classList.toggle('active', t.dataset.instab === name));
  $('#insert-tab-form').classList.toggle('hidden', name !== 'form');
  $('#insert-tab-json').classList.toggle('hidden', name !== 'json');
}

document.querySelectorAll('[data-instab]').forEach((tab) =>
  tab.addEventListener('click', () => selectInsertTab(tab.dataset.instab))
);

$('#insert-json').addEventListener('input', () => { insertJsonTouched = true; });

$('#insert-addfield').addEventListener('click', () => {
  $('#insert-form-empty').classList.add('hidden');
  const row = addInsertRow({ nameEditable: true, kind: 'text', removable: true });
  row.nameInput.focus();
});

$('#insert-btn').addEventListener('click', () => {
  const isMysql = state.dbType === 'mysql';
  $('#insert-title').textContent = isMysql ? 'Nuova riga' : 'Nuovo documento';
  $('#insert-json').value = '{\n  \n}';
  insertJsonTouched = false;
  insertRows = [];
  $('#insert-form tbody').innerHTML = '';
  $('#insert-form-empty').classList.add('hidden');
  $('#insert-addfield').classList.toggle('hidden', isMysql); // i campi liberi sono solo per Mongo
  $('#insert-error').classList.add('hidden');
  selectInsertTab('form');
  $('#insert-overlay').classList.remove('hidden');

  // Il modulo si costruisce dallo schema: colonne reali per MySQL, campi
  // campionati per MongoDB.
  socket.emit('collection:stats', { db: state.db, coll: state.coll }, (res) => {
    if (res.ok) {
      for (const f of res.fields) {
        if (f.name === '_id' && !isMysql) continue; // l'_id lo genera MongoDB
        const mainType = f.types.find((t) => t !== 'null') || 'null';
        addInsertRow({
          name: f.name,
          typeLabel: f.types.join(', '),
          kind: insertKindOf(mainType),
          auto: !!f.autoIncrement,
          required: isMysql && !f.nullable && f.default == null && !f.autoIncrement,
        });
      }
    }
    if (!insertRows.length) $('#insert-form-empty').classList.remove('hidden');
    const first = insertRows.find((r) => !r.auto);
    if (first) first.input.focus();
  });
});

$('#insert-cancel').addEventListener('click', () => $('#insert-overlay').classList.add('hidden'));

$('#insert-save').addEventListener('click', () => {
  const usingForm = !$('#insert-tab-form').classList.contains('hidden');
  let docText;
  if (usingForm) {
    try {
      docText = JSON.stringify(buildInsertDoc());
    } catch (err) {
      const el = $('#insert-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
      return;
    }
  } else {
    docText = $('#insert-json').value;
  }
  socket.emit('doc:insert', {
    db: state.db,
    coll: state.coll,
    doc: docText,
  }, (res) => {
    if (!res.ok) {
      const err = $('#insert-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#insert-overlay').classList.add('hidden');
    toast(state.dbType === 'mysql' ? 'Riga inserita' : 'Documento inserito');
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
  const isMysql = state.dbType === 'mysql';
  const rows = [
    [isMysql ? 'Righe (stima)' : 'Documenti', stats.count == null ? '—' : stats.count],
    ['Dimensione dati', fmtBytes(stats.size)],
    ['Dimensione su disco', fmtBytes(stats.storageSize)],
    [isMysql ? 'Media per riga' : 'Media per documento', fmtBytes(stats.avgObjSize)],
    ['Dimensione indici', fmtBytes(stats.totalIndexSize)],
    ['Numero di indici', stats.nindexes == null ? indexes.length : stats.nindexes],
  ];
  $('#stats-table tbody').innerHTML = rows
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');

  $('#index-table thead').innerHTML = '<tr><th>Nome</th><th>Chiavi</th><th>Unico</th><th></th></tr>';
  $('#index-table tbody').innerHTML = indexes.length
    ? indexes
        .map((i) => {
          // L'indice _id_ di MongoDB è obbligatorio e non eliminabile.
          const del = i.name === '_id_'
            ? ''
            : `<button type="button" class="del-btn idx-del" data-name="${esc(i.name)}" title="Elimina indice">✕</button>`;
          return `<tr><td>${esc(i.name)}</td><td class="mono">${esc(JSON.stringify(i.key))}</td>` +
                 `<td>${i.unique ? 'sì' : ''}</td><td class="row-actions">${del}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="dim">Nessun indice</td></tr>';

  $('#schema-title').textContent = isMysql ? 'Colonne' : 'Schema rilevato';
  $('#schema-note').textContent = isMysql ? '' : `(campione di ${sampled} documenti)`;
  $('#column-add-btn').classList.remove('hidden');
  $('#column-add-btn').title = isMysql ? 'Aggiungi colonna' : 'Aggiungi campo a tutti i documenti';
  $('#schema-table thead').innerHTML =
    `<tr><th>Campo</th><th>Tipi</th><th>${isMysql ? 'NULL' : 'Presenza'}</th><th></th></tr>`;
  $('#schema-table tbody').innerHTML = fields.length
    ? fields
        .map((f) => {
          const third = isMysql ? (f.nullable ? 'sì' : 'no') : `${f.presence}%`;
          // L'_id di MongoDB non è né modificabile né eliminabile.
          const actions = (!isMysql && f.name === '_id')
            ? '<td class="row-actions"></td>'
            : `<td class="row-actions">` +
              `<button type="button" class="edit-btn col-edit" data-field="${esc(JSON.stringify(f))}" title="${isMysql ? 'Modifica colonna' : 'Rinomina/converti il campo in tutti i documenti'}">✎</button>` +
              `<button type="button" class="del-btn col-del" data-name="${esc(f.name)}" title="${isMysql ? 'Elimina colonna' : 'Rimuovi il campo da tutti i documenti'}">✕</button></td>`;
          return `<tr><td class="mono">${esc(f.name)}</td><td>${esc(f.types.join(', '))}</td><td>${third}</td>${actions}</tr>`;
        })
        .join('')
    : `<tr><td colspan="4" class="dim">${isMysql ? 'Nessuna colonna' : 'Collection vuota'}</td></tr>`;
}

/* ---------- Gestione indici (entrambi i DBMS) ---------- */

$('#index-table').addEventListener('click', (e) => {
  const btn = e.target.closest('.idx-del');
  if (!btn) return;
  const name = btn.dataset.name;
  const extra = name.toUpperCase() === 'PRIMARY' ? '\nAttenzione: è la chiave primaria della tabella.' : '';
  if (!confirm(`Eliminare l'indice "${name}"?${extra}`)) return;
  socket.emit('index:drop', { db: state.db, coll: state.coll, name }, (res) => {
    if (!res.ok) return toast(res.error, true);
    toast(`Indice "${name}" eliminato`);
    loadDetails();
  });
});

$('#index-add-btn').addEventListener('click', () => {
  $('#idxcreate-name').value = '';
  $('#idxcreate-fields').value = '';
  $('#idxcreate-unique').checked = false;
  $('#idxcreate-error').classList.add('hidden');
  $('#idxcreate-overlay').classList.remove('hidden');
  $('#idxcreate-fields').focus();
});

$('#idxcreate-cancel').addEventListener('click', () => $('#idxcreate-overlay').classList.add('hidden'));

$('#idxcreate-save').addEventListener('click', () => {
  socket.emit('index:create', {
    db: state.db,
    coll: state.coll,
    name: $('#idxcreate-name').value,
    fields: $('#idxcreate-fields').value,
    unique: $('#idxcreate-unique').checked,
  }, (res) => {
    if (!res.ok) {
      const err = $('#idxcreate-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#idxcreate-overlay').classList.add('hidden');
    toast(`Indice "${res.name}" creato`);
    loadDetails();
  });
});

/* ---------- Gestione colonne (MySQL) / campi (MongoDB) ---------- */

let colEditOldName = null; // nome attuale della colonna in modifica (null = nuova)

// Termine usato nel modale e nei toast: "colonna" per SQL, "campo" per Mongo.
function colWord(capital) {
  const w = state.dbType === 'mysql' ? 'colonna' : 'campo';
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

function openColumnModal(field) {
  const isMysql = state.dbType === 'mysql';
  colEditOldName = field ? field.name : null;
  $('#coledit-title').textContent = field ? `Modifica ${colWord()} "${field.name}"` : `Aggiungi ${colWord()}`;
  $('#coledit-name').value = field ? field.name : '';

  // MySQL: tipo SQL, NULL e default. MongoDB: conversione di tipo solo in
  // modifica, valore iniziale solo in aggiunta.
  $('#coledit-type-row').classList.toggle('hidden', !isMysql);
  $('#coledit-bsontype-row').classList.toggle('hidden', isMysql || !field);
  $('#coledit-null-row').classList.toggle('hidden', !isMysql);
  $('#coledit-default-row').classList.toggle('hidden', !isMysql && !!field);
  $('#coledit-default-label').textContent = isMysql ? 'Default' : 'Valore iniziale per i documenti esistenti';
  $('#coledit-default').placeholder = isMysql
    ? '(nessuno; testo, numero o CURRENT_TIMESTAMP)'
    : '(vuoto = null; testo, numero o EJSON come {"$date": "..."})';

  $('#coledit-type').value = field && isMysql ? field.types[0] : '';
  $('#coledit-bsontype').value = '';
  $('#coledit-null').checked = field ? !!field.nullable : true;
  $('#coledit-default').value = field && field.default != null ? field.default : '';
  $('#coledit-error').classList.add('hidden');
  $('#coledit-overlay').classList.remove('hidden');
  $('#coledit-name').focus();
}

$('#column-add-btn').addEventListener('click', () => openColumnModal(null));
$('#coledit-cancel').addEventListener('click', () => $('#coledit-overlay').classList.add('hidden'));

$('#schema-table').addEventListener('click', (e) => {
  const editBtn = e.target.closest('.col-edit');
  if (editBtn) return openColumnModal(JSON.parse(editBtn.dataset.field));
  const delBtn = e.target.closest('.col-del');
  if (!delBtn) return;
  const name = delBtn.dataset.name;
  const msg = state.dbType === 'mysql'
    ? `Eliminare la colonna "${name}" e tutti i suoi dati?\nL'operazione non è reversibile.`
    : `Rimuovere il campo "${name}" da TUTTI i documenti della collection?\nL'operazione non è reversibile.`;
  if (!confirm(msg)) return;
  socket.emit('column:drop', { db: state.db, coll: state.coll, name }, (res) => {
    if (!res.ok) return toast(res.error, true);
    toast(`${colWord(true)} "${name}" eliminat${state.dbType === 'mysql' ? 'a' : 'o'}` +
      (res.modified != null ? ` (${res.modified} documenti aggiornati)` : ''));
    state.dbSchema = null;
    loadDetails();
  });
});

$('#coledit-save').addEventListener('click', () => {
  const isMysql = state.dbType === 'mysql';
  const column = isMysql
    ? {
        name: $('#coledit-name').value.trim(),
        type: $('#coledit-type').value.trim(),
        nullable: $('#coledit-null').checked,
        default: $('#coledit-default').value,
      }
    : colEditOldName
      ? { name: $('#coledit-name').value.trim(), type: $('#coledit-bsontype').value } // rinomina/converti
      : { name: $('#coledit-name').value.trim(), default: $('#coledit-default').value }; // nuovo campo
  const event = colEditOldName ? 'column:alter' : 'column:add';
  const payload = colEditOldName
    ? { db: state.db, coll: state.coll, oldName: colEditOldName, column }
    : { db: state.db, coll: state.coll, column };
  socket.emit(event, payload, (res) => {
    if (!res.ok) {
      const err = $('#coledit-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    $('#coledit-overlay').classList.add('hidden');
    const done = colEditOldName
      ? `${colWord(true)} "${column.name}" modificat${isMysql ? 'a' : 'o'}`
      : `${colWord(true)} "${column.name}" aggiunt${isMysql ? 'a' : 'o'}`;
    toast(done + (res.modified != null ? ` (${res.modified} documenti aggiornati)` : ''));
    state.dbSchema = null;
    loadDetails();
  });
});

/* UML delegate to module */

/* ===========================================================================
 * Aggiornamenti in tempo reale (change stream)
 * ========================================================================= */

function togglePolling() {
  const isEnabled = $('#polling-checkbox').checked;
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
  if (isEnabled) {
    state.pollingInterval = setInterval(() => {
      if (document.hidden) return; // Tab inattivo
      if (document.querySelector('.editing')) return; // Modifica in corso
      if (!$('#editdoc-overlay').classList.contains('hidden')) return; // Modifica modale JSON in corso
      if (!$('#insert-overlay').classList.contains('hidden')) return; // Inserimento in corso
      runQuery(); // Esegui auto-refresh silente
    }, 5000);
  }
}

$('#polling-checkbox').addEventListener('change', togglePolling);

function startWatch() {
  $('#polling-toggle').classList.add('hidden');
  $('#polling-checkbox').checked = false;
  togglePolling();
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
  $('#polling-toggle').classList.remove('hidden');
});
