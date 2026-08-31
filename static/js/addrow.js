// addrow.js - insert one row, with the schema doing the work.
//
// Everything here is read off the structure mydb already fetches, so the
// form knows what the table knows:
//
//   an auto-increment key is locked, and says why rather than looking broken
//   a nullable column starts on NULL, which is a value, not an empty box
//   NOT NULL with no default gets a red mark and stays marked until it is set
//   a column with a default arrives filled in and says where the value came from
//   an enum becomes a list of its own members
//   a column with a link -- declared or declared by you -- becomes a list of
//   real rows from the other side of it
//
// The INSERT it will run is written out underneath and rewritten on every
// keystroke. A form that posts and hopes is how you find out afterwards.

import { h, modal, toast, clear, fmtNum } from './dom.js';
import { api, aborted } from './api.js';
import { runJob } from './state.js';

const CANDIDATES = 50;

export async function openAddRow(ctx, onDone) {
  let struct;
  try {
    struct = await api.structure(ctx.server, ctx.db, ctx.table);
  } catch (e) {
    if (!aborted(e)) toast('Could not read the table: ' + e.message, 'err');
    return;
  }
  form(ctx, struct, onDone);
}

// state per column: the server assigns it, the schema's default applies,
// SQL NULL, or a value you typed.
//
// A column with a default starts on 'default', meaning mydb leaves it out
// of the INSERT entirely and the server fills it in. That is not laziness:
// the structure endpoint hands defaults back as strings, so "0.00" and
// "current_timestamp()" look alike, and a form that prefilled both would
// send the second one as the literal text of a function call. Omitting the
// column gets exactly what the schema says in both cases.
function initial(c) {
  if (isAuto(c)) return { mode: 'auto' };
  if (isBinary(c)) return { mode: 'default' };   // never sent: the endpoint refuses them
  if (c.default !== null && c.default !== undefined) return { mode: 'default' };
  if (c.nullable) return { mode: 'null' };
  return { mode: 'value', value: '' };
}

const isAuto = (c) => /auto_increment/i.test(c.extra || '');
// The write endpoint refuses binary columns, so the form must not offer
// them: a box you can type in but never save is worse than one you cannot.
// The answer comes from the server rather than a regex here -- BIT is
// binary and does not look it, and that rule belongs in one place.
const isBinary = (c) => !!c.binary;
const isNumeric = (c) => /^(tiny|small|medium|big)?int|^decimal|^numeric|^float|^double|^bit/i.test(c.type || '');
const enumMembers = (c) => {
  const m = /^(?:enum|set)\((.*)\)$/i.exec((c.type || '').trim());
  if (!m) return null;
  return m[1].split(/','|", "/).map((v) => v.replace(/^'|'$/g, '').replace(/''/g, "'"));
};

function form(ctx, struct, onDone) {
  const cols = struct.columns || [];
  const state = new Map(cols.map((c) => [c.name, initial(c)]));
  const preview = h('pre', { class: 'sql' });
  const note = h('span', { class: 'note' });
  const rows = h('dl', { class: 'fields' });

  for (const c of cols) rows.append(...fieldFor(ctx, c, state, redraw));

  function redraw() {
    const { sql, missing } = statement(ctx, cols, state);
    clear(preview);
    preview.append(sql);
    note.textContent = missing.length
      ? missing.length + ' column' + (missing.length === 1 ? '' : 's') + ' still needed: ' + missing.join(', ')
      : 'ready to run';
    note.className = 'note' + (missing.length ? ' warn-text' : '');
    save.disabled = missing.length > 0;
  }

  const save = h('button', { class: 'btn primary', type: 'button', text: 'Insert' });
  const body = h('div', {},
    rows,
    h('div', { class: 'st-title', text: 'Statement' }),
    preview,
    note,
  );

  const close = modal('New row in ' + ctx.table, body,
    [h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => close() }), save]);

  save.addEventListener('click', async () => {
    save.disabled = true;
    const values = {};
    for (const c of cols) {
      const st = state.get(c.name);
      if (st.mode === 'auto') continue;               // the server assigns it
      if (st.mode === 'default') continue;            // leave it out entirely
      values[c.name] = st.mode === 'null' ? null : String(st.value ?? '');
    }
    try {
      const res = await api.insertRow({
        server: ctx.server, db: ctx.db, table: ctx.table, values,
      });
      close();
      toast(res.insert_id ? 'Inserted row ' + res.insert_id : 'Row inserted', 'ok');
      onDone?.();
    } catch (e) {
      save.disabled = false;
      toast(e.message, 'err');
    }
  });

  redraw();
}

