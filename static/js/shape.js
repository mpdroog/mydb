// shape.js - what a column actually contains, drawn under its name.
//
// A grid is a thousand values you read one at a time. To learn that a
// fifth of ship_ref is NULL, or that one order is ten times the median,
// you scroll and squint -- or you go and write another query.
//
// This costs neither: it is computed from the page of rows already
// fetched, so there is no second round-trip, and it is one strip for the
// whole table rather than a line per column.
//
// Two primitives, because there are two questions:
//
//   a histogram   for numbers and dates: where the values sit
//   a proportion  for categories: which values, and in what share
//
// plus a comb where every value is distinct (an id, a reference: knowing
// they are all different is the whole finding), and a dashed segment on
// the right wherever there are NULLs, in every case.

const BUCKETS = 16;
const W = 100;
const H = 12;

const NUMERIC = /^(tiny|small|medium|big)?int|^decimal|^numeric|^float|^double|^bit|^year/i;
const TEMPORAL = /^date|^time|^year/i;

export function shapeOf(col, values) {
  const nulls = values.filter((v) => v === null || v === undefined).length;
  const present = values.filter((v) => v !== null && v !== undefined);
  const nullFrac = values.length ? nulls / values.length : 0;
  const width = W * (1 - nullFrac);

  if (!present.length) {
    return { kind: 'empty', nulls, total: values.length, width, marks: [], summary: 'every value is NULL' };
  }

  const type = String(col.type || '');
  const numeric = NUMERIC.test(type);
  const temporal = TEMPORAL.test(type) && !/^year/i.test(type);

  if (numeric || temporal) {
    const nums = temporal
      ? present.map((v) => Date.parse(String(v).replace(' ', 'T'))).filter((n) => !Number.isNaN(n))
      : present.map(Number).filter((n) => !Number.isNaN(n));
    if (nums.length) return histogram(nums, present, { nulls, total: values.length, width, temporal });
  }
  return proportion(present, { nulls, total: values.length, width });
}

function histogram(nums, present, ctx) {
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const buckets = new Array(BUCKETS).fill(0);
  for (const v of nums) {
    const b = hi === lo ? 0 : Math.min(BUCKETS - 1, Math.floor(((v - lo) / (hi - lo)) * BUCKETS));
    buckets[b]++;
  }
  const peak = Math.max(...buckets);
  const bw = ctx.width / BUCKETS;

  const marks = [];
  buckets.forEach((count, b) => {
    if (!count) return;
    const h = Math.max(1.5, (count / peak) * (H - 2));
    marks.push({
      kind: 'bar',
      hi: count === peak,
      x: b * bw + bw * 0.14,
      y: H - 1 - h,
      w: Math.max(0.5, bw * 0.72),
      h,
    });
  });

  const range = ctx.temporal
    ? String(present[present.length - 1]) + ' → ' + String(present[0])
    : fmt(lo) + ' → ' + fmt(hi);
  return {
    kind: 'histogram',
    ...ctx,
    marks,
    summary: present.length + ' values, ' + range + nullNote(ctx),
  };
}

function proportion(present, ctx) {
  const counts = new Map();
  for (const v of present) counts.set(String(v), (counts.get(String(v)) || 0) + 1);

  // Every value distinct is a finding in itself, and a bar of a hundred
  // equal slivers is not a way to say it.
  if (counts.size === present.length && present.length > 3) {
    const step = ctx.width / present.length;
    const marks = present.map((_, i) => ({ kind: 'tick', x: (i + 0.5) * step }));
    return {
      kind: 'distinct', ...ctx, marks,
      summary: present.length + ' values, all distinct' + nullNote(ctx),
    };
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const marks = [];
  let x = 0;
  sorted.forEach(([value, count], i) => {
    const w = (count / present.length) * ctx.width;
    marks.push({ kind: 'seg', value, rank: Math.min(i, 2), x, w: Math.max(0.6, w - 0.6) });
    x += w;
  });
  return {
    kind: 'proportion', ...ctx, marks,
    summary: sorted.slice(0, 5).map(([v, c]) =>
      v + ' ' + Math.round((c / present.length) * 100) + '%').join(', ') + nullNote(ctx),
  };
}

function nullNote(ctx) {
  if (!ctx.nulls) return ', no NULLs';
  return ', ' + ctx.nulls + ' NULL (' + Math.round((ctx.nulls / ctx.total) * 100) + '%)';
}

function fmt(n) {
  return Math.abs(n) >= 1000 ? n.toLocaleString('en-US') : String(Math.round(n * 100) / 100);
}

// draw turns a shape into SVG. Kept apart from shapeOf so the arithmetic
// can be tested without a DOM.
export function draw(shape, svgEl) {
  const NS = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svgEl.append(el);
  };

  for (const m of shape.marks) {
    if (m.kind === 'bar') add('rect', { class: 'bar' + (m.hi ? ' hi' : ''), x: r(m.x), y: r(m.y), width: r(m.w), height: r(m.h) });
    else if (m.kind === 'tick') add('line', { class: 'comb', x1: r(m.x), y1: 2, x2: r(m.x), y2: H - 1 });
    else if (m.kind === 'seg') add('rect', { class: 'seg s' + m.rank, x: r(m.x), y: 3, width: r(m.w), height: H - 4 });
  }
  if (shape.nulls) {
    add('rect', {
      class: 'nulls',
      x: r(shape.width + 0.5), y: 3.5,
      width: r(Math.max(1, W - shape.width - 1)), height: H - 5,
    });
  }
  add('line', { class: 'base', x1: 0, y1: H - 0.5, x2: W, y2: H - 0.5 });
}

const r = (n) => Math.round(n * 100) / 100;
