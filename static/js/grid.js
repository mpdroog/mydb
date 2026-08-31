// grid.js - a virtualized result grid.
//
// Only the rows that fit on screen exist in the DOM; the rest is a spacer
// with the right height, so 1000 rows and 100k rows cost the same. Row
// nodes are recycled, which keeps scrolling free of layout churn.
//
// Every column header carries a tick box and the toolbar above the grid
// copies the ticked columns as CSV. That copy reads the row array, not the
// DOM, so it covers every loaded row and not just the handful that
// virtualization keeps on screen.
//
// Note on CSP: sizes are set through the CSSOM (el.style.width = ...),
// which the strict style-src allows. What it forbids is parsing a style
// attribute, so nothing here ever calls setAttribute('style', ...).

import { h, clear, toast, copyText, fmtNum } from './dom.js';

// Row height comes from --row rather than a constant, so the density
// switch moves the virtualization arithmetic with it. Read once per grid:
// it cannot change without the stylesheet changing.
function rowHeight() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--row');
  return parseInt(v, 10) || 25;
}
const OVER = 6;      // rows rendered above and below the viewport
const BOX = 18;      // room a header tick box takes
const MINW = 64;
const MAXW = 600;

export function createGrid() {
  const head = h('div', { class: 'grid-head' });
  const rowsEl = h('div', { class: 'grid-rows' });
  const body = h('div', { class: 'grid-body' }, rowsEl);
  const scroll = h('div', { class: 'grid', tabIndex: 0 }, head, body);

  // The toolbar sits above the scroller rather than inside it: the header
  // is already sticky, and a second sticky layer would have to know the
  // first one's height. Outside, it also stays put when the grid is
  // scrolled sideways.
  const allBox = h('input', {
    type: 'checkbox',
    class: 'gsel',
    checked: true,
    title: 'Tick or clear every column',
  });
  const countEl = h('span', { class: 'muted' });
  const csvBtn = h('button', {
    type: 'button',
    text: 'Copy CSV',
    title: 'Copy the ticked columns of every loaded row as CSV, header row '
      + 'included (Ctrl/Cmd+Shift+X)',
  });
  const tools = h('div', { class: 'grid-tools' },
    h('label', { class: 'gall', title: 'Tick or clear every column' }, allBox, 'all'),
    countEl,
    h('span', { class: 'grow' }),
    csvBtn,
  );
  const el = h('div', { class: 'gridwrap' }, tools, scroll);

  const ROW = rowHeight();
  let cols = [];
  let rows = [];
  let widths = [];
  let checked = [];
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
    return Math.max(MINW, Math.min(MAXW, n * 7.4 + 14 + BOX));
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

      const box = h('input', {
        type: 'checkbox',
        class: 'gsel',
        checked: checked[i],
        title: 'Include ' + c.name + ' in the CSV copy',
      });
      box.addEventListener('change', () => { checked[i] = box.checked; syncTools(); });

      head.append(h('div', {
        class: 'gh',
        title: c.name + ' — ' + c.type + (isPk ? ' (primary key)' : ''),
      },
        box,
        h('span', { class: isPk ? 'pk' : '' }, isPk ? '\u26bf ' + c.name : c.name),
        h('span', { class: 'ty', text: shortType(c.type) }),
        grip,
      ));
    });
    syncTools();
  }

  // shortType trims a declared type down to what fits beside a name. The
  // width and the unsigned flag are the parts you check for; the rest is
  // in Structure.
  function shortType(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/\s*unsigned/, ' u')
      .replace(/^(enum|set)\b.*/, '$1')
      .replace(/\s*zerofill/, '')
      .trim();
  }

  // ---- column ticks + CSV --------------------------------------------

  // syncTools keeps the toolbar saying the same thing as the header ticks.
  // The all box goes indeterminate on a partial selection, which is the one
  // state a checkbox can show that a label would have to spell out.
  function syncTools() {
    const n = checked.filter(Boolean).length;
    countEl.textContent = cols.length
      ? (n === cols.length ? 'all ' + n + ' columns' : n + ' of ' + cols.length + ' columns')
      : '';
    allBox.checked = n > 0 && n === cols.length;
    allBox.indeterminate = n > 0 && n < cols.length;
    csvBtn.disabled = n === 0;
  }

  allBox.addEventListener('change', () => {
    checked = cols.map(() => allBox.checked);
    head.querySelectorAll('.gsel').forEach((b, i) => { b.checked = checked[i]; });
    syncTools();
  });

  // csvField quotes by RFC 4180: quotes are doubled, and a field is quoted
  // whenever it holds a comma, a quote, a newline, or edge whitespace a
  // spreadsheet would otherwise swallow. NULL is written as an empty field,
  // which is as close as CSV gets to saying NULL at all.
  function csvField(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function copyCSV() {
    const idx = cols.map((_, i) => i).filter((i) => checked[i]);
    if (!idx.length) { toast('No columns are ticked', 'err'); return; }

    const out = [idx.map((i) => csvField(cols[i].name)).join(',')];
    for (const row of rows) out.push(idx.map((i) => csvField(row[i])).join(','));

    copyText(out.join('\r\n'))
      .then(() => toast('Copied ' + idx.length + ' column' + (idx.length === 1 ? '' : 's')
        + ' × ' + fmtNum(rows.length) + ' row' + (rows.length === 1 ? '' : 's') + ' as CSV'))
      .catch((e) => toast('Could not copy to clipboard: ' + e.message, 'err'));
  }

  csvBtn.addEventListener('click', copyCSV);

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

  // numeric decides which columns right-align. Digits that line up can be
  // compared down the column; ragged ones cannot.
  function numeric(t) {
    return /^(tiny|small|medium|big)?int|^decimal|^numeric|^float|^double|^bit/i.test(String(t || ''));
  }

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
    tr.className = 'gr' + (r === focus.r ? ' sel' : '');
    const row = rows[r];
    for (let i = 0; i < cols.length; i++) {
      const td = tr.children[i];
      const v = row[i];
      let cls = 'gc';
      const isNull = v === null || v === undefined;
      if (isNull) cls += ' null';
      else if (cols[i].binary) cls += ' bin';
      else if (numeric(cols[i].type)) cls += ' num';
      if (r === focus.r && i === focus.c) cls += ' focus';
      td.className = cls;
      // A NULL cell carries no text: the stylesheet draws the dashed chip,
      // so a copy of the cell does not silently become the string "NULL".
      td.textContent = isNull ? '' : v;
      td.title = isNull ? 'NULL' : v;
      td.style.width = widths[i] + 'px';
    }
  }

  function render() {
    if (editing) return;
    const start = Math.max(0, Math.floor(scroll.scrollTop / ROW) - OVER);
    const need = Math.min(rows.length - start, Math.ceil(scroll.clientHeight / ROW) + OVER * 2);

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

  scroll.addEventListener('scroll', render, { passive: true });

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
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight;
  }

  function move(dr, dc) {
    if (!rows.length) return;
    if (focus.r < 0) setFocus(0, 0);
    else setFocus(focus.r + dr, focus.c + dc);
  }

  scroll.addEventListener('keydown', (ev) => {
    if (editing) return;
    const page = Math.max(1, Math.floor(scroll.clientHeight / ROW) - 1);
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
      // X for export, because Ctrl/Cmd+Shift+C is the browser's own inspect
      // shortcut in both Chrome and Firefox and never reaches the page.
      // Shift makes ev.key the capital, so both cases have to be listed.
      case 'x':
      case 'X':
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey) { copyCSV(); break; }
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
    copyText(v === null || v === undefined ? '' : String(v))
      .catch((e) => toast('Could not copy to clipboard: ' + e.message, 'err'));
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
    scroll.focus();
  }

  // commit hands the change to the caller and only paints it once the
  // server confirmed, so a rejected write never leaves a false value on
  // screen.
  function commit(value) {
    const r = focus.r;
    const c = focus.c;
    const orig = editing ? editing.orig : rows[r][c];
    editing = null;

    if (value === orig) { render(); scroll.focus(); return; }

    const key = {};
    for (const name of opts.pk) {
      const i = cols.findIndex((col) => col.name === name);
      if (i < 0) { toast('primary-key column ' + name + ' is not in this result', 'err'); render(); return; }
      key[name] = rows[r][i];
    }

    render();
    scroll.focus();

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

      // A new result is a new set of columns, so every one of them starts
      // ticked: the common copy is the whole thing, and unticking is the
      // exception.
      checked = cols.map(() => true);

      buildHead();
      widths = loadWidths() || cols.map((_, i) => guessWidth(i));
      body.style.height = (rows.length * ROW) + 'px';
      scroll.scrollTop = 0;
      render();
      applyWidths();
    },
    focusGrid() { scroll.focus(); },
    rowCount() { return rows.length; },
  };
}
