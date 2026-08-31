// sidebar.js - the server tree, and the flat index the palette searches.
//
// The tree itself lives in tree.js; this is the seam the rest of the app
// talks to, and the place the palette gets its list of everything from.
//
// There is no filter box here any more. Ctrl+K searches servers, databases
// and tables across every connection, which is a strictly better answer to
// the same question, and two search boxes for one job is one too many.

import { aborted } from './api.js';
import { servers } from './state.js';
import * as tree from './tree.js';
import { openPalette } from './palette.js';

// index is what the palette reads: one flat list of everything the tree
// has learned about, rebuilt as databases and tables arrive.
const index = [];

export function init(handlers = {}) {
  tree.init(handlers);
}

export function render() {
  tree.draw();
  rebuildIndex();
}

export function selection() {
  return tree.selection() || {};
}

// focusFilter is what "/" used to do. It opens the palette already looking
// at tables, which is what the filter was for.
export function focusFilter() {
  openPalette({ scope: 'tables' });
}

export function setGrouping(on) { tree.setGrouping(on); }
export function forget(server) { tree.forget(server); rebuildIndex(); }

// entries yields everything the palette can jump to. Servers always;
// databases and tables for whatever has been expanded, since asking every
// server for every table on every keystroke is not a search box, it is a
// denial of service against your own database.
export function* entries() {
  for (const e of index) yield e;
}

// reveal selects a table in the tree and opens the prefix group holding
// it, so jumping to something from the palette leaves it visible.
export async function reveal({ server, db, table }) {
  if (!server) return;
  await tree.expand(server, db);
  if (table) tree.reveal(server, db, table);
  rebuildIndex();
}

function rebuildIndex() {
  index.length = 0;
  for (const s of servers.values()) {
    index.push({ kind: 'server', server: s.name, label: s.name, colour: s.colour });
  }
  for (const { server, db, tables } of tree.known()) {
    index.push({ kind: 'db', server, db, label: db, colour: colourOf(server) });
    for (const t of tables || []) {
      index.push({
        kind: 'table', server, db, table: t.name, label: t.name,
        rows: t.rows, view: (t.type || '').toUpperCase() === 'VIEW',
        colour: colourOf(server),
      });
    }
  }
}

function colourOf(server) {
  return servers.get(server)?.colour;
}

// warm expands a server quietly, so the palette has something to search
// before anything has been clicked.
export async function warm(server) {
  try {
    await tree.expand(server);
    rebuildIndex();
  } catch (e) {
    if (!aborted(e)) console.warn('mydb: could not warm', server, e);
  }
}
