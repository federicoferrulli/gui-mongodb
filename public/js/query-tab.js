import { state } from './state.js';
import { $, emit, displayValue } from './utils.js';
import { initSnippetManager } from './snippet-manager.js';

let activeViewMode = 'table'; // 'table' | 'json'
let currentResults = [];
let executionStartTime = 0;

export function initQueryTab() {
  initSnippetManager();
  const targetEngineSelect = $('#query-target-engine');
  const runBtn = $('#query-run-btn');
  const stopBtn = $('#query-stop-btn');
  const formatBtn = $('#query-format-btn');
  const clearBtn = $('#query-clear-btn');
  const schemaRefreshBtn = $('#query-schema-refresh');
  const schemaSearchInput = $('#query-schema-search');
  const resModeTableBtn = $('#res-mode-table');
  const resModeJsonBtn = $('#res-mode-json');
  const editorInput = $('#query-editor-input');

  // Switch vista risultati (Tabella vs JSON Tree)
  if (resModeTableBtn && resModeJsonBtn) {
    resModeTableBtn.addEventListener('click', () => setResultsViewMode('table'));
    resModeJsonBtn.addEventListener('click', () => setResultsViewMode('json'));
  }

  // Azioni editor
  if (formatBtn && editorInput) {
    formatBtn.addEventListener('click', () => {
      const val = editorInput.value.trim();
      if (!val) return;
      try {
        if (val.startsWith('{') || val.startsWith('[')) {
          const parsed = JSON.parse(val);
          editorInput.value = JSON.stringify(parsed, null, 2);
        }
      } catch (e) {
        // lascia com'è se non è JSON valido
      }
    });
  }

  if (clearBtn && editorInput) {
    clearBtn.addEventListener('click', () => {
      editorInput.value = '';
    });
  }

  // Shortcut tastiera per l'esecuzione (Ctrl+Enter / Cmd+Enter)
  if (editorInput) {
    editorInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    });
  }

  if (runBtn) {
    runBtn.addEventListener('click', () => runQuery());
  }

  if (schemaRefreshBtn) {
    schemaRefreshBtn.addEventListener('click', () => renderQuerySchemaBrowser());
  }

  if (schemaSearchInput) {
    schemaSearchInput.addEventListener('input', (e) => {
      filterQuerySchemaBrowser(e.target.value.toLowerCase());
    });
  }

  initVerticalResizer();
}

// Inizializza la tab Query
export function loadQueryTab() {
  renderQuerySchemaBrowser();
}

