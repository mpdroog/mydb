// tabs.js - the tabbed content pane.
//
// A tab owns an AbortController; closing one aborts every request it
// started, which on the Go side also cancels the query it was waiting on.

import { h, $, clear } from './dom.js';

const list = [];
let active = null;
let seq = 0;

function bar() { return $('#tabbar'); }
function panes() { return $('#panes'); }

export function open({ key, title, build }) {
  const found = list.find((t) => t.key === key && key);
  if (found) { activate(found.id); return found; }

  const id = 'tab' + (++seq);
  const pane = h('div', { class: 'pane', hidden: true });
  const ctl = new AbortController();

  const btn = h('div', { class: 'tab', role: 'tab' },
    h('span', { class: 'label', text: title }),
    h('button', {
      class: 'x',
      type: 'button',
      title: 'Close',
      onclick: (ev) => { ev.stopPropagation(); close(id); },
    }, '×'),
  );
  btn.addEventListener('mousedown', (ev) => {
    if (ev.button === 1) { ev.preventDefault(); close(id); }
    else activate(id);
  });

  const tab = { id, key, title, btn, pane, ctl, api: null };
  list.push(tab);
  bar().append(btn);
  panes().append(pane);

  tab.api = build(pane, ctl.signal, tab) || {};
  activate(id);
  return tab;
}

export function activate(id) {
  for (const t of list) {
    const on = t.id === id;
    t.pane.hidden = !on;
    t.btn.classList.toggle('active', on);
    if (on) active = t;
  }
  active?.api?.onShow?.();
  active?.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
}

export function closeActive() {
  if (active) close(active.id);
}

export function current() {
  return active;
}

export function rename(tab, title) {
  tab.title = title;
  clear(tab.btn.querySelector('.label'));
  tab.btn.querySelector('.label').textContent = title;
}

export function all() {
  return [...list];
}
