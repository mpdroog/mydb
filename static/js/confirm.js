// confirm.js - the dialog a destructive statement raises.
//
// The server decides what is destructive, not this file: an UPDATE or
// DELETE with no WHERE of its own, a TRUNCATE, a DROP of a table or a
// database. mydb refuses it, says why, and this turns that refusal into a
// question. Nothing here can bypass the gate — answering yes resubmits the
// same statement with the confirmation attached, and the server checks it
// again.
//
// On a server marked production the button is not enough. You type the
// server's name, which is the difference between a reflex and a decision.

import { h, modal, fmtNum } from './dom.js';
import { runJob, isProduction } from './state.js';
import { aborted } from './api.js';

export function askConfirm(risk, { server, db, sql }) {
  return new Promise((resolve) => {
    const prod = isProduction(server);
    const target = risk.target || 'this table';

    const count = h('span', { class: 'muted', text: '' });
    const countBtn = h('button', {
      type: 'button',
      text: 'Count the rows first',
      title: risk.count_sql || '',
    });

    let counting = false;
    countBtn.addEventListener('click', async () => {
      if (counting) return;
      counting = true;
      countBtn.disabled = true;
      count.textContent = 'counting…';
      try {
        const res = await runJob(
          { server, db, sql: risk.count_sql, kind: 'meta', limit: 1 },
        ).promise;
        const n = res.result?.rows?.[0]?.[0];
        count.textContent = n === null || n === undefined
          ? 'the table could not be counted'
          : fmtNum(n) + ' rows are about to be affected';
        count.className = 'warn-text';
      } catch (e) {
        counting = false;
        countBtn.disabled = false;
        count.textContent = aborted(e) ? '' : 'count failed: ' + e.message;
      }
    });

    const run = h('button', { type: 'button', class: 'danger', text: 'Run it anyway' });
    const typed = h('input', {
      type: 'text',
      placeholder: server,
      spellcheck: false,
      autocomplete: 'off',
    });

    // The gate on production: the button stays dead until the name matches.
    if (prod) {
      run.disabled = true;
      typed.addEventListener('input', () => {
        run.disabled = typed.value.trim() !== server;
      });
      typed.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !run.disabled) { ev.preventDefault(); run.click(); }
      });
    }

    const body = h('div', { class: 'confirm' },
      h('p', { class: 'confirm-lead' },
        h('strong', { text: risk.verb }),
        ' on ',
        h('code', { text: target }),
        ' — ',
        risk.reason,
      ),
      h('pre', { class: 'sql', text: sql }),
      risk.countable && risk.count_sql
        ? h('div', { class: 'confirm-count' }, countBtn, count)
        : null,
      prod
        ? h('div', { class: 'confirm-prod' },
          h('p', {
            class: 'note',
            text: server + ' is marked production. Type its name to confirm.',
          }),
          typed,
        )
        : null,
    );

    let answered = false;
    const finish = (ok) => {
      if (answered) return;
      answered = true;
      close();
      resolve(ok);
    };

    const cancel = h('button', { type: 'button', text: 'Cancel', onclick: () => finish(false) });
    const close = modal(
      prod ? '⚠ Production — ' + server : 'Confirm ' + risk.verb,
      body,
      [cancel, run],
    );
    run.addEventListener('click', () => finish(true));

    // Escape and the backdrop close the dialog through modal() itself,
    // which does not go through finish(). Watching for the card leaving
    // the DOM is what keeps the promise from hanging in that case.
    const host = document.getElementById('modal');
    const watch = new MutationObserver(() => {
      if (host.hidden) { watch.disconnect(); finish(false); }
    });
    watch.observe(host, { attributes: true, attributeFilter: ['hidden'] });

    // Never the danger button: it must not be one Enter away.
    (prod ? typed : cancel).focus();
  });
}
