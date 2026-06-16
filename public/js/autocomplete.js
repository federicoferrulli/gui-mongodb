import { state } from './state.js';
import { $ } from './utils.js';

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'LIKE', 'IN', 'BETWEEN',
  'IS', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT', 'ASC', 'DESC',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON',
];

const SQL_WHERE_KEYWORDS = [
  'AND', 'OR', 'NOT', 'NULL', 'LIKE', 'IN', 'BETWEEN', 'IS', 'ASC', 'DESC',
];

const MONGO_KEYWORDS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex',
  '$group', '$match', '$sort', '$project', '$limit', '$skip',
  '$lookup', '$unwind', '$sum', '$avg', '$count',
];

function keywordsFor() {
  const isMysql = state.dbType === 'mysql';
  const aggregate = $('#query-mode').value === 'aggregate';
  if (isMysql) return aggregate ? SQL_KEYWORDS : SQL_WHERE_KEYWORDS;
  return MONGO_KEYWORDS;
}

function suggestionsFor(opts) {
  const kws = opts.keywords !== false ? keywordsFor() : [];
  return [...kws, ...(state.columns || [])];
}

function currentToken(input) {
  const upto = input.value.slice(0, input.selectionStart);
  const m = upto.match(/[\w$.]+$/);
  return m ? m[0] : '';
}

function filterSuggestions(token, opts) {
  if (!token) return [];
  const t = token.toLowerCase();
  return suggestionsFor(opts)
    .filter((s) => s.toLowerCase().startsWith(t) && s.toLowerCase() !== t)
    .slice(0, 8);
}

function applySuggestion(input, suggestion) {
  const start = input.selectionStart;
  const before = input.value.slice(0, start).replace(/[\w$.]+$/, '');
  const after = input.value.slice(start);
  input.value = before + suggestion + after;
  const pos = (before + suggestion).length;
  input.setSelectionRange(pos, pos);
  input.focus();
}

export function attachAutocomplete(input, opts = {}) {
  let wrap = input.closest('.ac-wrap');
  let list = wrap ? wrap.querySelector('.ac-list') : null;

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
  }

  if (!list) {
    list = document.createElement('ul');
    list.className = 'ac-list hidden';
    wrap.appendChild(list);
  }

  let activeIndex = -1;
  let items = [];

  function hideDropdown() {
    list.classList.add('hidden');
    list.innerHTML = '';
    activeIndex = -1;
  }

  function renderDropdown(suggestions) {
    if (suggestions.length === 0) {
      hideDropdown();
      return;
    }
    items = suggestions;
    list.innerHTML = '';
    suggestions.forEach((s, idx) => {
      const li = document.createElement('li');
      li.textContent = s;
      li.addEventListener('mousedown', (e) => {
        // Prevent blur when clicking a suggestion
        e.preventDefault();
        applySuggestion(input, s);
        hideDropdown();
      });
      list.appendChild(li);
    });
    activeIndex = -1;
    list.classList.remove('hidden');
  }

  function updateActive() {
    const lis = list.querySelectorAll('li');
    lis.forEach((li, i) => li.classList.toggle('active', i === activeIndex));
    if (activeIndex >= 0) {
      lis[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  input.addEventListener('input', () => {
    const token = currentToken(input);
    const suggestions = filterSuggestions(token, opts);
    renderDropdown(suggestions);
  });

  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      updateActive();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIndex >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        applySuggestion(input, items[activeIndex]);
        hideDropdown();
      } else if (items.length > 0 && e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        applySuggestion(input, items[0]);
        hideDropdown();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideDropdown();
    }
  }, true); // use capture phase or just regular phase, but stopImmediatePropagation handles other listeners on the same element

  input.addEventListener('blur', () => {
    hideDropdown();
  });
}