function fieldFor(ctx, c, state, redraw) {
  const st = state.get(c.name);
  const required = !c.nullable && c.default === null && !isAuto(c);

  const dt = h('dt', {},
    h('span', { class: 'cname', text: c.name }),
    required ? h('abbr', { class: 'req', title: 'NOT NULL and no default — this one has to be set', text: '*' }) : null,
    h('span', { class: 'ty', text: c.type }),
  );
  const dd = h('dd', {});

  if (isAuto(c)) {
    dd.append(
      h('input', { type: 'text', value: 'auto', disabled: true, 'aria-label': c.name }),
      h('span', { class: 'note', text: 'AUTO_INCREMENT — the server assigns it.' }),
    );
    return [dt, dd];
  }

  if (isBinary(c)) {
    dd.append(
      h('input', { type: 'text', value: c.nullable ? 'NULL' : 'default', disabled: true, 'aria-label': c.name }),
      h('span', { class: 'note', text: 'Binary — mydb does not write these; use the console.' }),
    );
    return [dt, dd];
  }

  const members = enumMembers(c);
  const input = members
    ? h('select', { 'aria-label': c.name }, ...members.map((v) => h('option', { value: v, text: v })))
    : h('input', { type: 'text', 'aria-label': c.name, placeholder: isNumeric(c) ? '0' : '' });

  if (st.mode === 'value') input.value = st.value ?? '';
  // A default shows as a placeholder rather than a value: it says what
  // will happen without claiming you typed it.
  if (st.mode === 'default' && !members) input.placeholder = String(c.default);
  if (st.mode === 'default' && members) input.value = String(c.default);
  input.disabled = st.mode === 'null';
  input.addEventListener('input', () => {
    // Emptying a field that has a default hands it back to the server
    // rather than sending an empty string.
    const hasDefault = c.default !== null && c.default !== undefined;
    state.set(c.name, (!input.value && hasDefault)
      ? { mode: 'default' }
      : { mode: 'value', value: input.value });
    input.classList.toggle('needed', required && !input.value.trim());
    redraw();
  });
  input.addEventListener('change', () => {
    state.set(c.name, { mode: 'value', value: input.value });
    redraw();
  });
  if (required && !input.value.trim()) input.classList.add('needed');
  dd.append(input);

  // NULL is a value you choose, not an empty box you leave alone.
  if (c.nullable) {
    const nullBtn = h('button', {
      class: 'nullbtn',
      type: 'button',
      text: 'NULL',
      title: 'Leave this column NULL',
      'aria-pressed': String(st.mode === 'null'),
      onclick: () => {
        const on = nullBtn.getAttribute('aria-pressed') !== 'true';
        nullBtn.setAttribute('aria-pressed', String(on));
        const hasDefault = c.default !== null && c.default !== undefined;
        state.set(c.name, on
          ? { mode: 'null' }
          : (input.value ? { mode: 'value', value: input.value } : (hasDefault ? { mode: 'default' } : { mode: 'value', value: '' })));
        input.disabled = on;
        if (!on) input.focus();
        redraw();
      },
    });
    dd.append(nullBtn);
  }

  if (c.default !== null && c.default !== undefined) {
    dd.append(h('span', {
      class: 'note',
      text: 'DEFAULT ' + c.default + ' — left to the server unless you type something.',
    }));
  } else if (required) {
    dd.append(h('span', { class: 'note', text: 'NOT NULL and no default.' }));
  }

  // A column that links somewhere becomes a list of real rows. Loaded on
  // demand: a form should not fire a query per foreign key on open.
  const link = linkFor(ctx, c);
  if (link && !members) offerCandidates(ctx, c, link, dd, input, state, redraw);

  return [dt, dd];
}

