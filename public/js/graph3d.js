import { state } from './state.js';
import { $, emit, esc, notify } from './utils.js';
import { openCollTab } from './colltabs.js';
import { setView } from './main.js';

let graphInstance = null;
let currentSchemaData = null;
let selectedNodeId = null;
let autoRotateActive = false;
let is2DMode = false;
let showImplicitRelations = true;
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
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) {
    if (canvas) {
      canvas.innerHTML = '<div class="uml-msg" style="color:#aaa; padding:20px;">Nessuna tabella/collection trovata nello schema.</div>';
    }
    return;
  }

  currentSchemaData = schema;
  canvas.innerHTML = '';

  const colorMode = ($('#graph3d-color-mode') && $('#graph3d-color-mode').value) || 'prefix';
  const hopFilter = ($('#graph3d-hop-filter') && $('#graph3d-hop-filter').value) || 'all';

  const neighborsMap = new Map();
  const degreeMap = new Map();
  for (const c of schema.collections) {
    neighborsMap.set(c.name, new Set());
    degreeMap.set(c.name, 0);
  }

  const allRelations = [...(schema.relations || [])];

  if (showImplicitRelations) {
    const implicitRels = detectImplicitRelations(schema.collections, allRelations);
    allRelations.push(...implicitRels);
  }

  for (const r of allRelations) {
    if (neighborsMap.has(r.from)) neighborsMap.get(r.from).add(r.to);
    if (neighborsMap.has(r.to)) neighborsMap.get(r.to).add(r.from);
    degreeMap.set(r.from, (degreeMap.get(r.from) || 0) + 1);
    degreeMap.set(r.to, (degreeMap.get(r.to) || 0) + 1);
  }

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
      const nodeObj = {
        id: c.name,
        name: c.name,
        degree,
        fieldCount: (c.fields && c.fields.length) || 0,
        fields: c.fields || [],
        val,
      };
      if (is2DMode) {
        nodeObj.fz = 0;
      }
      return nodeObj;
    });

  const nodeIdsSet = new Set(nodes.map((n) => n.id));
  const edges = allRelations
    .filter((r) => nodeIdsSet.has(r.from) && nodeIdsSet.has(r.to))
    .map((r) => ({
      source: r.from,
      target: r.to,
      label: r.field,
      many: r.many,
      implicit: !!r.implicit,
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
    .linkDirectionalParticles((link) => (link.implicit ? 4 : 2))
    .linkDirectionalParticleSpeed((link) => (link.implicit ? 0.012 : 0.006))
    .linkLabel((link) => `<span style="color:#aaa;">${esc(link.label)}${link.implicit ? ' (Implicita)' : ''}${link.many ? ' [N]' : ''}</span>`)
    .linkColor((link) => {
      if (link.implicit) return '#bd10e0';
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
      const distance = is2DMode ? 200 : 120;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, (is2DMode ? 0 : node.z) || 1);
      graphInstance.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: is2DMode ? 300 : (node.z || 0) * distRatio },
        { x: node.x, y: node.y, z: is2DMode ? 0 : node.z || 0 },
        1200
      );

      showTableDetailsPanel(node.name, currentSearchQuery);
      graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
    });

  if (is2DMode) {
    graphInstance.cameraPosition({ x: 0, y: 0, z: 350 }, { x: 0, y: 0, z: 0 }, 500);
  }

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

function detectImplicitRelations(collections, existingRelations) {
  const existingSet = new Set((existingRelations || []).map((r) => `${r.from}.${r.field}->${r.to}`));
  const implicit = [];

  for (const c of collections) {
    for (const f of c.fields || []) {
      if (f.name === '_id' || f.pk) continue;
      const low = f.name.toLowerCase();
      const match = low.match(/^(.+?)_?ids?$/);
      if (match) {
        const base = match[1];
        const target = collections.find((x) => x.name.toLowerCase() === base || x.name.toLowerCase() === base + 's');
        if (target && target.name !== c.name) {
          const key = `${c.name}.${f.name}->${target.name}`;
          if (!existingSet.has(key)) {
            implicit.push({
              from: c.name,
              field: f.name,
              to: target.name,
              many: true,
              implicit: true,
            });
            existingSet.add(key);
          }
        }
      }
    }
  }
  return implicit;
}

function getTablePrefix(name) {
  const parts = name.split('_');
  return parts.length > 1 ? parts[0] : name;
}

