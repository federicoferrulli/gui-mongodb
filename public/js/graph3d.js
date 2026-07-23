import { state } from './state.js';
import { $, emit, esc, notify } from './utils.js';
import { openCollTab } from './colltabs.js';
import { setView } from './main.js';

let graphInstance = null;
let currentSchemaData = null;
let selectedNodeId = null;
let autoRotateActive = false;
let autoRotateAnimId = null;
let currentSearchQuery = '';

export function loadGraph3d(force) {
  if (!state.db) return;
  if (!force && state.dbSchema && state.dbSchemaFor === state.db) {
    renderGraph3d();
    return;
  }
  const canvas = $('#graph3d-canvas');
  if (canvas) {
    canvas.innerHTML = '<div class="uml-msg" style="color:#aaa; padding:20px;">Caricamento grafo 3D dello schema…</div>';
  }
  emit('db:schema', { db: state.db })
    .then((res) => {
      res._tab.state.dbSchema = res;
      res._tab.state.dbSchemaFor = res._tab.state.db;
      renderGraph3d();
    })
    .catch((err) => {
      if (canvas) {
        canvas.innerHTML = `<div class="error" style="padding:20px;">${esc(err.message)}</div>`;
      }
    });
}

export function renderGraph3d() {
  const canvas = $('#graph3d-canvas');
  const schema = state.dbSchema;
  if (!schema || !schema.collections || !schema.collections.length) {
    canvas.innerHTML = '<div class="uml-msg" style="color:#aaa; padding:20px;">Nessuna tabella/collection trovata nel database.</div>';
    return;
  }

  currentSchemaData = schema;
  canvas.innerHTML = '';

  const colorMode = ($('#graph3d-color-mode') && $('#graph3d-color-mode').value) || 'prefix';
  const hopFilter = ($('#graph3d-hop-filter') && $('#graph3d-hop-filter').value) || 'all';

  // Calcolo delle adiacenze (grado) e mappa dei vicini
  const neighborsMap = new Map();
  const degreeMap = new Map();
  for (const c of schema.collections) {
    neighborsMap.set(c.name, new Set());
    degreeMap.set(c.name, 0);
  }
  for (const r of schema.relations || []) {
    if (neighborsMap.has(r.from)) neighborsMap.get(r.from).add(r.to);
    if (neighborsMap.has(r.to)) neighborsMap.get(r.to).add(r.from);
    degreeMap.set(r.from, (degreeMap.get(r.from) || 0) + 1);
    degreeMap.set(r.to, (degreeMap.get(r.to) || 0) + 1);
  }

  // Seleziona nodi entro N hop se un nodo è selezionato e hopFilter != 'all'
  let activeNodesSet = null;
  if (selectedNodeId && hopFilter !== 'all') {
    const maxHops = parseInt(hopFilter, 10) || 1;
    activeNodesSet = getNodesWithinHops(selectedNodeId, maxHops, neighborsMap);
  }

  const nodes = schema.collections
    .filter((c) => !activeNodesSet || activeNodesSet.has(c.name))
    .map((c) => {
      const degree = degreeMap.get(c.name) || 0;
      let val = 5;
      if (colorMode === 'degree') {
        val = Math.max(4, Math.min(22, 4 + degree * 3.5));
      } else {
        val = Math.max(3, Math.min(15, (c.fields && c.fields.length) || 5));
      }
      return {
        id: c.name,
        name: c.name,
        degree,
        fieldCount: (c.fields && c.fields.length) || 0,
        fields: c.fields || [],
        val,
      };
    });

  const nodeIdsSet = new Set(nodes.map((n) => n.id));
  const edges = (schema.relations || [])
    .filter((r) => nodeIdsSet.has(r.from) && nodeIdsSet.has(r.to))
    .map((r) => ({
      source: r.from,
      target: r.to,
      label: r.field,
      many: r.many,
    }));

  const graphData = { nodes, links: edges };

  if (typeof ForceGraph3D === 'undefined') {
    canvas.innerHTML = '<div class="error" style="padding:20px;">Libreria 3D Force Graph non disponibile.</div>';
    return;
  }

  const prefixColors = ['#4a9eff', '#50e3c2', '#f5a623', '#b8e986', '#bd10e0', '#9013fe', '#e65100', '#ff4081', '#00e676'];

  graphInstance = ForceGraph3D({ preserveDrawingBuffer: true })(canvas)
    .graphData(graphData)
    .nodeId('id')
    .nodeLabel((node) => `<div style="background:rgba(15,20,28,0.95); padding:8px 12px; border-radius:6px; border:1px solid #4a9eff; font-family:sans-serif; color:#fff; font-size:12px;"><b>${esc(node.name)}</b><br/><small style="color:#aaa;">${node.fieldCount} campi • ${node.degree} relazioni</small></div>`)
    .nodeColor((node) => {
      // Dimming per nodi non selezionati/non collegati
      if (selectedNodeId && selectedNodeId !== node.id && !isNeighbor(selectedNodeId, node.id, neighborsMap)) {
        return 'rgba(50, 55, 65, 0.25)';
      }
      if (colorMode === 'degree') {
        return getDegreeColor(node.degree);
      }
      const prefix = getTablePrefix(node.name);
      return prefixColors[Math.abs(hashString(prefix)) % prefixColors.length];
    })
    .nodeRelSize(4)
    .linkDirectionalParticles(2)
    .linkDirectionalParticleSpeed(0.006)
    .linkLabel((link) => `<span style="color:#aaa;">${esc(link.label)}${link.many ? ' [N]' : ''}</span>`)
    .linkColor((link) => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      if (selectedNodeId && srcId !== selectedNodeId && tgtId !== selectedNodeId) {
        return 'rgba(40, 45, 55, 0.15)';
      }
      return '#4a9eff';
    })
    .linkWidth((link) => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      return selectedNodeId && (srcId === selectedNodeId || tgtId === selectedNodeId) ? 2.8 : 1.2;
    })
    .onNodeClick((node) => {
      selectedNodeId = node.id;
      const distance = 120;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z || 1);
      graphInstance.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: (node.z || 0) * distRatio },
        { x: node.x, y: node.y, z: node.z || 0 },
        1200
      );

      showTableDetailsPanel(node.name, currentSearchQuery);
      // Aggiorna gli stili di dimming e ampiezza archi
      graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
    });

  if (typeof THREE !== 'undefined') {
    graphInstance.nodeThreeObject((node) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: createTextTexture(node.name),
          depthTest: false,
        })
      );
      sprite.scale.set(36, 18, 1);
      sprite.position.y = 12;
      return sprite;
    });
    graphInstance.nodeThreeObjectExtend(true);
  }

  // Ripristina l'auto-rotate se attivo
  if (autoRotateActive && graphInstance.controls()) {
    graphInstance.controls().autoRotate = true;
    graphInstance.controls().autoRotateSpeed = 1.5;
  }

  const resizeObserver = new ResizeObserver(() => {
    if (graphInstance && canvas && canvas.clientWidth > 0) {
      graphInstance.width(canvas.clientWidth);
      graphInstance.height(canvas.clientHeight);
    }
  });
  resizeObserver.observe(canvas);
}

