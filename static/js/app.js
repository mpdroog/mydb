// app.js - bootstrap and the global keymap.
//
// Every binding carries a description, because the help overlay is built
// from this registry rather than from a second list that would drift.

import { $, toast } from './dom.js';
import { api, aborted } from './api.js';
import { setServers, watchStatus } from './state.js';
import * as sidebar from './sidebar.js';
import * as tabs from './tabs.js';
import * as keymap from './keymap.js';
import { openStructure } from './structure.js';
import { openConsole } from './console.js';
import { openPalette } from './palette.js';
import { openDashboard } from './dashboard.js';
import { openQueryLog } from './querylog.js';
import { openHelp } from './help.js';
import { addServer } from './servers.js';

// One controller for the page's lifetime, so a reload tears every stream
// down cleanly.
const page = new AbortController();

async function reloadServers() {
  try {
    setServers(await api.servers(page.signal));
    sidebar.render();
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
    group: 'Navigate', desc: 'Focus the sidebar filter',
  });
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
  $('#open-sql').addEventListener('click', () => {
    const c = context();
    openConsole(c.server, c.db, '');
  });
  $('#open-qlog').addEventListener('click', () => openQueryLog({ server: context().server }));
  $('#open-help').addEventListener('click', openHelp);
  $('#close-all').addEventListener('click', closeAll);
  document.addEventListener('mydb:servers-changed', reloadServers);
  window.addEventListener('beforeunload', () => page.abort());
}

async function main() {
  sidebar.init();
  wireChrome();
  bindKeys();

  await reloadServers();

  // Fire and forget: the status stream reconnects on its own.
  watchStatus(page.signal).catch((e) => {
    if (!aborted(e)) console.warn('mydb: status watcher stopped', e);
  });
}

main().catch((e) => toast('Startup failed: ' + e.message, 'err'));
