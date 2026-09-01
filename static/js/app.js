// app.js - bootstrap and the global keymap.
//
// Every binding carries a description, because the help overlay is built
// from this registry rather than from a second list that would drift.

import { $, toast } from './dom.js';
import { api, aborted } from './api.js';
import { setServers, watchStatus, servers } from './state.js';
import * as sidebar from './sidebar.js';
import * as tabs from './tabs.js';
import { openTable } from './data.js';
import { addServer, editServer, serverMenu } from './servers.js';
import * as keymap from './keymap.js';
import { openStructure } from './structure.js';
import { openConsole } from './console.js';
import { openPalette } from './palette.js';
import { openDashboard } from './dashboard.js';
import { openQueryLog } from './querylog.js';
import { openERM } from './erm.js';
import { openHelp } from './help.js';

// One controller for the page's lifetime, so a reload tears every stream
// down cleanly.
const page = new AbortController();

async function reloadServers() {
  try {
    setServers(await api.servers(page.signal));
    sidebar.render();
    // A hue may have changed in the connection sheet, and the chips and
    // the window edge are drawn from it.
    tabs.repaint();
  } catch (e) {
    if (!aborted(e)) toast('Could not load servers: ' + e.message, 'err');
  }
}

// context works out what the shortcuts should act on: the focused tab if
// there is one, otherwise whatever the sidebar has selected.
function context() {
  const t = tabs.current();
  if (t?.api?.ctx) return t.api.ctx;
  return sidebar.selection() || {};
}

function bindKeys() {
  keymap.bind('mod+k', openPalette, {
    inField: true, group: 'Navigate',
    desc: 'Jump to a server, database or table',
  });
  keymap.bind('/', () => sidebar.focusFilter(), {
    group: 'Navigate', desc: 'Find a table (the palette, already on tables)',
  });
  keymap.bind('mod+backslash', () => {
    const app = $('#app');
    app.dataset.sidebar = app.dataset.sidebar === 'off' ? 'on' : 'off';
  }, { inField: true, group: 'Navigate', desc: 'Show or hide the sidebar' });
  keymap.bind(['?', 'shift+?'], openHelp, {
    group: 'Navigate', desc: 'This list',
  });

  keymap.bind('mod+d', () => {
    const c = context();
    if (!c.db || !c.table) { toast('Select a table first'); return; }
    openStructure(c.server, c.db, c.table);
  }, { inField: true, group: 'Open', desc: 'Structure editor for the current table' });

  keymap.bind('mod+t', async () => {
    const c = context();
    if (c.server && !c.db) { openConsoleFor(c.server); return; }
    openConsole(c.server, c.db, '');
  }, { inField: true, group: 'Open', desc: 'New SQL console' });

  keymap.bind('mod+shift+d', () => {
    const c = context();
    const server = c.server || [...sidebarServers()][0];
    if (!server) { toast('Select a server first'); return; }
    openDashboard(server);
  }, { inField: true, group: 'Open', desc: 'Dashboard: what this server is doing' });

  keymap.bind('mod+shift+l', () => openQueryLog({ server: context().server }), {
    inField: true, group: 'Open', desc: 'Query log — everything mydb has run',
  });

  keymap.bind('mod+enter', () => {
    const t = tabs.current();
    if (t?.api?.run) t.api.run();
    else if (t?.api?.reload) t.api.reload();
  }, { inField: true, group: 'Run', desc: 'Run the query / reload the grid' });

  keymap.bind('mod+r', () => {
    const t = tabs.current();
    if (t?.api?.reload) t.api.reload();
    else return false; // let the browser reload the page
    return true;
  }, { inField: true, group: 'Run', desc: 'Reload the current tab' });

  keymap.bind('escape', () => {
    const t = tabs.current();
    if (t?.api?.cancel) { t.api.cancel(); return true; }
    return false;
  }, { group: 'Run', desc: 'Cancel the running query (a real KILL QUERY)' });

  keymap.bind('mod+w', () => tabs.closeActive(), {
    inField: true, group: 'Tabs', desc: 'Close this tab',
  });
  keymap.bind('mod+shift+w', closeAll, {
    inField: true, group: 'Tabs', desc: 'Close every tab',
  });

  // Handled inside the console, the grid and the completion popup, listed
  // here so the overlay is the whole truth about the keyboard.
  keymap.doc('mod+shift+enter', 'Run every statement in the buffer', 'Run');
  keymap.doc('mod+e', 'Explain the statement the cursor is in', 'Run');
  keymap.doc('mod+shift+e', 'Analyze: run it and show the real plan', 'Run');
  keymap.doc('mod+space', 'Force the completion list open (it also opens as you type)', 'Editor');
  keymap.doc('escape', 'Dismiss the completion list', 'Editor');
  keymap.doc('up', 'Previous statement from history (on an empty editor)', 'Editor');
  keymap.doc('tab', 'Accept the highlighted completion', 'Editor');
  keymap.doc('arrows', 'Move around the grid', 'Grid');
  keymap.doc('enter', 'Edit the focused cell', 'Grid');
  keymap.doc('mod+0', 'Set the focused cell to NULL', 'Grid');
  keymap.doc('mod+c', 'Copy the focused cell', 'Grid');
  keymap.doc('mod+shift+x', 'Copy the ticked columns as CSV, header row included', 'Grid');
  keymap.doc('pageup', 'Move a screen up · PageDown moves down', 'Grid');
  keymap.doc('home', 'First column · End is the last · Ctrl+Home the first row', 'Grid');

  keymap.start();
}

