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
let clip = '';
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async (t) => { clip = String(t); } }, configurable: true,
});

// Make the page's globals visible to the modules we import here.
function expose(k, v) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
for (const k of ['document', 'window', 'fetch', 'AbortController', 'TextDecoder',
                 'localStorage', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
                 'CustomEvent', 'HTMLElement', 'getComputedStyle', 'MutationObserver']) {
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
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: i + 1 }));
  }
  if (count === 2) {
    el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  }
}
// The tree has one class per kind of row rather than one shared .node
// class, and a table row carries its name in a data attribute because the
// visible text may be split to dim a shared prefix.
const ROW = { server: '.srv', db: '.db', table: '.tbl' };

function nodeNamed(cls, name) {
  return $$('#tree ' + ROW[cls]).find((n) => {
    if (cls === 'table') return n.dataset.table === name;
    if (cls === 'server') return n.querySelector('.name')?.textContent === name;
    return n.textContent.replace(/[\u25b8\u25be]/g, '').trim().startsWith(name);
  });
}

console.log('--- boot ---');
sidebar.init();
keymap.start();
state.setServers(await api.servers());
sidebar.render();
// app.js starts this; without it nothing ever learns a server went ready.
const page = new AbortController();
state.watchStatus(page.signal).catch(() => {});
ok($$('#tree .srv').length >= 1, 'sidebar rendered a server row');

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
ok(after.getAttribute('aria-current') === 'true', 'the clicked row is marked as current');

console.log('--- DOUBLE CLICK a table ---');
click(nodeNamed('table', 'orders'), 2);
for (let i = 0; i < 60 && $$('#chips .chip').length === 0; i++) await sleep(150);
ok($$('#chips .chip').length === 1, 'a tab opened');
ok($('#chips .chip .label')?.textContent === 'orders', 'the tab is named after the table');

console.log('--- the grid actually has content ---');
for (let i = 0; i < 60; i++) {
  if ($$('#panes .gr').length > 0) break;
  await sleep(150);
}
// A header carries the column's declared type beside its name now, so
// read the name element rather than the whole cell.
function colName(gh) {
  return (gh?.querySelector('span:not(.ty):not(.rz)')?.textContent || '')
    .replace(/^\u26bf\s*/, '').trim();
}
const headers = $$('#panes .gh').map(colName);
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

console.log('--- copy the ticked columns as CSV ---');
const tools = $('#panes .pane .grid-tools');
const csvBtn = tools?.querySelector('button');
const allBox = tools?.querySelector('.gall .gsel');
const boxes = $$('#panes .pane .gh .gsel');
ok(boxes.length === headers.length, 'every column header carries a tick box',
   boxes.length + ' boxes for ' + headers.length + ' columns');
ok(boxes.every((b) => b.checked), 'a fresh result starts with every column ticked');
ok(/all \d+ columns/.test(tools?.textContent || ''), 'the toolbar says so',
   JSON.stringify(tools?.textContent));

click(allBox);
ok(boxes.every((b) => !b.checked), 'the all box clears every column');
ok(csvBtn.disabled === true, 'with nothing ticked there is nothing to copy');

for (const name of ['id', 'client', 'notes']) click(boxes[headers.indexOf(name)]);
ok(csvBtn.disabled === false, 'ticking a column arms the button');
ok(/3 of \d+ columns/.test(tools.textContent), 'and the toolbar counts them',
   JSON.stringify(tools.textContent));
ok(allBox.indeterminate === true, 'a partial selection shows as indeterminate');

clip = '';
click(csvBtn);
await sleep(50);
// Records are split on CRLF, which is what separates them: the newline
// living inside a value is a bare LF inside quotes and must not split a
// record, or every CSV reader would see a sixth row.
const csv = clip.split('\r\n');
ok(csv[0] === 'id,client,notes', 'the header row is the ticked column names', csv[0]);
ok(csv.length === 6, 'a header row and one line per row', csv.length + ' lines');
ok(csv[1] === '5,"multi\nline",newline in value',
   'a newline inside a value is quoted and stays inside its record', JSON.stringify(csv[1]));