function getTablePrefix(name) {
  const parts = name.split('_');
  return parts.length > 1 ? parts[0] : name;
}

function getDegreeColor(degree) {
  if (degree <= 1) return '#4a9eff'; // Blu tenue
  if (degree <= 3) return '#50e3c2'; // Turchese
  if (degree <= 5) return '#f5a623'; // Arancione
  return '#e5534b'; // Rosso brillante per nodi hub centrati
}

function isNeighbor(id1, id2, map) {
  const set = map.get(id1);
  return set ? set.has(id2) : false;
}

function getNodesWithinHops(startId, maxHops, map) {
  const result = new Set([startId]);
  let currentLevel = new Set([startId]);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextLevel = new Set();
    for (const nodeId of currentLevel) {
      const neighbors = map.get(nodeId);
      if (neighbors) {
        for (const n of neighbors) {
          if (!result.has(n)) {
            result.add(n);
            nextLevel.add(n);
          }
        }
      }
    }
    currentLevel = nextLevel;
  }
  return result;
}

function showTableDetailsPanel(tableName, highlightQuery) {
  const panel = $('#graph3d-side-panel');
  const title = $('#graph3d-panel-title');
  const content = $('#graph3d-panel-content');
  const schema = state.dbSchema || currentSchemaData;
  if (!panel || !schema) return;

  const collection = schema.collections.find((c) => c.name === tableName);
  if (!collection) return;

  title.textContent = collection.name;

  let html = '';

  html += `<div class="side-panel-section">
    <h4>Campi / Colonne (${collection.fields.length})</h4>
    <ul class="side-panel-fields">`;
  for (const f of collection.fields) {
    const isPk = f.pk || f.name === '_id';
    const typeStr = (f.types || []).join(' | ') || 'any';
    const isMatched = highlightQuery && f.name.toLowerCase().includes(highlightQuery.toLowerCase());
    const highlightStyle = isMatched ? 'style="background: rgba(74, 158, 255, 0.25); border: 1px solid #4a9eff;"' : '';

    html += `<li ${highlightStyle}>
      <span class="field-name">${esc(f.name)} ${isMatched ? '🔍' : ''}</span>
      <span>
        ${isPk ? '<span class="field-badge pk">PK</span> ' : ''}
        <span class="field-badge">${esc(typeStr)}</span>
      </span>
    </li>`;
  }
  html += `</ul></div>`;

  const rels = (schema.relations || []).filter((r) => r.from === tableName || r.to === tableName);
  if (rels.length) {
    html += `<div class="side-panel-section">
      <h4>Relazioni (${rels.length})</h4>
      <ul class="side-panel-fields">`;
    for (const r of rels) {
      const isOutgoing = r.from === tableName;
      const target = isOutgoing ? r.to : r.from;
      const arrow = isOutgoing ? '→' : '←';
      html += `<li>
        <span><strong style="color:#4a9eff">${arrow}</strong> ${esc(target)}</span>
        <span class="field-badge" style="cursor:pointer;" data-jump-node="${esc(target)}" title="Centra nel grafo 3D">${esc(r.field)}</span>
      </li>`;
    }
    html += `</ul></div>`;
  }

  html += `<div class="side-panel-actions">
    <button type="button" id="panel-btn-open-grid" class="primary" style="flex:1;">▤ Apri Tab Dati</button>
    <button type="button" id="panel-btn-open-uml" class="ghost" style="flex:1;">◫ Apri Tab UML</button>
  </div>`;

  content.innerHTML = html;
  panel.classList.remove('hidden');

  content.querySelectorAll('[data-jump-node]').forEach((el) => {
    el.addEventListener('click', () => {
      const targetName = el.dataset.jumpNode;
      selectedNodeId = targetName;
      if (!graphInstance) return;
      const targetNode = graphInstance.graphData().nodes.find((n) => n.name === targetName);
      if (targetNode && targetNode.x != null) {
        const distance = 120;
        const distRatio = 1 + distance / Math.hypot(targetNode.x, targetNode.y, targetNode.z || 1);
        graphInstance.cameraPosition(
          { x: targetNode.x * distRatio, y: targetNode.y * distRatio, z: (targetNode.z || 0) * distRatio },
          { x: targetNode.x, y: targetNode.y, z: targetNode.z || 0 },
          1200
        );
        showTableDetailsPanel(targetName, currentSearchQuery);
      }
    });
  });

  const openGridBtn = $('#panel-btn-open-grid');
  if (openGridBtn) {
    openGridBtn.addEventListener('click', () => {
      if (state.db) {
        openCollTab(state.db, tableName);
        setView('data');
      }
    });
  }

  const openUmlBtn = $('#panel-btn-open-uml');
  if (openUmlBtn) {
    openUmlBtn.addEventListener('click', () => {
      if (state.db) {
        openCollTab(state.db, tableName);
        setView('uml');
      }
    });
  }
}