// sidebarServers is the fallback for a dashboard shortcut pressed before
// anything has been selected.
function* sidebarServers() {
  for (const e of sidebar.entries()) {
    if (e.kind === 'server') yield e.server;
  }
}

// closeAll clears the work that costs nothing to reopen, and asks only
// about the work that does.
//
// A table you browsed and a schema you looked at can be opened again in a
// click. A statement you wrote over the generated one, a console you typed
// into, an ALTER you assembled and have not applied: those exist nowhere
// else, and losing them to a button meant for tidying up is the kind of
// thing you only forgive once. So the question names them.
function closeAll() {
  const dirty = tabs.all().filter((t) => {
    try { return !!t.api?.dirty?.(); } catch { return false; }
  });
  for (const t of tabs.all()) {
    if (!dirty.includes(t)) tabs.close(t.id);
  }
  if (!dirty.length) return;

  const names = dirty.map((t) => t.title).join(', ');
  const ask = dirty.length === 1
    ? `${names} has changes you made and nothing else has a copy of them.\n\nClose it too?`
    : `${dirty.length} of these have changes you made, and nothing else has a copy of them:\n\n  ${dirty.map((t) => t.title).join('\n  ')}\n\nClose them too?`;
  if (confirm(ask)) for (const t of dirty) tabs.close(t.id);
}

function wireChrome() {
  $('#add-server').addEventListener('click', () => addServer());
  $('#open-any').addEventListener('click', () => openPalette());
  $('#open-help').addEventListener('click', openHelp);
  $('#close-all').addEventListener('click', closeAll);

  const grouping = $('#group-toggle');
  grouping.addEventListener('click', () => {
    const on = grouping.getAttribute('aria-pressed') !== 'true';
    grouping.setAttribute('aria-pressed', String(on));
    sidebar.setGrouping(on);
  });

  document.addEventListener('mydb:servers-changed', reloadServers);
  window.addEventListener('beforeunload', () => page.abort());
}

// SYSTEM_DBS are the schemas nobody means when they say "open a console
// on this server".
const SYSTEM_DBS = /^(information_schema|performance_schema|mysql|sys)$/;

// pickDb works out which database an action on a server should act on.
// Opening a console with the server filled in and the database left blank
// is half an answer: the next thing you do is always type the database.
async function pickDb(server) {
  const c = sidebar.selection();
  if (c.server === server && c.db) return c.db;

  // Whatever is open and belongs to this server is a better guess than
  // alphabetical order.
  for (const t of tabs.all()) {
    if (t.server === server && t.api?.ctx?.db) return t.api.ctx.db;
  }
  try {
    const dbs = await api.databases(server, page.signal);
    return dbs.find((d) => !SYSTEM_DBS.test(d.name))?.name || dbs[0]?.name || '';
  } catch (e) {
    if (!aborted(e)) toast(e.message, 'err');
    return '';
  }
}

// The diagram is per-schema, so a server-level menu item has to choose
// one. Asking "which?" first is a worse answer than opening the obvious.
async function openSchemaFor(server) {
  const db = await pickDb(server);
  if (!db) { toast('No schema to draw on ' + server); return; }
  openERM(server, db);
}

async function openConsoleFor(server) {
  openConsole(server, await pickDb(server), '');
}

// tunnel says how the sidebar's footer describes the connections: how many
// are dialled through SSH, since that is the thing worth knowing about a
// server you cannot reach directly.
function drawTunnel() {
  const all = [...servers.values()];
  const tunnelled = all.filter((s) => s.ssh).length;
  const ready = all.filter((s) => s.status?.state === 'ready').length;
  const el = $('#tunnel');
  if (!el) return;
  el.textContent = tunnelled
    ? `ssh · ${tunnelled} tunnel${tunnelled === 1 ? '' : 's'} · ${ready} connected`
    : `${ready} of ${all.length} connected`;
}

async function main() {
  sidebar.init({
    onOpenTable: (server, db, table) => openTable(server, db, table),
    onOpenServer: (server) => openDashboard(server),
    onServerMenu: (server, anchor) => serverMenu(server, anchor, {
      health: openDashboard,
      log: (name) => openQueryLog({ server: name }),
      schema: (name) => openSchemaFor(name),
      console: openConsoleFor,
      edit: editServer,
    }),
  });
  wireChrome();
  bindKeys();

  await reloadServers();
  drawTunnel();
  document.addEventListener('mydb:status', drawTunnel);

  // Fire and forget: the status stream reconnects on its own.
  watchStatus(page.signal).catch((e) => {
    if (!aborted(e)) console.warn('mydb: status watcher stopped', e);
  });
}

main().catch((e) => toast('Startup failed: ' + e.message, 'err'));
