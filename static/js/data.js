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

const LIMIT = 1000;

export function openTable(server, db, table) {
  return tabs.open({
    key: 'data:' + server + ':' + db + ':' + table,
    title: table,
    danger: isProduction(server),
    build: (pane, signal, tab) => build(pane, signal, tab, { server, db, table }),
  });
}

function build(pane, signal, tab, ctx) {
  pane.classList.add('data');

  // Do not put WHERE in the placeholder: it reads as "type the keyword",
  // and mydb supplies its own. A concrete example is clearer anyway.
  const where = h('input', {
    class: 'where',
    type: 'text',
    placeholder: "filter, e.g. status = 'new'   (Enter to run)",
    title: 'The tail of the SELECT. A leading WHERE is optional, and your own '
      + 'ORDER BY or LIMIT replaces the default ones.',
    spellcheck: false,
    autocomplete: 'off',
  });
  const runBtn = h('button', { type: 'button', text: 'Run' });
  const structBtn = h('button', { type: 'button', title: 'Structure (Ctrl/Cmd+D)', text: 'Structure' });
  const cancelBtn = h('button', { type: 'button', class: 'danger', text: 'Cancel', hidden: true });

  const head = h('div', { class: 'pane-head' },
    h('span', { class: 'muted mono', text: ctx.db + '.' + ctx.table }),
    where, runBtn, structBtn, cancelBtn,
  );

  const grid = createGrid();
  const status = h('span', { text: 'loading…' });
  // The statement really does ask for one row past the limit; that extra
  // row is how "exactly 1000 rows" is told apart from "the first 1000 of
  // many". Say so, or the LIMIT reads as an off-by-one.
  const sqlNote = h('span', {
    class: 'mono muted',
    title: 'The statement mydb ran. It asks for one row past the limit, '
      + 'which is how it knows whether there are more rows to show.',
  });
  const foot = h('div', { class: 'pane-foot' }, status, h('span', { class: 'grow' }), sqlNote);

  pane.append(head, grid.el, foot);

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
    sqlNote.textContent = '';

    job = runJob({
      server: ctx.server,
      db: ctx.db,
      table: ctx.table,
      where: where.value.trim(),
      limit: LIMIT,
      kind: 'data',
    }, {
      signal,
      onState: (s) => {
        if (s.state === 'running' || s.state === 'queued') {
          const p = fmtProgress(s.progress);
          status.textContent = s.state === 'queued'
            ? 'waiting for connection'
            : 'running ' + fmtMs(s.elapsed_ms) + (p ? ' · ' + p : '');
        }
        if (s.sql) sqlNote.textContent = s.sql.replace(/\s+/g, ' ');
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
  structBtn.addEventListener('click', () => openStructure(ctx.server, ctx.db, ctx.table));
  cancelBtn.addEventListener('click', () => job?.cancel());
  where.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); load(); }
    if (ev.key === 'Escape') { ev.preventDefault(); where.blur(); grid.focusGrid(); }
  });

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