function sanitizeName(str) {
  if (!str) return 'entity';
  return String(str).replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildMermaidDiagram() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) return '';
  let lines = ['erDiagram'];
  for (const c of schema.collections) {
    const cName = sanitizeName(c.name);
    lines.push(`    ${cName} {`);
    for (const f of c.fields || []) {
      const typeStr = (f.types && f.types[0]) ? sanitizeName(f.types[0]) : 'string';
      const fName = sanitizeName(f.name);
      lines.push(`        ${typeStr} ${fName}`);
    }
    lines.push('    }');
  }
  for (const r of schema.relations || []) {
    const fromName = sanitizeName(r.from);
    const toName = sanitizeName(r.to);
    const fieldName = sanitizeName(r.field);
    lines.push(`    ${fromName} ||--o{ ${toName} : "${fieldName}"`);
  }
  return lines.join('\n');
}

function buildDbmlDiagram() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) return '';
  let lines = [`// Database Markup Language (DBML) per dbdiagram.io`, `Project "${state.db || 'database'}" {`, `  database_type: '${state.dbType || 'MySQL'}'`, `}`, ''];
  for (const c of schema.collections) {
    lines.push(`Table "${c.name}" {`);
    for (const f of c.fields || []) {
      const typeStr = (f.types && f.types[0]) ? f.types[0] : 'varchar';
      const isPk = f.pk || f.name === '_id';
      lines.push(`  "${f.name}" ${typeStr}${isPk ? ' [pk]' : ''}`);
    }
    lines.push('}\n');
  }
  for (const r of schema.relations || []) {
    lines.push(`Ref: "${r.from}"."${r.field}" > "${r.to}"."_id"`);
  }
  return lines.join('\n');
}

