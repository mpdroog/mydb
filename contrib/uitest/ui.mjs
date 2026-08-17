// Drives the real mydb frontend inside jsdom against the live Go server,
// so the click paths get exercised rather than reasoned about.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:9999';
const STATIC = '/home/mp/go/src/github.com/mpdroog/mydb/static';

const html = readFileSync(STATIC + '/index.html', 'utf8');

const dom = new JSDOM(html, {
  url: BASE + '/static/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom has no fetch/EventSource plumbing wired to a real socket, so hand
// the page node's fetch. Everything else (DOM, events) is jsdom's own.
const realFetch = globalThis.fetch;
window.fetch = (url, opts) => realFetch(String(url).startsWith('http') ? url : BASE + url, opts);
window.AbortController = AbortController;
window.TextDecoder = TextDecoder;
// jsdom's localStorage is getter-only; jsdom already provides a working one.
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async () => {} }, configurable: true,
});

// Make the page's globals visible to the modules we import here.
function expose(k, v) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
for (const k of ['document', 'window', 'fetch', 'AbortController', 'TextDecoder',
                 'localStorage', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
                 'CustomEvent', 'HTMLElement', 'getComputedStyle']) {
  if (window[k] !== undefined) expose(k, window[k]);
}
expose('navigator', window.navigator);
expose('confirm', () => true);
expose('requestAnimationFrame', (fn) => setTimeout(fn, 0));
// jsdom implements no layout, so these are no-ops here.
window.Element.prototype.scrollIntoView = function () {};

const sidebar = await import(STATIC + '/js/sidebar.js');
const tabs = await import(STATIC + '/js/tabs.js');
const state = await import(STATIC + '/js/state.js');
const keymap = await import(STATIC + '/js/keymap.js');
const api = (await import(STATIC + '/js/api.js')).api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

let pass = 0, fail = 0;
function ok(cond, what, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  -> ' + extra : '')); }
}
function click(el, count = 1) {
  for (let i = 0; i < count; i++) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  if (count === 2) {
    el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }
}
function nodeNamed(cls, name) {
  return $$('#tree .node.' + cls).find((n) => n.querySelector('.name')?.textContent === name);
}

console.log('--- boot ---');
sidebar.init();
keymap.start();
state.setServers(await api.servers());
sidebar.render();
// app.js starts this; without it nothing ever learns a server went ready.
const page = new AbortController();
state.watchStatus(page.signal).catch(() => {});
ok($$('#tree .node.server').length >= 1, 'sidebar rendered a server row');

console.log('--- expand server -> databases ---');
click(nodeNamed('server', 'local'));
for (let i = 0; i < 40 && !nodeNamed('db', 'mydb_test'); i++) await sleep(150);
ok(!!nodeNamed('db', 'mydb_test'), 'databases appeared after clicking the server');

console.log('--- expand database -> tables ---');
click(nodeNamed('db', 'mydb_test'));
for (let i = 0; i < 40 && !nodeNamed('table', 'orders'); i++) await sleep(150);
ok(!!nodeNamed('table', 'orders'), 'tables appeared after clicking the database');

console.log('--- single click selects without rebuilding the row ---');
const before = nodeNamed('table', 'orders');
click(before);
const after = nodeNamed('table', 'orders');
ok(before === after, 'the row survives a click (this is what dblclick needs)',
   before === after ? '' : 'node was replaced');
ok(after.classList.contains('sel'), 'the clicked row is highlighted');

console.log('--- DOUBLE CLICK a table ---');
click(nodeNamed('table', 'orders'), 2);
for (let i = 0; i < 60 && $$('#tabbar .tab').length === 0; i++) await sleep(150);
ok($$('#tabbar .tab').length === 1, 'a tab opened');
ok($('#tabbar .tab .label')?.textContent === 'orders', 'the tab is named after the table');

console.log('--- the grid actually has content ---');
for (let i = 0; i < 60; i++) {
  if ($$('#panes .gr').length > 0) break;
  await sleep(150);
}
const headers = $$('#panes .gh').map((h) => h.textContent.replace(/\s+$/, ''));
const rows = $$('#panes .gr');
const live = await api.structure('local', 'mydb_test', 'orders');
ok(headers.length === live.columns.length,
   'grid header matches the table (' + live.columns.length + ' columns)',
   'got ' + headers.length + ': ' + headers.join(','));
