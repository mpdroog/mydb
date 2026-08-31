// data.js - the table data pane.
//
// Opening a table paints the whole pane immediately and fills the grid when
// the job reports back, so a double-click is never followed by a frozen
// window. The Cancel button issues a real KILL QUERY on the server.

import { h, clear, toast, fmtNum, fmtMs, fmtProgress } from './dom.js';
import { api, aborted } from './api.js';
import { runJob, isProduction } from './state.js';
import { createGrid } from './grid.js';
import * as tabs from './tabs.js';
import { openStructure } from './structure.js';
import { createStatement } from './statement.js';
import { openAddRow } from './addrow.js';
import { crumb } from './crumb.js';

const LIMIT = 1000;

export function openTable(server, db, table) {
  return tabs.open({
    key: 'data:' + server + ':' + db + ':' + table,
    title: table,
    danger: isProduction(server),
    server,
    build: (pane, signal, tab) => build(pane, signal, tab, { server, db, table }),
  });
}

function build(pane, signal, tab, ctx) {
  pane.classList.add('data');

  const runBtn = h('button', { class: 'btn primary', type: 'button' }, 'Run', h('span', { class: 'key', text: 'Ctrl+Enter' }));
  const addBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Add row', h('span', { class: 'key', text: 'Ctrl+N' }));
  const structBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Structure', h('span', { class: 'key', text: 'Ctrl+D' }));
  const cancelBtn = h('button', { class: 'btn danger', type: 'button', text: 'Cancel', hidden: true });

  const head = h('div', { class: 'pane-head' },
    crumb(ctx.server, ctx.db, ctx.table),
    h('span', { class: 'grow' }),
    addBtn, structBtn, cancelBtn, runBtn,
  );

  // The whole statement, editable, rather than a filter squeezed into a
  // text box. Until you touch it the pane submits table+limit and lets the
  // Go side build the SQL -- which is what keeps the identifiers quoted and
  // the LIMIT from being talked upwards. Once edited it submits your text.
  const stmt = createStatement({ onRun: () => load(), label: 'what mydb wrote for this table' });

  const grid = createGrid();
  const status = h('span', { text: 'loading…' });
  // The statement really does ask for one row past the limit; that extra
  // row is how "exactly 1000 rows" is told apart from "the first 1000 of
  // many". Say so, or the LIMIT reads as an off-by-one.
  const foot = h('div', { class: 'pane-foot' }, status, h('span', { class: 'grow' }));

  pane.append(head, stmt.el, grid.el, foot);
  pane.classList.add('has-stmt');

  let job = null;
  let pk = [];

  function setBusy(on) {
    cancelBtn.hidden = !on;
    runBtn.disabled = on;
    status.className = on ? 'busy spin' : '';
  }

  async function load() {
    job?.dispose();
    setBusy(true);
    status.textContent = 'running';

    // Unedited: hand the Go side the table and let it write the statement,
    // so quoting and the row limit stay its job. Edited: run what you wrote.
    const custom = stmt.dirty() && stmt.value().trim();
    job = runJob(custom
      ? { server: ctx.server, db: ctx.db, sql: stmt.value(), kind: 'data' }
      : { server: ctx.server, db: ctx.db, table: ctx.table, limit: LIMIT, kind: 'data' }, {
      signal,
      onState: (s) => {
        if (s.state === 'running' || s.state === 'queued') {
          const p = fmtProgress(s.progress);
          status.textContent = s.state === 'queued'
            ? 'waiting for connection'
            : 'running ' + fmtMs(s.elapsed_ms) + (p ? ' · ' + p : '');
        }
        // The band shows the statement that actually ran, straight from
        // the job, so it is never a guess at what mydb would have written.
        if (s.sql && !stmt.dirty()) stmt.rebase(s.sql);
      },
    });

    try {
      const res = await job.promise;
      pk = res.primary_key || [];
      grid.setResult(res.result, {
        pk,
        storeKey: ctx.server + '/' + ctx.db + '/' + ctx.table,
        onEdit: (edit) => api.updateRow({
          server: ctx.server, db: ctx.db, table: ctx.table, ...edit,
        }, signal),
      });

      const n = res.result?.rows?.length || 0;
      const parts = [fmtNum(n) + ' row' + (n === 1 ? '' : 's')];
      if (res.result?.truncated) parts.push('truncated at ' + fmtNum(LIMIT));
      parts.push(fmtMs(res.elapsed_ms));
      parts.push(pk.length ? 'pk ' + pk.join(', ') : 'no primary key — read-only');
      status.textContent = parts.join(' · ');
      grid.focusGrid();
    } catch (e) {
      if (aborted(e)) return;
      status.textContent = 'failed';
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  runBtn.addEventListener('click', load);
  addBtn.addEventListener('click', () => openAddRow(ctx, () => load()));
  structBtn.addEventListener('click', () => openStructure(ctx.server, ctx.db, ctx.table));
  cancelBtn.addEventListener('click', () => job?.cancel());

  load();

  return {
    kind: 'data',
    ctx,
    onShow: () => grid.focusGrid(),
    cancel: () => job?.cancel(),
    reload: load,
    dispose: () => job?.dispose(),
  };
}
