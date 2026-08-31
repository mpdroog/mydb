// statement.js - the query, at the size the query is.
//
// Not a filter squeezed into a text field. A statement is the thing being
// worked on, so it gets its own band, and the band is as tall as the
// statement: one line for a plain SELECT, ten for a join, then it scrolls.
//
// Syntax colour comes from a mirror sitting under a transparent textarea,
// which is the only way to have both real editing and real colour without
// a code editor. The two share a grid cell and the same metrics, so the
// caret lands where the glyphs are.
//
// The buffer is cut into statements here so the strip below it can say one
// chip per statement and the gutter can mark the one the cursor is in. The
// Go side does the same cut authoritatively when it runs; this copy exists
// so the interface can answer without a round-trip per keystroke.

import { h, clear } from './dom.js';

const KEYWORDS = /('(?:[^'\\]|\\.|'')*')|(`(?:[^`]|``)*`)|(--[^\n]*|#[^\n]*)|(\/\*[\s\S]*?\*\/)|(\b(?:SELECT|FROM|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|INSERT\s+INTO|VALUES|UPDATE|SET|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ON|AS|AND|OR|NOT|NULL|IS|IN|LIKE|BETWEEN|EXISTS|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|ASC|DESC|CREATE|ALTER|DROP|TABLE|INDEX|EXPLAIN|ANALYZE|SHOW|USE|WITH)\b)|(\b\d+(?:\.\d+)?\b)/gi;

// tint turns SQL into coloured nodes. Strings and comments are matched
// before keywords, so a keyword inside a string stays a string.
export function tint(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  KEYWORDS.lastIndex = 0;
  for (let m; (m = KEYWORDS.exec(text)) !== null;) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const cls = m[1] ? 'str' : m[2] ? '' : (m[3] || m[4]) ? 'cm' : m[5] ? 'kw' : 'num';
    frag.append(cls ? h('span', { class: cls, text: m[0] }) : m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// cut splits a buffer on semicolons that are not inside a string, an
// identifier or a comment. The browser-side twin of what the Go side does.
export function cut(text) {
  const out = [];
  let start = 0, quote = '', line = false, block = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && text[i + 1] === '/') { block = false; i++; } continue; }
    if (quote) {
      if (c === '\\' && quote !== '`') { i++; continue; }
      if (c === quote) { if (text[i + 1] === quote) i++; else quote = ''; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '-' && text[i + 1] === '-') { line = true; i++; continue; }
    if (c === '#') { line = true; continue; }
    if (c === '/' && text[i + 1] === '*') { block = true; i++; continue; }
    if (c === ';') { out.push({ start, end: i + 1 }); start = i + 1; }
  }
  if (text.slice(start).trim()) out.push({ start, end: text.length });

  // A statement begins at its first real character: the blank lines
  // between statements belong to nobody and must not be highlighted, or
  // blamed for an error.
  return out
    .filter((r) => text.slice(r.start, r.end).trim())
    .map((r) => {
      let i = r.start;
      while (i < r.end && /\s/.test(text[i])) i++;
      return { start: i, end: r.end };
    });
}

// describe reads a chip's label back out of the statement it points at, so
// nothing on screen claims to know something the text does not say.
export function describe(sql) {
  const body = sql.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const verb = (body.match(/\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|SHOW|EXPLAIN|ANALYZE|TRUNCATE|USE|SET)\b/i) || [, ''])[1];
  const table = (body.match(/\b(?:FROM|INTO|UPDATE|TABLE)\s+`?([\w$.]+)`?/i) || [, ''])[1];
  return { verb: verb.toUpperCase(), table };
}

const MAX_LINES = 10;