ok(rows.length > 0, 'grid rendered row elements', 'got ' + rows.length);
ok($('#panes .pane').hidden === false, 'the pane is visible');
const status = $('#panes .pane-foot')?.textContent || '';
ok(/5 rows/.test(status), 'footer reports the row count', JSON.stringify(status));
ok(/pk id/.test(status), 'footer reports the primary key', JSON.stringify(status));
if (rows.length) {
  const cells = [...rows[0].children].map((c) => c.textContent);
  console.log('       first row:', JSON.stringify(cells.slice(0, 5)));
  ok(cells[0] === '5', 'first row is the highest id (ORDER BY id DESC)', cells[0]);
  const nullCell = $$('#panes .gc.null');
  ok(nullCell.length > 0, 'NULL cells are marked .null and read "NULL"');
  ok($$('#panes .gc.bin').length > 0, 'binary cells are marked .bin');
}

console.log('--- flavor badge + encoding labels ---');
const badge = $('#tree .node.server .flavor');
ok(!!badge && badge.classList.contains('mariadb'), 'server carries a MariaDB badge',
   badge ? badge.className : 'no badge');
ok(/MariaDB \d/.test(badge?.title || ''), 'badge tooltip names the version', badge?.title);

const dbRow = nodeNamed('db', 'mydb_test');
ok(dbRow.querySelector('.sub.enc')?.textContent === 'utf8mb4',
   'database row shows its default charset',
   dbRow.querySelector('.sub.enc')?.textContent);

function encOf(name) {
  const n = nodeNamed('table', name);
  const e = n?.querySelector('.sub.enc');
  return e ? [...e.classList].filter((c) => c === 'bad' || c === 'warn')[0] + ':' + e.textContent : 'none';
}
ok(encOf('legacy_latin1') === 'bad:latin1', 'a latin1 table is flagged red', encOf('legacy_latin1'));
ok(encOf('odd_collation') === 'warn:unicode_ci', 'a differing collation is flagged amber', encOf('odd_collation'));
ok(encOf('matches_db') === 'none', 'a matching table shows its row count, not an encoding', encOf('matches_db'));
ok(encOf('paid_orders') === 'none', 'a view is not flagged', encOf('paid_orders'));
ok(/latin1/.test(nodeNamed('table', 'legacy_latin1').title), 'the tooltip explains the mismatch');

console.log('--- virtualization: a 5000-row table must not build 5000 rows ---');
const big = nodeNamed('table', 'big');
click(big, 2);
for (let i = 0; i < 80 && $$('#tabbar .tab').length < 2; i++) await sleep(150);
ok($$('#tabbar .tab').length === 2, 'second tab opened');
for (let i = 0; i < 80; i++) {
  const p = $$('#panes .pane')[1];
  if (p && p.querySelectorAll('.gr').length) break;
  await sleep(150);
}
const bigPane = $$('#panes .pane')[1];
const bigRows = bigPane ? bigPane.querySelectorAll('.gr').length : 0;
const bigFoot = bigPane?.querySelector('.pane-foot')?.textContent || '';
console.log('       footer:', JSON.stringify(bigFoot.trim()));
ok(bigRows > 0 && bigRows < 100, 'only a viewport of rows is in the DOM', 'rendered ' + bigRows);
ok(/1,000 rows/.test(bigFoot), 'footer reports 1,000 rows');
ok(/truncated/.test(bigFoot), 'footer says the result was truncated');

console.log('--- tab switching + close ---');
tabs.activate(tabs.all()[0].id);
ok($$('#panes .pane')[0].hidden === false, 'switching back shows the first pane');
tabs.close(tabs.all()[1].id);
ok($$('#tabbar .tab').length === 1, 'closing a tab removes it');

console.log('--- keymap: named keys must match ---');
let hit = null;
keymap.bind('mod+enter', () => { hit = 'mod+enter'; });
keymap.bind('escape', () => { hit = 'escape'; });
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
ok(hit === 'mod+enter', 'Ctrl/Cmd+Enter fires', String(hit));
hit = null;
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true, cancelable: true }));
ok(hit === 'escape', 'Escape fires', String(hit));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
page.abort();
process.exit(fail ? 1 : 0);
