// statement.js's two pure parts, which is where the bugs would be.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body>');
for (const k of ['document', 'window', 'Node', 'HTMLElement']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true });
}
const { cut, describe, tint } = await import('../../../static/js/statement.js');
import assert from 'node:assert/strict';

const slice = (s) => cut(s).map((r) => s.slice(r.start, r.end).trim());

// A semicolon inside a string, an identifier or a comment is not a cut.
assert.deepEqual(slice("SELECT 1;"), ['SELECT 1;']);
assert.deepEqual(slice("SELECT ';'; SELECT 2;"), ["SELECT ';';", 'SELECT 2;']);
assert.deepEqual(slice('SELECT `a;b` FROM t; SELECT 2;'), ['SELECT `a;b` FROM t;', 'SELECT 2;']);
assert.deepEqual(slice('SELECT 1; -- and; then\nSELECT 2;'), ['SELECT 1;', '-- and; then\nSELECT 2;']);
assert.deepEqual(slice('SELECT 1; /* a; b */ SELECT 2;'), ['SELECT 1;', '/* a; b */ SELECT 2;']);
assert.deepEqual(slice("SELECT 'it''s'; SELECT 2;"), ["SELECT 'it''s';", 'SELECT 2;']);

// Blank lines between statements belong to nobody: the range must start at
// the first real character, or a failure is blamed on the wrong line.
const buf = 'SELECT 1;\n\n\nSELECT 2;';
const r = cut(buf)[1];
assert.equal(buf.slice(r.start, r.end), 'SELECT 2;');
assert.equal(buf.slice(0, r.start).split('\n').length - 1, 3, 'statement 2 starts on line 4');

// A trailing statement with no semicolon still counts; trailing space does not.
assert.deepEqual(slice('SELECT 1;\nSELECT 2'), ['SELECT 1;', 'SELECT 2']);
assert.deepEqual(slice('SELECT 1;   \n  '), ['SELECT 1;']);

// describe reads the label out of the statement, never invents one.
assert.deepEqual(describe('SELECT * FROM `orders` WHERE x=1'), { verb: 'SELECT', table: 'orders' });
assert.deepEqual(describe('-- revenue\nSELECT a FROM shop.orders o'), { verb: 'SELECT', table: 'shop.orders' });
assert.deepEqual(describe('INSERT INTO t (a) VALUES (1)'), { verb: 'INSERT', table: 't' });
assert.deepEqual(describe('ALTER TABLE orders ADD INDEX x (y)'), { verb: 'ALTER', table: 'orders' });
assert.deepEqual(describe('  '), { verb: '', table: '' });

// A keyword inside a string stays a string.
const nodes = [...tint("SELECT 'FROM here'").childNodes];
const kw = nodes.filter((n) => n.className === 'kw').map((n) => n.textContent);
const str = nodes.filter((n) => n.className === 'str').map((n) => n.textContent);
assert.deepEqual(kw, ['SELECT']);
assert.deepEqual(str, ["'FROM here'"]);

console.log('statement.js: 17 assertions passed');