export function createStatement({ onRun, label = 'the statement mydb wrote' } = {}) {
  const gutter = h('div', { class: 'stmt-gutter' });
  const mirror = h('pre', { class: 'stmt-mirror', 'aria-hidden': 'true' });
  const input = h('textarea', {
    class: 'stmt-in',
    rows: 1,
    spellcheck: false,
    'aria-label': 'The statement this view runs',
  });
  const box = h('div', { class: 'stmt-box' }, gutter, mirror, input);

  const meta = h('span', { class: 'meta' });
  const resetBtn = h('button', { type: 'button', text: 'Reset' });
  const foot = h('div', { class: 'stmt-foot' }, meta, h('span', { class: 'grow' }), resetBtn);
  const strip = h('div', { class: 'results', hidden: true });
  const el = h('div', { class: 'stmt' }, box, strip, foot);

  let baseline = '';
  let stmts = [];
  let activeIdx = 0;
  let outcomes = [];
  let onPick = () => {};

  function sync(keepActive) {
    const text = input.value;
    stmts = cut(text);
    if (!keepActive) {
      const caret = input.selectionStart || 0;
      activeIdx = 0;
      stmts.forEach((r, i) => { if (caret >= r.start) activeIdx = i; });
    }
    activeIdx = Math.max(0, Math.min(activeIdx, Math.max(0, stmts.length - 1)));

    clear(mirror);
    let at = 0;
    stmts.forEach((r, i) => {
      if (r.start > at) mirror.append(text.slice(at, r.start));
      const bad = outcomes[i]?.error;
      const span = h('span', {
        class: 'st' + (i === activeIdx && stmts.length > 1 ? ' on' : '') + (bad ? ' bad' : ''),
      });
      span.append(tint(text.slice(r.start, r.end)));
      mirror.append(span);
      at = r.end;
    });
    if (at < text.length) mirror.append(text.slice(at));
    mirror.append('\n');   // keeps the last line's height

    drawGutter(text);
    drawStrip();

    const dirty = text.trim() !== baseline.trim();
    clear(meta);
    const lines = text.split('\n').length;
    meta.append(lines + (lines === 1 ? ' line' : ' lines')
      + (stmts.length > 1 ? ' · ' + stmts.length + ' statements' : '') + ' · ');
    meta.append(dirty
      ? h('span', { class: 'dirty', text: 'edited — no longer ' + label })
      : label);
    resetBtn.hidden = !dirty;
  }

  function lineOf(text, pos) { return text.slice(0, pos).split('\n').length - 1; }

  function drawGutter(text) {
    clear(gutter);
    const lines = text.split('\n').length;
    const bad = new Set();
    stmts.forEach((r, i) => {
      if (!outcomes[i]?.error) return;
      for (let L = lineOf(text, r.start); L <= lineOf(text, Math.max(r.start, r.end - 1)); L++) bad.add(L);
    });
    const from = stmts.length ? lineOf(text, stmts[activeIdx].start) : 0;
    const to = stmts.length ? lineOf(text, Math.max(0, stmts[activeIdx].end - 1)) : 0;
    for (let n = 0; n < lines; n++) {
      const cls = bad.has(n) ? 'bad' : (stmts.length > 1 && n >= from && n <= to) ? 'on' : '';
      gutter.append(h('span', { class: cls, text: String(n + 1) }), '\n');
    }
  }

  // The strip is a map of the buffer. One statement means there is nothing
  // to map, so it does not appear -- the pane's footer already describes it.
  function drawStrip() {
    clear(strip);
    strip.hidden = stmts.length < 2;
    if (strip.hidden) return;

    stmts.forEach((r, i) => {
      const sql = input.value.slice(r.start, r.end);
      const d = describe(sql);
      const o = outcomes[i] || {};
      strip.append(h('button', {
        class: 'res' + (o.error ? ' bad' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': String(i === activeIdx),
        title: sql.trim(),
        onclick: () => {
          activeIdx = i;
          input.focus();
          input.setSelectionRange(r.start, r.start);
          sync(true);
          onPick(i);
        },
      },
        h('span', { class: 'n', text: String(i + 1) }),
        h('span', { class: 'verb', text: d.verb }),
        d.table ? h('span', { class: 'tbl', text: d.table }) : null,
        // Outcome only. Duration belongs to the footer, describing the one
        // chip you have selected, so no number is printed twice.
        h('span', { class: 'out', text: o.error ? 'failed' : (o.rows ?? 'not run') })));
    });
  }

  input.addEventListener('input', () => sync(false));
  input.addEventListener('click', () => sync(false));
  input.addEventListener('keyup', (ev) => {
    if (ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') sync(false);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); onRun?.(); }
  });
  resetBtn.addEventListener('click', () => { set(baseline); input.focus(); });

  function set(text, { baseline: b } = {}) {
    input.value = text || '';
    if (b !== undefined) baseline = b;
    else if (!baseline) baseline = text || '';
    activeIdx = 0;
    sync(true);
  }

  return {
    el,
    input,
    set,
    rebase(text) { baseline = text; set(text, { baseline: text }); },
    value: () => input.value,
    dirty: () => input.value.trim() !== baseline.trim(),
    baseline: () => baseline,
    statements: () => stmts.map((r) => input.value.slice(r.start, r.end)),
    activeIndex: () => activeIdx,
    activeStatement: () => (stmts.length ? input.value.slice(stmts[activeIdx].start, stmts[activeIdx].end) : ''),
    setOutcomes(list) { outcomes = list || []; sync(true); },
    onPick(fn) { onPick = fn; },
    focus: () => input.focus(),
  };
}
