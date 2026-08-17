// app.js - bootstrap and the global keymap.

import { $, toast } from './dom.js';
import { api, aborted } from './api.js';
import { setServers, watchStatus } from './state.js';
import * as sidebar from './sidebar.js';
import * as tabs from './tabs.js';
import * as keymap from './keymap.js';
import { openStructure } from './structure.js';
import { openConsole } from './console.js';
import { openPalette } from './palette.js';
import { addServer } from './servers.js';

// One controller for the page's lifetime, so a reload tears every stream
// down cleanly.
const page = new AbortController();

async function reloadServers() {
  try {
    setServers(await api.servers(page.signal));
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
  keymap.bind('mod+k', openPalette, { inField: true });
  keymap.bind('mod+w', () => tabs.closeActive(), { inField: true });
  keymap.bind('/', () => sidebar.focusFilter());

  keymap.bind('mod+d', () => {
    const c = context();
    if (!c.db || !c.table) { toast('Select a table first'); return; }
    openStructure(c.server, c.db, c.table);
  }, { inField: true });

  keymap.bind('mod+enter', () => {
    const t = tabs.current();
    if (t?.api?.run) t.api.run();
    else if (t?.api?.reload) t.api.reload();
  }, { inField: true });

  keymap.bind('mod+t', () => {
    const c = context();
    openConsole(c.server, c.db, '');
  }, { inField: true });

  keymap.bind('mod+r', () => {
    const t = tabs.current();
    if (t?.api?.reload) t.api.reload();
    else return false; // let the browser reload the page
    return true;
  }, { inField: true });

  keymap.bind('escape', () => {
    const t = tabs.current();
    if (t?.api?.cancel) { t.api.cancel(); return true; }
    return false;
  });

  keymap.start();
}

function wireChrome() {
  $('#add-server').addEventListener('click', () => addServer());
  $('#open-sql').addEventListener('click', () => {
    const c = context();
    openConsole(c.server, c.db, '');
  });
  document.addEventListener('mydb:servers-changed', reloadServers);
  window.addEventListener('beforeunload', () => page.abort());
}

async function main() {
  sidebar.init();
  wireChrome();
  bindKeys();

  await reloadServers();
  sidebar.render();

  // Fire and forget: the status stream reconnects on its own.
  watchStatus(page.signal).catch((e) => {
    if (!aborted(e)) console.warn('mydb: status watcher stopped', e);
  });
}

main().catch((e) => toast('Startup failed: ' + e.message, 'err'));
