'use strict';

import { $ } from './utils.js';
import { runQuery } from './query-tab.js';

// Libreria di Preset e Template pronti all'uso
export const PRESETS = [
  {
    name: '🐬 MySQL: Multi-table JOIN',
    engine: 'mysql',
    code: `-- Query MySQL Multi-Table JOIN\nSELECT \n  u.id AS user_id,\n  u.name,\n  u.email,\n  o.id AS order_id,\n  o.total_amount\nFROM users u\nJOIN orders o ON u.id = o.user_id\nWHERE u.status = 'active'\nLIMIT 50;`
  },
  {
    name: '🐬 MySQL: Temporal GROUP BY',
    engine: 'mysql',
    code: `-- Aggregazione Temporale MySQL\nSELECT \n  DATE(created_at) AS order_date,\n  COUNT(*) AS total_orders,\n  SUM(total_amount) AS revenue\nFROM orders\nWHERE created_at >= '2026-01-01'\nGROUP BY DATE(created_at)\nORDER BY order_date DESC;`
  },
  {
    name: '🐬 MySQL: Window Functions',
    engine: 'mysql',
    code: `-- Ranking & Window Functions MySQL\nSELECT \n  name,\n  department,\n  salary,\n  DENSE_RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS salary_rank\nFROM employees;`
  },
  {
    name: '🍃 MongoDB: Pipeline $lookup (JOIN)',
    engine: 'mongodb',
    code: `[\n  {\n    "$lookup": {\n      "from": "orders",\n      "localField": "_id",\n      "foreignField": "user_id",\n      "as": "user_orders"\n    }\n  },\n  {\n    "$limit": 20\n  }\n]`
  },
  {
    name: '🍃 MongoDB: $unwind & $group',
    engine: 'mongodb',
    code: `[\n  {\n    "$unwind": "$items"\n  },\n  {\n    "$group": {\n      "_id": "$items.category",\n      "total_sales": { "$sum": "$items.price" },\n      "count": { "$sum": 1 }\n    }\n  },\n  {\n    "$sort": { "total_sales": -1 }\n  }\n]`
  },
  {
    name: '🍃 MongoDB: $facet Multi-Pipeline',
    engine: 'mongodb',
    code: `[\n  {\n    "$facet": {\n      "total_stats": [\n        { "$count": "total_documents" }\n      ],\n      "recent_docs": [\n        { "$sort": { "created_at": -1 } },\n        { "$limit": 5 }\n      ]\n    }\n  }\n]`
  },
  {
    name: '🔀 Cross-DB: Virtual JOIN (MySQL ➔ MongoDB)',
    engine: 'crossdb',
    code: `{\n  "virtualJoin": {\n    "sourceA": {\n      "dbType": "mysql",\n      "db": "shop",\n      "table": "orders",\n      "query": "SELECT id, user_id, total_amount FROM orders LIMIT 50"\n    },\n    "sourceB": {\n      "dbType": "mongodb",\n      "db": "crm",\n      "collection": "customers",\n      "foreignKey": "_id"\n    },\n    "on": {\n      "leftKey": "user_id",\n      "rightKey": "_id"\n    },\n    "as": "customer_details"\n  }\n}`
  }
];

export function initSnippetManager() {
  const snippetBtn = $('#query-snippet-btn');
  const exportCsvBtn = $('#query-export-csv');
  const exportJsonBtn = $('#query-export-json');
  const exportSqlBtn = $('#query-export-sql');

  if (snippetBtn) {
    snippetBtn.addEventListener('click', () => openSnippetModal());
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => exportResults('csv'));
  }
  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => exportResults('json'));
  }
  if (exportSqlBtn) {
    exportSqlBtn.addEventListener('click', () => exportResults('sql'));
  }
}

// Modale Snippets
export function openSnippetModal() {
  let modal = $('#snippet-overlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'snippet-overlay';
    modal.className = 'overlay';
    modal.innerHTML = `
      <div class="modal wide">
        <h2>📚 Libreria Snippet & Template Query</h2>
        <p class="subtitle">Seleziona un preset o inserisci parametri per la tua query</p>

        <div style="display: flex; gap: 12px; margin-bottom: 12px;">
          <div style="flex: 1;">
            <label style="display:block; margin-bottom:4px; font-weight:600;">Seleziona Preset:</label>
            <select id="snippet-preset-select" class="styled-select" style="width: 100%; padding: 6px;">
              ${PRESETS.map((p, idx) => `<option value="${idx}">${p.name}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display:block; margin-bottom:4px; font-weight:600;">Anteprima Codice:</label>
          <textarea id="snippet-preview" rows="8" spellcheck="false" readonly style="width:100%; font-family:monospace; background:var(--input-bg); color:var(--fg); border:1px solid var(--border-2); padding:8px;"></textarea>
        </div>

        <div class="modal-actions">
          <button type="button" id="snippet-cancel-btn" class="ghost">Annulla</button>
          <button type="button" id="snippet-use-btn" class="primary">Incolla nell'Editor</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const select = modal.querySelector('#snippet-preset-select');
    const preview = modal.querySelector('#snippet-preview');
    const cancelBtn = modal.querySelector('#snippet-cancel-btn');
    const useBtn = modal.querySelector('#snippet-use-btn');

    const updatePreview = () => {
      const idx = parseInt(select.value, 10);
      if (PRESETS[idx]) {
        preview.value = PRESETS[idx].code;
      }
    };

    select.addEventListener('change', updatePreview);
    updatePreview();

    cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));

    useBtn.addEventListener('click', () => {
      const idx = parseInt(select.value, 10);
      const preset = PRESETS[idx];
      if (preset) {
        const editor = $('#query-editor-input');
        const engineSelect = $('#query-target-engine');
        if (editor) editor.value = preset.code;
        if (engineSelect) engineSelect.value = preset.engine;
      }
      modal.classList.add('hidden');
    });
  } else {
    modal.classList.remove('hidden');
  }
}

// Esportazione dei risultati
export function exportResults(format) {
  const table = $('#query-result-table');
  if (!table) return;

  const rows = [];
  const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
  const trs = table.querySelectorAll('tbody tr');

  trs.forEach((tr) => {
    const rowObj = {};
    const tds = tr.querySelectorAll('td');
    headers.forEach((h, idx) => {
      rowObj[h] = tds[idx] ? tds[idx].textContent : '';
    });
    rows.push(rowObj);
  });

  if (!rows.length) {
    alert('Nessun dato da esportare.');
    return;
  }

  let content = '';
  let filename = `query_result_${Date.now()}`;
  let mimeType = 'text/plain';

  if (format === 'csv') {
    filename += '.csv';
    mimeType = 'text/csv';
    content = headers.join(',') + '\n';
    rows.forEach((r) => {
      const vals = headers.map((h) => `"${String(r[h] || '').replace(/"/g, '""')}"`);
      content += vals.join(',') + '\n';
    });
  } else if (format === 'json') {
    filename += '.json';
    mimeType = 'application/json';
    content = JSON.stringify(rows, null, 2);
  } else if (format === 'sql') {
    filename += '.sql';
    mimeType = 'application/sql';
    content = rows.map((r) => {
      const cols = Object.keys(r).map((k) => `\`${k}\``).join(', ');
      const vals = Object.values(r).map((v) => `'${String(v).replace(/'/g, "\\'")}'`).join(', ');
      return `INSERT INTO \`query_result\` (${cols}) VALUES (${vals});`;
    }).join('\n');
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