// Resizer verticale tra editor e pannello risultati
function initVerticalResizer() {
  const resizer = $('#query-editor-resizer');
  const topPanel = $('#query-editor-container');
  const bottomPanel = $('#query-results-container');
  if (!resizer || !topPanel || !bottomPanel) return;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startTopH = topPanel.getBoundingClientRect().height;
    const startBottomH = bottomPanel.getBoundingClientRect().height;
    resizer.classList.add('dragging');

    const onMouseMove = (ev) => {
      const dy = ev.clientY - startY;
      const newTopH = Math.max(80, startTopH + dy);
      const newBottomH = Math.max(80, startBottomH - dy);
      topPanel.style.flex = 'none';
      topPanel.style.height = `${newTopH}px`;
      bottomPanel.style.flex = 'none';
      bottomPanel.style.height = `${newBottomH}px`;
    };

    const onMouseUp = () => {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Gestione modalità vista risultati (Table vs JSON)
export function setResultsViewMode(mode) {
  activeViewMode = mode;
  const tableBtn = $('#res-mode-table');
  const jsonBtn = $('#res-mode-json');
  const tableView = $('#query-table-view');
  const jsonView = $('#query-json-view');

  if (tableBtn) tableBtn.classList.toggle('active', mode === 'table');
  if (jsonBtn) jsonBtn.classList.toggle('active', mode === 'json');
  if (tableView) tableView.classList.toggle('hidden', mode !== 'table');
  if (jsonView) jsonView.classList.toggle('hidden', mode !== 'json');

  renderResults(currentResults);
}

// Aggiorna badge e metriche
export function updateQueryMetrics(status, timeMs = null, count = null, errorMsg = null) {
  const statusBadge = $('#query-status-badge');
  const timeMetric = $('#query-time-metric');
  const timeVal = $('#query-time-val');
  const countMetric = $('#query-count-metric');
  const countVal = $('#query-count-val');
  const errorBox = $('#query-error-box');

  if (statusBadge) {
    statusBadge.className = `badge badge-${status}`;
    if (status === 'idle') statusBadge.textContent = '● In attesa';
    else if (status === 'running') statusBadge.textContent = '⏳ Esecuzione...';
    else if (status === 'success') statusBadge.textContent = '✓ Completato';
    else if (status === 'error') statusBadge.textContent = '✖ Errore';
  }

  if (timeMs !== null && timeMetric && timeVal) {
    timeVal.textContent = timeMs;
    timeMetric.classList.remove('hidden');
  }

  if (count !== null && countMetric && countVal) {
    countVal.textContent = count;
    countMetric.classList.remove('hidden');
  }

  if (errorBox) {
    if (errorMsg) {
      errorBox.textContent = errorMsg;
      errorBox.classList.remove('hidden');
    } else {
      errorBox.classList.add('hidden');
    }
  }
}

// Renderizza i risultati nella vista attiva
export function renderResults(data) {
  currentResults = Array.isArray(data) ? data : (data ? [data] : []);

  if (activeViewMode === 'table') {
    renderResultsTable(currentResults);
  } else {
    renderResultsJsonTree(currentResults);
  }
}

// Render Tabella
function renderResultsTable(rows) {
  const table = $('#query-result-table');
  if (!table) return;
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td style="color: var(--fg-dim); text-align: center;">Nessun risultato da mostrare</td></tr>';
    return;
  }

  // Estrai tutte le colonne uniche
  const cols = new Set();
  rows.forEach((r) => {
    if (r && typeof r === 'object') {
      Object.keys(r).forEach((k) => cols.add(k));
    }
  });

  const colArray = Array.from(cols);
  const headerTr = document.createElement('tr');
  colArray.forEach((colName) => {
    const th = document.createElement('th');
    th.textContent = colName;
    headerTr.appendChild(th);
  });
  thead.appendChild(headerTr);

  // Popola righe
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    colArray.forEach((col) => {
      const td = document.createElement('td');
      const val = row[col];
      const res = displayValue(val);
      td.textContent = (res && typeof res === 'object') ? (res.text ?? '') : String(res ?? '');
      if (res && res.cls) td.className = res.cls;
      td.title = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// Render JSON Tree View
function renderResultsJsonTree(data) {
  const container = $('#query-json-tree');
  if (!container) return;
  container.innerHTML = '';

  if (!data || (Array.isArray(data) && data.length === 0)) {
    container.innerHTML = '<span style="color: var(--fg-dim);">Nessun risultato da mostrare</span>';
    return;
  }

  const tree = buildJsonNode(data, 'root', true);
  container.appendChild(tree);
}

// Costruttore albero JSON interattivo
function buildJsonNode(val, key = null, isRoot = false) {
  const node = document.createElement('div');
  node.className = 'json-node';

  const type = typeof val;

  if (val === null) {
    node.innerHTML = `${key ? `<span class="json-key">${key}</span>: ` : ''}<span class="json-null">null</span>`;
    return node;
  }

  if (type === 'object') {
    const isArray = Array.isArray(val);
    const keys = Object.keys(val);

    const header = document.createElement('div');
    header.className = 'json-header';

    const toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    toggle.textContent = '▼ ';

    const keySpan = key ? `<span class="json-key">${key}</span>: ` : '';
    const bracketOpen = isArray ? '[' : '{';
    const countText = `<span class="json-count">(${keys.length} ${isArray ? 'elementi' : 'chiavi'})</span>`;

    header.innerHTML = `${keySpan}${bracketOpen} ${countText}`;
    header.prepend(toggle);
    node.appendChild(header);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'json-children';
    childrenWrap.style.marginLeft = '16px';

    keys.forEach((k) => {
      childrenWrap.appendChild(buildJsonNode(val[k], k));
    });

    const footer = document.createElement('div');
    footer.className = 'json-footer';
    footer.textContent = isArray ? ']' : '}';
    footer.style.marginLeft = '16px';

    node.appendChild(childrenWrap);
    node.appendChild(footer);

    toggle.addEventListener('click', () => {
      const isHidden = childrenWrap.style.display === 'none';
      childrenWrap.style.display = isHidden ? 'block' : 'none';
      footer.style.display = isHidden ? 'block' : 'none';
      toggle.textContent = isHidden ? '▼ ' : '▶ ';
    });

    return node;
  }

  // Tipi primitivi
  let valHtml = '';
  if (type === 'string') valHtml = `<span class="json-string">"${escapeHtml(val)}"</span>`;
  else if (type === 'number') valHtml = `<span class="json-number">${val}</span>`;
  else if (type === 'boolean') valHtml = `<span class="json-boolean">${val}</span>`;
  else valHtml = `<span>${String(val)}</span>`;

  node.innerHTML = `${key ? `<span class="json-key">${key}</span>: ` : ''}${valHtml}`;
  return node;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render Schema Browser (Task 2)
export function renderQuerySchemaBrowser() {
  const container = $('#query-schema-tree');
  if (!container) return;
  container.innerHTML = '';

  const dbs = state.databases || [];
  if (dbs.length === 0) {
    container.innerHTML = '<div style="color: var(--fg-dim); padding: 10px;">Nessun database caricato.</div>';
    return;
  }

  dbs.forEach((dbObj) => {
    const dbName = typeof dbObj === 'string' ? dbObj : (dbObj && dbObj.name ? dbObj.name : String(dbObj));
    const dbNode = document.createElement('div');
    dbNode.className = 'schema-node';

    const dbLabel = document.createElement('div');
    dbLabel.className = 'schema-node-label';
    dbLabel.innerHTML = `<span>🗄 <strong>${escapeHtml(dbName)}</strong></span>`;

    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'schema-node-children hidden';

    dbLabel.addEventListener('click', () => {
      const isHidden = childrenContainer.classList.contains('hidden');
      childrenContainer.classList.toggle('hidden', !isHidden);

      if (isHidden && childrenContainer.children.length === 0) {
        // Carica collezioni/tabelle
        fetchCollectionsForSchemaBrowser(dbName, childrenContainer);
      }
    });

    dbNode.appendChild(dbLabel);
    dbNode.appendChild(childrenContainer);
    container.appendChild(dbNode);

    // Auto-espandi il DB attivo corrente se corrisponde
    if (state.db && dbName === state.db) {
      childrenContainer.classList.remove('hidden');
      fetchCollectionsForSchemaBrowser(dbName, childrenContainer);
    }
  });
}

function fetchCollectionsForSchemaBrowser(dbName, container) {
  container.innerHTML = '<div style="color: var(--fg-dim); padding: 4px;">Caricamento schema...</div>';
  emit('db:schema', { db: dbName })
    .then((res) => {
      renderSchemaTreeForDb(dbName, container, res.collections);
    })
    .catch(() => {
      // Fallback su db:collections in caso di errore
      emit('db:collections', { db: dbName })
        .then((res) => {
          renderSchemaTreeForDb(dbName, container, res.collections);
        })
        .catch((err) => {
          container.innerHTML = `<div style="color: var(--danger); font-size: 0.85em;">${escapeHtml(err.message || 'Errore caricamento')}</div>`;
        });
    });
}

function renderSchemaTreeForDb(dbName, container, collections) {
  container.innerHTML = '';
  if (!collections || !collections.length) {
    container.innerHTML = '<div style="color: var(--fg-dim); font-size: 0.85em; padding-left: 6px;">(Nessuna collezione/tabella)</div>';
    return;
  }

  collections.forEach((item) => {
    const collName = typeof item === 'string' ? item : (item && item.name ? item.name : String(item));
    const fields = (item && Array.isArray(item.fields)) ? item.fields : [];

    const collNode = document.createElement('div');
    collNode.className = 'schema-node';

    const collLabel = document.createElement('div');
    collLabel.className = 'schema-node-label';
    collLabel.draggable = true;
    const icon = state.dbType === 'mysql' ? '📋' : '📁';
    collLabel.innerHTML = `<span>${icon} <strong>${escapeHtml(collName)}</strong></span>`;

    // Drag & Drop
    collLabel.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', collName);
    });

    // Click per inserire nome nell'editor
    collLabel.addEventListener('dblclick', () => {
      insertTextInEditor(collName);
    });

    const fieldsContainer = document.createElement('div');
    fieldsContainer.className = 'schema-node-children hidden';

    if (fields.length > 0) {
      fields.forEach((field) => {
        const fieldName = typeof field === 'string' ? field : (field.name || field.column || JSON.stringify(field));
        const fieldType = typeof field === 'object' ? (field.type || (Array.isArray(field.types) ? field.types.join('|') : (field.dataType || ''))) : '';

        const fieldNode = document.createElement('div');
        fieldNode.className = 'schema-node';

        const fieldLabel = document.createElement('div');
        fieldLabel.className = 'schema-node-label';
        fieldLabel.draggable = true;
        fieldLabel.style.fontSize = '0.85em';
        fieldLabel.innerHTML = `<span>🔹 ${escapeHtml(fieldName)}</span> ${fieldType ? `<span class="schema-node-type">${escapeHtml(fieldType)}</span>` : ''}`;

        fieldLabel.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', fieldName);
        });

        fieldLabel.addEventListener('dblclick', () => {
          insertTextInEditor(fieldName);
        });

        fieldNode.appendChild(fieldLabel);
        fieldsContainer.appendChild(fieldNode);
      });
    } else {
      fieldsContainer.innerHTML = '<div style="color: var(--fg-dim); font-size: 0.85em; padding-left: 6px;">(Nessun campo rilevato)</div>';
    }

    collLabel.addEventListener('click', (e) => {
      if (e.target.closest('.mini-btn')) return;
      fieldsContainer.classList.toggle('hidden');
    });

    collNode.appendChild(collLabel);
    collNode.appendChild(fieldsContainer);
    container.appendChild(collNode);
  });
}

function filterQuerySchemaBrowser(query) {
  const nodes = document.querySelectorAll('#query-schema-tree .schema-node-label');
  nodes.forEach((node) => {
    const text = node.textContent.toLowerCase();
    const parentNode = node.closest('.schema-node');
    if (parentNode) {
      const match = !query || text.includes(query);
      parentNode.style.display = match ? 'block' : 'none';
    }
  });
}

function insertTextInEditor(text) {
  const input = $('#query-editor-input');
  if (!input) return;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  const val = input.value;
  input.value = val.substring(0, start) + text + val.substring(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  input.focus();
}

// Esecuzione Query (Task 3 runner integration)
export function runQuery() {
  const editorInput = $('#query-editor-input');
  if (!editorInput) return;
  const code = editorInput.value.trim();
  if (!code) return;

  const engine = $('#query-target-engine')?.value || 'auto';
  updateQueryMetrics('running');
  executionStartTime = performance.now();

  const stopBtn = $('#query-stop-btn');
  if (stopBtn) stopBtn.classList.remove('hidden');

  // Emissione evento socket query:execute
  emit('query:execute', {
    code,
    engine,
    db: state.db,
    coll: state.coll,
    dbType: state.dbType
  })
    .then((res) => {
      const elapsed = Math.round(performance.now() - executionStartTime);
      if (stopBtn) stopBtn.classList.add('hidden');

      const rows = res.data || res.docs || res.rows || [];
      updateQueryMetrics('success', elapsed, rows.length);
      renderResults(rows);
    })
    .catch((err) => {
      const elapsed = Math.round(performance.now() - executionStartTime);
      if (stopBtn) stopBtn.classList.add('hidden');

      updateQueryMetrics('error', elapsed, 0, err.message || 'Errore durante l\'esecuzione della query');
      renderResults([]);
    });
}
