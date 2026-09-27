// crumb.js - which server, which database, which table.
//
// Every pane opens with one, so the answer to "where am I about to run
// this" is in the same place whatever you are looking at. The server wears
// its own colour here too: the name alone is a word, and a word in the
// same grey as every other word is not something you notice in time.

import { h } from './dom.js';
import { servers, isProduction } from './state.js';
import { classOf } from './colour.js';

export function crumb(server, db, table) {
  const s = servers.get(server);
  // Whichever address this one actually has: a socket server has no host,
  // and "prod-eu" with nothing after it is a worse tooltip than the path.
  const where = s?.socket || s?.host;
  const el = h('div', { class: 'crumb ' + classOf(s?.colour) },
    h('span', { class: 'env', title: where ? server + ' — ' + where : server },
      h('span', { class: 'swatch' }), server || '—'));

  if (db) el.append(h('span', { class: 'sep', text: '/' }), h('span', { text: db }));
  if (table) el.append(h('span', { class: 'sep', text: '/' }), h('b', { text: table }));
  if (isProduction(server)) {
    el.append(h('span', { class: 'prod-badge', title: 'A mistake here is expensive', text: 'prod' }));
  }
  return el;
}
