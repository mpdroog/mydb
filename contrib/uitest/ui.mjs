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

console.log('--- ERM diagram ---');
const erm = await import(STATIC + '/js/erm.js');
// jsdom has no layout engine, so give the canvas a size to fit against.
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth:  { get() { return 1200; }, configurable: true },
  clientHeight: { get() { return 800; }, configurable: true },
});
window.HTMLCanvasElement.prototype.getContext = () => ({
  font: '', measureText: (t) => ({ width: t.length * 6.6 }),
  fillRect(){}, drawImage(){}, fillStyle: '',
});

erm.openERM('local', 'erm_demo');
for (let i = 0; i < 80 && !$('.erm-svg'); i++) await sleep(150);
const root = $('.erm-svg');
ok(!!root, 'the ERM tab rendered an svg');

if (root) {
  // Derived from the live model rather than hard-coded, so seeding another
  // table into the demo schema cannot fail the suite.
  const m = await api.erm('local', 'erm_demo');
  const real = m.tables.filter((t) => !t.backup);
  const realNames = new Set(real.map((t) => t.name));
  const realLinks = m.links.filter((l) => realNames.has(l.from) && realNames.has(l.to));

  const boxes = $$('.erm-node');
  const edges = $$('.erm-edge');
  const groups = $$('.erm-group');
  ok(boxes.length === real.length, 'a box per non-backup table',
     boxes.length + ' boxes / ' + real.length + ' tables');
  ok(edges.length === realLinks.length, 'an edge per link between drawn tables',
     edges.length + ' edges / ' + realLinks.length + ' links');
  ok(groups.length > 0 && groups.length <= m.groups.length, 'clusters drawn',
     groups.length + ' of ' + m.groups.length);

  // Backups are hidden by default; the toggle brings them back.
  ok(m.tables.some((t) => t.backup), 'the demo schema has backup-shaped tables');
  const backupToggle = $$('.erm-pane .pane-head input[type=checkbox]')[1];
  backupToggle.checked = true;
  backupToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(200);
  ok($$('.erm-node').length === m.tables.length, 'ticking backups shows every table',
     String($$('.erm-node').length));
  ok($$('.erm-node.erm-backup').length > 0, 'and they are drawn as backups');
  backupToggle.checked = false;
  backupToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(200);

  // SVG must be built with createElementNS, or it renders as nothing.
  ok(root.namespaceURI === 'http://www.w3.org/2000/svg', 'svg is in the svg namespace');
  ok(boxes[0].namespaceURI === 'http://www.w3.org/2000/svg', 'nodes are in the svg namespace');

  // A guess must never look like a declared constraint.
  const guessed = $$('.erm-edge.erm-guess');
  const declared = $$('.erm-edge.erm-fk');
  ok(guessed.length === realLinks.filter((l) => l.kind === 'guess').length
     && declared.length === realLinks.filter((l) => l.kind === 'fk').length,
     'guessed and declared links are drawn differently',
     guessed.length + ' guessed / ' + declared.length + ' fk');

  // Hiding guesses leaves only the real foreign key.
  const toggle = $$('.erm-pane .pane-head input[type=checkbox]')[0];
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(100);
  ok($$('.erm-edge').length === 1, 'unchecking guessed links leaves only the FK',
     String($$('.erm-edge').length));
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(100);

  // Clicking a table focuses it and its neighbours. Re-query first: the
  // toggle above called draw(), which replaces the whole <svg>.
  const live = $('.erm-svg');
  const users = $$('.erm-node').find((n) => n.dataset.id === 'users');
  users.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(60);
  ok(live.classList.contains('erm-focused'), 'clicking a table enters focus mode');
  ok($$('.erm-node.lit').length === 9, 'users lights itself and its 8 satellites',
     String($$('.erm-node.lit').length));
  users.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(60);
  ok(!live.classList.contains('erm-focused'), 'clicking again clears focus');

  // Zoom: the diagram must scale on wheel, buttons and keys, and the live
  // <svg> must carry no viewBox -- that was scaling the drawing a second
  // time on top of the transform.
  const liveSvg = $('.erm-svg');
  ok(!liveSvg.hasAttribute('viewBox'),
     'the live svg has no viewBox (it would double-scale)',
     liveSvg.getAttribute('viewBox'));

  const worldOf = () => $('.erm-world').getAttribute('transform') || '';
  const scaleOf = () => Number((worldOf().match(/scale\(([-\d.]+)\)/) || [0, 1])[1]);

  const atFit = scaleOf();
  ok(atFit > 0, 'fit produced a scale', String(atFit));

  $('.erm-canvas').dispatchEvent(new window.WheelEvent('wheel',
    { deltaY: -120, clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
  const afterWheel = scaleOf();
  ok(afterWheel > atFit, 'wheel up zooms in', atFit + ' -> ' + afterWheel);

  $('.erm-canvas').dispatchEvent(new window.WheelEvent('wheel',
    { deltaY: 120, clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
  ok(scaleOf() < afterWheel, 'wheel down zooms out');

  const plus = $$('.erm-pane .pane-head button').find((b) => b.textContent === '+');
  const was = scaleOf();
  plus.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok(scaleOf() > was, 'the + button zooms in without a wheel');

  $('.erm-canvas').dispatchEvent(new window.KeyboardEvent('keydown',
    { key: '+', bubbles: true, cancelable: true }));
  ok(scaleOf() > was, 'the + key zooms in');

  // Fit must actually use the window. The old bug left the diagram at the
  // product of two scale factors, filling barely half of it.
  $$('.erm-pane .pane-head button').find((b) => b.textContent === 'Fit')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const k = scaleOf();
  const pw = Number($('.erm-svg').dataset.w), ph = Number($('.erm-svg').dataset.h);
  const fill = Math.max(pw * k / 1200, ph * k / 800);
  ok(fill > 0.9, 'fit fills the window on its tighter axis',
     'fills ' + Math.round(fill * 100) + '% of ' + pw + 'x' + ph);

  // And a diagram smaller than the window is enlarged rather than left
  // marooned in the middle, up to MAX_FIT.
  const small = { database: 'x',
    tables: [{ name: 'a', type: 'BASE TABLE', columns: [], primary_key: [], rows: 0 }],
    links: [], groups: [{ name: 'g', kind: 'component', tables: ['a'] }] };
  const { layout: lay } = await import(STATIC + '/js/layout.js');
  const tiny = lay(small);
  const wouldBe = Math.min(1200 / tiny.width, 800 / tiny.height) * 0.94;
  ok(wouldBe > 1, 'a one-table diagram would be scaled up, not capped at 1:1',
     'k=' + wouldBe.toFixed(2));

  // Unlinked diagnostics must be reachable, or a sparse diagram is
  // indistinguishable from an over-strict rule.
  const gapBtn = $$('.erm-pane .pane-head button').find((b) => b.textContent === 'Unlinked');
  ok(!!gapBtn && !gapBtn.disabled, 'the Unlinked button is offered when there are gaps');
  gapBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const gapText = $('#modal').textContent;
  ok(/things\.owner_id/.test(gapText), 'the ambiguous column is listed', gapText.slice(0, 80));
  ok(/ambiguous/.test(gapText), 'with its reason');
  ok(/owner, owners/.test(gapText), 'and the tables it could not choose between');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(60);

  const foot = $('.erm-pane .pane-foot').textContent;
  ok(foot.includes(real.length + ' of ' + m.tables.length + ' tables')
     && /foreign keys/.test(foot) && /guessed/.test(foot),
     'footer summarises the model', JSON.stringify(foot.trim()));
  // The promise the Unlinked panel makes: a key-shaped column is either
  // drawn or explained, never silently dropped. A column that is neither
  // looks like the tool considered it and had nothing to say.
  const keyish = [];
  for (const t of m.tables) {
    for (const c of t.columns || []) {
      if (/_id$/.test(c.name)) keyish.push(t.name + '.' + c.name);
    }
  }
  const accounted = new Set();
  for (const l of m.links) l.from_cols.forEach((c) => accounted.add(l.from + '.' + c));
  for (const u of m.unmatched) accounted.add(u.table + '.' + u.column);
  // A table's own identity column is the one thing allowed to stay quiet.
  const own = new Set(m.tables.filter((t) => (t.primary_key || []).length === 1)
    .map((t) => t.name + '.' + t.primary_key[0]));
  const silent = keyish.filter((k) => !accounted.has(k) && !own.has(k));
  ok(silent.length === 0, 'every _id column is either linked or explained',
     silent.slice(0, 5).join(', '));

  // And a reason must point at the real problem.
  const typeGap = m.unmatched.find((u) => /not usable as a parent/.test(u.reason));
  ok(!typeGap || /vs/.test((typeGap.candidates || []).join(',')),
     'a type mismatch names both types rather than claiming no match',
     JSON.stringify(typeGap && typeGap.candidates));

  // The reported bug, asserted end to end: a backup copy must not steal
  // the link from the table the application actually uses.
  const drawn = $$('.erm-edge').map((e) => e.dataset.from + '->' + e.dataset.to);
  ok(drawn.includes('amember_payment_logs->amember_payments'),
     'payment_id links to amember_payments, not its _b4encoding copy');
  ok(drawn.includes('amember_notes->amember_members'),
     'member_id links to amember_members, not its _copy1');
  ok(!drawn.some((d) => /b4encoding|copy1|deleted_/.test(d)),
     'nothing links into a backup table', drawn.filter((d) => /b4|copy1/.test(d)).join(' '));
}

console.log('--- tab switching + close ---');
tabs.activate(tabs.all()[0].id);
ok($$('#panes .pane')[0].hidden === false, 'switching back shows the first pane');
const tabsBefore = $$('#tabbar .tab').length;
tabs.close(tabs.all()[1].id);
ok($$('#tabbar .tab').length === tabsBefore - 1, 'closing a tab removes it',
   tabsBefore + ' -> ' + $$('#tabbar .tab').length);

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