// linkFor finds where this column points, using the diagram's own model so
// a link the operator declared in config.toml counts exactly as much as a
// foreign key does.
function linkFor(ctx, c) {
  const model = ctx.links;
  if (!model) return null;
  for (const l of model) {
    if (l.from !== ctx.table) continue;
    const i = (l.from_cols || []).indexOf(c.name);
    if (i >= 0) return { table: l.to, column: (l.to_cols || [])[i], kind: l.kind };
  }
  return null;
}

function offerCandidates(ctx, c, link, dd, input, state, redraw) {
  const tag = h('span', {
    class: 'linktag' + (link.kind === 'guess' ? ' guessed' : ''),
    text: (link.kind === 'guess' ? 'inferred → ' : 'links → ') + link.table + '.' + link.column,
    title: link.kind === 'guess'
      ? 'mydb matched this on naming; the schema does not declare it'
      : 'declared in the schema',
  });
  const pick = h('button', { class: 'btn ghost', type: 'button', text: 'Pick…' });
  dd.append(tag, pick);

  pick.addEventListener('click', async () => {
    pick.disabled = true;
    try {
      const job = runJob({
        server: ctx.server,
        db: ctx.db,
        table: link.table,
        limit: CANDIDATES,
        kind: 'meta',
      }, {});
      const res = await job.promise;
      const cols = res.result?.cols || [];
      const idx = cols.findIndex((x) => x.name === link.column);
      if (idx < 0) { toast('No column ' + link.column + ' in ' + link.table, 'err'); return; }
      // A second column makes the list readable: an id on its own is not
      // something anyone recognises.
      const labelIdx = cols.findIndex((x, i) => i !== idx && !/^(tiny|small|medium|big)?int/i.test(x.type));
      const list = h('div', { class: 'pal-list' });
      for (const row of res.result?.rows || []) {
        const value = row[idx];
        list.append(h('button', {
          type: 'button',
          onclick: () => {
            input.value = value ?? '';
            input.disabled = false;
            state.set(c.name, { mode: 'value', value: input.value });
            redraw();
            closePick();
          },
        },
          h('span', { class: 'nm', text: String(value) }),
          labelIdx >= 0 ? h('span', { class: 'sub', text: String(row[labelIdx] ?? '') }) : null));
      }
      const closePick = modal(
        link.table + '.' + link.column,
        h('div', {}, list, h('p', {
          class: 'note',
          text: fmtNum(res.result?.rows?.length || 0) + ' of the newest rows. '
            + 'Type into the field for anything else.',
        })),
        [h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => closePick() })]);
    } catch (e) {
      if (!aborted(e)) toast(e.message, 'err');
    } finally {
      pick.disabled = false;
    }
  });
}

// statement writes the INSERT the form will send. Values are quoted here
// for reading only; on the wire they travel as placeholders.
function statement(ctx, cols, state) {
  const names = [];
  const values = [];
  const missing = [];

  for (const c of cols) {
    const st = state.get(c.name);
    if (st.mode === 'auto') continue;
    if (st.mode === 'default') continue;
    if (st.mode === 'null') { names.push(c.name); values.push({ nul: 'NULL' }); continue; }

    const v = String(st.value ?? '');
    const required = !c.nullable && c.default === null && c.default === undefined;
    if (!v.trim() && !c.nullable && c.default === null) { missing.push(c.name); continue; }
    if (!v && c.default !== null && c.default !== undefined) continue;
    names.push(c.name);
    values.push(isNumeric(c) && v !== '' ? { raw: v } : { str: quote(v) });
  }

  const frag = document.createDocumentFragment();
  frag.append(h('span', { class: 'kw', text: 'INSERT INTO' }));
  frag.append(' `' + ctx.table + '`\n  ('
    + names.map((n) => '`' + n + '`').join(', ') + ')\n');
  frag.append(h('span', { class: 'kw', text: 'VALUES' }));
  frag.append('\n  (');
  values.forEach((v, i) => {
    if (i) frag.append(', ');
    if (v.nul) frag.append(h('span', { class: 'dim', text: v.nul }));
    else if (v.str) frag.append(h('span', { class: 'str', text: v.str }));
    else frag.append(v.raw);
  });
  frag.append(');');
  return { sql: frag, missing };
}

function quote(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}
