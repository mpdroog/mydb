// erm.js - the entity-relationship diagram tab.
//
// Draws the model from /api/v1/erm as SVG: one box per table, clusters
// boxed and labelled, links drawn solid when the schema declares them and
// dashed when mydb guessed. Guesses are always visibly guesses.

import { h, clear, modal, toast, fmtNum, svg } from './dom.js';
import { api, aborted } from './api.js';
import { layout, shortType } from './layout.js';
import * as tabs from './tabs.js';
import { isProduction } from './state.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
// How far Fit may enlarge a small schema. Without this a 20-table diagram
// sat tiny in the middle of the window because fit refused to exceed 1.
const MAX_FIT = 1.75;
const ZOOM_STEP = 1.25;

export function openERM(server, db) {
  return tabs.open({
    key: 'erm:' + server + ':' + db,
    title: db,
    danger: isProduction(server),
    server,
    build: (pane, signal) => build(pane, signal, { server, db }),
  });
}

function build(pane, signal, ctx) {
  pane.classList.add('erm-pane');

  const guessBox = h('input', { type: 'checkbox', checked: true });
  const zoomOut = h('button', { type: 'button', title: 'Zoom out (-)', text: '\u2212' });
  const zoomIn = h('button', { type: 'button', title: 'Zoom in (+)', text: '+' });
  const pct = h('button', {
    type: 'button', class: 'zoom-pct', title: 'Reset to 100%', text: '100%',
  });
  const gaps = h('button', { type: 'button', text: 'Unlinked', title: 'Key-shaped columns mydb did not link, and why' });
  const backupBox = h('input', { type: 'checkbox' });
  const relayout = h('button', { type: 'button', text: 'Re-layout' });
  const fit = h('button', { type: 'button', text: 'Fit' });
  const png = h('button', { type: 'button', text: 'PNG' });
  const svgBtn = h('button', { type: 'button', text: 'SVG' });

  const head = h('div', { class: 'pane-head' },
    h('span', { class: 'muted mono', text: ctx.db }),
    h('label', { class: 'muted' }, guessBox, ' guessed links'),
    h('label', { class: 'muted' }, backupBox, ' backups'),
    h('span', { class: 'grow' }),
    zoomOut, pct, zoomIn, fit, gaps, relayout, svgBtn, png,
  );

  const canvas = h('div', { class: 'erm-canvas' });
  const status = h('span', { text: 'loading…' });
  const foot = h('div', { class: 'pane-foot' }, status);
  pane.append(head, canvas, foot);

  let model = null;
  let view = null;      // {nodes, groups, width, height}
  let root = null;      // <svg>
  let world = null;     // <g> that pan/zoom transforms
  let zoom = 1, panX = 0, panY = 0;
  let focus = null;

  // measureText uses a real canvas so box widths match the rendered text
  // rather than a guess at average character width.
  const ruler = document.createElement('canvas').getContext('2d');
  const measureText = (text, mono) => {
    ruler.font = mono ? '11px ui-monospace, monospace' : '600 12px system-ui, sans-serif';
    return ruler.measureText(text).width;
  };

  // ---- drawing -------------------------------------------------------

  function draw() {
    clear(canvas);
    if (!view) return;

    // Deliberately no viewBox here. A viewBox would scale the drawing to
    // fit as well as the transform below, so the diagram came out at the
    // product of the two, and wheel-zoom -- computed in screen pixels --
    // moved the picture in viewBox units and flung it off-screen. The
    // exported copy gets a viewBox instead, where nothing pans or zooms.
    root = svg('svg', {
      class: 'erm-svg', width: '100%', height: '100%',
      'data-w': view.width, 'data-h': view.height,
    });

    root.append(svg('defs', {},
      arrowMarker('erm-arrow', '#7f8899'),
      arrowMarker('erm-arrow-lit', '#59a5f5'),
    ));

    world = svg('g', { class: 'erm-world' });
    root.append(world);

    const groupLayer = svg('g', {});
    const edgeLayer = svg('g', {});
    const nodeLayer = svg('g', {});
    world.append(groupLayer, edgeLayer, nodeLayer);

    for (const g of view.groups) groupLayer.append(groupBox(g));
    for (const l of shownLinks()) edgeLayer.append(edge(l));
    for (const n of view.nodes.values()) nodeLayer.append(node(n));

    canvas.append(root);
    applyTransform();
    highlight();
  }

  function shownLinks() {
    const on = guessBox.checked;
    const drawn = new Set(view.nodes.keys());
    return model.links.filter((l) => (on || l.kind === 'fk')
      && drawn.has(l.from) && drawn.has(l.to));
  }

  function groupBox(g) {
    return svg('g', { class: 'erm-group' },
      svg('rect', {
        x: g.x, y: g.y, width: g.w, height: g.h, rx: 6,
        class: 'erm-group-bg erm-group-' + g.kind,
      }),
      svg('text', { x: g.x + 10, y: g.y + 14, class: 'erm-group-label' }, g.name),
    );
  }

  function node(n) {
    const rows = [];
    let y = n.y + 15;
    for (const c of n.cols) {
      rows.push(svg('text', { x: n.x + 8, y: y + 10, class: 'erm-col erm-col-' + c.role },
        c.name + '  ' + shortType(c.type)));
      y += 13;
    }
    if (n.hidden > 0) {
      rows.push(svg('text', { x: n.x + 8, y: y + 10, class: 'erm-col erm-more' },
        '+' + n.hidden + ' more'));
    }

    const g = svg('g', {
      class: 'erm-node' + (n.isView ? ' erm-view' : '') + (n.table.backup ? ' erm-backup' : ''),
      'data-id': n.id,
    },
      svg('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 4, class: 'erm-box' }),
      svg('rect', { x: n.x, y: n.y, width: n.w, height: 19, rx: 4, class: 'erm-head' }),
      svg('text', { x: n.x + 8, y: n.y + 13, class: 'erm-title' }, n.id),
      ...rows,
    );
    g.append(svg('title', {}, n.id + '\n' + fmtNum(n.table.rows) + ' rows'
      + (n.isView ? '\nview' : '')));

    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      focus = focus === n.id ? null : n.id;
      highlight();
    });
    return g;
  }

  function edge(l) {
    const a = view.nodes.get(l.from);
    const b = view.nodes.get(l.to);
    if (!a || !b) return svg('g', {});

    const [x1, y1, x2, y2] = connect(a, b);
    const line = svg('path', {
      d: `M ${x1} ${y1} L ${x2} ${y2}`,
      class: 'erm-edge erm-' + l.kind
        + (/signedness/.test(l.rule || '') ? ' erm-smell' : ''),
      'marker-end': 'url(#erm-arrow)',
      'data-from': l.from,
      'data-to': l.to,
    });
    line.append(svg('title', {}, `${l.from}.${l.from_cols.join(',')} → ${l.to}.${l.to_cols.join(',')}`
      + (l.kind === 'fk' ? `\nforeign key ${l.name || ''}` : `\nguessed (${l.confidence}) — ${l.rule}`)));
    return line;
  }

  // connect finds where the line should touch each box, so arrows land on
  // an edge instead of disappearing under the box.
  function connect(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    return [...border(a, ax, ay, bx, by), ...border(b, bx, by, ax, ay)];
  }

  function border(box, cx, cy, tx, ty) {
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return [cx, cy];
    const sx = (box.w / 2 + 2) / Math.abs(dx || 1e-6);
    const sy = (box.h / 2 + 2) / Math.abs(dy || 1e-6);
    const s = Math.min(sx, sy);
    return [cx + dx * s, cy + dy * s];
  }

  // highlight dims everything that is not the focused table or one of its
  // direct neighbours, which is the only way to read a busy diagram.
  function highlight() {
    if (!root) return;
    const near = new Set();
    if (focus) {
      near.add(focus);
      for (const l of shownLinks()) {
        if (l.from === focus) near.add(l.to);
        if (l.to === focus) near.add(l.from);
      }
    }
    root.classList.toggle('erm-focused', !!focus);
    for (const el of root.querySelectorAll('.erm-node')) {
      el.classList.toggle('lit', near.has(el.dataset.id));
    }
    for (const el of root.querySelectorAll('.erm-edge')) {
      const on = focus && (el.dataset.from === focus || el.dataset.to === focus);
      el.classList.toggle('lit', !!on);
      el.setAttribute('marker-end', on ? 'url(#erm-arrow-lit)' : 'url(#erm-arrow)');
    }
    if (focus) {
      const links = shownLinks().filter((l) => l.from === focus || l.to === focus);
      status.textContent = focus + ' — ' + links.length + ' link' + (links.length === 1 ? '' : 's')
        + ' · click again to clear';
    } else {
      summarise();
    }
  }

  function summarise() {
    const fk = shownLinks().filter((l) => l.kind === 'fk').length;
    const un = (model.unmatched || []).length;
    clear(status);
    status.append(document.createTextNode([
      fmtNum(view.nodes.size) + ' of ' + fmtNum(model.tables.length) + ' tables',
      fmtNum(fk) + ' foreign keys',
      fmtNum(shownLinks().length - fk) + ' guessed',
      view.groups.length + ' groups',
    ].join(' · ')));
    if (un) {
      status.append(document.createTextNode(' · '));
      status.append(h('button', {
        class: 'link-btn', type: 'button', onclick: showGaps,
        text: fmtNum(un) + ' unlinked key column' + (un === 1 ? '' : 's'),
      }));
    }
    gaps.disabled = !un;
  }

  // showGaps lists what was not linked and why. A diagram with few edges
  // is otherwise ambiguous: you cannot tell a schema that really has no
  // relationships from a rule of mine that is too strict.
  function showGaps() {
    const un = model.unmatched || [];
    if (!un.length) { toast('Every key-shaped column was linked', 'ok'); return; }

    const rows = un.map((m) => h('tr', {},
      h('td', { class: 'mono', text: m.table + '.' + m.column }),
      h('td', { class: 'mono muted', text: shortType(m.type) }),
      h('td', { text: m.reason }),
      h('td', { class: 'mono muted', text: (m.candidates || []).join(', ') }),
    ));

    const close = modal('Unlinked key columns in ' + ctx.db,
      h('div', {},
        h('p', { class: 'note', text: un.length + ' column' + (un.length === 1 ? '' : 's')
          + ' looked like a key but was not linked. Only columns ending in _id, or '
          + 'sharing a name with some table\u2019s primary key, are considered.' }),
        h('table', { class: 'st' },
          h('thead', {}, h('tr', {}, ...['Column', 'Type', 'Why not', 'Closest'].map(
            (t) => h('th', { text: t })))),
          h('tbody', {}, ...rows)),
      ),
      [h('button', { type: 'button', text: 'Close', onclick: () => close() })],
    );
  }

  // ---- pan + zoom ----------------------------------------------------

  function applyTransform() {
    if (world) world.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
  }

  function fitToView() {
    if (!view || !canvas.clientWidth) return;
    const k = Math.min(canvas.clientWidth / view.width, canvas.clientHeight / view.height);
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_FIT, k * 0.94)));
    panX = (canvas.clientWidth - view.width * zoom) / 2;
    panY = (canvas.clientHeight - view.height * zoom) / 2;
    applyTransform();
  }

  // zoomAt scales around a point in canvas coordinates, so the thing under
  // the cursor stays put.
  function zoomAt(factor, mx, my) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (next === zoom) return;
    panX = mx - (mx - panX) * (next / zoom);
    panY = my - (my - panY) * (next / zoom);
    setZoom(next);
    applyTransform();
  }

  function zoomCentre(factor) {
    zoomAt(factor, canvas.clientWidth / 2, canvas.clientHeight / 2);
  }

  function setZoom(z) {
    zoom = z;
    pct.textContent = Math.round(zoom * 100) + '%';
  }

  canvas.addEventListener('wheel', (ev) => {
    if (!view) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    // A trackpad sends many small deltas, a mouse wheel a few large ones;
    // scaling the step by the delta keeps both feeling the same.
    const mag = Math.min(3, Math.abs(ev.deltaY) / 100 + 0.6);
    zoomAt(ev.deltaY < 0 ? 1 + 0.18 * mag : 1 / (1 + 0.18 * mag),
           ev.clientX - rect.left, ev.clientY - rect.top);
  }, { passive: false });

  // Zoom without a wheel at all: buttons, and the usual keys while the
  // diagram has focus.
  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case '+': case '=': zoomCentre(ZOOM_STEP); break;
      case '-': case '_': zoomCentre(1 / ZOOM_STEP); break;
      case '0': fitToView(); break;
      case 'Escape': focus = null; highlight(); break;
      default: return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  });
  canvas.addEventListener('dblclick', (ev) => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(ZOOM_STEP, ev.clientX - rect.left, ev.clientY - rect.top);
  });

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const sx = ev.clientX - panX;
    const sy = ev.clientY - panY;
    const move = (e) => { panX = e.clientX - sx; panY = e.clientY - sy; applyTransform(); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      canvas.classList.remove('dragging');
    };
    canvas.classList.add('dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  canvas.addEventListener('click', (ev) => {
    if (ev.target === canvas || ev.target === root) { focus = null; highlight(); }
  });

  // ---- export --------------------------------------------------------

  // exportSVG serialises the diagram with its styles inlined, so the file
  // stands on its own outside this page.
  function exportSVG() {
    const clone = root.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', view.width);
    clone.setAttribute('height', view.height);
    clone.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
    clone.querySelector('.erm-world').removeAttribute('transform');

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = ermStyles();
    clone.insertBefore(style, clone.firstChild);

    return new XMLSerializer().serializeToString(clone);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  svgBtn.addEventListener('click', () => {
    download(new Blob([exportSVG()], { type: 'image/svg+xml' }), ctx.db + '-erm.svg');
  });

  png.addEventListener('click', () => {
    const scale = 2; // readable text at normal zoom
    const blob = new Blob([exportSVG()], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = view.width * scale;
      c.height = view.height * scale;
      const g = c.getContext('2d');
      g.fillStyle = '#16181d';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => {
        if (!b) { toast('Could not render the PNG', 'err'); return; }
        download(b, ctx.db + '-erm.png');
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Could not render the PNG', 'err'); };
    img.src = url;
  });

  // ---- load ----------------------------------------------------------

  // visible drops backup copies unless asked for. On a schema carrying a
  // dozen *_copy1 and *_b4encoding tables they are most of the boxes and
  // none of the meaning.
  function visibleModel() {
    if (backupBox.checked) return model;
    const keep = new Set(model.tables.filter((t) => !t.backup).map((t) => t.name));
    return {
      ...model,
      tables: model.tables.filter((t) => keep.has(t.name)),
      links: model.links.filter((l) => keep.has(l.from) && keep.has(l.to)),
      groups: model.groups
        .map((g) => ({ ...g, tables: g.tables.filter((n) => keep.has(n)) }))
        .filter((g) => g.tables.length),
    };
  }

  async function load() {
    status.textContent = 'reading schema…';
    try {
      model = await api.erm(ctx.server, ctx.db, signal);
      view = layout(visibleModel(), { measureText });
      draw();
      fitToView();
      canvas.focus();
      summarise();
    } catch (e) {
      if (aborted(e)) return;
      status.textContent = 'failed';
      toast(e.message, 'err');
    }
  }

  function rebuild() {
    if (!model) return;
    view = layout(visibleModel(), { measureText });
    draw();
    fitToView();
  }
  relayout.addEventListener('click', rebuild);
  backupBox.addEventListener('change', rebuild);
  fit.addEventListener('click', fitToView);
  gaps.addEventListener('click', showGaps);
  zoomIn.addEventListener('click', () => zoomCentre(ZOOM_STEP));
  zoomOut.addEventListener('click', () => zoomCentre(1 / ZOOM_STEP));
  pct.addEventListener('click', () => {
    const mx = canvas.clientWidth / 2, my = canvas.clientHeight / 2;
    zoomAt(1 / zoom, mx, my);
  });
  guessBox.addEventListener('change', () => { draw(); });

  load();

  return { kind: 'erm', ctx, reload: load, onShow: fitToView };
}

// ermStyles is the diagram's own stylesheet, duplicated here so an exported
// SVG carries its appearance with it instead of arriving unstyled.
function ermStyles() {
  return `
    .erm-box{fill:#1c1f26;stroke:#39404e}
    .erm-head{fill:#2b313d;stroke:none}
    .erm-title{fill:#d6dae2;font:600 12px system-ui,sans-serif}
    .erm-col{fill:#9aa3b2;font:11px ui-monospace,monospace}
    .erm-col-pk{fill:#59a5f5}
    .erm-col-fk{fill:#c3cbd8}
    .erm-more{fill:#6b7383;font-style:italic}
    .erm-view .erm-box{stroke-dasharray:4 3}
    .erm-edge{stroke:#7f8899;stroke-width:1.3;fill:none}
    .erm-guess{stroke-dasharray:5 4;stroke:#8a7f5f}
    .erm-group-bg{fill:#1a1d24;stroke:#2e323c}
    .erm-group-component{stroke:#3a4658}
    .erm-group-hub{stroke:#5a4a3a}
    .erm-group-prefix{stroke:#3a5044}
    .erm-group-label{fill:#6b7383;font:10px ui-monospace,monospace;text-transform:uppercase}
  `;
}

// arrowMarker builds one arrowhead definition.
function arrowMarker(id, color) {
  return svg('marker', {
    id, viewBox: '0 0 10 10', refX: 9, refY: 5,
    markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  }, svg('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: color }));
}
