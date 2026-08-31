// state.js - the shared store plus the job runner.
//
// The runner is what keeps clicks instant: submit returns a job id right
// away, the result arrives over SSE, and every step is tied to an
// AbortController so closing a tab cancels the query on the server too.

import { api, stream, aborted } from './api.js';

function emitter() {
  const subs = new Set();
  return {
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(v) { for (const fn of [...subs]) fn(v); },
  };
}

export const servers = new Map();      // name -> {server, status}
export const onServers = emitter();
export const onStatus = emitter();

export function setServers(list) {
  servers.clear();
  for (const s of list) servers.set(s.name, s);
  onServers.emit([...servers.values()]);
}

export function applyStatus(st) {
  const s = servers.get(st.name);
  if (!s) return;
  s.status = st;
  onStatus.emit(st);
}

export function statusOf(name) {
  return servers.get(name)?.status?.state || 'offline';
}

// isProduction says whether this server is the kind where a mistake is
// expensive. It drives the red chrome and the harder confirmation.
export function isProduction(name) {
  return !!servers.get(name)?.production;
}

// watchStatus keeps the sidebar dots live, reconnecting if the stream drops.
export async function watchStatus(signal) {
  for (;;) {
    try {
      await stream('/status/events', applyStatus, signal);
    } catch (e) {
      if (aborted(e) || signal.aborted) return;
      console.warn('mydb: status stream lost', e);
    }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// abort builds the error a cancelled dialog throws, shaped so that every
// caller's existing `if (aborted(e)) return` treats it as a non-event.
function abort() {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}

// runJob submits a statement and follows it to completion.
//
// onState fires for every transition so the UI can paint "running 2.1s"
// with a cancel button and never sit on a blank screen. The returned
// object exposes cancel(), which issues a real KILL QUERY server-side.
//
// onConfirm is asked when the server holds a statement back for being
// destructive — an UPDATE or DELETE with no WHERE, a TRUNCATE, a DROP.
// Answering yes resubmits the identical statement with the confirmation
// attached; answering no aborts. A caller that passes no onConfirm gets
// the refusal as an error, which is the right default: nothing runs
// unasked just because a code path forgot to handle the question.
export function runJob(request, { onState, signal, onConfirm } = {}) {
  const ctl = new AbortController();
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

  let id = null;
  let cancelled = false;
  let finished = false;
  // A schema change outlives its tab. Killing a table rebuild half-way
  // through throws away the work and then makes you wait for the rollback,
  // so closing the tab by accident must not do that. A SELECT has nothing
  // to lose and is cancelled as before.
  const detach = request.kind === 'ddl';

  async function submit() {
    try {
      return await api.submit(request, ctl.signal);
    } catch (e) {
      const risk = e?.data?.confirm;
      if (!risk || !onConfirm) throw e;
      if (!await onConfirm(risk)) throw abort();
      return api.submit({ ...request, confirm: true }, ctl.signal);
    }
  }

  const done = (async () => {
    const snap = await submit();
    id = snap.job;
    onState?.(snap);

    let last = snap;
    await stream('/jobs/' + encodeURIComponent(id) + '/events', (ev) => {
      last = { ...last, ...ev };
      onState?.(last);
    }, ctl.signal);

    // The event only carries counters; fetch the rows themselves.
    const full = await api.job(id, ctl.signal);
    onState?.(full);
    if (full.state === 'error') throw new Error(full.error || 'query failed');
    return full;
  })();
  // A job that already ran to the end has nothing left to cancel, and
  // asking anyway is what made closing a tab log "no such job" on the
  // server: the DELETE that follows can land first and drop it.
  done.then(() => { finished = true; }, () => { finished = true; });

  return {
    get id() { return id; },
    promise: done,
    async cancel() {
      cancelled = true;
      if (id && !finished) {
        try {
          await api.cancel(id);
        } catch (e) {
          if (!aborted(e)) console.warn('mydb: cancel failed', e);
        }
      } else {
        ctl.abort();
      }
    },
    // dispose stops watching and tells the server to drop the buffered
    // result, used when a tab closes. The server keeps any job that is
    // still running, so a detached schema change stays observable.
    async dispose() {
      ctl.abort();
      if (!id) return;
      // Cancel before forgetting, or the two race and the KILL arrives for
      // a job the server has already dropped.
      if (!cancelled && !finished && !detach) await api.cancel(id).catch(() => {});
      api.forget(id);
    },
  };
}
