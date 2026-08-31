// dashboard.js - what a server is doing right now.
//
// One SSE stream per open dashboard; the Go side does the polling, so a
// dashboard left in a background tab cannot pile up requests. Everything
// here is a read of server metadata, never table data.
//
// Two rendering rules earn their keep. The process list and the lock-wait
// list are updated in place, keyed by connection id, rather than rebuilt:
// a list that rebuilds itself every three seconds eats the click on its own
// Kill button, which is the same bug that once kept double-click from
// opening a table. And Pause stops the paint rather than the stream, so
// resuming is instant and reading a busy server is possible at all.

import { h, svg, clear, toast, fmtNum, fmtBytes, fmtSecs, fmtPerSec, fmtMs } from './dom.js';
import { api, stream, aborted, dashPath } from './api.js';
import { isProduction } from './state.js';
import * as tabs from './tabs.js';

// HIST is how many ticks of history a sparkline keeps.
const HIST = 60;

export function openDashboard(server) {
  return tabs.open({
    key: 'dash:' + server,
    title: server,
    danger: isProduction(server),
    server,
    build: (pane, signal) => build(pane, signal, { server }),
  });
}

function build(pane, signal, ctx) {
  pane.classList.add('dash');

  const title = h('span', { class: 'mono', text: ctx.server });
  const version = h('span', { class: 'muted' });
  const uptime = h('span', { class: 'muted' });

  const pauseBtn = h('button', { type: 'button', text: 'Pause', title: 'Freeze the view (the stream stays open)' });
  const sleepers = h('input', { type: 'checkbox' });
  const filter = h('input', {
    type: 'search', class: 'where', placeholder: 'filter connections by user, host, db or statement',
    spellcheck: false, autocomplete: 'off',
  });

  const head = h('div', { class: 'pane-head' },
    title,
    isProduction(ctx.server) ? h('span', { class: 'prod-badge', text: 'PROD' }) : null,
    version, uptime,
    filter,
    h('label', { title: 'Show connections that are idle' }, sleepers, 'sleeping'),
    pauseBtn,
  );

  const tiles = h('div', { class: 'tiles' });
  const waits = section('Blocked by', 'waits');
  const procs = section('Connections', 'procs');
  const trx = section('Open transactions', 'trx');
  const top = section('Top statements', 'top');
  const memory = section('Memory', 'mem');
  const deadlock = section('Last deadlock', 'deadlock');
  const notes = h('div', { class: 'dash-notes' });

  const body = h('div', { class: 'dash-body' },
    tiles, waits.el, procs.el, trx.el, top.el, memory.el, deadlock.el, notes);

  const status = h('span', { text: 'connecting…' });
  const foot = h('div', { class: 'pane-foot' }, status);

  pane.append(head, body, foot);

  const hist = new Map();          // rate name -> recent per-second values
  const procRows = new Map();      // connection id -> row element
  const waitRows = new Map();      // waiting thread id -> row element
  let paused = false;
  let last = null;

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('on', paused);
    if (!paused && last) draw(last);
  });
  sleepers.addEventListener('change', () => { if (last) draw(last); });
  filter.addEventListener('input', () => { if (last) draw(last); });

  // ---- kill ----------------------------------------------------------

  async function kill(id, queryOnly) {
    if (!queryOnly && !confirm('Kill connection ' + id + ' on ' + ctx.server
      + '?\n\nIts open transaction is rolled back and whoever owns it is disconnected.')) return;
    try {
      await api.kill({ server: ctx.server, id, query: queryOnly }, signal);
      toast((queryOnly ? 'Killed the query on ' : 'Killed connection ') + id, 'ok');
    } catch (e) {
      if (!aborted(e)) toast(e.message, 'err');
    }
  }

  // fillKill puts the two Kill buttons in a cell, once. Keeping the row
  // across ticks is not enough on its own: rebuilding the buttons inside it
  // every three seconds would still take the click away between mousedown
  // and mouseup. The id never changes for a given row, so this builds them
  // the first time and leaves them alone after that.
  function fillKill(cell, id) {
    if (cell.dataset.id === String(id)) return;
    cell.dataset.id = String(id);
    clear(cell);
    cell.append(
      h('button', { type: 'button', text: 'query', title: 'KILL QUERY ' + id, onclick: () => kill(id, true) }),
      h('button', { type: 'button', class: 'danger', text: 'conn', title: 'KILL ' + id, onclick: () => kill(id, false) }),
    );
  }

  // ---- tiles ---------------------------------------------------------

  function push(name, v) {
    let a = hist.get(name);
    if (!a) { a = []; hist.set(name, a); }
    a.push(v);
    if (a.length > HIST) a.shift();
    return a;
  }

  function drawTiles(s) {
    clear(tiles);

    const conn = s.threads || {};
    const usedPct = conn.max ? (100 * conn.connected) / conn.max : 0;
    push('connections', conn.connected);
    tiles.append(tile('connections', fmtNum(conn.connected)
      + (conn.max ? ' / ' + fmtNum(conn.max) : ''),
      hist.get('connections'), usedPct > 85 ? 'bad' : usedPct > 65 ? 'warn' : ''));

    push('running', conn.running);
    // Threads_running is the closest thing MySQL has to a CPU gauge: it is
    // how many connections are actually executing rather than waiting.
    tiles.append(tile('threads running', fmtNum(conn.running), hist.get('running'),
      conn.running > 20 ? 'bad' : conn.running > 8 ? 'warn' : '',
      'Connections executing right now. The nearest thing to a CPU reading '
      + 'MySQL offers: a number that climbs and stays up is a server falling behind.'));

    const q = (s.rates || []).find((r) => r.name === 'queries');
    if (q) {
      push('queries', q.per_sec);
      tiles.append(tile('queries/s', fmtPerSec(q.per_sec), hist.get('queries')));
    }

    const m = s.memory || {};
    if (m.hit_pct >= 0) {
      push('hit', m.hit_pct);
      tiles.append(tile('buffer pool hits', m.hit_pct.toFixed(2) + '%', hist.get('hit'),
        m.hit_pct < 95 ? 'bad' : m.hit_pct < 99 ? 'warn' : '',
        'Reads served from the buffer pool. Every miss is a read that went to disk.'));
    }

    // The counters that should sit still. Anything moving here is worth a
    // look even when the absolute number is small.
    const moving = h('div', { class: 'tile wide' }, h('div', { class: 'tile-label', text: 'watch' }));
    const grid = h('div', { class: 'counters' });
    for (const r of s.rates || []) {
      if (!r.warn) continue;
      const hot = r.per_sec > 0;
      grid.append(
        h('span', { class: 'cname' + (hot ? ' hot' : ''), text: r.name }),
        h('span', { class: 'cval' + (hot ? ' hot' : ''), text: hot ? '+' + fmtPerSec(r.per_sec) + '/s' : '—' }),
        h('span', { class: 'ctot', text: r.unit === 'B' ? fmtBytes(r.total) : fmtNum(r.total) }),
      );
    }
    moving.append(grid);
    tiles.append(moving);
  }

  function tile(label, value, series, level = '', why = '') {
    return h('div', { class: 'tile ' + level, title: why },
      h('div', { class: 'tile-label', text: label }),
      h('div', { class: 'tile-value', text: value }),
      spark(series),
    );
  }

  // ---- sections ------------------------------------------------------

  function drawWaits(s) {
    const list = s.waits || [];
    waits.setCount(list.length ? list.length + ' blocked' : '');
    waits.el.hidden = list.length === 0;
    waits.el.classList.toggle('bad', list.length > 0);
    if (!list.length) { waitRows.clear(); clear(waits.body); return; }

    sync(waits.body, list, (wt) => wt.kind + ':' + wt.waiting_thread + ':' + wt.blocking_thread,
      () => h('div', { class: 'gr wait' },
        h('div', { class: 'gc w-state' }), h('div', { class: 'gc w-state' }),
        h('div', { class: 'gc grow' }), h('div', { class: 'gc kill' })),
      (row, wt) => {
        const [kind, who, what, act] = row.children;
        kind.textContent = wt.kind === 'metadata'
          ? 'metadata lock' + (wt.object ? ' on ' + wt.object : '')
          : 'row lock';
        who.textContent = wt.blocking_thread
          ? wt.waiting_thread + ' ← blocked by ' + wt.blocking_thread
          : wt.waiting_thread + ' ← waiting (blocker unknown)';
        who.title = 'waiting ' + fmtSecs(wt.age);
        what.textContent = (wt.blocking_query || '(the blocker is idle in an open transaction)')
          .replace(/\s+/g, ' ');
        what.title = 'blocked statement: ' + (wt.waiting_query || '(unknown)')
          + '\n\nblocking statement: ' + (wt.blocking_query || '(idle — an open transaction that never committed)');
        // Only the blocker can be killed; the waiter is the victim.
        if (wt.blocking_thread) fillKill(act, wt.blocking_thread);
        else clear(act);
      }, waitRows);
  }

  function visible(s) {
    const q = filter.value.trim().toLowerCase();
    return (s.procs || []).filter((p) => {
      if (!sleepers.checked && p.command === 'Sleep') return false;
      if (!q) return true;
      return (p.user + ' ' + p.host + ' ' + p.db + ' ' + p.info + ' ' + p.state)
        .toLowerCase().includes(q);
    });
  }

  function drawProcs(s) {
    const list = visible(s);
    const total = (s.procs || []).length;
    procs.setCount(list.length === total ? fmtNum(total) : fmtNum(list.length) + ' of ' + fmtNum(total));

    sync(procs.body, list, (p) => p.id,
      () => h('div', { class: 'gr' },
        h('div', { class: 'gc w-id' }), h('div', { class: 'gc w-user' }),
        h('div', { class: 'gc w-db' }), h('div', { class: 'gc w-cmd' }),
        h('div', { class: 'gc w-time' }), h('div', { class: 'gc w-state' }),
        h('div', { class: 'gc grow' }), h('div', { class: 'gc kill' })),
      (row, p) => {
        const [id, user, db, cmd, time, state, info, act] = row.children;
        row.className = 'gr' + (p.self ? ' self' : '')
          + (p.command !== 'Sleep' && p.time > 30 ? ' slow' : '');
        id.textContent = p.id;
        user.textContent = p.user;
        user.title = p.user + '@' + p.host + (p.memory ? '\nmemory ' + fmtBytes(p.memory) : '');
        db.textContent = p.db;
        cmd.textContent = p.command;
        time.textContent = fmtSecs(p.time);
        state.textContent = p.state;
        info.textContent = p.progress > 0
          ? p.progress.toFixed(1) + '% · ' + (p.info || '').replace(/\s+/g, ' ')
          : (p.info || '').replace(/\s+/g, ' ');
        info.title = p.info || '';
        // Killing the dashboard's own poll would be a strange thing to
        // offer, and it comes back a tick later anyway.
        if (!p.self) fillKill(act, p.id);
        else clear(act);
      }, procRows);
  }

  function drawTrx(s) {
    const list = s.trx || [];
    trx.setCount(list.length ? fmtNum(list.length) : '');
    trx.el.hidden = list.length === 0;
    clear(trx.body);
    for (const t of list) {
      const stuck = t.wait_secs > 0 || /LOCK WAIT/i.test(t.state);
      trx.body.append(h('div', { class: 'gr' + (stuck ? ' slow' : '') },
        h('div', { class: 'gc w-id', text: String(t.thread || '—') }),
        h('div', { class: 'gc w-state', text: t.state }),
        h('div', { class: 'gc w-time', text: t.wait_secs ? 'waiting ' + fmtSecs(t.wait_secs) : t.started }),
        h('div', {
          class: 'gc w-rows',
          text: fmtNum(t.rows_locked) + ' locked',
          title: fmtNum(t.rows_modified) + ' rows modified · '
            + fmtNum(t.tables_locked) + ' tables locked · started ' + t.started,
        }),
        h('div', { class: 'gc grow', text: (t.query || '(idle in transaction)').replace(/\s+/g, ' ') }),
      ));
    }
  }

  function drawTop(s) {
    const list = s.top || [];
    top.el.hidden = list.length === 0;
    top.setCount(list.length ? 'by time since the last tick' : '');
    clear(top.body);
    for (const d of list) {
      top.body.append(h('div', { class: 'gr' + (d.delta_ms > 0 ? ' hot' : '') },
        h('div', { class: 'gc w-time', text: d.delta_ms > 0 ? '+' + fmtMs(Math.round(d.delta_ms)) : '—' }),
        h('div', { class: 'gc w-time', text: fmtNum(d.delta_count) }),
        h('div', {
          class: 'gc w-time' + (d.avg > 100 ? ' warn-text' : ''),
          text: fmtMs(Math.round(d.avg)),
          title: 'average over ' + fmtNum(d.count) + ' executions',
        }),
        h('div', {
          class: 'gc w-flags',
          text: [d.no_index ? 'no index' : '', d.tmp_disk ? 'tmp disk' : ''].filter(Boolean).join(' · '),
          title: fmtNum(d.rows_examined) + ' rows examined, ' + fmtNum(d.rows_sent) + ' sent',
        }),
        h('div', { class: 'gc grow', text: d.text, title: d.text }),
      ));
    }
  }

  function drawMemory(s) {
    const m = s.memory || {};
    clear(memory.body);
    memory.setCount(m.innodb_alloc ? fmtBytes(m.innodb_alloc) + ' in InnoDB' : '');

    const bar = (label, used, of, extra) => {
      const pct = of > 0 ? Math.min(100, (100 * used) / of) : 0;
      const fill = h('div', { class: 'bar-fill' });
      fill.style.width = pct.toFixed(1) + '%';
      return h('div', { class: 'memrow' },
        h('span', { class: 'memlabel', text: label }),
        h('div', { class: 'bar' }, fill),
        h('span', { class: 'memval', text: fmtBytes(used) + (of ? ' / ' + fmtBytes(of) : '') + (extra || '') }),
      );
    };

    if (m.buffer_pool) {
      memory.body.append(bar('buffer pool', m.buffer_pool_data, m.buffer_pool,
        m.buffer_pool_dirty ? ' · ' + fmtBytes(m.buffer_pool_dirty) + ' dirty' : ''));
    }
    if (m.threads) memory.body.append(bar('connections', m.threads, m.innodb_alloc || m.threads));
    for (const ev of m.events || []) {
      memory.body.append(bar(ev.name, ev.bytes, (m.events[0] || {}).bytes || ev.bytes));
    }
    memory.el.hidden = memory.body.children.length === 0;
  }

  function drawDeadlock(s) {
    const d = s.deadlock;
    deadlock.el.hidden = !d;
    if (!d) return;
    deadlock.setCount(d.at);
    clear(deadlock.body);
    deadlock.body.append(h('pre', { class: 'sql', text: d.text }));
  }

  function drawNotes(s) {
    clear(notes);
    for (const n of s.notes || []) {
      notes.append(h('div', { class: 'note', text: n }));
    }
  }

  // ---- the tick ------------------------------------------------------

  function draw(s) {
    if (s.error) {
      status.textContent = 'cannot read the server: ' + s.error;
      status.className = 'err-text';
      return;
    }
    status.className = '';
    version.textContent = s.version ? (s.hostname ? s.hostname + ' · ' : '') + s.version : '';
    uptime.textContent = s.uptime ? 'up ' + fmtSecs(s.uptime) : '';

    drawTiles(s);
    drawWaits(s);
    drawProcs(s);
    drawTrx(s);
    drawTop(s);
    drawMemory(s);
    drawDeadlock(s);
    drawNotes(s);

    status.textContent = 'updated ' + new Date(s.at).toLocaleTimeString()
      + ' · collected in ' + fmtMs(s.elapsed_ms)
      + (paused ? ' · PAUSED' : '');
  }

  function onSnap(s) {
    last = s;
    if (!paused) draw(s);
    else status.textContent = 'PAUSED — the view is frozen, the stream is still running';
  }

  // The stream reconnects on its own, the same way the status stream does:
  // a tunnel that dropped is usually back a moment later, and losing the
  // dashboard over it would throw away the history on screen.
  (async () => {
    for (;;) {
      try {
        await stream(dashPath(ctx.server), onSnap, signal);
      } catch (e) {
        if (aborted(e) || signal.aborted) return;
        status.textContent = 'stream lost, retrying — ' + e.message;
        status.className = 'err-text';
      }
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();

  return {
    kind: 'dash',
    ctx,
    reload: () => { if (last) draw(last); },
  };
}

// section builds a collapsible titled block.
function section(title, cls) {
  const count = h('span', { class: 'muted' });
  const body = h('div', { class: 'sec-body ' + cls });
  const el = h('section', { class: 'sec' },
    h('h3', {}, h('span', { text: title }), count),
    body,
  );
  el.hidden = true;
  return {
    el,
    body,
    setCount: (t) => { count.textContent = t; },
  };
}

// sync updates a keyed list in place.
//
// Rebuilding the whole list on every tick would replace the node under the
// cursor between mousedown and mouseup, and the Kill button would never
// fire. Keeping the element for a given id is what makes it clickable at
// all — the same lesson the sidebar learned about double-click.
function sync(container, items, keyOf, create, update, cache) {
  const seen = new Set();
  let prev = null;

  for (const item of items) {
    const key = String(keyOf(item));
    seen.add(key);
    let row = cache.get(key);
    if (!row) {
      row = create(item);
      cache.set(key, row);
    }
    update(row, item);
    // Keep the DOM in the order the server sent, without moving nodes that
    // are already where they belong.
    const want = prev ? prev.nextSibling : container.firstChild;
    if (row !== want) container.insertBefore(row, want);
    prev = row;
  }

  for (const [key, row] of cache) {
    if (seen.has(key)) continue;
    row.remove();
    cache.delete(key);
  }
}

// spark draws a sparkline. Flat lines are drawn flat rather than scaled up
// into noise: a quiet server should look quiet.
function spark(series) {
  const el = svg('svg', { class: 'spark', viewBox: '0 0 100 20', preserveAspectRatio: 'none' });
  if (!series || series.length < 2) return el;

  const max = Math.max(...series, 0);
  const step = 100 / (series.length - 1);
  const pts = series.map((v, i) => {
    const y = max > 0 ? 19 - (18 * v) / max : 19;
    return (i * step).toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  el.append(svg('polyline', { points: pts }));
  return el;
}
