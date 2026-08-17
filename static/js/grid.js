// grid.js - a virtualized result grid.
//
// Only the rows that fit on screen exist in the DOM; the rest is a spacer
// with the right height, so 1000 rows and 100k rows cost the same. Row
// nodes are recycled, which keeps scrolling free of layout churn.
//
// Note on CSP: sizes are set through the CSSOM (el.style.width = ...),
// which the strict style-src allows. What it forbids is parsing a style
// attribute, so nothing here ever calls setAttribute('style', ...).

import { h, clear, toast } from './dom.js';

const ROW = 24;      // must match --row in app.css
const OVER = 6;      // rows rendered above and below the viewport
const MINW = 48;
const MAXW = 600;

export function createGrid() {
  const head = h('div', { class: 'grid-head' });
  const rowsEl = h('div', { class: 'grid-rows' });
  const body = h('div', { class: 'grid-body' }, rowsEl);
  const el = h('div', { class: 'grid', tabIndex: 0 }, head, body);

  let cols = [];
  let rows = [];
  let widths = [];
  let pool = [];
  let opts = {};
  let focus = { r: -1, c: -1 };
  let editing = null;
  let first = -1;

  // ---- sizing -------------------------------------------------------

  function guessWidth(i) {
    let n = cols[i].name.length + 2;
    for (let r = 0; r < Math.min(rows.length, 40); r++) {
      const v = rows[r][i];
      if (v !== null && v !== undefined) n = Math.max(n, Math.min(v.length, 60));
    }
    return Math.max(MINW, Math.min(MAXW, n * 7.4 + 14));
  }

  function applyWidths() {
    for (let i = 0; i < cols.length; i++) {
      head.children[i].style.width = widths[i] + 'px';
    }
    for (const row of pool) {
      for (let i = 0; i < cols.length; i++) row.children[i].style.width = widths[i] + 'px';
    }
  }

  function storeKey() {
    return opts.storeKey ? 'mydb.w.' + opts.storeKey : null;
  }

  function loadWidths() {
    const k = storeKey();
    if (!k) return null;
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return Array.isArray(v) && v.length === cols.length ? v : null;
    } catch { return null; }
  }

  function saveWidths() {
    const k = storeKey();
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(widths)); } catch { /* quota, ignore */ }
  }

  // ---- header -------------------------------------------------------

  function buildHead() {
    clear(head);
    cols.forEach((c, i) => {
      const isPk = (opts.pk || []).includes(c.name);
      const grip = h('span', { class: 'rz' });
      grip.addEventListener('mousedown', (ev) => startResize(ev, i));

      head.append(h('div', {
        class: 'gh',
        title: c.name + ' — ' + c.type + (isPk ? ' (primary key)' : ''),
      },
        h('span', { class: isPk ? 'pk' : '', text: c.name }),
        grip,
      ));
    });
  }

  function startResize(ev, i) {
    ev.preventDefault();
    const x0 = ev.clientX;
    const w0 = widths[i];
    const move = (e) => {
      widths[i] = Math.max(MINW, Math.min(MAXW, w0 + (e.clientX - x0)));
      applyWidths();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveWidths();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ---- rows ---------------------------------------------------------

  function makeRow() {
    const tr = h('div', { class: 'gr' });
    for (let i = 0; i < cols.length; i++) {
      const td = h('div', { class: 'gc' });
      td.addEventListener('mousedown', () => setFocus(Number(tr.dataset.row), i));
      td.addEventListener('dblclick', () => { setFocus(Number(tr.dataset.row), i); beginEdit(); });
      tr.append(td);
    }
    return tr;
  }

  function fillRow(tr, r) {
    tr.dataset.row = String(r);
    tr.className = 'gr' + (r % 2 ? ' alt' : '') + (r === focus.r ? ' sel' : '');
    const row = rows[r];
    for (let i = 0; i < cols.length; i++) {
      const td = tr.children[i];
      const v = row[i];
      let cls = 'gc';
      if (v === null || v === undefined) cls += ' null';
      else if (cols[i].binary) cls += ' bin';
      if (r === focus.r && i === focus.c) cls += ' focus';
      td.className = cls;
      td.textContent = v === null || v === undefined ? 'NULL' : v;
      td.title = v === null || v === undefined ? 'NULL' : v;
      td.style.width = widths[i] + 'px';
    }
  }

  function render() {
    if (editing) return;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW) - OVER);
    const need = Math.min(rows.length - start, Math.ceil(el.clientHeight / ROW) + OVER * 2);

    while (pool.length < need) {
      const tr = makeRow();
      pool.push(tr);
      rowsEl.append(tr);
    }
    while (pool.length > need) {
      pool.pop().remove();
    }

    for (let k = 0; k < need; k++) fillRow(pool[k], start + k);
    rowsEl.style.transform = 'translateY(' + (start * ROW) + 'px)';
    first = start;
  }

  el.addEventListener('scroll', render, { passive: true });

  // ---- focus + keyboard ---------------------------------------------

  function setFocus(r, c) {
    if (Number.isNaN(r)) return;
    focus = {
      r: Math.max(0, Math.min(rows.length - 1, r)),
      c: Math.max(0, Math.min(cols.length - 1, c)),
    };
    scrollIntoView();
    render();
  }

  function scrollIntoView() {
    const top = focus.r * ROW;
    const bottom = top + ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }

  function move(dr, dc) {
    if (!rows.length) return;
    if (focus.r < 0) setFocus(0, 0);
    else setFocus(focus.r + dr, focus.c + dc);
  }

  el.addEventListener('keydown', (ev) => {
    if (editing) return;
    const page = Math.max(1, Math.floor(el.clientHeight / ROW) - 1);
    switch (ev.key) {
      case 'ArrowDown': move(1, 0); break;
      case 'ArrowUp': move(-1, 0); break;
      case 'ArrowRight': move(0, 1); break;
      case 'ArrowLeft': move(0, -1); break;
      case 'PageDown': move(page, 0); break;
      case 'PageUp': move(-page, 0); break;
      case 'Home': setFocus(ev.ctrlKey || ev.metaKey ? 0 : focus.r, 0); break;
      case 'End': setFocus(ev.ctrlKey || ev.metaKey ? rows.length - 1 : focus.r, cols.length - 1); break;
      case 'Enter': beginEdit(); break;
      case 'c':
        if (ev.ctrlKey || ev.metaKey) { copyCell(); break; }
        return;
      case '0':
        if (ev.ctrlKey || ev.metaKey) { commit(null); break; }
        return;
      default: return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  });

  function copyCell() {
    const v = rows[focus.r]?.[focus.c];
    navigator.clipboard?.writeText(v === null || v === undefined ? '' : v)
      .catch(() => toast('Could not copy to clipboard', 'err'));
  }

  // ---- inline editing ------------------------------------------------

  function editable() {
    if (!opts.onEdit) return 'this result is not editable';
    if (!(opts.pk || []).length) return 'table has no primary key, rows are read-only';
    if (cols[focus.c]?.binary) return 'binary columns are read-only';
    return null;
  }

  function beginEdit() {
    if (focus.r < 0 || editing) return;
    const why = editable();
    if (why) { toast(why, 'err'); return; }

    const tr = pool[focus.r - first];
    if (!tr) return;
    const td = tr.children[focus.c];
    const orig = rows[focus.r][focus.c];

    const input = h('input', { type: 'text', value: orig === null ? '' : orig });
    editing = { orig, input };
    clear(td);
    td.append(input);
    input.focus();
    input.select();

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); commit(input.value); }
      else if ((ev.ctrlKey || ev.metaKey) && ev.key === '0') { ev.preventDefault(); commit(null); }
    });
    input.addEventListener('blur', () => cancelEdit());
  }

  function cancelEdit() {
    if (!editing) return;
    editing = null;
    render();
    el.focus();
  }

  // commit hands the change to the caller and only paints it once the
  // server confirmed, so a rejected write never leaves a false value on
  // screen.
  function commit(value) {
    const r = focus.r;
    const c = focus.c;
    const orig = editing ? editing.orig : rows[r][c];
    editing = null;

    if (value === orig) { render(); el.focus(); return; }

    const key = {};
    for (const name of opts.pk) {
      const i = cols.findIndex((col) => col.name === name);
      if (i < 0) { toast('primary-key column ' + name + ' is not in this result', 'err'); render(); return; }
      key[name] = rows[r][i];
    }

    render();
    el.focus();

    opts.onEdit({ column: cols[c].name, value, orig, key })
      .then(() => { rows[r][c] = value; render(); })
      .catch((e) => toast(e.message, 'err'));
  }

  // ---- public -------------------------------------------------------

  return {
    el,
    setResult(res, o = {}) {
      opts = o;
      cols = res?.cols || [];
      rows = res?.rows || [];
      focus = { r: -1, c: -1 };
      editing = null;
      pool.forEach((p) => p.remove());
      pool = [];

      buildHead();
      widths = loadWidths() || cols.map((_, i) => guessWidth(i));
      body.style.height = (rows.length * ROW) + 'px';
      el.scrollTop = 0;
      render();
      applyWidths();
    },
    focusGrid() { el.focus(); },
    rowCount() { return rows.length; },
  };
}
