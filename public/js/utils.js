export const $ = (sel) => document.querySelector(sel);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function displayValue(v) {
  if (v === null || v === undefined) return { text: 'null', cls: 'type-null' };
  if (typeof v === 'string') return { text: v, cls: '' };
  if (typeof v === 'number') return { text: String(v), cls: 'type-num' };
  if (typeof v === 'boolean') return { text: String(v), cls: 'type-bool' };
  if (Array.isArray(v)) return { text: JSON.stringify(v.map(simplify)), cls: 'type-obj' };

  if (isPlainObject(v)) {
    if ('$oid' in v) return { text: v.$oid, cls: 'type-oid' };
    if ('$date' in v) {
      const d = isPlainObject(v.$date) ? Number(v.$date.$numberLong) : v.$date;
      return { text: new Date(d).toISOString(), cls: 'type-date' };
    }
    if ('$numberInt' in v) return { text: v.$numberInt, cls: 'type-num' };
    if ('$numberLong' in v) return { text: v.$numberLong, cls: 'type-num' };
    if ('$numberDouble' in v) return { text: v.$numberDouble, cls: 'type-num' };
    if ('$numberDecimal' in v) return { text: String(v.$numberDecimal), cls: 'type-num' };
    if ('$binary' in v) {
      const b64 = v.$binary.base64 || '';
      const size = Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
      let hex = '';
      if (size > 0) {
        const header = atob(b64.slice(0, 16)).substring(0, 8);
        for (let i = 0; i < Math.min(header.length, 8); i++) {
          hex += header.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase() + ' ';
        }
        if (size > 8) hex += '...';
      }
      return { text: `[BLOB ${fmtBytes(size)}] ${hex.trim()}`, cls: 'type-obj' };
    }
    return { text: JSON.stringify(simplify(v)), cls: 'type-obj' };
  }
  return { text: String(v), cls: '' };
}

export function simplify(v) {
  if (Array.isArray(v)) return v.map(simplify);
  if (isPlainObject(v)) {
    if ('$oid' in v) return v.$oid;
    if ('$date' in v) return displayValue(v).text;
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v || '$numberDecimal' in v) {
      return Number(Object.values(v)[0]);
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = simplify(val);
    return out;
  }
  return v;
}

export function valueType(v) {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (isPlainObject(v)) {
    if ('$date' in v) return 'date';
    if ('$oid' in v) return 'oid';
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v) return 'number';
    if ('$numberDecimal' in v) return 'decimal';
  }
  return 'json';
}

export function editValue(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function parseEdited(text) {
  const t = text.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

export function idOf(doc) {
  return JSON.stringify(doc._id);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export function cut(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

export function showQueryError(msg) {
  const el = $('#query-error');
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

export function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item === '---') {
      li.className = 'separator';
    } else {
      li.textContent = item.label;
      if (item.danger) li.classList.add('danger');
      li.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
    }
    menu.appendChild(li);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}

export function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});
