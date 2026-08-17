// structure.js - the CMD+D table-structure editor.
//
// The editor never applies anything blind: it always asks the server for a
// dry-run first and puts the exact ALTER TABLE on screen. Applying then
// runs as a normal job, so a long table-rebuild stays cancellable.

import { h, clear, modal, toast, fmtMs, fmtProgress } from './dom.js';
import { api, aborted } from './api.js';
import { runJob } from './state.js';
import * as tabs from './tabs.js';

const EXTRAS = ['', 'AUTO_INCREMENT', 'ON UPDATE CURRENT_TIMESTAMP'];

export function openStructure(server, db, table) {
  return tabs.open({
    key: 'struct:' + server + ':' + db + ':' + table,
    title: table + ' ⚙',
    build: (pane, signal) => build(pane, signal, { server, db, table }),
  });
}

function build(pane, signal, ctx) {
  pane.classList.add('struct-pane');

  const applyBtn = h('button', { type: 'button', text: 'Preview changes…' });
  const reloadBtn = h('button', { type: 'button', text: 'Reload' });
  const createBtn = h('button', { type: 'button', text: 'SHOW CREATE' });
  const cancelBtn = h('button', {
    type: 'button', class: 'danger', text: 'Cancel', hidden: true,
    title: 'Abort the running statement. A table rebuild then has to roll '
      + 'back, which can take as long again as it has already run.',
  });
  const head = h('div', { class: 'pane-head' },
    h('span', { class: 'muted mono', text: ctx.db + '.' + ctx.table }),
    h('span', { class: 'grow' }), cancelBtn, createBtn, reloadBtn, applyBtn,
  );

  const bodyEl = h('div', { class: 'struct' });
  const status = h('span', { text: 'loading…' });
  const foot = h('div', { class: 'pane-foot' }, status);

  pane.append(head, bodyEl, foot);

  let current = null;   // last structure from the server
  let job = null;       // the ALTER in flight, if any
  let cols = [];        // editable column models
  let idxs = [];        // editable index models
  let pkText = null;

  // ---- rendering ----------------------------------------------------

  function colRow(c, i) {
    const name = h('input', { type: 'text', value: c.name });
    const type = h('input', { type: 'text', value: c.type });
    const nul = h('input', { type: 'checkbox', checked: c.nullable });
    const def = h('input', { type: 'text', value: c.default === null ? '' : c.default, placeholder: 'NULL' });
    const raw = h('input', { type: 'checkbox', checked: c.default_raw, title: 'Treat default as an expression' });
    const extra = h('select', {},
      ...EXTRAS.map((x) => h('option', { value: x, text: x || '—', selected: eqExtra(x, c.extra) })));
    const comment = h('input', { type: 'text', value: c.comment });

    name.addEventListener('input', () => { c.name = name.value; });
    type.addEventListener('input', () => { c.type = type.value; });
    nul.addEventListener('change', () => { c.nullable = nul.checked; });
    def.addEventListener('input', () => { c.default = def.value === '' ? null : def.value; });
    raw.addEventListener('change', () => { c.default_raw = raw.checked; });
    extra.addEventListener('change', () => { c.extra = extra.value; });
    comment.addEventListener('input', () => { c.comment = comment.value; });

    const up = h('button', { type: 'button', title: 'Move up', text: '↑', onclick: () => moveCol(i, -1) });
    const down = h('button', { type: 'button', title: 'Move down', text: '↓', onclick: () => moveCol(i, 1) });
    const del = h('button', {
      type: 'button', class: 'danger', title: 'Drop column', text: '×',
      onclick: () => { cols.splice(i, 1); render(); },
    });

    return h('tr', {},
      h('td', {}, name),
      h('td', {}, type),
      h('td', { class: 'narrow' }, nul),
      h('td', {}, def),
      h('td', { class: 'narrow' }, raw),
      h('td', {}, extra),
      h('td', {}, comment),
      h('td', { class: 'narrow' }, up, down, del),
    );
  }

  function idxRow(x, i) {
    const name = h('input', { type: 'text', value: x.name });
    const colsIn = h('input', { type: 'text', value: x.columns.join(', ') });
    const uniq = h('input', { type: 'checkbox', checked: x.unique });

    name.addEventListener('input', () => { x.name = name.value; });
    colsIn.addEventListener('input', () => { x.columns = splitList(colsIn.value); });
    uniq.addEventListener('change', () => { x.unique = uniq.checked; });

    return h('tr', {},
      h('td', {}, name),
      h('td', {}, colsIn),
      h('td', { class: 'narrow' }, uniq),
      h('td', { class: 'narrow' },
        h('button', {
          type: 'button', class: 'danger', text: '×', title: 'Drop index',
          onclick: () => { idxs.splice(i, 1); render(); },
        })),
    );
  }

  function render() {
    clear(bodyEl);
    if (!current) return;

    const colTable = h('table', { class: 'st' },
      h('thead', {}, h('tr', {},
        ...['Column', 'Type', 'Null', 'Default', 'Expr', 'Extra', 'Comment', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...cols.map(colRow)),
    );

    const idxTable = h('table', { class: 'st' },
      h('thead', {}, h('tr', {},
        ...['Index', 'Columns', 'Unique', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...idxs.map(idxRow)),
    );

    pkText = h('input', { type: 'text', value: (current.primary_key || []).join(', '), placeholder: 'no primary key' });

    bodyEl.append(
      h('div', { class: 'st-title', text: 'Columns' }),
      colTable,
      h('div', {}, h('button', {
        type: 'button', text: '+ column',
        onclick: () => {
          cols.push({ orig: '', name: 'new_column', type: 'VARCHAR(255)', nullable: true, default: null, default_raw: false, extra: '', comment: '' });
          render();
        },
      })),
      h('div', { class: 'st-title', text: 'Primary key' }),
      pkText,
      h('div', { class: 'st-title', text: 'Indexes' }),
      idxTable,
      h('div', {}, h('button', {
        type: 'button', text: '+ index',
        onclick: () => { idxs.push({ orig: '', name: 'idx_new', columns: [], unique: false }); render(); },
      })),
      h('p', { class: 'note', text: 'Foreign keys, partitions and engine/charset changes are shown in SHOW CREATE but not editable here.' }),
    );
  }

  function moveCol(i, d) {
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    render();
  }

  // ---- load + apply --------------------------------------------------

  async function load() {
    status.textContent = 'loading…';
    try {
      current = await api.structure(ctx.server, ctx.db, ctx.table, signal);
      cols = (current.columns || []).map((c) => ({
        orig: c.name,
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.default,
        default_raw: isExpr(c.default),
        extra: c.extra || '',
        comment: c.comment || '',
      }));
      idxs = (current.indexes || []).map((x) => ({
        orig: x.name, name: x.name, columns: [...x.columns], unique: x.unique,
      }));
      render();
      status.textContent = cols.length + ' columns · ' + idxs.length + ' indexes';
    } catch (e) {
      if (aborted(e)) return;
      status.textContent = 'failed';
      toast(e.message, 'err');
    }
  }

  function desired() {
    return {
      columns: cols.map((c) => ({
        orig: c.orig,
        name: c.name.trim(),
        type: c.type.trim(),
        nullable: !!c.nullable,
        default: c.default,
        default_raw: !!c.default_raw,
        extra: c.extra || '',
        comment: c.comment || '',
      })),
      indexes: idxs.map((x) => ({
        orig: x.orig, name: x.name.trim(), columns: x.columns, unique: !!x.unique,
      })),
      primary_key: splitList(pkText ? pkText.value : ''),
    };
  }

  async function preview() {
    try {
      const res = await api.alter({
        server: ctx.server, db: ctx.db, table: ctx.table, desired: desired(), dry: true,
      }, signal);

      if (!res.changed) { toast('Nothing to change', 'ok'); return; }
      showApply(res.sql);
    } catch (e) {
      if (!aborted(e)) toast(e.message, 'err');
    }
  }

  function showApply(sql) {
    const applyNow = h('button', { type: 'button', class: 'danger', text: 'Apply' });
    const close = modal('Apply to ' + ctx.db + '.' + ctx.table,
      h('div', {},
        h('p', { class: 'note', text: 'This exact statement will run on the server.' }),
        h('pre', { class: 'sql', text: sql }),
        h('p', {
          class: 'note',
          text: 'It runs without a deadline, because a table rebuild can take '
            + 'many minutes and cutting it off would lose the work. You get live '
            + 'progress and a Cancel button, and it keeps going if you close the tab.',
        }),
      ),
      [h('button', { type: 'button', text: 'Cancel', onclick: () => close() }), applyNow],
    );

    applyNow.addEventListener('click', async () => {
      applyNow.disabled = true;
      close();
      await apply();
    });
  }

  // apply runs the ALTER as a job with no deadline. A table rebuild can
  // legitimately take many minutes, so instead of a timeout it gets live
  // progress and a cancel button, and it keeps running if this tab closes.
  async function apply() {
    status.textContent = 'applying…';
    status.className = 'busy spin';
    applyBtn.disabled = true;
    try {
      const snap = await api.alter({
        server: ctx.server, db: ctx.db, table: ctx.table, desired: desired(), dry: false,
      }, signal);

      job = runJob({ server: ctx.server, db: ctx.db, sql: snap.sql, kind: 'ddl' }, {
        signal,
        onState: (s) => {
          if (s.state !== 'running' && s.state !== 'queued') return;
          cancelBtn.hidden = false;
          const p = fmtProgress(s.progress);
          status.textContent = 'altering ' + fmtMs(s.elapsed_ms) + (p ? ' · ' + p : '');
        },
      });

      const res = await job.promise;
      toast('Applied in ' + fmtMs(res.elapsed_ms), 'ok');
      await load();
    } catch (e) {
      if (!aborted(e)) { status.textContent = 'failed'; toast(e.message, 'err'); }
    } finally {
      job = null;
      cancelBtn.hidden = true;
      applyBtn.disabled = false;
      status.className = '';
    }
  }

  async function showCreate() {
    if (!current) return;
    const close = modal('CREATE TABLE ' + ctx.table,
      h('pre', { class: 'sql', text: current.create_sql || '(none)' }),
      [h('button', { type: 'button', text: 'Close', onclick: () => close() })],
    );
  }

  applyBtn.addEventListener('click', preview);
  reloadBtn.addEventListener('click', load);
  createBtn.addEventListener('click', showCreate);
  cancelBtn.addEventListener('click', () => job?.cancel());

  load();

  return {
    kind: 'struct',
    ctx,
    reload: load,
    cancel: () => job?.cancel(),
    // No dispose() that kills the job: an ALTER keeps running when its tab
    // is closed, and the server keeps it observable.
  };
}

function splitList(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function eqExtra(a, b) {
  return String(a).toUpperCase() === String(b || '').toUpperCase();
}

// isExpr guesses whether a stored DEFAULT is an expression rather than a
// literal, so re-saving an untouched column does not quote it by mistake.
function isExpr(v) {
  if (v === null || v === undefined) return false;
  return /^(CURRENT_TIMESTAMP(\(\d?\))?|NOW\(\)|CURRENT_DATE|CURRENT_TIME|UUID\(\))$/i.test(String(v).trim());
}
