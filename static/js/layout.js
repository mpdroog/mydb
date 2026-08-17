// layout.js - places the ERM boxes. Pure: no DOM, no globals, same input
// gives the same output every time, which is what makes a re-layout button
// safe and lets this be tested outside a browser.
//
// The shape of the algorithm:
//   1. size every box from the text it has to hold
//   2. relax each group on its own with a small force simulation
//   3. shelf-pack the finished groups side by side
//
// Doing the groups separately is the whole trick. One simulation over the
// entire schema pulls everything into a single ball; laying out islands
// independently and then packing them keeps the islands legible.

const HEADER_H = 19;
const ROW_H = 13;
const PAD_X = 10;
const PAD_Y = 6;
const MIN_W = 118;
const MAX_W = 260;
const MAX_ROWS = 8;

// GROUP_PAD is the breathing room drawn around a cluster's contents.
const GROUP_PAD = 26;
// GROUP_GAP separates packed clusters.
const GROUP_GAP = 40;

// Force-simulation constants. Tuned by eye on schemas of 5-200 tables.
const ITERATIONS = 420;
const REPULSION = 5200;
const SPRING = 0.035;
const IDEAL_EDGE = 150;
const COLLIDE_PAD = 16;

// estimate is the fallback text measurer, used when no real one is given
// (in tests, and before the canvas is available).
function estimate(text, mono) {
  return text.length * (mono ? 6.4 : 6.7);
}

// visibleColumns picks what a box shows: the primary key first, then the
// columns that actually take part in a link. A box listing all 60 columns
// of a wide table tells you nothing at overview zoom.
export function visibleColumns(table, linkedCols) {
  const pk = new Set(table.primary_key || []);
  const out = [];

  for (const c of table.columns || []) {
    if (pk.has(c.name)) out.push({ name: c.name, type: c.type, role: 'pk' });
  }
  for (const c of table.columns || []) {
    if (!pk.has(c.name) && linkedCols.has(c.name)) {
      out.push({ name: c.name, type: c.type, role: 'fk' });
    }
  }
  const hidden = (table.columns || []).length - out.length;
  return { shown: out.slice(0, MAX_ROWS), hidden: Math.max(0, hidden - Math.max(0, out.length - MAX_ROWS)) };
}

// measure works out every box's size.
function measure(model, measureText) {
  const linked = new Map();
  for (const l of model.links) {
    if (!linked.has(l.from)) linked.set(l.from, new Set());
    if (!linked.has(l.to)) linked.set(l.to, new Set());
    l.from_cols.forEach((c) => linked.get(l.from).add(c));
    l.to_cols.forEach((c) => linked.get(l.to).add(c));
  }

  const nodes = new Map();
  for (const t of model.tables) {
    const { shown, hidden } = visibleColumns(t, linked.get(t.name) || new Set());
    const rows = shown.length + (hidden > 0 ? 1 : 0);

    let w = measureText(t.name, false) + PAD_X * 2;
    for (const c of shown) {
      w = Math.max(w, measureText(c.name + '  ' + shortType(c.type), true) + PAD_X * 2);
    }
    nodes.set(t.name, {
      id: t.name,
      table: t,
      cols: shown,
      hidden,
      isView: t.type === 'VIEW',
      w: Math.round(Math.max(MIN_W, Math.min(MAX_W, w))),
      h: HEADER_H + rows * ROW_H + PAD_Y,
      x: 0,
      y: 0,
    });
  }
  return nodes;
}

// shortType trims a column type down to what fits in a box.
export function shortType(t) {
  return String(t || '').replace(/\s*unsigned/i, 'u').replace(/\(\d+(,\d+)?\)/, '');
}