function buildSqlDdl() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) return '';
  let lines = [`-- Script DDL generato per database ${state.db || 'db'}`, ''];
  for (const c of schema.collections) {
    lines.push(`CREATE TABLE \`${c.name}\` (`);
    const colDefs = [];
    for (const f of c.fields || []) {
      const isPk = f.pk || f.name === '_id';
      const type = (f.types && f.types[0]) ? f.types[0].toUpperCase() : 'VARCHAR(255)';
      colDefs.push(`  \`${f.name}\` ${type}${isPk ? ' NOT NULL PRIMARY KEY' : ''}`);
    }
    lines.push(colDefs.join(',\n'));
    lines.push(');\n');
  }
  for (const r of schema.relations || []) {
    lines.push(`ALTER TABLE \`${r.from}\` ADD CONSTRAINT \`fk_${r.from}_${r.field}\` FOREIGN KEY (\`${r.field}\`) REFERENCES \`${r.to}\` (\`id\`);`);
  }
  return lines.join('\n');
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function createTextTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15, 20, 28, 0.85)';
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 4;
  if (ctx.roundRect) {
    ctx.roundRect(4, 4, 248, 120, 12);
  } else {
    ctx.rect(4, 4, 248, 120);
  }
  ctx.fill();
  ctx.stroke();

  ctx.font = 'Bold 28px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const truncated = text.length > 15 ? text.slice(0, 13) + '…' : text;
  ctx.fillText(truncated, 128, 64);

  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

