'use strict';

import { tabs, switchTab, closeTab } from './tabs.js';
import { $, makeDraggable, reorderById } from './utils.js';
import { saveWorkspaceInputs, renderWorkspace } from './workspace.js';
import { openConnModal } from './connection.js';

export function renderTabBar() {
  const bar = $('#tab-bar');
  bar.innerHTML = '';

  for (const tab of tabs.list) {
    if (!tab.state.connected) continue; // i tab compaiono a connessione riuscita
    const el = document.createElement('div');
    el.className = 'conn-tab' + (tab.id === tabs.activeId ? ' active' : '');
    el.title = tab.state.connLabel;

    const dot = document.createElement('span');
    dot.className = `dot ${tab.dbType}`;
    const name = document.createElement('span');
    name.className = 'conn-tab-name';
    name.textContent = tab.label || 'Connessione';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'conn-tab-close';
    close.title = 'Chiudi tab (disconnette)';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      // closeTab notifica i listener solo se era il tab attivo: il ri-render
      // della barra va fatto comunque.
      closeTab(tab.id);
      renderTabBar();
      renderWorkspace();
    });

    el.addEventListener('click', () => {
      if (tab.id === tabs.activeId) return;
      saveWorkspaceInputs(); // snapshot degli input del tab che si lascia
      switchTab(tab.id);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return; // click centrale = chiudi, come nei browser
      closeTab(tab.id);
      renderTabBar();
      renderWorkspace();
    });

    makeDraggable(el, tab.id, (fromId, toId) => {
      if (reorderById(tabs.list, fromId, toId)) renderTabBar();
    });

    el.append(dot, name, close);
    bar.appendChild(el);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.id = 'tab-add-btn';
  add.title = 'Nuova connessione';
  add.textContent = '＋';
  add.addEventListener('click', () => openConnModal());
  bar.appendChild(add);
}