// relax runs the force simulation over one group.
//
// Deterministic on purpose: the starting ring is derived from the index,
// never from a random number, so pressing re-layout twice cannot produce
// two different pictures of the same schema.
function relax(items, edges) {
  const n = items.length;
  if (n === 1) {
    items[0].x = 0;
    items[0].y = 0;
    return;
  }

  const radius = Math.max(120, n * 26);
  items.forEach((it, i) => {
    const a = (i / n) * Math.PI * 2;
    it.x = Math.cos(a) * radius;
    it.y = Math.sin(a) * radius;
  });

  const index = new Map(items.map((it, i) => [it.id, i]));
  const springs = edges
    .map((e) => [index.get(e.from), index.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b);

  for (let step = 0; step < ITERATIONS; step++) {
    const cool = 1 - step / ITERATIONS;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = items[i];
        const b = items[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (i - j) || 1; dy = 1; d2 = 2; }
        const f = (REPULSION / d2) * cool;
        const d = Math.sqrt(d2);
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        a.x -= ux; a.y -= uy;
        b.x += ux; b.y += uy;
      }
    }

    for (const [i, j] of springs) {
      const a = items[i];
      const b = items[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - IDEAL_EDGE) * SPRING * cool;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      a.x += ux; a.y += uy;
      b.x -= ux; b.y -= uy;
    }

    separate(items);
  }
  separate(items, 6);
}

// separate pushes overlapping boxes apart along whichever axis needs the
// smaller move, which keeps the arrangement the springs found.
function separate(items, passes = 1) {
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + COLLIDE_PAD - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + COLLIDE_PAD - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;

        if (ox < oy) {
          const s = (dx < 0 ? -1 : 1) * ox / 2;
          a.x -= s; b.x += s;
        } else {
          const s = (dy < 0 ? -1 : 1) * oy / 2;
          a.y -= s; b.y += s;
        }
      }
    }
  }
}

// bounds measures a set of placed boxes.
function bounds(items) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of items) {
    x1 = Math.min(x1, it.x - it.w / 2);
    y1 = Math.min(y1, it.y - it.h / 2);
    x2 = Math.max(x2, it.x + it.w / 2);
    y2 = Math.max(y2, it.y + it.h / 2);
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

// layout places every table and returns the drawing in absolute
// coordinates, with the top-left corner at 0,0.
export function layout(model, { measureText = estimate } = {}) {
  const nodes = measure(model, measureText);

  // Group membership. Anything the server did not place lands in a
  // trailing group of its own rather than being dropped from the picture.
  const groups = (model.groups || []).map((g) => ({ ...g, items: [] }));
  const placed = new Set();
  for (const g of groups) {
    for (const name of g.tables) {
      const n = nodes.get(name);
      if (n) { g.items.push(n); placed.add(name); }
    }
  }
  const leftovers = [...nodes.values()].filter((n) => !placed.has(n.id));
  if (leftovers.length) {
    groups.push({ name: 'ungrouped', kind: 'isolated', tables: leftovers.map((n) => n.id), items: leftovers });
  }

  // Relax each group on its own.
  for (const g of groups) {
    if (!g.items.length) continue;
    const inside = new Set(g.tables);
    relax(g.items, model.links.filter((l) => inside.has(l.from) && inside.has(l.to)));
    const b = bounds(g.items);
    g.items.forEach((it) => { it.x -= b.x1; it.y -= b.y1; });
    g.w = b.w + GROUP_PAD * 2;
    g.h = b.h + GROUP_PAD * 2 + 14; // 14 leaves room for the group label
  }

  // Shelf-pack the groups, biggest first, into a roughly square page.
  const live = groups.filter((g) => g.items.length);
  live.sort((a, b) => b.w * b.h - a.w * a.h);

  const total = live.reduce((sum, g) => sum + g.w * g.h, 0);
  const target = Math.max(900, Math.sqrt(total) * 1.5);

  let shelfX = 0, shelfY = 0, shelfH = 0, pageW = 0;
  for (const g of live) {
    if (shelfX > 0 && shelfX + g.w > target) {
      shelfX = 0;
      shelfY += shelfH + GROUP_GAP;
      shelfH = 0;
    }
    g.x = shelfX;
    g.y = shelfY;
    shelfX += g.w + GROUP_GAP;
    shelfH = Math.max(shelfH, g.h);
    pageW = Math.max(pageW, g.x + g.w);
  }

  // Absolute positions: box centres become top-left corners.
  for (const g of live) {
    for (const it of g.items) {
      it.x = g.x + GROUP_PAD + it.x - it.w / 2;
      it.y = g.y + GROUP_PAD + 14 + it.y - it.h / 2;
    }
  }

  return {
    nodes,
    groups: live,
    width: Math.ceil(pageW),
    height: Math.ceil(shelfY + shelfH),
  };
}
