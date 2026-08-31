// console.js - the free-form SQL console.
//
// Three things it does that a text box and a Run button do not:
//
//   * A buffer holding several statements is cut into statements by the Go
//     side and each one runs as its own job. Ctrl/Cmd+Enter runs the one
//     the cursor is in, so a scratch file full of queries works the way it
//     does in a real editor. The driver still refuses stacked statements —
//     these are separate round-trips, not a relaxed MultiStatements.
//   * Table and column names complete as you type, from the schema cache.
//     Ctrl/Cmd+Space forces the list open where the desktop lets that
//     shortcut through — on Linux the input-method switcher usually does
//     not, which is why it does not depend on it.
//   * Ctrl/Cmd+E shows the plan as a tree instead of EXPLAIN's grid.
//
// Up-arrow history stays in localStorage because it is per-browser muscle
// memory. The searchable log of what actually ran lives on the server —
// the History button opens it.

import { h, clear, toast, fmtNum, fmtMs, fmtProgress } from './dom.js';
import { api, aborted } from './api.js';
import { runJob, servers, isProduction } from './state.js';
import { createGrid } from './grid.js';
import { askConfirm } from './confirm.js';
import { attach } from './complete.js';
import * as schema from './schema.js';
import { openQueryLog } from './querylog.js';
import * as explain from './explain.js';
import * as tabs from './tabs.js';

const HKEY = 'mydb.history';
const HMAX = 200;

export function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; }
}

function pushHistory(entry) {
  const list = loadHistory().filter((x) => x.sql !== entry.sql);
  list.unshift(entry);
  try { localStorage.setItem(HKEY, JSON.stringify(list.slice(0, HMAX))); } catch { /* quota */ }
}

let counter = 0;

export function openConsole(server, db, sql) {
  const n = ++counter;
  return tabs.open({
    key: 'sql:' + n,
    title: 'SQL ' + n,
    danger: isProduction(server),
    server,
    build: (pane, signal) => build(pane, signal, { server, db, sql: sql || '' }),
  });
}

