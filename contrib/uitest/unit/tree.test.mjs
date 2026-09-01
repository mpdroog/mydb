// The pure part of the tree: how a version string is shortened for a
// sidebar that is 236px wide.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// shortVersion is module-private, so read it out rather than exporting a
// function only a test would use.
const src = readFileSync(new URL('../../../static/js/tree.js', import.meta.url), 'utf8');
const body = /function shortVersion\(v\) \{([\s\S]*?)\n\}/.exec(src)[1];
const shortVersion = new Function('v', body);

// The case that made the server's ... button unreachable.
assert.equal(shortVersion('8.0.46-0ubuntu0.24.04.1'), '8.0.46');
assert.equal(shortVersion('10.11.14-MariaDB-0ubuntu0.24.04.1'), '10.11.14');
assert.equal(shortVersion('8.0.36'), '8.0.36');
assert.equal(shortVersion('5.7.44-log'), '5.7.44');

// Anything unexpected is passed through rather than mangled.
assert.equal(shortVersion(''), '');
assert.equal(shortVersion(undefined), '');
assert.equal(shortVersion('unknown'), 'unknown');

console.log('tree.js: 7 assertions passed');
