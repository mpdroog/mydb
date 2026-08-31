// querylog.js - everything mydb has run, searchable.
//
// The log lives on the Go side in a file next to config.toml, not in
// localStorage, so it survives a different browser, a restart and a
// cleared cache — and so that "what did I run against prod last week" has
// an answer at all. Clicking an entry opens it in a console; it is never
// re-run from here.

import { h, clear, toast, fmtNum, fmtMs } from './dom.js';
import { api, aborted } from './api.js';
import { servers, isProduction } from './state.js';
import * as tabs from './tabs.js';

export function openQueryLog(prefill) {
  return tabs.open({
    key: 'qlog',
    title: 'Query log',
    server: prefill?.server,
    build: (pane, signal) => build(pane, signal, prefill || {}),
  });
}

function build(pane, signal, prefill) {
  pane.classList.add('qlog');

  const search = h('input', {
    type: 'search', class: 'where', spellcheck: false, autocomplete: 'off',
    value: prefill.q || '',
    placeholder: 'search every statement mydb has run   (Enter to search)',
  });
  const srvSel = h('select', {}, h('option', { value: '', text: 'every server' }));
  for (const s of servers.keys()) {
    srvSel.append(h('option', { value: s, text: s, selected: s === prefill.server }));
  }
  const failed = h('input', { type: 'checkbox' });
  const refresh = h('button', { type: 'button', text: 'Refresh' });

  const head = h('div', { class: 'pane-head' },
    search, srvSel,
    h('label', { title: 'Only statements that failed or were cancelled' }, failed, 'failures only'),
    refresh,
  );

  const list = h('div', { class: 'qlog-list' });
  const status = h('span', { text: 'loading…' });
  const where = h('span', { class: 'mono muted' });
  const foot = h('div', { class: 'pane-foot' }, status, h('span', { class: 'grow' }), where);

  pane.append(head, list, foot);

  async function load() {
    status.textContent = 'searching…';
    try {
      const res = await api.qlog({
        q: search.value.trim(),
        server: srvSel.value,
        failed: failed.checked ? '1' : '',
        limit: 500,
      }, signal);
      where.textContent = res.path || '';
      render(res.entries || []);
    } catch (e) {
      if (aborted(e)) return;
      status.textContent = 'failed';
      clear(list);
      list.append(h('div', { class: 'note', text: e.message }));
    }
  }

  function render(entries) {
    clear(list);
    status.textContent = entries.length
      ? fmtNum(entries.length) + ' statement' + (entries.length === 1 ? '' : 's') + ', newest first'
      : 'nothing matched';

    for (const e of entries) {
      const when = new Date(e.at);
      const meta = [
        e.server + (e.db ? ' · ' + e.db : ''),
        e.kind,
        fmtMs(e.ms),
        e.rows ? fmtNum(e.rows) + ' rows' : '',
        e.affected ? fmtNum(e.affected) + ' affected' : '',
      ].filter(Boolean).join(' · ');

      const entry = h('div', { class: 'qentry ' + (e.state === 'done' ? '' : 'bad') },
        h('div', { class: 'qhead' },
          h('span', { class: 'qtime', text: when.toLocaleString(), title: when.toISOString() }),
          e.production ? h('span', { class: 'prod-badge', text: 'PROD' }) : null,
          h('span', { class: 'muted', text: meta }),
          e.state === 'done' ? null : h('span', { class: 'qstate', text: e.state }),
          h('span', { class: 'grow' }),
          h('button', {
            type: 'button', text: 'Copy', title: 'Copy the statement',
            onclick: () => navigator.clipboard?.writeText(e.sql)
              .then(() => toast('Copied', 'ok'))
              .catch(() => toast('Could not copy to clipboard', 'err')),
          }),
          h('button', {
            type: 'button', text: 'Open',
            title: 'Open this statement in a console — it is not run',
            onclick: () => open(e),
          }),
        ),
        h('pre', { class: 'sql', text: e.sql }),
        e.error ? h('div', { class: 'qerr', text: e.error }) : null,
      );
      list.append(entry);
    }
  }

  // Imported lazily: console.js opens grids, which pulls in a good deal of
  // the app, and the log is useful without any of it until you click.
  async function open(entry) {
    const { openConsole } = await import('./console.js');
    openConsole(entry.server, entry.db, entry.sql);
    if (isProduction(entry.server)) {
      toast(entry.server + ' is production — the statement was loaded, not run');
    }
  }

  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); load(); }
  });
  srvSel.addEventListener('change', load);
  failed.addEventListener('change', load);
  refresh.addEventListener('click', load);

  load();
  search.focus();

  return { kind: 'qlog', ctx: {}, reload: load, onShow: () => search.focus() };
}
