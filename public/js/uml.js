import { state } from './state.js';
import { $, emit, esc, cut } from './utils.js';

const UML = { W: 230, ROW: 17, HEAD: 26, PAD: 10, GAP: 30, COLGAP: 140, MAXF: 11 };

export function loadUml(force) {
  if (!state.db || !state.coll) return;
  if (!force && state.dbSchema && state.dbSchemaFor === state.db) {
    renderUml();
    return;
  }
  $('#uml-canvas').innerHTML = '<div class="uml-msg">Analisi dello schema del database…</div>';
  emit('db:schema', { db: state.db }).then((res) => {
    res._tab.state.dbSchema = res;
    res._tab.state.dbSchemaFor = res._tab.state.db;
    renderUml();
  }).catch((err) => {
    $('#uml-canvas').innerHTML = `<div class="error">${esc(err.message)}</div>`;
  });
}

export function renderUml() {
  const canvas = $('#uml-canvas');
  const schema = state.dbSchema;
  const focal = schema && schema.collections.find((c) => c.name === state.coll);
  if (!focal) {
    canvas.innerHTML = '<div class="uml-msg">Schema non disponibile per questa collection.</div>';
    return;
  }

  const edges = schema.relations.filter(
    (r) => r.from !== r.to && (r.from === focal.name || r.to === focal.name)
  );
  const neighborNames = [...new Set(edges.map((r) => (r.from === focal.name ? r.to : r.from)))];
  const neighbors = neighborNames
    .map((n) => schema.collections.find((c) => c.name === n))
    .filter(Boolean);

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

export function initUml() {
  $('#uml-refresh')?.addEventListener('click', () => loadUml(true));
}
