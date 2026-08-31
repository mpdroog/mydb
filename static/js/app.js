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

  keymap.bind('mod+t', () => {
    const c = context();
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

function closeAll() {
  // Anything still running is worth one question: closing the tab of a
  // schema change leaves it running, but closing the tab of a query does
  // cancel it.
  if (tabs.count() > 2 && !confirm('Close all ' + tabs.count() + ' tabs?')) return;
  tabs.closeAll();
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

// openSchemaFor picks a database to draw. The diagram is per-schema, and
// a server-level menu item that asked "which one?" first would be a worse
// answer than opening the obvious one.
async function openSchemaFor(server) {
  const c = sidebar.selection();
  if (c.server === server && c.db) { openERM(server, c.db); return; }
  try {
    const dbs = await api.databases(server, page.signal);
    const first = dbs.find((d) => !/^(information_schema|performance_schema|mysql|sys)$/.test(d.name));
    if (!first) { toast('No schema to draw on ' + server); return; }
    openERM(server, first.name);
  } catch (e) {
    if (!aborted(e)) toast(e.message, 'err');
  }
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
      console: (name) => openConsole(name, '', ''),
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
