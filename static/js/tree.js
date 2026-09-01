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
import { openTable } from './data.js';

const tree = () => document.getElementById('tree');

// encodingIssue reports how a table's encoding differs from the database
// it lives in.
//
// A different charset is the one that bites: it silently mangles text on
// the way in and out. A matching charset with a different collation is
// milder but still worth seeing, because a join across two collations
// fails with "illegal mix of collations" rather than returning rows.
function encodingIssue(t, db) {
  if (!db || !t.charset || (t.type || '').toUpperCase() === 'VIEW') return null;
  if (t.charset !== db.charset) {
    return {
      level: 'bad',
      text: t.charset,
      why: 'table is ' + t.charset + ', database default is ' + db.charset,
    };
  }
  if (t.collation && db.collation && t.collation !== db.collation) {
    return {
      level: 'warn',
      text: t.collation.replace(t.charset + '_', ''),
      why: 'table collation is ' + t.collation + ', database default is ' + db.collation,
    };
  }
  return null;
}

// shortVersion keeps the part of a version string that identifies the
// server and drops the packaging. A distro appends its own build to it --
// 8.0.46-0ubuntu0.24.04.1 -- and in a 236px sidebar that suffix is longer
// than everything else on the row put together. The whole string stays in
// the tooltip.
function shortVersion(v) {
  if (!v) return '';
  const m = /^(\d+\.\d+\.\d+)/.exec(String(v));
  return m ? m[1] : String(v).split('-')[0];
}

// dbOf finds the database record a table belongs to, so its encoding has
// something to be compared against.
function dbOf(server, dbName) {
  return (cache.get(server) || []).find((d) => d.name === dbName);
}

// What is expanded, what is selected, and which prefix groups are open.
// Kept here rather than in the DOM so a redraw does not collapse the world.
const open = new Set();          // "server" and "server/db"
const openGroups = new Set();    // "server/db/prefix"
const cache = new Map();         // "server" -> [db], "server/db" -> [table]

let selected = null;             // {server, db, table}
let grouping = true;

// Opening a table is what the tree is for, so that is the default rather
// than something a caller has to remember to wire. A tree that silently
// does nothing on double-click is a worse failure than a wrong callback,
// because nothing about it looks broken.
let onOpen = { table: openTable };

export function init({ onOpenTable, onOpenServer, onServerMenu } = {}) {
  onOpen = {
    table: onOpenTable || openTable,
    server: onOpenServer,
    menu: onServerMenu,
  };
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
    // A production server is marked in the tree as well as on the top
    // edge: the edge says what you are looking at, this says what you are
    // about to click.
    class: 'srv ' + classOf(s.colour) + (s.production ? ' prod' : ''),
    title: s.name + (s.ssh ? ' via ' + s.ssh.host : '')
      + (s.production ? '\n\u26a0 marked production' : ''),
    ondblclick: () => onOpen.server?.(s.name),
  },
    h('span', { class: 'twist', onclick: (ev) => { ev.stopPropagation(); toggleServer(s.name); } },
      open.has(s.name) ? '▾' : '▸'),
    h('span', { class: 'led ' + state, title: state }),
    flavorBadge(s),
    h('span', { class: 'name' }, s.name),
    s.production ? h('span', { class: 'prod-badge', text: 'PROD' }) : null,
    h('span', {
      class: 'meta',
      title: s.status?.version || '',
    }, shortVersion(s.status?.version)));

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
// The two forks differ in enough places -- DDL progress reporting, default
// lock_wait_timeout, SHOW CREATE output -- that it is worth seeing which
// one you are about to change.
function flavorBadge(s) {
  const f = s.status?.flavor;
  if (!f) return h('span', { class: 'flavor none', title: 'not connected yet' });
  return h('span', {
    class: 'flavor ' + f,
    title: (f === 'mariadb' ? 'MariaDB' : 'MySQL') + ' ' + (s.status.version || ''),
  }, f === 'mariadb' ? 'Ma' : 'My');
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
    db.charset ? h('span', { class: 'enc n', title: 'default encoding' }, db.charset) : null);
}

function tableRow(s, db, t, prefix) {
  const isView = (t.type || '').toUpperCase() === 'VIEW';
  const issue = encodingIssue(t, dbOf(s.name, db.name));
  const name = prefix
    ? h('span', {}, h('span', { class: 'pfx' }, prefix + '_'), t.name.slice(prefix.length + 1))
    : h('span', {}, t.name);

  const row = h('button', {
    class: 'tbl' + (prefix ? ' in-grp' : ''),
    type: 'button',
    'data-table': t.name,
    title: t.name + (isView ? ' (view)' : ''),
    'data-charset': t.charset || '',
    onclick: () => select(s.name, db.name, t.name),
    ondblclick: () => { select(s.name, db.name, t.name); onOpen.table?.(s.name, db.name, t.name); },
  },
    isView ? h('span', { class: 'view-mark' }, '◇') : null,
    name,
    issue ? h('span', { class: 'enc ' + issue.level, title: issue.why }, issue.text) : null,
    h('span', { class: 'rows' }, t.rows == null ? '' : short(t.rows)));
  if (issue) row.title = t.name + ' — ' + issue.why;

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

// expand opens a server, and optionally one of its databases, fetching
// what it needs. Awaitable, so the palette can jump somewhere and know the
// tree has caught up before it selects.
export async function expand(server, db) {
  if (!open.has(server)) {
    open.add(server);
    if (!cache.has(server)) cache.set(server, await api.databases(server));
  }
  if (db) {
    const key = server + '/' + db;
    if (!open.has(key)) {
      open.add(key);
      if (!cache.has(key)) cache.set(key, await api.tables(server, db));
    }
  }
  draw();
}

// reveal selects a table and opens the prefix group holding it.
export function reveal(server, db, table) {
  selected = { server, db, table };
  revealGroup(server + '/' + db, table);
  draw();
}

// known yields every database whose tables have been fetched, which is
// what the palette searches. Nothing is fetched here: asking every server
// for every table on each keystroke is not a search box.
export function* known() {
  for (const [key, value] of cache) {
    if (!key.includes('/')) continue;
    const [server, db] = key.split('/');
    yield { server, db, tables: value };
  }
}
