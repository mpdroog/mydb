// structure.js - the CMD+D table-structure editor.
//
// The editor never applies anything blind: it always asks the server for a
// dry-run first and puts the exact ALTER TABLE on screen. Applying then
// runs as a normal job, so a long table-rebuild stays cancellable.

import { h, clear, modal, toast, copyText, fmtMs, fmtProgress } from './dom.js';
import { crumb } from './crumb.js';
import { api, aborted } from './api.js';
import { runJob } from './state.js';
import * as tabs from './tabs.js';
import { isProduction } from './state.js';

const EXTRAS = ['', 'AUTO_INCREMENT', 'ON UPDATE CURRENT_TIMESTAMP'];

export function openStructure(server, db, table) {
  return tabs.open({
    key: 'struct:' + server + ':' + db + ':' + table,
    title: table,
    danger: isProduction(server),
    server,
    build: (pane, signal) => build(pane, signal, { server, db, table }),
  });
}

function build(pane, signal, ctx) {
  pane.classList.add('struct-pane');

  const applyBtn = h('button', { class: 'btn primary', type: 'button', text: 'Preview changes…' });
  const reloadBtn = h('button', { class: 'btn ghost', type: 'button' },
    'Reload', h('span', { class: 'key', text: 'Ctrl+R' }));
  const createBtn = h('button', { class: 'btn ghost', type: 'button' },
    'SHOW CREATE', h('span', { class: 'key', text: 'Ctrl+Shift+C' }));
  const cancelBtn = h('button', {
    type: 'button', class: 'danger', text: 'Cancel', hidden: true,
    title: 'Abort the running statement. A table rebuild then has to roll '
      + 'back, which can take as long again as it has already run.',
  });
  const head = h('div', { class: 'pane-head' },
    crumb(ctx.server, ctx.db, ctx.table),
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
  let tableComment = null;
  let comment = '';

  // ---- rendering ----------------------------------------------------

  function colRow(c, i) {
    const name = h('input', { type: 'text', value: c.name });
    // A type is a base and its arguments, so it is two controls: a list of
    // the types mydb will actually write, and a box for what goes in the
    // brackets. Free text meant guessing at both, and guessing wrong was
    // only found out on apply.
    const parsed = splitType(c.type);
    const base = h('select', { class: 'ty-base' },
      ...(current?.types || []).map((t) => h('option', { value: t, text: t })),
      // A type the table already has that mydb does not offer stays
      // selectable rather than being silently rewritten to something else.
      (current?.types || []).includes(parsed.base)
        ? null
        : h('option', { value: parsed.base, text: parsed.base + ' (as found)' }));
    base.value = parsed.base;

    const args = h('input', {
      class: 'ty-args',
      type: 'text',
      value: parsed.args,
      spellcheck: false,
      placeholder: argHint(parsed.base),
      title: 'What goes in the brackets: a length, a precision and scale, or '
        + 'the members of an enum. Leave it empty for a type that takes none.',
    });

    function syncType() {
      c.type = args.value.trim() ? base.value + '(' + args.value.trim() + ')' : base.value;
      args.placeholder = argHint(base.value);
      type.value = c.type;
    }
    // Kept so the rest of the row, and the preview, still read one value.
    const type = h('input', { type: 'hidden', value: c.type });
    const nul = h('input', { type: 'checkbox', checked: c.nullable });
    const def = h('input', { type: 'text', value: c.default === null ? '' : c.default });
    const raw = h('input', {
      type: 'checkbox',
      checked: c.default_raw,
      title: 'The default is an expression to evaluate, such as '
        + 'CURRENT_TIMESTAMP or (UUID()), rather than a literal value to store.',
    });

    // What a blank default actually means depends on the column, so the
    // placeholder says which of the three it is rather than always
    // claiming NULL -- which is not even allowed on a NOT NULL column.
    function syncDefault() {
      const auto = /auto_increment/i.test(c.extra || '');
      def.disabled = auto;
      raw.disabled = auto;
      def.placeholder = auto ? 'AUTO_INCREMENT'
        : c.nullable ? 'NULL'
        : 'no default';
      def.title = auto
        ? 'An AUTO_INCREMENT column takes its value from the server; it cannot have a default.'
        : c.nullable
          ? 'Blank means DEFAULT NULL.'
          : 'Blank means no default at all: every INSERT has to name this column. '
            + 'NULL is not available here because the column is NOT NULL.';
    }
    const extra = h('select', {},
      ...EXTRAS.map((x) => h('option', { value: x, text: x || '—', selected: eqExtra(x, c.extra) })));
    const comment = h('input', { type: 'text', value: c.comment });

    name.addEventListener('input', () => { c.name = name.value; });
    base.addEventListener('change', syncType);
    args.addEventListener('input', syncType);
    nul.addEventListener('change', () => { c.nullable = nul.checked; syncDefault(); });
    def.addEventListener('input', () => { c.default = def.value === '' ? null : def.value; });
    raw.addEventListener('change', () => { c.default_raw = raw.checked; });
    extra.addEventListener('change', () => { c.extra = extra.value; syncDefault(); });
    syncDefault();
    comment.addEventListener('input', () => { c.comment = comment.value; });

    const up = h('button', { type: 'button', title: 'Move up', text: '↑', onclick: () => moveCol(i, -1) });
    const down = h('button', { type: 'button', title: 'Move down', text: '↓', onclick: () => moveCol(i, 1) });
    const del = h('button', {
      type: 'button', class: 'danger', title: 'Drop column', text: '×',
      onclick: () => { cols.splice(i, 1); render(); },
    });

    return h('tr', {},
      h('td', {}, name),
      h('td', { class: 'ty-cell' }, base, args, type),
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
    // An index over several columns is written as a list, and the order of
    // that list is the index: (a, b) serves a lookup on a, and on a and b
    // together, but not one on b alone.
    const colsIn = h('input', {
      type: 'text',
      value: x.columns.join(', '),
      list: 'mydb-cols',
      placeholder: 'one or more, in order: customer_id, placed_at',
      title: 'Several columns make one composite index, and their order '
        + 'matters: (a, b) answers a lookup on a, and on a with b, but not '
        + 'on b by itself.',
    });
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

  // Which section is on screen. Columns and indexes are separate jobs and
  // a table with forty columns buries its indexes off the bottom of the
  // page, where you stop remembering they are there.
  let section = 'columns';

  function render() {
    clear(bodyEl);
    if (!current) return;

    // The types mydb will write, and the columns this table has: both
    // offered rather than left to be remembered.
    const typeList = h('datalist', { id: 'mydb-types' },
      ...(current.types || []).map((t) => h('option', { value: t })));
    const colList = h('datalist', { id: 'mydb-cols' },
      ...cols.map((c) => h('option', { value: c.name })));

    const tab = (id, label, count) => h('button', {
      class: 'sec-tab',
      type: 'button',
      'aria-selected': String(section === id),
      onclick: () => { section = id; render(); },
    }, label, count == null ? null : h('span', { class: 'n', text: String(count) }));

    const tabsRow = h('div', { class: 'sec-tabs' },
      tab('columns', 'Columns', cols.length),
      tab('indexes', 'Indexes', idxs.length),
      tab('table', 'Table'));

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

    pkText = h('input', {
      type: 'text',
      value: (current.primary_key || []).join(', '),
      placeholder: 'no primary key',
      list: 'mydb-cols',
    });
    tableComment = h('textarea', {
      class: 'comment-box',
      rows: 5,
      spellcheck: true,
      placeholder: 'What one row of this table is, and anything the column '
        + 'names do not say. Whoever reads this next will not have the context '
        + 'you have now.',
    });
    tableComment.value = comment;
    tableComment.addEventListener('input', () => { comment = tableComment.value; });

    bodyEl.append(typeList, colList, tabsRow);

    if (section === 'columns') {
      bodyEl.append(
        colTable,
        h('div', {}, h('button', {
          type: 'button', text: '+ column',
          onclick: () => {
            cols.push({ orig: '', name: 'new_column', type: 'VARCHAR(255)', nullable: true, default: null, default_raw: false, extra: '', comment: '' });
            render();
          },
        })),
      );
    } else if (section === 'indexes') {
      bodyEl.append(
        h('div', { class: 'st-title', text: 'Primary key' }),
        pkText,
        h('p', {
          class: 'note',
          text: 'One column, or several separated by commas for a composite key.',
        }),
        h('div', { class: 'st-title', text: 'Secondary indexes' }),
        idxTable,
        h('div', {}, h('button', {
          type: 'button', text: '+ index',
          onclick: () => { idxs.push({ orig: '', name: 'idx_new', columns: [], unique: false }); render(); },
        })),
        h('p', {
          class: 'note',
          text: 'An index over several columns is one index, not several: put them '
            + 'in the order you look them up in. (customer_id, placed_at) answers a '
            + "query on the customer, and on the customer within a date range, but "
            + 'not one on the date alone.',
        }),
      );
    } else {
      bodyEl.append(
        h('div', { class: 'st-title', text: 'Table comment' }),
        tableComment,
        h('p', {
          class: 'note',
          text: 'Stored with the table and shown by SHOW CREATE TABLE. '
            + 'A sentence saying what one row is tends to be worth more than the name.',
        }),
        h('div', { class: 'st-title', text: 'Not editable here' }),
        h('p', {
          class: 'note',
          text: 'Foreign keys, partitions, and engine or charset changes appear in '
            + 'SHOW CREATE but are not edited from this page. Use a console for those.',
        }),
      );
    }
  }

  // splitType takes VARCHAR(300) apart into its base and its arguments,
  // keeping anything it does not understand as the base so a type mydb
  // did not write is never quietly replaced.
  function splitType(t) {
    const m = /^\s*([A-Za-z ]+?)\s*\((.*)\)\s*$/.exec(String(t || ''));
    if (!m) return { base: String(t || '').trim().toUpperCase(), args: '' };
    return { base: m[1].trim().toUpperCase(), args: m[2].trim() };
  }

  // argHint says what the brackets are for, per type, rather than leaving
  // it to be remembered.
  function argHint(base) {
    switch (base) {
      case 'VARCHAR': case 'CHAR': case 'VARBINARY': case 'BINARY': return 'length, e.g. 255';
      case 'DECIMAL': case 'NUMERIC': return 'precision, scale — e.g. 10,2';
      case 'ENUM': case 'SET': return "'a','b','c'";
      case 'BIT': return 'bits, e.g. 8';
      case 'DATETIME': case 'TIMESTAMP': case 'TIME': return 'fractional digits, 0-6';
      case 'FLOAT': case 'DOUBLE': return 'optional';
      default: return 'none';
    }
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
      comment = current.comment || '';
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
      comment,
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
    const sql = current.create_sql || '';
    const close = modal('CREATE TABLE ' + ctx.table,
      h('pre', { class: 'sql', text: sql || '(none)' }),
      [
        // The reason to open this is almost always to put it somewhere
        // else: a migration, a ticket, another server.
        // Copying is silent by nature: nothing on screen changes, so the
        // only way to know it worked is to be told.
        h('button', {
          class: 'btn', type: 'button', text: 'Copy',
          disabled: !sql,
          onclick: (ev) => {
            const btn = ev.currentTarget;
            copyText(sql)
              .then(() => {
                btn.textContent = 'Copied';
                toast('CREATE TABLE copied — ' + sql.split('\n').length + ' lines', 'ok');
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
              })
              .catch((e) => toast('Could not copy: ' + e.message, 'err'));
          },
        }),
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => close() }),
      ],
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