export function initGraph3d() {
  // Ricerca Avanzata per Nome Tabella e per Nome Campo
  const searchInput = $('#graph3d-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.trim().toLowerCase();
      const schema = state.dbSchema || currentSchemaData;
      if (!currentSearchQuery || !graphInstance || !schema) return;

      // Cerca prima per nome tabella, altrimenti per nome campo contenuto
      let targetNode = graphInstance.graphData().nodes.find((n) => n.name.toLowerCase().includes(currentSearchQuery));
      if (!targetNode) {
        targetNode = graphInstance.graphData().nodes.find((n) =>
          (n.fields || []).some((f) => f.name.toLowerCase().includes(currentSearchQuery))
        );
      }

      if (targetNode && targetNode.x != null) {
        selectedNodeId = targetNode.id;
        const distance = 100;
        const distRatio = 1 + distance / Math.hypot(targetNode.x, targetNode.y, targetNode.z || 1);
        graphInstance.cameraPosition(
          { x: targetNode.x * distRatio, y: targetNode.y * distRatio, z: (targetNode.z || 0) * distRatio },
          { x: targetNode.x, y: targetNode.y, z: targetNode.z || 0 },
          1200
        );
        showTableDetailsPanel(targetNode.name, currentSearchQuery);
      }
    });
  }

  // Cambio Modalità Colori (Prefisso vs Centralità)
  const colorSelect = $('#graph3d-color-mode');
  if (colorSelect) {
    colorSelect.addEventListener('change', () => renderGraph3d());
  }

  // Cambio Filtro Hop (1° Livello, 2° Livello, Tutti)
  const hopSelect = $('#graph3d-hop-filter');
  if (hopSelect) {
    hopSelect.addEventListener('change', () => renderGraph3d());
  }

  // Auto-Rotate 3D Presentation Mode
  const autoRotateBtn = $('#graph3d-auto-rotate');
  if (autoRotateBtn) {
    autoRotateBtn.addEventListener('click', () => {
      autoRotateActive = !autoRotateActive;
      autoRotateBtn.classList.toggle('active', autoRotateActive);
      if (graphInstance && graphInstance.controls()) {
        graphInstance.controls().autoRotate = autoRotateActive;
        graphInstance.controls().autoRotateSpeed = 1.5;
      }
      notify(autoRotateActive ? 'Modalità Auto-Rotate 3D attivata' : 'Auto-Rotate disattivata');
    });
  }

  const closePanelBtn = $('#graph3d-panel-close');
  if (closePanelBtn) {
    closePanelBtn.addEventListener('click', () => {
      const panel = $('#graph3d-side-panel');
      if (panel) panel.classList.add('hidden');
      selectedNodeId = null;
      if (graphInstance) {
        graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
      }
    });
  }

  const resetBtn = $('#graph3d-reset-cam');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      selectedNodeId = null;
      if (graphInstance) {
        graphInstance.zoomToFit(1000, 50);
        graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
      }
    });
  }

  const refreshBtn = $('#graph3d-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadGraph3d(true));
  }

  // Export PNG
  const exportPngBtn = $('#graph3d-export-png');
  if (exportPngBtn) {
    exportPngBtn.addEventListener('click', () => {
      if (!graphInstance) return;
      try {
        const renderer = graphInstance.renderer();
        const scene = graphInstance.scene();
        const camera = graphInstance.camera();
        renderer.render(scene, camera);
        const dataUrl = renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `schema-${state.db || 'db'}-3d.png`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        notify('Immagine PNG esportata con successo!');
      } catch (err) {
        console.error('Errore export PNG:', err);
        notify('Impossibile esportare l\'immagine PNG.');
      }
    });
  }

  // Export Mermaid
  const exportMermaidBtn = $('#graph3d-export-mermaid');
  if (exportMermaidBtn) {
    exportMermaidBtn.addEventListener('click', () => {
      const mermaidText = buildMermaidDiagram();
      if (!mermaidText) {
        notify('Nessun dato di schema disponibile per Mermaid.');
        return;
      }
      const textarea = $('#mermaid-textarea');
      const modal = $('#mermaid-modal');
      if (textarea && modal) {
        textarea.value = mermaidText;
        modal.classList.remove('hidden');
      }
    });
  }

  const mermaidCloseBtn = $('#mermaid-modal-close');
  if (mermaidCloseBtn) {
    mermaidCloseBtn.addEventListener('click', () => {
      $('#mermaid-modal').classList.add('hidden');
    });
  }

  const mermaidCopyBtn = $('#mermaid-modal-copy');
  if (mermaidCopyBtn) {
    mermaidCopyBtn.addEventListener('click', () => {
      const textarea = $('#mermaid-textarea');
      if (!textarea) return;
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        notify('Diagramma Mermaid copiato negli appunti!');
      }).catch(() => {
        document.execCommand('copy');
        notify('Diagramma Mermaid copiato negli appunti!');
      });
    });
  }

  // Export DBML
  const exportDbmlBtn = $('#graph3d-export-dbml');
  if (exportDbmlBtn) {
    exportDbmlBtn.addEventListener('click', () => {
      const dbmlText = buildDbmlDiagram();
      if (!dbmlText) {
        notify('Nessun dato di schema disponibile per DBML.');
        return;
      }
      const textarea = $('#dbml-textarea');
      const modal = $('#dbml-modal');
      if (textarea && modal) {
        textarea.value = dbmlText;
        modal.classList.remove('hidden');
      }
    });
  }

  const dbmlCloseBtn = $('#dbml-modal-close');
  if (dbmlCloseBtn) {
    dbmlCloseBtn.addEventListener('click', () => {
      $('#dbml-modal').classList.add('hidden');
    });
  }

  const dbmlCopyBtn = $('#dbml-modal-copy');
  if (dbmlCopyBtn) {
    dbmlCopyBtn.addEventListener('click', () => {
      const textarea = $('#dbml-textarea');
      if (!textarea) return;
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        notify('Schema DBML copiato negli appunti!');
      }).catch(() => {
        document.execCommand('copy');
        notify('Schema DBML copiato negli appunti!');
      });
    });
  }

  // Export SQL DDL
  const exportSqlBtn = $('#graph3d-export-sql');
  if (exportSqlBtn) {
    exportSqlBtn.addEventListener('click', () => {
      const sqlText = buildSqlDdl();
      if (!sqlText) {
        notify('Nessun dato di schema disponibile per SQL DDL.');
        return;
      }
      const textarea = $('#sql-textarea');
      const modal = $('#sql-modal');
      if (textarea && modal) {
        textarea.value = sqlText;
        modal.classList.remove('hidden');
      }
    });
  }

  const sqlCloseBtn = $('#sql-modal-close');
  if (sqlCloseBtn) {
    sqlCloseBtn.addEventListener('click', () => {
      $('#sql-modal').classList.add('hidden');
    });
  }

  const sqlCopyBtn = $('#sql-modal-copy');
  if (sqlCopyBtn) {
    sqlCopyBtn.addEventListener('click', () => {
      const textarea = $('#sql-textarea');
      if (!textarea) return;
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        notify('Script SQL DDL copiato negli appunti!');
      }).catch(() => {
        document.execCommand('copy');
        notify('Script SQL DDL copiato negli appunti!');
      });
    });
  }
}
