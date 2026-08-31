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

export function open({ key, title, build, danger }) {
  const found = list.find((t) => t.key === key && key);
  if (found) { activate(found.id); return found; }

  const id = 'tab' + (++seq);
  // A pane belonging to a production server carries a red rule along its
  // top edge. It is the one piece of chrome that is always in view while
  // you work, which is the point.
  const pane = h('div', { class: 'pane' + (danger ? ' prod' : ''), hidden: true });
  const ctl = new AbortController();

  const btn = h('div', { class: 'tab' + (danger ? ' prod' : ''), role: 'tab' },
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
  updateTools();
  return tab;
}

// updateTools shows the close-all button only when there is more than one
// tab to close, so it is not a permanent piece of furniture.
function updateTools() {
  const btn = $('#close-all');
  if (btn) btn.hidden = list.length < 2;
}

export function activate(id) {
  for (const t of list) {
    const on = t.id === id;
    t.pane.hidden = !on;
    t.btn.classList.toggle('active', on);
    if (on) active = t;
  }
  active?.api?.onShow?.();
  if (active) keepVisible(active.btn);
}

// keepVisible scrolls the tab bar, and nothing but the tab bar, so the
// active tab is in view. scrollIntoView() would also scroll every ancestor
// up to the body, which clips its overflow: one such scroll and the sidebar
// sits off-screen with no way left to scroll it back.
function keepVisible(btn) {
  const box = bar().getBoundingClientRect();
  const tab = btn.getBoundingClientRect();
  if (tab.left < box.left) bar().scrollLeft -= box.left - tab.left;
  else if (tab.right > box.right) bar().scrollLeft += tab.right - box.right;
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

// closeAll empties the tab bar.
//
// Each tab is closed through close(), so every one of them disposes its
// job and aborts its requests — which on the Go side cancels the query it
// was waiting on. A schema change is the exception and detaches instead,
// exactly as it does when you close its tab by hand.
export function closeAll() {
  for (const t of [...list]) close(t.id);
}

// count is how many tabs are open, for the confirmation on closing a lot
// of them at once.
export function count() {
  return list.length;
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
