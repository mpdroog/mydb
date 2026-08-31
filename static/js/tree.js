// tree.js - the sidebar: servers, their databases, their tables.
//
// Two things it holds to. Single click selects and double click opens,
// which is the contract the whole tree shares rather than tables having one
// rule and servers another. And a table list is folded on shared prefixes,
// because a schema of two hundred tables named for six subsystems is a
// list you scroll rather than read.

import { h, clear, toast } from './dom.js';
import { api, aborted } from './api.js';
import { servers, statusOf } from './state.js';
import { classOf } from './colour.js';
import { byPrefix } from './group.js';

const tree = () => document.getElementById('tree');

// What is expanded, what is selected, and which prefix groups are open.
// Kept here rather than in the DOM so a redraw does not collapse the world.
const open = new Set();          // "server" and "server/db"
const openGroups = new Set();    // "server/db/prefix"
const cache = new Map();         // "server" -> [db], "server/db" -> [table]

let selected = null;             // {server, db, table}
let grouping = true;
let onOpen = () => {};

export function init({ onOpenTable, onOpenServer, onServerMenu }) {
  onOpen = { table: onOpenTable, server: onOpenServer, menu: onServerMenu };
}

export function setGrouping(on) { grouping = on; draw(); }
export function selection() { return selected; }

// ---------------------------------------------------------------- drawing

export function draw() {
  const el = tree();
  if (!el) return;
  clear(el);

  for (const s of servers.values()) {
    el.append(serverRow(s));
    if (!open.has(s.name)) continue;

    const dbs = cache.get(s.name);
    if (!dbs) { el.append(pending('databases')); continue; }
    for (const db of dbs) {
      el.append(dbRow(s, db));
      const key = s.name + '/' + db.name;
      if (!open.has(key)) continue;

      const tables = cache.get(key);
      if (!tables) { el.append(pending('tables')); continue; }
      for (const node of drawTables(s, db, tables)) el.append(node);
    }
  }
}

function pending(what) {
  return h('div', { class: 'db dim' }, h('span', { class: 'twist' }), 'loading ' + what + '…');
}

function drawTables(s, db, tables) {
  const out = [];
  if (!grouping) {
    for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(tableRow(s, db, t, ''));
    }
    return out;
  }

  for (const e of byPrefix(tables)) {
    if (!e.group) { out.push(tableRow(s, db, e.table, '')); continue; }

    const key = s.name + '/' + db.name + '/' + e.key;
    const isOpen = openGroups.has(key);
    const row = h('button', {
      class: 'grp',
      type: 'button',
      'aria-expanded': String(isOpen),
      title: e.tables.map((t) => t.name).join(', '),
      onclick: () => { openGroups.has(key) ? openGroups.delete(key) : openGroups.add(key); draw(); },
    },
      h('span', { class: 'twist' }, isOpen ? '▾' : '▸'),
      h('span', {}, e.key + '_', h('span', { class: 'dim' }, '*')),
      h('span', { class: 'n' }, String(e.tables.length)));
    out.push(row);

    if (isOpen) for (const t of e.tables) out.push(tableRow(s, db, t, e.key));
  }
  return out;
}

// ------------------------------------------------------------------- rows

function serverRow(s) {
  const state = statusOf(s.name);
  const row = h('div', {
    class: 'srv ' + classOf(s.colour),
    ondblclick: () => onOpen.server?.(s.name),
  },
    h('span', { class: 'twist', onclick: (ev) => { ev.stopPropagation(); toggleServer(s.name); } },
      open.has(s.name) ? '▾' : '▸'),
    h('span', { class: 'led ' + state, title: state }),
    flavorBadge(s),
    h('span', { class: 'name', title: 'Double-click to open ' + s.name + ' health' }, s.name),
    h('span', { class: 'meta' }, s.version || ''));

  row.append(h('button', {
    class: 'icon srv-act',
    type: 'button',
    'aria-label': 'Actions for ' + s.name,
    onclick: (ev) => { ev.stopPropagation(); onOpen.menu?.(s, ev.currentTarget); },
  }, dots()));
  row.addEventListener('click', () => toggleServer(s.name));
  return row;
}