ok(csv[2] === "4,o'brien & co,quote in the name", 'an apostrophe needs no quoting', csv[2]);
ok(/^3,,".*,.*"$/.test(csv[3]), 'a comma inside a value is quoted', csv[3]);
ok(/^2,[^,"]*,$/.test(csv[4]), 'NULL is written as an empty field', csv[4]);
ok(csv[5] === '1,acme,fine', 'and the last row is there too', csv[5]);

clip = '';
keys($('#panes .pane .grid'), { key: 'X', ctrlKey: true, shiftKey: true });
await sleep(50);
ok(clip.split('\r\n')[0] === 'id,client,notes', 'Ctrl+Shift+X copies the same CSV',
   JSON.stringify(clip.slice(0, 40)));

clip = '';
click(allBox);
ok(boxes.every((b) => b.checked), 'the all box ticks everything back on');
ok(/all \d+ columns/.test(tools.textContent), 'and the toolbar agrees',
   JSON.stringify(tools.textContent));

console.log('--- flavor badge + encoding labels ---');
const badge = $('#tree .srv .flavor');
ok(!!badge && badge.classList.contains('mariadb'), 'server carries a MariaDB badge',
   badge ? badge.className : 'no badge');
ok(/MariaDB \d/.test(badge?.title || ''), 'badge tooltip names the version', badge?.title);

const dbRow = nodeNamed('db', 'mydb_test');
ok(dbRow.querySelector('.enc')?.textContent === 'utf8mb4',
   'database row shows its default charset',
   dbRow.querySelector('.sub.enc')?.textContent);

function encOf(name) {
  const n = nodeNamed('table', name);
  const e = n?.querySelector('.enc');
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
for (let i = 0; i < 80 && $$('#chips .chip').length < 2; i++) await sleep(150);
ok($$('#chips .chip').length === 2, 'second tab opened');
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
  ok(/owner/.test(gapText) && /owners/.test(gapText),
     'and the tables it could not choose between, each offered as a link');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(60);

  const foot = $('.erm-pane .pane-foot').textContent;
  // Counted by who asserted each edge -- declared, yours, guessed -- since
  // a link the operator wrote has nowhere to go in a two-way split.
  ok(foot.includes(real.length + ' of ' + m.tables.length + ' tables')
     && /declared/.test(foot) && /guessed/.test(foot),
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
const tabsBefore = $$('#chips .chip').length;
tabs.close(tabs.all()[1].id);
ok($$('#chips .chip').length === tabsBefore - 1, 'closing a tab removes it',
   tabsBefore + ' -> ' + $$('#chips .chip').length);

console.log('--- keymap: named keys must match ---');
let hit = null;
// Described like any other binding: the overlay is built from this
// registry, and an undescribed one is asserted against further down.
keymap.bind('mod+enter', () => { hit = 'mod+enter'; }, { desc: 'test binding', group: 'Test' });
keymap.bind('escape', () => { hit = 'escape'; }, { desc: 'test binding', group: 'Test' });
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
ok(hit === 'mod+enter', 'Ctrl/Cmd+Enter fires', String(hit));
hit = null;
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true, cancelable: true }));
ok(hit === 'escape', 'Escape fires', String(hit));

console.log('--- keyboard overlay ---');
const help = await import(STATIC + '/js/help.js');
const appmod = await import(STATIC + '/js/app.js');
// app.js registers the bindings on import; the overlay is built from that
// registry, so an undescribed shortcut shows up as a hole rather than as
// nothing at all.
help.openHelp();
const keyRows = $$('#modal .keys kbd').map((k) => k.textContent);
ok(keyRows.length > 10, 'the overlay lists the shortcuts', String(keyRows.length));
ok(keyRows.some((k) => /Ctrl\+K|⌘\+K/.test(k)), 'including the palette', keyRows.slice(0, 6).join(' '));
ok(!$('#modal').textContent.includes('(undescribed)'),
   'every binding carries a description');
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true, cancelable: true }));
await sleep(50);

console.log('--- close all tabs ---');
const con = await import(STATIC + '/js/console.js');
con.openConsole('local', 'mydb_test', 'SELECT 1');
con.openConsole('local', 'mydb_test', 'SELECT 2');
await sleep(50);
ok($$('#chips .chip').length >= 2, 'several tabs are open');
ok(!$('#close-all').hidden, 'the close-all button appears once there is more than one tab');
click($('#close-all'));
await sleep(50);
ok($$('#chips .chip').length === 0, 'close-all emptied the tab bar',
   String($$('#chips .chip').length));
ok($('#close-all').hidden, 'and the button went away with them');

console.log('--- console: several statements in one buffer ---');
const multi = con.openConsole('local', 'mydb_test', 'SELECT 1 AS a; SELECT 2 AS b;');
await sleep(50);
const runAll = $$('#panes .pane.sql .pane-head button').find((b) => /Run all/.test(b.textContent));
ok(!!runAll && !runAll.hidden, 'the Run all button appears for a multi-statement buffer',
   runAll ? runAll.textContent : 'missing');
