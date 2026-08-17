// console.js - the free-form SQL console.
//
// History lives in localStorage so it survives a restart. Running is
// Ctrl/Cmd+Enter; the request itself is a job, so a heavy query shows a
// timer and a Cancel button instead of locking the tab.

import { h, modal, toast, fmtNum, fmtMs } from './dom.js';
import { aborted } from './api.js';
import { runJob, servers } from './state.js';
import { createGrid } from './grid.js';
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
    build: (pane, signal) => build(pane, signal, { server, db, sql: sql || '' }),
  });
}

function build(pane, signal, ctx) {
  pane.classList.add('sql');

  const srvSel = h('select', {});
  const dbIn = h('input', { type: 'text', value: ctx.db || '', placeholder: 'database', spellcheck: false });
  const runBtn = h('button', { type: 'button', text: 'Run' });
  const cancelBtn = h('button', { type: 'button', class: 'danger', text: 'Cancel', hidden: true });
  const histBtn = h('button', { type: 'button', text: 'History' });

  for (const s of servers.keys()) {
    srvSel.append(h('option', { value: s, text: s, selected: s === ctx.server }));
  }

  const head = h('div', { class: 'pane-head' },
    srvSel, dbIn, h('span', { class: 'grow' }), histBtn, cancelBtn, runBtn,
  );

  const editor = h('textarea', {
    class: 'sql-edit',
    spellcheck: false,
    placeholder: 'SELECT …    (Ctrl/Cmd+Enter to run)',
    value: ctx.sql,
  });

  const grid = createGrid();
  const status = h('span', { class: 'muted', text: 'ready' });
  const foot = h('div', { class: 'pane-foot' }, status);

  pane.append(head, editor, grid.el, foot);

  let job = null;
  let histIdx = -1;

  function setBusy(on) {
    cancelBtn.hidden = !on;
    runBtn.disabled = on;
    status.className = on ? 'busy spin' : 'muted';
  }

  async function run() {
    const sql = editor.value.trim();
    if (!sql) return;

    job?.dispose();
    setBusy(true);
    status.textContent = 'running';

    job = runJob({
      server: srvSel.value,
      db: dbIn.value.trim(),
      sql,
      limit: 1000,
      kind: 'data',
    }, {
      signal,
      onState: (s) => {
        if (s.state === 'queued') status.textContent = 'waiting for connection';
        else if (s.state === 'running') status.textContent = 'running ' + fmtMs(s.elapsed_ms);
      },
    });

    try {
      const res = await job.promise;
      pushHistory({ sql, server: srvSel.value, db: dbIn.value.trim(), at: Date.now() });

      if (res.result) {
        grid.setResult(res.result, { storeKey: null });
        const n = res.result.rows.length;
        status.textContent = fmtNum(n) + ' row' + (n === 1 ? '' : 's')
          + (res.result.truncated ? ' (truncated)' : '') + ' · ' + fmtMs(res.elapsed_ms);
        grid.focusGrid();
      } else {
        grid.setResult({ cols: [], rows: [] }, {});
        status.textContent = fmtNum(res.affected) + ' row(s) affected · ' + fmtMs(res.elapsed_ms);
      }
    } catch (e) {
      if (aborted(e)) return;
      status.textContent = 'failed';
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  function showHistory() {
    const list = loadHistory();
    if (!list.length) { toast('No history yet'); return; }

    const box = h('div', { class: 'hist' });
    for (const entry of list.slice(0, 60)) {
      box.append(h('button', {
        type: 'button',
        text: entry.sql.length > 300 ? entry.sql.slice(0, 300) + '…' : entry.sql,
        title: entry.server + (entry.db ? ' · ' + entry.db : ''),
        onclick: () => { editor.value = entry.sql; close(); editor.focus(); },
      }));
    }
    const close = modal('Query history', box, [
      h('button', { type: 'button', text: 'Close', onclick: () => close() }),
    ]);
  }

  editor.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      run();
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
  cancelBtn.addEventListener('click', () => job?.cancel());
  histBtn.addEventListener('click', showHistory);

  editor.focus();

  return {
    kind: 'sql',
    ctx,
    onShow: () => editor.focus(),
    run,
    cancel: () => job?.cancel(),
    dispose: () => job?.dispose(),
  };
}
