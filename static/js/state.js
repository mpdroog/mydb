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

// runJob submits a statement and follows it to completion.
//
// onState fires for every transition so the UI can paint "running 2.1s"
// with a cancel button and never sit on a blank screen. The returned
// object exposes cancel(), which issues a real KILL QUERY server-side.
export function runJob(request, { onState, signal } = {}) {
  const ctl = new AbortController();
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

  let id = null;
  let cancelled = false;
  // A schema change outlives its tab. Killing a table rebuild half-way
  // through throws away the work and then makes you wait for the rollback,
  // so closing the tab by accident must not do that. A SELECT has nothing
  // to lose and is cancelled as before.
  const detach = request.kind === 'ddl';

  const done = (async () => {
    const snap = await api.submit(request, ctl.signal);
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

  return {
    get id() { return id; },
    promise: done,
    async cancel() {
      cancelled = true;
      if (id) {
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
    dispose() {
      ctl.abort();
      if (id && !cancelled && !detach) api.cancel(id).catch(() => {});
      if (id) api.forget(id);
    },
  };
}
