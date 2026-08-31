// palette.js - the Ctrl/Cmd+K quick-switcher over servers, databases and
// tables. It only lists what the sidebar has already loaded, so opening it
// costs nothing and never waits on the network: asking every server for
// every table on each keystroke is not a search box.
//
// This is also where the sidebar's filter went. Every row wears its
// server's colour and says what kind of thing it is, because the same
// table name on two servers is the case that matters -- picking `orders`
// on production when you meant staging is not a mistake a list of
// identical grey words helps you avoid.

import { h, modal, clear, fmtNum } from './dom.js';
import { entries, reveal } from './sidebar.js';
import { openTable } from './data.js';
import { api } from './api.js';
import { classOf } from './colour.js';

export function openPalette({ scope } = {}) {
  // Everything stays reachable whatever the scope; scoring does the
  // steering, so "/" cannot hide a server you actually wanted.
  const all = [...entries()];
  const input = h('input', {
    type: 'text',
    placeholder: scope === 'tables' ? 'Find a table…' : 'Jump to a server, database or table…',
    spellcheck: false,
  });
  const list = h('div', { class: 'pal-list' });
  const box = h('div', { class: 'pal' }, input, list);

  let shown = [];
  let cursor = 0;

  function score(item, q) {
    const l = item.label.toLowerCase();
    // With "/" the operator asked for tables; keep the rest reachable but
    // never ahead of what was asked for.
    const bias = scope === 'tables' && item.kind !== 'table' ? -50 : 0;
    if (!q) return 1 + bias + (item.kind === 'table' ? 1 : 0);
    if (l.includes(q)) return 100 - l.indexOf(q) + bias;
    // Loose subsequence match, so "shord" finds "shop / orders".
    let i = 0;
    for (const ch of q) {
      i = l.indexOf(ch, i);
      if (i < 0) return 0;
      i++;
    }
    return Math.max(0.1, 1 + bias);
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
        class: (i === cursor ? 'on ' : '') + classOf(it.colour),
        onclick: () => choose(it),
      },
        h('span', { class: 'kind', text: KIND[it.kind] || '' }),
        h('span', { class: 'nm', text: it.label }),
        h('span', { class: 'sub', text: where(it) })));
    });
  }

  const KIND = { server: 'srv', db: 'db', table: 'tbl' };

  // where says which one this is, which is the whole reason the palette
  // beats the sidebar filter it replaced.
  function where(it) {
    if (it.kind === 'server') return it.server;
    if (it.kind === 'db') return it.server;
    return it.server + ' · ' + it.db
      + (it.view ? ' · view' : it.rows == null ? '' : ' · ' + fmtNum(it.rows) + ' rows');
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
