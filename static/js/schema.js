// schema.js - what the console knows about the database it is typing at.
//
// Completion has to answer instantly, so nothing here ever waits: a lookup
// returns whatever is cached and starts a fetch for what is not. The next
// keystroke has more to work with than the last, which is the right
// trade-off for a list of suggestions.

import { api } from './api.js';

const tableCache = new Map();   // "srv/db"        -> [{name, type}]
const columnCache = new Map();  // "srv/db/table"  -> [{name, type, key}]
const inflight = new Set();

const dbKey = (server, db) => server + '/' + db;
const tblKey = (server, db, table) => server + '/' + db + '/' + table;

// tables returns the cached table list, starting a fetch when there is none.
export function tables(server, db) {
  if (!server || !db) return [];
  const key = dbKey(server, db);
  const hit = tableCache.get(key);
  if (hit) return hit;
  fetchOnce(key, async () => {
    tableCache.set(key, await api.tables(server, db));
  });
  return [];
}

// columns returns the cached column list for one table, fetching in the
// background when it is not there yet.
export function columns(server, db, table) {
  if (!server || !db || !table) return [];
  const key = tblKey(server, db, table);
  const hit = columnCache.get(key);
  if (hit) return hit;
  fetchOnce(key, async () => {
    const s = await api.structure(server, db, table);
    columnCache.set(key, (s.columns || []).map((c) => ({
      name: c.name,
      type: c.type,
      pk: (s.primary_key || []).includes(c.name),
    })));
  });
  return [];
}

// warm pulls in the columns of the tables a statement mentions, so that by
// the time the cursor reaches one of them the list is already there.
export function warm(server, db, names) {
  for (const n of names) columns(server, db, n);
}

// fetchOnce runs a loader once per key, swallowing failures: a completion
// list that could not be filled is an empty list, never an error toast.
function fetchOnce(key, load) {
  if (inflight.has(key)) return;
  inflight.add(key);
  load()
    .catch(() => {})
    .finally(() => inflight.delete(key));
}
