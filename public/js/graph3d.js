import { state } from './state.js';
import { $, emit, esc, notify } from './utils.js';
import { openCollTab } from './colltabs.js';
import { setView } from './main.js';

let graphInstance = null;
let currentSchemaData = null;

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

  const nodes = schema.collections.map((c) => ({
    id: c.name,
    name: c.name,
    fieldCount: (c.fields && c.fields.length) || 0,
    val: Math.max(3, Math.min(15, (c.fields && c.fields.length) || 5)),
  }));

  const edges = (schema.relations || []).map((r) => ({
    source: r.from,
    target: r.to,
    label: r.field,
    many: r.many,
  }));

  const graphData = { nodes, links: edges };

  const colors = ['#4a9eff', '#50e3c2', '#f5a623', '#b8e986', '#bd10e0', '#9013fe', '#e65100'];

  if (typeof ForceGraph3D === 'undefined') {
    canvas.innerHTML = '<div class="error" style="padding:20px;">Libreria 3D Force Graph non disponibile.</div>';
    return;
  }

  // preserveDrawingBuffer per consentire a toDataURL() l'export in PNG
  graphInstance = ForceGraph3D({ preserveDrawingBuffer: true })(canvas)
    .graphData(graphData)
    .nodeId('id')
    .nodeLabel((node) => `<div style="background:rgba(15,20,28,0.9); padding:6px 10px; border-radius:4px; border:1px solid #4a9eff; font-family:sans-serif; color:#fff;"><b>${esc(node.name)}</b><br/><small style="color:#aaa;">${node.fieldCount} campi</small></div>`)
    .nodeColor((node) => colors[Math.abs(hashString(node.name)) % colors.length])
    .nodeRelSize(4)
    .linkDirectionalParticles(2)
    .linkDirectionalParticleSpeed(0.006)
    .linkLabel((link) => `<span style="color:#aaa;">${esc(link.label)}${link.many ? ' [N]' : ''}</span>`)
    .linkColor(() => '#4a9eff')
    .linkWidth(1.5)
    .onNodeClick((node) => {
      const distance = 120;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z || 1);
      graphInstance.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: (node.z || 0) * distRatio },
        { x: node.x, y: node.y, z: node.z || 0 },
        1200
      );

      showTableDetailsPanel(node.name);
    });

  if (typeof THREE !== 'undefined') {
    graphInstance.nodeThreeObject((node) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: createTextTexture(node.name),
          depthTest: false,
        })
      );
      sprite.scale.set(35, 18, 1);
      sprite.position.y = 12;
      return sprite;
    });
    graphInstance.nodeThreeObjectExtend(true);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (graphInstance && canvas && canvas.clientWidth > 0) {
      graphInstance.width(canvas.clientWidth);
      graphInstance.height(canvas.clientHeight);
    }
  });
  resizeObserver.observe(canvas);
}

function showTableDetailsPanel(tableName) {
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
    html += `<li>
      <span class="field-name">${esc(f.name)}</span>
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
        showTableDetailsPanel(targetName);
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

function sanitizeMermaid(str) {
  if (!str) return 'entity';
  return String(str).replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildMermaidDiagram() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) return '';
  let lines = ['erDiagram'];
  for (const c of schema.collections) {
    const cName = sanitizeMermaid(c.name);
    lines.push(`    ${cName} {`);
    for (const f of c.fields || []) {
      const typeStr = (f.types && f.types[0]) ? sanitizeMermaid(f.types[0]) : 'string';
      const fName = sanitizeMermaid(f.name);
      lines.push(`        ${typeStr} ${fName}`);
    }
    lines.push('    }');
  }
  for (const r of schema.relations || []) {
    const fromName = sanitizeMermaid(r.from);
    const toName = sanitizeMermaid(r.to);
    const fieldName = sanitizeMermaid(r.field);
    lines.push(`    ${fromName} ||--o{ ${toName} : "${fieldName}"`);
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
      const query = e.target.value.trim().toLowerCase();
      const schema = state.dbSchema || currentSchemaData;
      if (!query || !graphInstance || !schema) return;
      const targetNode = graphInstance.graphData().nodes.find((n) => n.name.toLowerCase().includes(query));
      if (targetNode && targetNode.x != null) {
        const distance = 100;
        const distRatio = 1 + distance / Math.hypot(targetNode.x, targetNode.y, targetNode.z || 1);
        graphInstance.cameraPosition(
          { x: targetNode.x * distRatio, y: targetNode.y * distRatio, z: (targetNode.z || 0) * distRatio },
          { x: targetNode.x, y: targetNode.y, z: targetNode.z || 0 },
          1200
        );
        showTableDetailsPanel(targetNode.name);
      }
    });
  }

  const closePanelBtn = $('#graph3d-panel-close');
  if (closePanelBtn) {
    closePanelBtn.addEventListener('click', () => {
      const panel = $('#graph3d-side-panel');
      if (panel) panel.classList.add('hidden');
    });
  }

  const resetBtn = $('#graph3d-reset-cam');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (graphInstance) {
        graphInstance.zoomToFit(1000, 50);
      }
    });
  }

  const refreshBtn = $('#graph3d-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadGraph3d(true));
  }

  // Export PNG corretto con re-render WebGL e trigger download
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

  // Export Mermaid corretto con modale dedicata
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
      const modal = $('#mermaid-modal');
      if (modal) modal.classList.add('hidden');
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
}
