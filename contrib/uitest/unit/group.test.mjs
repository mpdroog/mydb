// Run with: node static/js/group.test.mjs
// Mirrors erm/group_test.go, so a change to one rule fails on both sides.
import { byPrefix, prefixOf } from '../../../static/js/group.js';
import assert from 'node:assert/strict';

const t = (...names) => names.map((name) => ({ name }));
const names = (e) => (e.group ? e.tables.map((x) => x.name) : e.table.name);

// prefixOf matches erm.prefixOf, including the two-character floor.
assert.equal(prefixOf('order_lines'), 'order');
assert.equal(prefixOf('orders'), '', 'no underscore, no prefix');
assert.equal(prefixOf('v_open_orders'), '', 'one character is too short to mean anything');
assert.equal(prefixOf('AUDIT_log'), 'audit', 'lowercased, as the Go side does');

// A bucket below the floor stays loose rather than becoming a group of one.
const one = byPrefix(t('invoice_lines', 'orders'));
assert.deepEqual(one.map(names), ['invoice_lines', 'orders']);
assert.ok(one.every((e) => !e.group), 'a single table must not form a group');

// The real shape: groups and loose tables in one alphabet, members sorted.
const mixed = byPrefix(t(
  'shop_zones', 'shop_locales', 'orders', 'order_lines', 'order_events', 'customers',
));
assert.deepEqual(mixed.map((e) => e.key), ['customers', 'order', 'orders', 'shop']);
assert.deepEqual(names(mixed[1]), ['order_events', 'order_lines']);
assert.deepEqual(names(mixed[3]), ['shop_locales', 'shop_zones']);

// orders sits beside order_*, never inside it: it has no underscore.
assert.equal(mixed[2].group, false);

console.log('group.js: 8 assertions passed');
