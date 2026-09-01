// Substitutes the design tokens into the stylesheet so jsdom can compute
// real colours, then measures text-against-background for the controls
// the interface builds without a class. "Unreadable" should be a number.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const S = new URL('../../../static', import.meta.url).pathname;

const tokens = new Map();
for (const m of readFileSync(S + '/css/tokens.css', 'utf8').matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
  tokens.set(m[1], m[2].trim());
}
let css = readFileSync(S + '/css/app.css', 'utf8');
for (let i = 0; i < 5; i++) {
  css = css.replace(/var\((--[\w-]+)(?:,[^()]*)?\)/g, (all, name) => tokens.get(name) ?? all);
}

const dom = new JSDOM(`<!doctype html><html><head><style>
  body { background: ${tokens.get('--paper')}; color: ${tokens.get('--ink')}; }
  ${css}</style></head><body><div id="app">
  <div class="modal"><div class="card">
    <div class="foot">
      <button id="cancel">Cancel</button>
      <button class="danger" id="del">Delete</button>
      <button id="save">Save</button>
    </div></div></div>
  <div class="pane sql"><div class="pane-head">
    <select id="srv"></select><input type="text" id="db"><button id="run">Run</button>
    <button class="btn primary" id="prim">Run</button>
  </div></div>
</div></body></html>`);
const { window } = dom;

const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const PAPER = tokens.get('--paper');
let worst = 99;
for (const [what, id] of [['Cancel', 'cancel'], ['Delete', 'del'], ['Save', 'save'],
                          ['select', 'srv'], ['input', 'db'], ['bare button', 'run'],
                          ['.btn primary', 'prim']]) {
  void what;
  const s = window.getComputedStyle(window.document.getElementById(id));
  const bg = s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' ? s.backgroundColor : PAPER;
  const r = ratio(s.color, bg);
  worst = Math.min(worst, r);
  const verdict = r >= 4.5 ? 'ok' : r >= 3 ? 'thin' : 'UNREADABLE';
}
if (worst < 4.5) throw new Error(`worst contrast ${worst.toFixed(2)}:1, wanted 4.5`);
console.log(`contrast: 7 controls, worst ${worst.toFixed(2)}:1 (AA wants 4.5)`);
