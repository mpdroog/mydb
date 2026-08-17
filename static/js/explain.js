// explain.js - the query plan, drawn rather than tabulated.
//
// EXPLAIN's grid of columns is famously hard to read: the nesting is
// implied by row order and the interesting parts are in a comma-separated
// Extra column. FORMAT=JSON has the nesting explicitly, so this draws the
// tree and calls out the four things worth acting on: a full table scan, a
// full index scan, a filesort and a temporary table.
//
// MySQL and MariaDB emit different JSON for the same query, so the walker
// reads what it recognises and shows the rest verbatim rather than guessing.

import { h, modal, fmtNum } from './dom.js';

// analyzable is the statement EXPLAIN ANALYZE may be pointed at.
//
// This is a safety rule, not a syntax one. Where EXPLAIN only plans,
// ANALYZE *runs* the statement — on MariaDB that includes an UPDATE or a
// DELETE, which would make "let me see the plan" delete the table.
export function analyzable(sql) {
  return /^\s*(\(|with\b|select\b|table\b|values\b)/i.test(sql);
}

// statement builds the EXPLAIN to run for this server.
//
// MySQL 8 spells the measured form `EXPLAIN ANALYZE` and answers with a
// text tree; MariaDB spells it `ANALYZE FORMAT=JSON` and answers with the
// same JSON shape as its EXPLAIN. Both are handled by showPlan.
export function statement(sql, { flavor, analyze }) {
  if (!analyze) return 'EXPLAIN FORMAT=JSON ' + sql;
  return flavor === 'mariadb' ? 'ANALYZE FORMAT=JSON ' + sql : 'EXPLAIN ANALYZE ' + sql;
}

// showPlan renders whatever the server answered with.
export function showPlan(title, result, sql) {
  const raw = result?.rows?.[0]?.[0] || '';
  const body = h('div', { class: 'plan' });

  let doc = null;
  try {
    doc = JSON.parse(raw);
  } catch {
    // EXPLAIN ANALYZE on MySQL answers with a text tree, not JSON. It is
    // already a tree, so it is shown as it came.
    body.append(h('pre', { class: 'sql', text: raw || '(the server returned no plan)' }));
  }

  if (doc) {
    const tree = h('div', { class: 'plan-tree' });
    node(tree, doc.query_block ? { query_block: doc.query_block } : doc, 0);
    body.append(summary(doc), tree);

    const rawBox = h('pre', { class: 'sql', hidden: true, text: pretty(raw) });
    const toggle = h('button', {
      type: 'button', text: 'Raw JSON',
      onclick: () => { rawBox.hidden = !rawBox.hidden; },
    });
    body.append(h('div', { class: 'plan-foot' }, toggle), rawBox);
  }

  body.prepend(h('pre', { class: 'sql dim', text: sql }));

  const close = modal(title, body, [
    h('button', { type: 'button', text: 'Close', onclick: () => close() }),
  ]);
}

// summary pulls the whole-query numbers out of the top of the plan.
function summary(doc) {
  const qb = doc.query_block || {};
  const bits = [];
  const cost = qb.cost_info?.query_cost;
  if (cost) bits.push('cost ' + fmtNum(Math.round(Number(cost))));
  const flags = [];
  walk(doc, (n) => {
    if (n.access_type === 'ALL') flags.push('full table scan');
    // MySQL flags these on a step, MariaDB makes them steps of their own.
    if (n.using_filesort || n.filesort) flags.push('filesort');
    if (n.using_temporary_table || n.temporary_table) flags.push('temporary table');
  });
  const box = h('div', { class: 'plan-sum' });
  if (bits.length) box.append(h('span', { class: 'muted', text: bits.join(' · ') }));
  for (const f of [...new Set(flags)]) {
    box.append(h('span', { class: 'flag bad', text: f }));
  }
  if (!box.children.length) box.append(h('span', { class: 'flag ok', text: 'no scans, sorts or temp tables' }));
  return box;
}

// walk visits every object in the plan, so a check can be written once
// without knowing where in the shape it might appear.
function walk(v, fn) {
  if (Array.isArray(v)) { for (const x of v) walk(x, fn); return; }
  if (!v || typeof v !== 'object') return;
  fn(v);
  for (const k of Object.keys(v)) walk(v[k], fn);
}

// containers are the keys that hold another step of the plan rather than a
// value, with the name to show and whether it is a step worth avoiding.
//
// MySQL and MariaDB describe the same two problems differently. MySQL sets
// using_filesort and using_temporary_table as flags on a step; MariaDB
// makes them steps of their own, named filesort and temporary_table. Both
// spellings are here, and both are read by summary().
const containers = {
  query_block: { label: 'query block' },
  ordering_operation: { label: 'ORDER BY' },
  grouping_operation: { label: 'GROUP BY' },
  duplicates_removal: { label: 'DISTINCT' },
  materialized_from_subquery: { label: 'materialised subquery' },
  union_result: { label: 'UNION' },
  attached_subqueries: { label: 'subquery' },
  optimized_away_subqueries: { label: 'subquery (optimised away)' },
  subqueries: { label: 'subquery' },
  having_subquery: { label: 'subquery in HAVING' },
  select_list_subqueries: { label: 'subquery in the select list' },
  nested_loop: { label: 'nested loop' },
  block_nested_loop: { label: 'block nested loop' },
  'block-nl-join': { label: 'block nested-loop join' },
  buffer_result: { label: 'buffered result' },
  // MariaDB's own words for the two steps worth noticing.
  filesort: { label: 'filesort', bad: true },
  temporary_table: { label: 'temporary table', bad: true },
};

// node draws one step of the plan and recurses into whatever it contains.
function node(parent, obj, depth) {
  if (Array.isArray(obj)) {
    for (const x of obj) node(parent, x, depth);
    return;
  }
  if (!obj || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'table') {
      parent.append(tableNode(value, depth));
      node(parent, value, depth + 1);
      continue;
    }
    const c = containers[key];
    if (!c || !value || typeof value !== 'object') continue;

    const flags = [];
    if (value.sort_key) flags.push('on ' + value.sort_key);
    if (value.r_total_time_ms !== undefined) flags.push(fmtNum(value.r_total_time_ms) + ' ms actual');
    parent.append(row(
      depth,
      c.label + (value.select_id ? ' #' + value.select_id : ''),
      flags,
      'step',
      [],
      c.bad,
    ));
    node(parent, value, depth + 1);
  }
}