function getDegreeColor(degree) {
  if (degree <= 1) return '#4a9eff';
  if (degree <= 3) return '#50e3c2';
  if (degree <= 5) return '#f5a623';
  return '#e5534b';
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

// 1. Health Check & Schema Audit Algorithm
function runSchemaAudit() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) {
    notify('Nessuno schema disponibile per la diagnostica.');
    return;
  }

  const issues = [];
  let score = 100;

  const neighborsMap = new Map();
  for (const c of schema.collections) neighborsMap.set(c.name, 0);
  for (const r of schema.relations || []) {
    neighborsMap.set(r.from, (neighborsMap.get(r.from) || 0) + 1);
    neighborsMap.set(r.to, (neighborsMap.get(r.to) || 0) + 1);
  }

  const orphans = schema.collections.filter((c) => (neighborsMap.get(c.name) || 0) === 0);
  if (orphans.length) {
    score -= Math.min(30, orphans.length * 10);
    issues.push({
      type: 'warn',
      title: `Tabelle Orfane (${orphans.length})`,
      desc: `Le seguenti tabelle non hanno alcuna relazione dichiarata o implicita: ${orphans.map((o) => `<b>${esc(o.name)}</b>`).join(', ')}.`,
    });
  }

  const oversized = schema.collections.filter((c) => c.fields && c.fields.length > 25);
  if (oversized.length) {
    score -= Math.min(20, oversized.length * 5);
    issues.push({
      type: 'warn',
      title: `Tabelle Molto Grandi (${oversized.length})`,
      desc: `Tabelle con più di 25 colonne (potenziale refactoring): ${oversized.map((o) => `<b>${esc(o.name)} (${o.fields.length} campi)</b>`).join(', ')}.`,
    });
  }

  const missingPk = schema.collections.filter((c) => !(c.fields || []).some((f) => f.pk || f.name === '_id'));
  if (missingPk.length) {
    score -= Math.min(30, missingPk.length * 15);
    issues.push({
      type: 'bad',
      title: `Tabelle senza Chiave Primaria (${missingPk.length})`,
      desc: `Tabelle prive di PK esplicita o campo _id: ${missingPk.map((m) => `<b>${esc(m.name)}</b>`).join(', ')}.`,
    });
  }

  score = Math.max(0, score);
  let scoreClass = 'audit-score-good';
  if (score < 80) scoreClass = 'audit-score-warn';
  if (score < 50) scoreClass = 'audit-score-bad';

  let html = `<div class="audit-score-card">
    <div class="audit-score-val ${scoreClass}">${score}%</div>
    <div>
      <h3 style="margin:0; color:var(--fg,#e1e4e8);">Punteggio Salute Schema</h3>
      <small style="color:var(--fg-dim,#8b949e);">${schema.collections.length} tabelle analizzate, ${schema.relations ? schema.relations.length : 0} relazioni controllate.</small>
    </div>
  </div>`;

  if (!issues.length) {
    html += `<div class="audit-issue-item" style="border-left-color:#00e676;">
      <div class="audit-issue-title" style="color:#00e676;">✓ Nessun problema rilevato!</div>
      <div class="audit-issue-desc">Lo schema rispetta tutte le best practice di strutturazione.</div>
    </div>`;
  } else {
    for (const issue of issues) {
      html += `<div class="audit-issue-item ${issue.type}">
        <div class="audit-issue-title">${issue.title}</div>
        <div class="audit-issue-desc">${issue.desc}</div>
      </div>`;
    }
  }

  const modalContent = $('#audit-content');
  if (modalContent) {
    modalContent.innerHTML = html;
    $('#audit-modal').classList.remove('hidden');
  }
}

