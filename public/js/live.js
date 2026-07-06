import { state } from './state.js';
import { socket } from './socket.js';
import { tabs } from './tabs.js';
import { $, emit } from './utils.js';
import { runQuery } from './grid.js';
import { renderDbTree } from './dbtree.js';

export function togglePolling() {
  const isEnabled = $('#polling-checkbox').checked;
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
  if (isEnabled) {
    const owner = tabs.activeId; // l'intervallo appartiene a questo tab
    state.pollingInterval = setInterval(() => {
      // runQuery agisce sul tab attivo: il polling di un tab in background
      // non deve interrogare i dati di un altro tab.
      if (owner !== tabs.activeId) return;
      if (document.hidden) return;
      if (document.querySelector('.editing')) return;
      if (!$('#editdoc-overlay').classList.contains('hidden')) return;
      if (!$('#insert-overlay').classList.contains('hidden')) return;
      runQuery();
    }, 5000);
  }
}

export function startWatch() {
  $('#polling-toggle').classList.add('hidden');
  $('#polling-checkbox').checked = false;
  state.pollingShown = false;
  togglePolling();
  const tab = tabs.list.find((t) => t.id === tabs.activeId);
  emit('collection:watch', { db: state.db, coll: state.coll }).then((res) => {
    res._tab.state.watching = true;
    if (res._tab.id === tabs.activeId) $('#live-badge').classList.remove('hidden');
  }).catch(() => {
    // Watch rifiutato subito (MySQL non lo supporta, o errore lato server):
    // stesso ripiego dell'evento watch:unavailable, cioè il toggle di
    // auto-refresh a polling. Così anche le tabelle hanno l'aggiornamento
    // automatico.
    if (!tab || !tabs.list.includes(tab)) return;
    tab.state.watching = false;
    tab.state.pollingShown = true;
    if (tab.id === tabs.activeId) {
      $('#live-badge').classList.add('hidden');
      $('#polling-toggle').classList.remove('hidden');
    }
  });
}

// Watch dello schema: attivato una volta per tab dopo il connect. Dove il
// change stream non c'è (MySQL, Mongo standalone) arriva schema:unavailable
// e si ripiega su un polling silenzioso della sidebar.
export function startSchemaWatch() {
  emit('schema:watch', {}).then((res) => {
    res._tab.state.schemaPolling = false;
  }).catch(() => {
    // Errore lato server: nessun auto-update dello schema, resta l'aggiornamento manuale.
  });
}

// Aggiorna la sidebar senza disturbare: salta se l'utente sta usando la
// ricerca (il tree mostrerebbe i risultati filtrati) e non mostra toast.
function refreshTreeAuto() {
  const search = $('#db-search');
  if (search.value.trim() || document.activeElement === search) return;
  emit('db:list', {}).then((res) => renderDbTree(res.databases)).catch(() => {});
}

export function initLive() {
  $('#polling-checkbox').addEventListener('change', togglePolling);

  socket.on('collection:changed', (change) => {
    // Gli eventi push sono taggati col tabId della sessione: contano solo
    // quelli del tab attivo (il workspace mostra i suoi dati).
    if (change.tabId && change.tabId !== tabs.activeId) return;
    if (change.db !== state.db || change.coll !== state.coll) return;
    clearTimeout(state.liveTimer);
    state.liveTimer = setTimeout(runQuery, 300);
  });

  let schemaTimer = null;
  socket.on('schema:changed', (info) => {
    const tab = tabs.list.find((t) => t.id === info.tabId);
    if (!tab) return;
    // Tab in background: si segna lo schema come sporco e si aggiorna
    // alla riattivazione (vedi renderWorkspace).
    if (tab.id !== tabs.activeId) {
      tab.state.schemaDirty = true;
      return;
    }
    clearTimeout(schemaTimer);
    schemaTimer = setTimeout(refreshTreeAuto, 300);
  });

  socket.on('schema:unavailable', (info) => {
    const tab = tabs.list.find((t) => t.id === (info && info.tabId));
    if (tab) tab.state.schemaPolling = true;
  });

  // Polling di riserva per i tab senza change stream: aggiorna la sidebar
  // del tab attivo ogni 10 secondi.
  setInterval(() => {
    if (document.hidden) return;
    const tab = tabs.list.find((t) => t.id === tabs.activeId);
    if (!tab || !tab.state.connected || !tab.state.schemaPolling) return;
    refreshTreeAuto();
  }, 10000);

  socket.on('watch:unavailable', (info) => {
    const tab = info && info.tabId
      ? tabs.list.find((t) => t.id === info.tabId)
      : tabs.list.find((t) => t.id === tabs.activeId);
    if (!tab) return;
    tab.state.watching = false;
    tab.state.pollingShown = true;
    if (tab.id === tabs.activeId) {
      $('#live-badge').classList.add('hidden');
      $('#polling-toggle').classList.remove('hidden');
    }
  });
}
