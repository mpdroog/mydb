// dom.js - element helpers.
//
// Nothing here ever touches innerHTML. Cell values come out of databases we
// do not control, so every string reaches the page as textContent.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && k !== 'type') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';

// svg builds an SVG element. Separate from h() because SVG needs
// createElementNS -- createElement would produce an HTML element of the
// same name, which renders as nothing at all inside an <svg>.
export function svg(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function toast(msg, kind = '') {
  const box = $('#toasts');
  const el = h('div', { class: 'toast ' + kind, text: String(msg) });
  box.append(el);
  const life = kind === 'err' ? 9000 : 3500;
  setTimeout(() => el.remove(), life);
  return el;
}

// modal shows a card and returns a close func. Esc and a backdrop click
// both close it, so nothing can trap the keyboard.
export function modal(title, bodyEl, footEls) {
  const host = $('#modal');
  const card = h('div', { class: 'card' },
    h('h2', { text: title }),
    h('div', { class: 'body' }, bodyEl),
    footEls ? h('div', { class: 'foot' }, footEls) : null,
  );

  clear(host);
  host.append(card);
  host.hidden = false;

  const close = () => {
    host.hidden = true;
    clear(host);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); }
  };

  document.addEventListener('keydown', onKey, true);
  host.addEventListener('mousedown', (ev) => { if (ev.target === host) close(); });

  const first = card.querySelector('input, textarea, select, button');
  if (first) first.focus();
  return close;
}

// field builds a labelled form row.
export function field(label, input) {
  return h('div', { class: 'field' }, h('label', { text: label }), input);
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

export function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

// fmtProgress turns what the server said it is doing into a line worth
// reading. MariaDB reports a stage and a percentage for a table rebuild;
// MySQL reports only the state, so both shapes have to render.
export function fmtProgress(p) {
  if (!p) return '';
  const bits = [];
  if (p.stage && p.max_stage) bits.push('stage ' + p.stage + '/' + p.max_stage);
  if (typeof p.percent === 'number' && p.percent >= 0) bits.push(p.percent.toFixed(1) + '%');
  if (p.state) bits.push(p.state);
  return bits.join(' · ');
}