// 3. Salva File Locale JSON (Download su Disco)
function saveSchemaSnapshotLocal() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema) {
    notify('Nessuno schema disponibile da salvare.');
    return;
  }
  const payload = {
    db: state.db || 'database',
    dbType: state.dbType || 'mysql',
    timestamp: new Date().toISOString(),
    collections: schema.collections,
    relations: schema.relations || [],
  };

  const jsonText = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `schema-snapshot-${state.db || 'db'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  notify(`File snapshot "schema-snapshot-${state.db || 'db'}.json" salvato sul tuo computer!`);
}

// Diff tra Schema Attivo e File JSON locale caricato
function renderDiffReport(snapshot) {
  const activeSchema = state.dbSchema || currentSchemaData;
  if (!activeSchema || !snapshot || !snapshot.collections) return;

  const snapTables = new Map(snapshot.collections.map((c) => [c.name, c]));
  const activeTables = new Map(activeSchema.collections.map((c) => [c.name, c]));

  const addedTables = [];
  const removedTables = [];
  const modifiedTables = [];

  for (const [name, activeCol] of activeTables.entries()) {
    if (!snapTables.has(name)) {
      addedTables.push(name);
    } else {
      const snapCol = snapTables.get(name);
      const snapFields = new Set((snapCol.fields || []).map((f) => f.name));
      const activeFields = new Set((activeCol.fields || []).map((f) => f.name));
      const addedFields = [...activeFields].filter((f) => !snapFields.has(f));
      const removedFields = [...snapFields].filter((f) => !activeFields.has(f));

      if (addedFields.length || removedFields.length) {
        modifiedTables.push({ name, addedFields, removedFields });
      }
    }
  }

  for (const name of snapTables.keys()) {
    if (!activeTables.has(name)) {
      removedTables.push(name);
    }
  }

  let html = `<div style="font-size:0.95rem; margin-bottom:12px; color:var(--fg-dim,#8b949e);">Risultato del confronto tra lo schema corrente ed il file JSON locale.</div>`;

  if (!addedTables.length && !removedTables.length && !modifiedTables.length) {
    html += `<div class="audit-issue-item" style="border-left-color:#00e676;">
      <div class="audit-issue-title" style="color:#00e676;">✓ Schemi identici</div>
      <div class="audit-issue-desc">Nessuna differenza trovata rispetto al file JSON selezionato.</div>
    </div>`;
  } else {
    for (const t of addedTables) {
      html += `<div class="audit-issue-item" style="border-left-color:#00e676;">
        <div class="audit-issue-title"><span class="diff-tag diff-added">+ TABELLA AGGIUNTA</span> ${esc(t)}</div>
      </div>`;
    }
    for (const t of removedTables) {
      html += `<div class="audit-issue-item" style="border-left-color:#e5534b;">
        <div class="audit-issue-title"><span class="diff-tag diff-removed">- TABELLA RIMOSSA</span> ${esc(t)}</div>
      </div>`;
    }
    for (const m of modifiedTables) {
      html += `<div class="audit-issue-item" style="border-left-color:#f5a623;">
        <div class="audit-issue-title"><span class="diff-tag diff-changed">~ TABELLA MODIFICATA</span> ${esc(m.name)}</div>
        <div class="audit-issue-desc">
          ${m.addedFields.length ? `<span style="color:#00e676;">+ Campi aggiunti: ${m.addedFields.join(', ')}</span><br/>` : ''}
          ${m.removedFields.length ? `<span style="color:#e5534b;">- Campi rimossi: ${m.removedFields.join(', ')}</span>` : ''}
        </div>
      </div>`;
    }
  }

  const diffContent = $('#diff-content');
  if (diffContent) {
    diffContent.innerHTML = html;
  }
}

// 4. Parser DDL SQL & DBML Standalone
function parseSchemaInput(text, format) {
  const collections = [];
  const relations = [];

  if (format === 'dbml') {
    const tableRegex = /Table\s+["']?([a-zA-Z0-9_]+)["']?\s*\{([^}]+)\}/gi;
    let match;
    while ((match = tableRegex.exec(text)) !== null) {
      const tableName = match[1];
      const body = match[2];
      const fields = [];
      const lines = body.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 1) {
          const fName = parts[0].replace(/["']/g, '');
          const fType = parts[1] || 'varchar';
          const isPk = trimmed.includes('[pk]');
          fields.push({ name: fName, types: [fType], pk: isPk });
        }
      }
      collections.push({ name: tableName, fields });
    }

    const refRegex = /Ref:\s*["']?([a-zA-Z0-9_]+)["']?\."?([a-zA-Z0-9_]+)"?\s*>\s*["']?([a-zA-Z0-9_]+)["']?\."?([a-zA-Z0-9_]+)"?/gi;
    let refMatch;
    while ((refMatch = refRegex.exec(text)) !== null) {
      relations.push({
        from: refMatch[1],
        field: refMatch[2],
        to: refMatch[3],
        many: true,
      });
    }
  } else {
    // SQL DDL Parser
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?\s*\(([^;]+)\);/gi;
    let match;
    while ((match = tableRegex.exec(text)) !== null) {
      const tableName = match[1];
      const body = match[2];
      const fields = [];
      const lines = body.split('\n');
      for (const line of lines) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed || trimmed.startsWith('--') || trimmed.toUpperCase().startsWith('PRIMARY KEY') || trimmed.toUpperCase().startsWith('CONSTRAINT')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 1) {
          const fName = parts[0].replace(/`/g, '');
          const fType = parts[1] || 'VARCHAR';
          const isPk = trimmed.toUpperCase().includes('PRIMARY KEY');
          fields.push({ name: fName, types: [fType], pk: isPk });
        }
      }
      collections.push({ name: tableName, fields });
    }

    const fkRegex = /FOREIGN\s+KEY\s*\(`?([a-zA-Z0-9_]+)`?\)\s*REFERENCES\s*`?([a-zA-Z0-9_]+)`?\s*\(`?([a-zA-Z0-9_]+)`?\)/gi;
    let fkMatch;
    while ((fkMatch = fkRegex.exec(text)) !== null) {
      relations.push({
        from: 'imported',
        field: fkMatch[1],
        to: fkMatch[2],
        many: true,
      });
    }
  }

  return { collections, relations };
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
  const searchInput = $('#graph3d-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.trim().toLowerCase();
      const schema = state.dbSchema || currentSchemaData;
      if (!currentSearchQuery || !graphInstance || !schema) return;

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

  const colorSelect = $('#graph3d-color-mode');
  if (colorSelect) colorSelect.addEventListener('change', () => renderGraph3d());

  const hopSelect = $('#graph3d-hop-filter');
  if (hopSelect) hopSelect.addEventListener('change', () => renderGraph3d());

  const implicitBtn = $('#graph3d-toggle-implicit');
  if (implicitBtn) {
    implicitBtn.addEventListener('click', () => {
      showImplicitRelations = !showImplicitRelations;
      implicitBtn.classList.toggle('active', showImplicitRelations);
      renderGraph3d();
      notify(showImplicitRelations ? 'Relazioni implicite visibili' : 'Relazioni implicite nascoste');
    });
  }

  const toggle2dBtn = $('#graph3d-toggle-2d');
  if (toggle2dBtn) {
    toggle2dBtn.addEventListener('click', () => {
      is2DMode = !is2DMode;
      toggle2dBtn.classList.toggle('active', is2DMode);
      renderGraph3d();
      notify(is2DMode ? 'Modalità 2D Piatta attivata' : 'Modalità 3D attivata');
    });
  }

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

  const auditBtn = $('#graph3d-audit');
  if (auditBtn) auditBtn.addEventListener('click', () => runSchemaAudit());
  const auditCloseBtn = $('#audit-modal-close');
  if (auditCloseBtn) auditCloseBtn.addEventListener('click', () => $('#audit-modal').classList.add('hidden'));

  // Salva Snapshot locale (.json file download)
  const saveSnapBtn = $('#graph3d-save-snapshot');
  if (saveSnapBtn) saveSnapBtn.addEventListener('click', () => saveSchemaSnapshotLocal());

  // Diff con caricamento file .json locale
  const diffBtn = $('#graph3d-diff');
  if (diffBtn) {
    diffBtn.addEventListener('click', () => {
      const diffContent = $('#diff-content');
      if (diffContent) {
        diffContent.innerHTML = '<div style="color:var(--fg-dim,#8b949e);">Seleziona un file snapshot JSON salvato in precedenza per visualizzare il report delle modifiche.</div>';
      }
      $('#diff-modal').classList.remove('hidden');
    });
  }

  const diffFileInput = $('#diff-file-input');
  if (diffFileInput) {
    diffFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const snapshot = JSON.parse(evt.target.result);
          renderDiffReport(snapshot);
        } catch (err) {
          notify('Impossibile leggere il file JSON: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  const diffCloseBtn = $('#diff-modal-close');
  if (diffCloseBtn) diffCloseBtn.addEventListener('click', () => $('#diff-modal').classList.add('hidden'));

  const importBtn = $('#graph3d-import-schema');
  if (importBtn) {
    importBtn.addEventListener('click', () => $('#import-schema-modal').classList.remove('hidden'));
  }
  const importCloseBtn = $('#import-schema-close');
  if (importCloseBtn) {
    importCloseBtn.addEventListener('click', () => $('#import-schema-modal').classList.add('hidden'));
  }
  const importRenderBtn = $('#import-schema-render');
  if (importRenderBtn) {
    importRenderBtn.addEventListener('click', () => {
      const textarea = $('#import-schema-textarea');
      const format = $('#import-schema-format').value;
      if (!textarea || !textarea.value.trim()) {
        notify('Incolla uno script SQL o DBML valido.');
        return;
      }
      const parsed = parseSchemaInput(textarea.value, format);
      if (!parsed.collections.length) {
        notify('Impossibile interpretare lo schema fornito.');
        return;
      }
      state.dbSchema = parsed;
      state.dbSchemaFor = 'imported';
      $('#import-schema-modal').classList.add('hidden');
      renderGraph3d();
      notify(`Schema importato (${parsed.collections.length} tabelle visualizzate)!`);
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
    mermaidCloseBtn.addEventListener('click', () => $('#mermaid-modal').classList.add('hidden'));
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
    dbmlCloseBtn.addEventListener('click', () => $('#dbml-modal').classList.add('hidden'));
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
    sqlCloseBtn.addEventListener('click', () => $('#sql-modal').classList.add('hidden'));
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