click(runAll);
for (let i = 0; i < 60 && $$('#panes .results .res').length < 2; i++) await sleep(150);
const chips = $$('#panes .results .res');
ok(chips.length === 2, 'each statement got its own result', String(chips.length));
ok(/1 row/.test(chips[0].textContent), 'the first one reports its rows', chips[0].textContent);
click(chips[0]);
await sleep(50);
ok(colName($$('#panes .pane.sql .gh')[0]) === 'a',
   'clicking a chip shows that statement’s grid',
   $$('#panes .pane.sql .gh')[0]?.textContent);

console.log('--- the confirm gate ---');
// A table that does not exist: the gate fires in Submit before any
// database work, so this can never reach a real table even if it passed.
const guarded = con.openConsole('local', 'mydb_test', 'DELETE FROM mydb_no_such_table');
await sleep(50);
const guardedRun = $$('#panes .pane.sql')[1] || $$('#panes .pane.sql')[0];
const runBtn = [...guardedRun.querySelectorAll('.pane-head button')].find((b) => b.textContent === 'Run');
click(runBtn);
for (let i = 0; i < 60 && $('#modal').hidden; i++) await sleep(100);
const dialog = $('#modal').textContent || '';
ok(!$('#modal').hidden, 'an unguarded DELETE raises a dialog instead of running');
ok(/DELETE/.test(dialog) && /every row/.test(dialog),
   'the dialog says what the statement would do', dialog.slice(0, 90));
ok(/mydb_no_such_table/.test(dialog), 'and which table it would do it to');
const cancelBtn = $$('#modal .foot button').find((b) => b.textContent === 'Cancel');
ok(!!cancelBtn, 'there is a way out');
ok($$('#modal .foot button').find((b) => b.textContent === 'Run it anyway')
   !== window.document.activeElement, 'the danger button is not the focused default');
click(cancelBtn);
await sleep(100);
ok($('#modal').hidden, 'cancelling closes the dialog');

console.log('--- production styling ---');
// Done in memory rather than by writing a production server into the real
// config.toml: the flag is what is being tested, not the config writer.
const realServers = await api.servers();
state.setServers(realServers.map((s) => ({ ...s, production: s.name === 'local' })));
sidebar.render();
const prodRow = nodeNamed('server', 'local');
ok(prodRow.classList.contains('prod'), 'a production server is marked in the tree');
ok(!!prodRow.querySelector('.prod-badge'), 'and carries a PROD badge');
const prodTab = con.openConsole('local', 'mydb_test', 'SELECT 1');
await sleep(50);
ok(prodTab.pane.classList.contains('prod'), 'its panes carry the production rule');
ok(prodTab.btn.classList.contains('prod'), 'and so does its tab');
tabs.close(prodTab.id);
state.setServers(realServers);
sidebar.render();

console.log('--- query plan ---');
const explain = await import(STATIC + '/js/explain.js');

// The safety rule: ANALYZE runs the statement, so it is only ever offered
// for one that reads.
ok(explain.analyzable('SELECT * FROM orders'), 'a SELECT can be analyzed');
ok(explain.analyzable('  with x as (select 1) select * from x'), 'and a CTE');
ok(!explain.analyzable('DELETE FROM orders'), 'a DELETE must never be "analyzed" — that would run it');
ok(!explain.analyzable('UPDATE orders SET a=1'), 'nor an UPDATE');

// MySQL 8's shape, canned: there is no MySQL server here to ask, and the
// two forks disagree about how they say "filesort".
const mysqlPlan = {
  query_block: {
    select_id: 1,
    cost_info: { query_cost: '1234.50' },
    ordering_operation: {
      using_filesort: true,
      table: {
        table_name: 'orders', access_type: 'ALL', rows_examined_per_scan: 5000,
        filtered: '10.00', attached_condition: '(`o`.`status` = \'new\')',
      },
    },
  },
};
explain.showPlan('MySQL plan', { rows: [[JSON.stringify(mysqlPlan)]] }, 'SELECT 1');
let plan = $('#modal').textContent || '';
ok(/orders/.test(plan), 'the MySQL plan names the table');
ok(/full table scan/.test(plan), 'and calls out the full table scan');
ok(/filesort/.test(plan), 'and the filesort');
ok(/cost 1,?235/.test(plan), 'and the query cost', plan.slice(0, 120));
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true, cancelable: true }));
await sleep(50);