function dots() {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'currentColor');
  el.setAttribute('aria-hidden', 'true');
  for (const cx of [5, 12, 19]) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', '12');
    c.setAttribute('r', '1.7');
    el.append(c);
  }
  return el;
}

// A wordmark rather than a logo: both are trademarks, and a 12px redrawing
// of either would be a poor likeness.
function flavorBadge(s) {
  const f = (s.status?.flavor || s.flavor || '').toLowerCase();
  const kind = f.includes('maria') ? 'mariadb' : f.includes('mysql') ? 'mysql' : 'none';
  const text = kind === 'mariadb' ? 'Ma' : kind === 'mysql' ? 'My' : '?';
  return h('span', { class: 'flavor ' + kind, title: s.status?.flavor || 'not connected' }, text);
}

function dbRow(s, db) {
  const key = s.name + '/' + db.name;
  return h('button', {
    class: 'db',
    type: 'button',
    onclick: () => toggleDb(s.name, db.name),
  },
    h('span', { class: 'twist' }, open.has(key) ? '▾' : '▸'),
    h('span', {}, db.name),
    db.charset ? h('span', { class: 'enc n' }, db.charset) : null);
}

function tableRow(s, db, t, prefix) {
  const isView = (t.type || '').toUpperCase() === 'VIEW';
  const name = prefix
    ? h('span', {}, h('span', { class: 'pfx' }, prefix + '_'), t.name.slice(prefix.length + 1))
    : h('span', {}, t.name);

  const row = h('button', {
    class: 'tbl' + (prefix ? ' in-grp' : ''),
    type: 'button',
    'data-table': t.name,
    title: t.name + (isView ? ' (view)' : ''),
    onclick: () => select(s.name, db.name, t.name),
    ondblclick: () => { select(s.name, db.name, t.name); onOpen.table?.(s.name, db.name, t.name); },
  },
    isView ? h('span', { class: 'view-mark' }, '◇') : null,
    name,
    h('span', { class: 'rows' }, t.rows == null ? '' : short(t.rows)));

  if (selected && selected.server === s.name && selected.db === db.name && selected.table === t.name) {
    row.setAttribute('aria-current', 'true');
  }
  return row;
}

function short(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

// --------------------------------------------------------------- expanding

function select(server, db, table) {
  selected = { server, db, table };
  for (const el of tree().querySelectorAll('.tbl[aria-current]')) el.removeAttribute('aria-current');
  const el = [...tree().querySelectorAll('.tbl')].find((x) => x.dataset.table === table);
  el?.setAttribute('aria-current', 'true');
}

async function toggleServer(name) {
  if (open.has(name)) { open.delete(name); draw(); return; }
  open.add(name);
  draw();
  if (cache.has(name)) return;
  try {
    cache.set(name, await api.databases(name));
  } catch (e) {
    if (!aborted(e)) { toast(e.message, 'err'); open.delete(name); }
  }
  draw();
}

async function toggleDb(server, db) {
  const key = server + '/' + db;
  if (open.has(key)) { open.delete(key); draw(); return; }
  open.add(key);
  draw();
  if (cache.has(key)) return;
  try {
    const tables = await api.tables(server, db);
    cache.set(key, tables);
    // Reveal the group holding whatever is already selected, once, so
    // opening a database does not hide the table you came here for.
    if (selected?.server === server && selected?.db === db) revealGroup(key, selected.table);
  } catch (e) {
    if (!aborted(e)) { toast(e.message, 'err'); open.delete(key); }
  }
  draw();
}

// revealGroup opens the prefix group a table belongs to. Called when the
// selection moves, never from draw(): a group the operator deliberately
// collapsed must stay collapsed.
export function revealGroup(dbKey, table) {
  const tables = cache.get(dbKey);
  if (!tables) return;
  for (const e of byPrefix(tables)) {
    if (e.group && e.tables.some((t) => t.name === table)) openGroups.add(dbKey + '/' + e.key);
  }
}

// forget drops a server's cached databases and tables, so the next expand
// asks the server again rather than drawing what used to be there.
export function forget(server) {
  for (const k of [...cache.keys()]) if (k === server || k.startsWith(server + '/')) cache.delete(k);
  for (const k of [...open.keys()]) if (k === server || k.startsWith(server + '/')) open.delete(k);
}
