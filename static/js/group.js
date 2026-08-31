// group.js - fold a table list on its shared prefixes.
//
// This is erm/group.go's byPrefix, ported. Not re-invented: the diagram and
// the tree must never disagree about what belongs together, and the only
// way to guarantee that is for both to apply the same rule.
//
//   prefixOf   the part before the first underscore, at least two
//              characters, so v_open_orders is not a "v" group
//   minGroup   how many tables must share a prefix before it means
//              anything, matching erm.minPrefixGroup

const MIN_GROUP = 2;

export function prefixOf(name) {
  const i = name.indexOf('_');
  return i < 2 ? '' : name.slice(0, i).toLowerCase();
}

// byPrefix returns entries for a tree: groups and loose tables, sorted into
// one alphabet so the eye still runs straight down the list rather than
// hitting a folders-then-files split.
export function byPrefix(tables) {
  const buckets = new Map();
  const loose = [];

  for (const t of tables) {
    const p = prefixOf(t.name);
    if (!p) { loose.push(t); continue; }
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p).push(t);
  }

  const entries = [];
  for (const [prefix, members] of buckets) {
    if (members.length < MIN_GROUP) { loose.push(...members); continue; }
    members.sort((a, b) => a.name.localeCompare(b.name));
    entries.push({ group: true, key: prefix, tables: members });
  }
  for (const t of loose) entries.push({ group: false, key: t.name, table: t });

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}