// MariaDB's shape, live from the server this test is pointed at.
const livePlan = await state.runJob({
  server: 'local', db: 'mydb_test', kind: 'meta', limit: 1,
  sql: 'EXPLAIN FORMAT=JSON SELECT * FROM orders o JOIN big b ON b.c = o.id ORDER BY o.total',
}).promise;
explain.showPlan('MariaDB plan', livePlan.result, 'SELECT …');
plan = $('#modal').textContent || '';
ok(/full table scan/.test(plan), 'the MariaDB plan calls out the full table scan', plan.slice(0, 160));
ok(/filesort/.test(plan), 'and the filesort, which MariaDB spells as a step of its own');
ok($$('#modal .plan-node').length >= 3, 'the plan is drawn as a tree',
   String($$('#modal .plan-node').length));
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true, cancelable: true }));
await sleep(50);

console.log('--- completion ---');
const complete = await import(STATIC + '/js/complete.js');
const holder = window.document.createElement('div');
const ta = window.document.createElement('textarea');
holder.append(ta);
$('#panes').append(holder);
const comp = complete.attach(ta, () => ({ server: 'local', db: 'mydb_test' }));

// Drive it the way a keyboard does. Calling open() directly would test the
// candidate list and nothing about whether a keystroke ever reaches it.
function type(el, data) {
  el.value += data;
  el.selectionStart = el.selectionEnd = el.value.length;
  el.dispatchEvent(new window.InputEvent('input', { data, bubbles: true }));
}
function keys(el, init) {
  const ev = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}
const popup = () => $$('#panes .complete .citem .cname').map((n) => n.textContent);

// Warm the cache first: completion never waits on the network, so a cold
// one has nothing to offer no matter how it was opened.
ta.value = 'SELECT * FROM ord';
ta.selectionStart = ta.value.length;
for (let i = 0; i < 40 && !popup().includes('orders'); i++) { comp.open(); await sleep(150); }
comp.close();

ta.value = '';
type(ta, 'S');
ok($$('#panes .complete').every((p) => p.hidden), 'one character does not open the list');
type(ta, 'E');
ok(popup().includes('SELECT'), 'two characters do, without any shortcut', popup().join(','));

// Escape must stay escaped until the word is over, or it reopens instantly.
keys(ta, { key: 'Escape' });
ok($$('#panes .complete').every((p) => p.hidden), 'Escape closes it');
type(ta, 'L');
ok($$('#panes .complete').every((p) => p.hidden), 'and it stays closed while the word continues');
type(ta, ' ');
type(ta, 'or');
ok(!popup().length === false, 'a new word opens it again', popup().join(','));

// The shortcut still works where the desktop does not eat it. Some layouts
// deliver a modified space with only ev.code set.
ta.value = 'SELECT * FROM ord';
ta.selectionStart = ta.selectionEnd = ta.value.length;
const withKey = keys(ta, { key: ' ', code: 'Space', ctrlKey: true });
ok(withKey.defaultPrevented && popup().includes('orders'),
   'Ctrl+Space opens it', popup().join(','));
comp.close();
const withCode = keys(ta, { key: 'Unidentified', code: 'Space', ctrlKey: true });
ok(withCode.defaultPrevented && popup().includes('orders'),
   'and so does a Ctrl+Space that arrives with only ev.code set');
comp.close();

// Inside a string literal a column list is not what is being typed.
ta.value = "SELECT * FROM orders WHERE client = 'ac";
ta.selectionStart = ta.selectionEnd = ta.value.length;
ta.dispatchEvent(new window.InputEvent('input', { data: 'c', bubbles: true }));
ok($$('#panes .complete').every((p) => p.hidden),
   'typing a value inside quotes does not raise the list');

// What the clause is asking for. After FROM it is a table; in the select
// list and after WHERE it is a column — and the wrong order here is what
// makes a completion list feel like it is guessing.
async function suggest(text) {
  ta.value = text;
  ta.selectionStart = ta.selectionEnd = text.length;
  for (let i = 0; i < 40; i++) {
    comp.open();
    const list = popup();
    if (list.length) return list;
    await sleep(150);
  }
  return [];
}

let list = await suggest('SELECT * FROM ord');
ok(list[0] === 'orders', 'after FROM, a table comes first', list.join(','));
ok(list.indexOf('orders') < list.indexOf('ORDER BY'),
   'ahead of the ORDER BY keyword that matches the same prefix', list.join(','));