function build(pane, signal, ctx) {
  pane.classList.add('sql');

  const srvSel = h('select', {});
  const dbIn = h('input', { type: 'text', value: ctx.db || '', placeholder: 'database', spellcheck: false });
  const runBtn = h('button', { type: 'button', text: 'Run' });
  const allBtn = h('button', { type: 'button', text: 'Run all', hidden: true });
  const explainBtn = h('button', { type: 'button', text: 'Explain', title: 'Show the plan (Ctrl/Cmd+E)' });
  const analyzeBtn = h('button', {
    type: 'button', text: 'Analyze',
    title: 'Run it and show the plan with the real numbers',
  });
  const cancelBtn = h('button', { type: 'button', class: 'danger', text: 'Cancel', hidden: true });
  const histBtn = h('button', { type: 'button', text: 'History', title: 'The searchable log of everything mydb has run' });

  for (const s of servers.keys()) {
    srvSel.append(h('option', { value: s, text: s, selected: s === ctx.server }));
  }

  const prodTag = h('span', { class: 'prod-badge', text: 'PROD', hidden: !isProduction(ctx.server) });
  const head = h('div', { class: 'pane-head' },
    srvSel, prodTag, dbIn, h('span', { class: 'grow' }),
    histBtn, explainBtn, analyzeBtn, cancelBtn, allBtn, runBtn,
  );

  const editor = h('textarea', {
    class: 'sql-edit',
    spellcheck: false,
    placeholder: 'SELECT …    (Ctrl/Cmd+Enter runs the statement the cursor is in; '
      + 'table and column names complete as you type)',
    value: ctx.sql,
  });
  // The editor and its popup share a positioned box.
  const editBox = h('div', { class: 'edit-box' }, editor);

  const strip = h('div', { class: 'results', hidden: true });
  const grid = createGrid();
  const status = h('span', { class: 'muted', text: 'ready' });
  const foot = h('div', { class: 'pane-foot' }, status);

  pane.append(head, editBox, strip, grid.el, foot);

  attach(editor, () => ({ server: srvSel.value, db: dbIn.value.trim() }));

  // Warm the table list now rather than on the first Ctrl+Space. Completion
  // never waits on the network, so a cold cache means the first press
  // silently has nothing to offer.
  const warm = () => schema.tables(srvSel.value, dbIn.value.trim());
  dbIn.addEventListener('change', warm);
  warm();

  let job = null;
  let histIdx = -1;
  let stopped = false;
  let results = [];

  function setBusy(on) {
    cancelBtn.hidden = !on;
    runBtn.disabled = on;
    allBtn.disabled = on;
    explainBtn.disabled = on;
    analyzeBtn.disabled = on;
    status.className = on ? 'busy spin' : 'muted';
  }

  srvSel.addEventListener('change', () => {
    const prod = isProduction(srvSel.value);
    prodTag.hidden = !prod;
    pane.classList.toggle('prod', prod);
  });

  // ---- splitting -----------------------------------------------------

  // statements asks the Go side to cut the buffer up. There is one SQL
  // reader in mydb and it is not in the browser; if the call fails the
  // buffer is treated as a single statement, which is what it was before
  // this feature existed.
  async function statements(text) {
    try {
      const res = await api.split(text, signal);
      return res.statements || [];
    } catch (e) {
      if (aborted(e)) throw e;
      const sql = text.trim();
      return sql ? [{ sql, start: 0, end: text.length }] : [];
    }
  }

  // current picks what Ctrl+Enter runs: the selection if there is one,
  // otherwise the statement the cursor sits in.
  async function current() {
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
    if (sel) return statements(sel);

    const list = await statements(editor.value);
    if (list.length < 2) return list;

    const pos = editor.selectionStart;
    let idx = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].start <= pos) idx = i;
    }
    return [list[idx]];
  }

  // ---- running -------------------------------------------------------

  function request(sql, kind = 'data') {
    return {
      server: srvSel.value,
      db: dbIn.value.trim(),
      sql,
      limit: 1000,
      kind,
    };
  }

  // one runs a single statement and hands back its snapshot.
  function one(sql, kind) {
    job = runJob(request(sql, kind), {
      signal,
      onConfirm: (risk) => askConfirm(risk, { server: srvSel.value, db: dbIn.value.trim(), sql }),
      onState: (s) => {
        if (s.state === 'queued') { status.textContent = 'waiting for connection'; return; }
        if (s.state !== 'running') return;
        const p = fmtProgress(s.progress);
        status.textContent = 'running ' + fmtMs(s.elapsed_ms) + (p ? ' · ' + p : '');
      },
    });
    return job.promise;
  }

  async function runList(list) {
    if (!list.length) return;
    job?.dispose();
    stopped = false;
    results = [];
    setBusy(true);

    for (let i = 0; i < list.length && !stopped; i++) {
      const sql = list[i].sql;
      if (list.length > 1) status.textContent = 'running ' + (i + 1) + ' of ' + list.length;
      try {
        const res = await one(sql, 'data');
        results.push({ sql, res });
        pushHistory({ sql, server: srvSel.value, db: dbIn.value.trim(), at: Date.now() });
      } catch (e) {
        if (aborted(e)) { setBusy(false); drawStrip(); return; }
        results.push({ sql, err: e });
        // Stopping on the first failure is the only safe default: the rest
        // of a script usually assumes the earlier statements worked.
        break;
      }
    }

    setBusy(false);
    drawStrip();
    show(results.length - 1);
  }

  function drawStrip() {
    clear(strip);
    strip.hidden = results.length < 2;
    if (strip.hidden) return;

    results.forEach((r, i) => {
      const label = r.err
        ? (i + 1) + ' ✗'
        : (i + 1) + ' ' + (r.res.result
          ? fmtNum(r.res.result.rows.length) + ' rows'
          : fmtNum(r.res.affected) + ' affected');
      strip.append(h('button', {
        type: 'button',
        class: 'res' + (r.err ? ' bad' : ''),
        text: label,
        title: r.sql,
        onclick: () => show(i),
      }));
    });
  }

  function show(i) {
    const r = results[i];
    if (!r) return;
    for (const [n, btn] of [...strip.children].entries()) {
      btn.classList.toggle('on', n === i);
    }

    if (r.err) {
      grid.setResult({ cols: [], rows: [] }, {});
      status.textContent = 'failed';
      status.className = 'err-text';
      toast(r.err.message, 'err');
      return;
    }
    status.className = 'muted';

    if (r.res.result) {
      grid.setResult(r.res.result, { storeKey: null });
      const n = r.res.result.rows.length;
      status.textContent = fmtNum(n) + ' row' + (n === 1 ? '' : 's')
        + (r.res.result.truncated ? ' (truncated)' : '') + ' · ' + fmtMs(r.res.elapsed_ms);
      grid.focusGrid();
    } else {
      grid.setResult({ cols: [], rows: [] }, {});
      status.textContent = fmtNum(r.res.affected) + ' row(s) affected · ' + fmtMs(r.res.elapsed_ms);
    }
  }

  async function run() {
    try {
      await runList(await current());
    } catch (e) {
      if (!aborted(e)) toast(e.message, 'err');
    }
  }

  async function runAll() {
    try {
      await runList(await statements(editor.value));
    } catch (e) {
      if (!aborted(e)) toast(e.message, 'err');
    }
  }

  // ---- explain -------------------------------------------------------

  async function plan(analyze) {
    const list = await current();
    if (!list.length) return;
    const sql = list[0].sql;

    if (analyze && !explain.analyzable(sql)) {
      toast('Analyze runs the statement, so it is only offered for SELECT', 'err');
      return;
    }

    const flavor = servers.get(srvSel.value)?.status?.flavor;
    setBusy(true);
    status.textContent = analyze ? 'analyzing' : 'explaining';
    try {
      const res = await one(explain.statement(sql, { flavor, analyze }), analyze ? 'data' : 'meta');
      explain.showPlan(analyze ? 'Plan with real numbers' : 'Query plan', res.result, sql);
      status.textContent = 'ready';
    } catch (e) {
      if (!aborted(e)) {
        status.textContent = 'failed';
        toast(e.message, 'err');
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- wiring --------------------------------------------------------

  async function updateAllBtn() {
    const list = await statements(editor.value).catch(() => []);
    allBtn.hidden = list.length < 2;
    allBtn.textContent = 'Run all ' + list.length;
  }

  let debounce = null;
  editor.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => updateAllBtn().catch(() => {}), 400);
  });

  editor.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) runAll();
      else run();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'e' || ev.key === 'E')) {
      ev.preventDefault();
      ev.stopPropagation();
      plan(ev.shiftKey);
      return;
    }
    // Up-arrow on an empty editor walks back through history.
    if (ev.key === 'ArrowUp' && editor.selectionStart === 0 && editor.selectionEnd === 0) {
      const list = loadHistory();
      if (!list.length) return;
      histIdx = Math.min(histIdx + 1, list.length - 1);
      editor.value = list[histIdx].sql;
      ev.preventDefault();
    }
    if (ev.key === 'ArrowDown' && histIdx >= 0) {
      const list = loadHistory();
      histIdx -= 1;
      editor.value = histIdx < 0 ? '' : list[histIdx].sql;
      ev.preventDefault();
    }
  });

  runBtn.addEventListener('click', run);
  allBtn.addEventListener('click', runAll);
  explainBtn.addEventListener('click', () => plan(false));
  analyzeBtn.addEventListener('click', () => plan(true));
  cancelBtn.addEventListener('click', () => { stopped = true; job?.cancel(); });
  histBtn.addEventListener('click', () => openQueryLog({ server: srvSel.value }));

  if (isProduction(ctx.server)) pane.classList.add('prod');
  editor.focus();
  updateAllBtn().catch(() => {});

  return {
    kind: 'sql',
    ctx,
    onShow: () => editor.focus(),
    run,
    cancel: () => { stopped = true; job?.cancel(); },
    dispose: () => job?.dispose(),
  };
}
