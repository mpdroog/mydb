import { shapeOf } from '../../../static/js/shape.js';
import assert from 'node:assert/strict';

const col = (type) => ({ type });

// A numeric column becomes a histogram over its own range.
const h = shapeOf(col('int'), [1, 2, 2, 3, 100]);
assert.equal(h.kind, 'histogram');
assert.ok(h.summary.includes('1 → 100'), h.summary);
assert.ok(h.marks.some((m) => m.hi), 'the fullest bucket is marked');
assert.ok(h.marks.every((m) => m.x + m.w <= 100.01), 'nothing overflows the strip');

// A low-cardinality column becomes proportions, commonest first.
const p = shapeOf(col('enum'), ['new', 'paid', 'new', 'new', 'shipped']);
assert.equal(p.kind, 'proportion');
assert.equal(p.marks[0].value, 'new');
assert.ok(p.summary.startsWith('new 60%'), p.summary);

// All-distinct is its own answer, not a bar of a hundred slivers.
const d = shapeOf(col('varchar'), ['a', 'b', 'c', 'd', 'e']);
assert.equal(d.kind, 'distinct');
assert.ok(d.summary.includes('all distinct'));

// NULLs take a share of the width in every case, and are counted.
const n = shapeOf(col('int'), [1, 2, null, null]);
assert.equal(n.nulls, 2);
assert.equal(n.width, 50, 'half the strip is the NULL segment');
assert.ok(n.summary.includes('2 NULL (50%)'), n.summary);

// A column of nothing but NULL says so rather than dividing by zero.
const e = shapeOf(col('text'), [null, null]);
assert.equal(e.kind, 'empty');
assert.equal(e.marks.length, 0);
assert.equal(e.summary, 'every value is NULL');

// One value repeated is a single full-width segment, not a crash.
const one = shapeOf(col('int'), [7, 7, 7]);
assert.ok(one.marks.length >= 1);
assert.ok(one.marks.every((m) => Number.isFinite(m.x)), 'no NaN when lo === hi');

// An empty result set does not throw.
assert.equal(shapeOf(col('int'), []).kind, 'empty');

console.log('shape.js: 17 assertions passed');
