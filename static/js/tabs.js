// tabs.js - the work strip.
//
// Open work is the only navigation there is: no rail duplicating it, and
// nothing to "go to" that is not already a chip. A chip owns an
// AbortController, so closing one aborts every request it started, which
// on the Go side also cancels the query it was waiting on.
//
// Each chip carries three things beyond its title: a three-letter kind, so
// a table is told from a console without reading; its server's colour on
// the left edge, so the same table on two servers is never picked by
// mistake; and an amber kind while its job is still running.
//
// The strip also drives the window's own chrome. Whichever chip is in
// front sets the hue on the top edge and whether the production hazard
// stripe is showing, because that has to describe the work you are looking
// at rather than the last server you happened to click.

import { h, $, clear } from './dom.js';
import { servers } from './state.js';
import { paint } from './colour.js';

const list = [];
let active = null;
let seq = 0;

function bar() { return $('#chips'); }
function panes() { return $('#panes'); }

// KINDS maps a tab key's prefix to the label its chip wears. Derived from
// the key so a caller that does not care gets a sensible one anyway.
const KINDS = {
  data: 'tbl', sql: 'sql', struct: 'ddl', dash: 'srv', erm: 'erm', qlog: 'log',
};

function kindOf(key, given) {
  if (given) return given;
  const head = String(key || '').split(':')[0];
  return KINDS[head] || '';
}

export function open({ key, title, build, danger, server, kind }) {
  const found = list.find((t) => t.key === key && key);
  if (found) { activate(found.id); return found; }

  const id = 'tab' + (++seq);
  const pane = h('div', { class: 'pane' + (danger ? ' prod' : ''), hidden: true });
  const ctl = new AbortController();

  const label = h('span', { class: 'label', text: title });
  const btn = h('button', {
    class: 'chip',
    type: 'button',
    role: 'tab',
    'aria-selected': 'false',
  },
    h('span', { class: 'kind', text: kindOf(key, kind) }),
    label,
    h('span', {
      class: 'x',
      role: 'button',
      title: 'Close',
      onclick: (ev) => { ev.stopPropagation(); close(id); },
    }, '×'),
  );
  paint(btn, servers.get(server)?.colour);

  btn.addEventListener('mousedown', (ev) => {
    if (ev.button === 1) { ev.preventDefault(); close(id); }
  });
  btn.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('x')) return;
    activate(id);
  });

  const tab = { id, key, title, btn, label, pane, ctl, server, danger, api: null };
  list.push(tab);
  bar().append(btn);
  panes().append(pane);

  tab.api = build(pane, ctl.signal, tab) || {};
  activate(id);
  updateTools();
  return tab;
}

// busy paints a chip's kind amber while its job runs, so the strip doubles
// as the list of what is still in flight.
export function busy(tab, on) {
  tab?.btn?.classList.toggle('running', !!on);
}

function updateTools() {
  const btn = $('#close-all');
  if (btn) btn.hidden = list.length < 2;
  const empty = $('#empty');
  if (empty) empty.hidden = list.length > 0;
  if (!list.length) chrome(null);
}

// chrome puts the server of whatever is in front onto the window: its hue
// on the top edge, and the hazard stripe when it is production.
function chrome(tab) {
  const app = $('#app');
  if (!app) return;
  paint(app, tab ? servers.get(tab.server)?.colour : undefined);
  app.dataset.prod = tab?.danger ? 'on' : 'off';
}

export function activate(id) {
  for (const t of list) {
    const on = t.id === id;
    t.pane.hidden = !on;
    t.btn.setAttribute('aria-selected', String(on));
    if (on) active = t;
  }
  chrome(active);
  active?.api?.onShow?.();
  if (active) keepVisible(active.btn);
}

// keepVisible scrolls the strip, and nothing but the strip. scrollIntoView
// would also scroll every ancestor up to the body, which clips its
// overflow: one such scroll and the sidebar sits off-screen with no way
// left to scroll it back.
function keepVisible(btn) {
  const box = bar().getBoundingClientRect();
  const chip = btn.getBoundingClientRect();
  if (chip.left < box.left) bar().scrollLeft -= box.left - chip.left;
  else if (chip.right > box.right) bar().scrollLeft += chip.right - box.right;
}

export function close(id) {
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = list[i];

  t.api?.dispose?.();
  t.ctl.abort();
  t.btn.remove();
  t.pane.remove();
  list.splice(i, 1);

  if (active === t) {
    active = null;
    const next = list[Math.min(i, list.length - 1)];
    if (next) activate(next.id);
  }
  updateTools();
}

export function closeActive() {
  if (active) close(active.id);
}

// closeAll empties the strip.
//
// Each chip is closed through close(), so every one disposes its job and
// aborts its requests -- which on the Go side cancels the query it was
// waiting on. A schema change is the exception and detaches instead,
// exactly as it does when you close its chip by hand.
export function closeAll() {
  for (const t of [...list]) close(t.id);
}

export function count() { return list.length; }
export function current() { return active; }
export function all() { return [...list]; }

export function rename(tab, title) {
  tab.title = title;
  clear(tab.label);
  tab.label.textContent = title;
}

// repaint re-reads every chip's colour, for when the server list reloads
// and a hue has been changed in the connection sheet.
export function repaint() {
  for (const t of list) paint(t.btn, servers.get(t.server)?.colour);
  chrome(active);
}
