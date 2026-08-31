// api.js - every call to the Go side.
//
// Two rules hold the non-blocking promise together:
//  1. every request carries an AbortSignal, so closing a tab or switching
//     tables really does stop the work instead of leaving it in flight;
//  2. SSE is read through fetch() rather than EventSource, because
//     EventSource cannot set the X-Mydb header the server demands.

const BASE = '/api/v1';

const HEAD = {
  'X-Mydb': '1',
  'Content-Type': 'application/json',
};

// ApiError carries the status and, when the server answered with JSON, the
// object it sent. The confirm gate uses that: a statement held back for
// confirmation comes back as 409 with the risk attached, which is a
// question to put in a dialog rather than an error to toast.
export class ApiError extends Error {
  constructor(status, body) {
    let msg = body || ('HTTP ' + status);
    let data = null;
    if (body && body.startsWith('{')) {
      try {
        data = JSON.parse(body);
        if (data.error) msg = data.error;
      } catch { /* a plain-text body that happened to start with a brace */ }
    }
    super(msg);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function aborted(e) {
  return e && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

async function req(method, path, body, signal) {
  const res = await fetch(BASE + path, {
    method,
    headers: HEAD,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text.trim());
  return text ? JSON.parse(text) : null;
}

const qs = (o) => new URLSearchParams(
  Object.entries(o).filter(([, v]) => v !== undefined && v !== ''),
).toString();

export const api = {
  servers: (signal) => req('GET', '/servers', undefined, signal),
  addServer: (s, signal) => req('POST', '/servers', s, signal),
  updateServer: (name, s, signal) => req('PUT', '/servers/' + encodeURIComponent(name), s, signal),
  deleteServer: (name, signal) => req('DELETE', '/servers/' + encodeURIComponent(name), undefined, signal),
  connect: (name, signal) => req('POST', '/servers/' + encodeURIComponent(name) + '/connect', undefined, signal),
  disconnect: (name, signal) => req('POST', '/servers/' + encodeURIComponent(name) + '/disconnect', undefined, signal),

  databases: (server, signal) => req('GET', '/databases?' + qs({ server }), undefined, signal),
  tables: (server, db, signal) => req('GET', '/tables?' + qs({ server, db }), undefined, signal),
  erm: (server, db, signal) => req('GET', '/erm?' + qs({ server, db }), undefined, signal),
  addLink: (l, signal) => req('POST', '/links', l, signal),
  deleteLink: (l, signal) => req('DELETE', '/links', l, signal),
  structure: (server, db, table, signal) => req('GET', '/structure?' + qs({ server, db, table }), undefined, signal),

  submit: (r, signal) => req('POST', '/query', r, signal),
  job: (id, signal) => req('GET', '/jobs/' + encodeURIComponent(id), undefined, signal),
  cancel: (id, signal) => req('POST', '/jobs/' + encodeURIComponent(id) + '/cancel', undefined, signal),
  forget: (id) => req('DELETE', '/jobs/' + encodeURIComponent(id)).catch(() => {}),

  alter: (r, signal) => req('POST', '/alter', r, signal),
  updateRow: (r, signal) => req('PATCH', '/row', r, signal),
  insertRow: (r, signal) => req('POST', '/row', r, signal),

  kill: (r, signal) => req('POST', '/kill', r, signal),
  split: (sql, signal) => req('POST', '/split', { sql }, signal),
  qlog: (f, signal) => req('GET', '/qlog?' + qs(f), undefined, signal),
};

// dashPath is the SSE endpoint one server's dashboard reads.
export const dashPath = (server) => '/dashboard/events?' + qs({ server });

// stream reads an SSE endpoint, calling onEvent for each message. It
// resolves when the server closes the stream and rejects on abort, so a
// caller can just await it in a try/catch.
export async function stream(path, onEvent, signal) {
  const res = await fetch(BASE + path, {
    headers: { 'X-Mydb': '1' },
    signal,
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, (await res.text()).trim());

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });

      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue; // ": ping" and friends
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch (e) {
            console.warn('mydb: bad SSE payload', e);
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