// tableNode is the row for one table access: the line that says how the
// server intends to find the rows.
function tableNode(t, depth) {
  const flags = [];
  const bad = [];

  switch (t.access_type) {
    case 'ALL':
      bad.push('full table scan');
      break;
    case 'index':
      bad.push('full index scan');
      break;
    default:
      if (t.access_type) flags.push(t.access_type);
  }
  if (!t.key && t.access_type && t.access_type !== 'system' && t.access_type !== 'const') {
    bad.push('no index used');
  }
  if (t.key) flags.push('key ' + t.key);
  if (t.using_filesort) bad.push('filesort');
  if (t.using_temporary_table) bad.push('temporary table');
  if (t.using_index) flags.push('covering index');

  // MySQL and MariaDB name the row estimate differently.
  const rows = t.rows_examined_per_scan ?? t.rows ?? t.rows_for_plan;
  if (rows !== undefined) flags.push(fmtNum(rows) + ' rows');
  if (t.filtered !== undefined) flags.push('filtered ' + Number(t.filtered).toFixed(0) + '%');
  if (t.r_rows !== undefined) flags.push('actual ' + fmtNum(t.r_rows));
  if (t.cost_info?.read_cost) flags.push('cost ' + Number(t.cost_info.read_cost).toFixed(1));

  const el = row(depth, t.table_name || '(derived)', flags, 'table', bad);
  if (t.attached_condition) el.title = t.attached_condition;
  return el;
}

// row builds one line of the tree. bad holds the chips that name a problem;
// warn marks a step that is a problem by being there at all, which needs no
// chip repeating its own label.
function row(depth, label, flags, kind, bad = [], warn = false) {
  const el = h('div', { class: 'plan-node ' + kind + (bad.length || warn ? ' bad' : '') });
  el.style.paddingLeft = (depth * 18 + 8) + 'px';
  el.append(h('span', { class: 'plabel', text: label }));
  for (const b of bad) el.append(h('span', { class: 'flag bad', text: b }));
  for (const f of flags) el.append(h('span', { class: 'flag', text: f }));
  return el;
}

// pretty re-indents the raw JSON, leaving it alone if it will not parse.
function pretty(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
