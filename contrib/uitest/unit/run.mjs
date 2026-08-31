// Runs the unit tests over the pure parts of the frontend: the grouping
// rule, the statement cutter, the column shapes.
//
// These need no database and no running mydb. group and shape need nothing
// at all; statement needs jsdom, because tinting SQL produces DOM nodes.
//
//   node contrib/uitest/unit/run.mjs
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;

for (const f of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  try {
    await import(pathToFileURL(join(here, f)).href);
  } catch (e) {
    failed++;
    if (String(e).includes("Cannot find package 'jsdom'")) {
      console.log(`  skip ${f} — needs jsdom (npm install jsdom)`);
      failed--;
      continue;
    }
    console.log(`  FAIL ${f}\n${e.stack || e}`);
  }
}
process.exit(failed ? 1 : 0);