list = await suggest('SELECT * FROM orders WHERE cli');
ok(list[0] === 'client', 'after WHERE, the column comes first', list.join(','));

list = await suggest('SELECT cli FROM orders');
// The caret is at the end here, so put it back in the select list.
ta.selectionStart = ta.selectionEnd = 'SELECT cli'.length;
comp.open();
list = popup();
ok(list[0] === 'client',
   'in the select list, a column of the table the FROM names comes first', list.join(','));

list = await suggest('INSERT INTO orders (cli');
ok(list[0] === 'client',
   'inside the bracket of an INSERT INTO, columns rather than tables', list.join(','));

// A dot after an alias resolves the alias to its table.
ta.value = 'SELECT * FROM orders o WHERE o.';
ta.selectionStart = ta.selectionEnd = ta.value.length;
let sugg = [];
for (let i = 0; i < 40; i++) {
  comp.open();
  sugg = popup();
  if (sugg.includes('client')) break;
  await sleep(150);
}
ok(sugg.includes('client') && sugg.includes('status'),
   'an alias followed by a dot suggests that table’s columns', sugg.join(','));
ok(!sugg.includes('orders'), 'and not the tables again');
holder.remove();

console.log('--- query log ---');
const qlog = await import(STATIC + '/js/querylog.js');
qlog.openQueryLog({});
for (let i = 0; i < 60 && !$$('#panes .qentry').length; i++) await sleep(150);
const entries = $$('#panes .qentry');
ok(entries.length > 0, 'the log has the statements this run just executed',
   String(entries.length));
ok($$('#panes .qentry pre.sql').some((p) => /SELECT 1 AS a|SELECT 2 AS b/.test(p.textContent)),
   'including the ones from the console',
   $$('#panes .qentry pre.sql')[0]?.textContent.slice(0, 40));
const qsearch = $('#panes .pane.qlog .pane-head input');
qsearch.value = 'no such statement anywhere';
qsearch.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Enter', bubbles: true, cancelable: true }));
for (let i = 0; i < 40 && $$('#panes .qentry').length; i++) await sleep(100);
ok($$('#panes .qentry').length === 0, 'searching narrows it down');

console.log('--- dashboard ---');
const dash = await import(STATIC + '/js/dashboard.js');
dash.openDashboard('local');
for (let i = 0; i < 80 && !$$('#panes .dash .tile').length; i++) await sleep(150);
const dashPane = $('#panes .pane.dash');
ok(!!dashPane, 'the dashboard tab opened');
ok($$('#panes .dash .tile').length >= 3, 'it drew its tiles',
   String($$('#panes .dash .tile').length));
ok(/connections/.test(dashPane.textContent), 'including the connection count');
for (let i = 0; i < 40 && !$$('#panes .dash .sec-body.procs .gr').length; i++) await sleep(150);
const procRows = $$('#panes .dash .sec-body.procs .gr');
ok(procRows.length > 0, 'the process list has rows', String(procRows.length));
ok($$('#panes .dash .sec-body.procs .gr.self').length > 0,
   'the dashboard marks its own polling connection rather than showing it as a stuck query');
// Idle connections are hidden by default, and on a quiet test server the
// dashboard's own poll is the only busy one — and that one deliberately
// gets no Kill button. Show the sleepers to have something killable.
const sleepBox = $$('#panes .dash .pane-head input[type=checkbox]')[0];
sleepBox.checked = true;
sleepBox.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(100);

// The row AND the button inside it must survive a tick. Keeping the row
// but rebuilding its buttons every three seconds still takes the click
// away between mousedown and mouseup, which is the whole bug.
const killable = $$('#panes .dash .sec-body.procs .gr')
  .find((r) => r.querySelector('.gc.kill button'));
ok(!!killable, 'a connection offers a Kill button');
const killBtn = killable?.querySelector('.gc.kill button');
const killId = killable?.querySelector('.gc')?.textContent;
await sleep(4000);
const stillThere = $$('#panes .dash .sec-body.procs .gr')
  .find((r) => r.querySelector('.gc')?.textContent === killId);
ok(stillThere === killable, 'a process row survives a tick rather than being rebuilt');
ok(stillThere?.querySelector('.gc.kill button') === killBtn,
   'and so does its Kill button, or the click would land on a replaced node');
const pause = $$('#panes .dash .pane-head button').find((b) => /Pause|Resume/.test(b.textContent));
click(pause);
ok(/Resume/.test(pause.textContent), 'Pause freezes the view');
click(pause);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
page.abort();
process.exit(fail ? 1 : 0);
