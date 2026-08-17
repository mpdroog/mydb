// palette.js - the Ctrl/Cmd+K quick-switcher over servers, databases and
// tables. It only lists what the sidebar has already loaded, so opening it
// costs nothing and never waits on the network.

import { h, modal, clear } from './dom.js';
import { entries, reveal } from './sidebar.js';
import { openTable } from './data.js';
import { api } from './api.js';

export function openPalette() {
  const all = entries();
  const input = h('input', { type: 'text', placeholder: 'Jump to server, database or table…', spellcheck: false });
  const list = h('div', { class: 'pal-list' });
  const box = h('div', { class: 'pal' }, input, list);

  let shown = [];
  let cursor = 0;

  function score(item, q) {
    const l = item.label.toLowerCase();
    if (!q) return 1;
    if (l.includes(q)) return 100 - l.indexOf(q);
    // Loose subsequence match, so "shord" finds "shop / orders".
    let i = 0;
    for (const ch of q) {
      i = l.indexOf(ch, i);
      if (i < 0) return 0;
      i++;
    }
    return 1;
  }

  function draw() {
    const q = input.value.trim().toLowerCase();
    shown = all
      .map((it) => ({ it, s: score(it, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.it);

    if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);

    clear(list);
    shown.forEach((it, i) => {
      list.append(h('button', {
        type: 'button',
        class: i === cursor ? 'on' : '',
        text: it.label,
        onclick: () => choose(it),
      }));
    });
  }

  function choose(it) {
    close();
    if (it.kind === 'table') openTable(it.server, it.db, it.table);
    else {
      reveal(it);
      if (it.kind === 'server') api.connect(it.server).catch(() => {});
    }
  }

  input.addEventListener('input', () => { cursor = 0; draw(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { cursor = Math.min(cursor + 1, shown.length - 1); draw(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); ev.preventDefault(); }
    else if (ev.key === 'Enter') { if (shown[cursor]) choose(shown[cursor]); ev.preventDefault(); }
  });

  const close = modal('Go to', box, null);
  draw();
}
