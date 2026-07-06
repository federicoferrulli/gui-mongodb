'use strict';

import { state } from './state.js';
import { onTabChange } from './tabs.js';
import { $ } from './utils.js';
import { initUml, loadUml } from './uml.js';
import { initConnection } from './connection.js';
import { initConnManager } from './connmanager.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace } from './workspace.js';
import { initDbTree } from './dbtree.js';
import { initSchemaOps } from './schema-ops.js';
import { initGrid } from './grid.js';
import { initCellSelect } from './cellselect.js';
import { initInlineEdit } from './inlineEdit.js';
import { initInsert } from './insert.js';
import { initDetails, loadDetails } from './details.js';
import { initLive } from './live.js';

export function setView(view) {
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

// Maniglie di ridimensionamento orizzontale: ogni .resizer ridimensiona
// l'elemento indicato da data-resize; la larghezza è ricordata in localStorage.
function initResizers() {
  document.querySelectorAll('.resizer[data-resize]').forEach((rz) => {
    const el = document.getElementById(rz.dataset.resize);
    if (!el) return;
    const key = `gui-db:width:${rz.dataset.resize}`;
    const saved = localStorage.getItem(key);
    if (saved) el.style.width = saved;
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      rz.classList.add('dragging');
      const move = (ev) => {
        el.style.width = Math.min(Math.max(150, startW + ev.clientX - startX), window.innerWidth * 0.45) + 'px';
      };
      const up = () => {
        rz.classList.remove('dragging');
        localStorage.setItem(key, el.style.width);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

// Cambio del tab attivo (switch o chiusura): ri-render di barra e workspace.
onTabChange(() => {
  renderTabBar();
  renderWorkspace();
});

initUml();
initConnection();
initConnManager();
initDbTree();
initSchemaOps();
initGrid();
initCellSelect();
initInlineEdit();
initInsert();
initDetails();
initLive();
initResizers();

// Stato iniziale: nessun tab aperto, schermata di benvenuto.
renderTabBar();
renderWorkspace();
