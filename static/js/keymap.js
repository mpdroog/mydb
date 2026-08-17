// keymap.js - one keydown listener for the whole app.
//
// Every binding calls preventDefault, including the ones the browser wants
// for itself (Ctrl/Cmd+D is "bookmark page"). Bindings are skipped while a
// text field has focus unless they are explicitly marked inField.
//
// A binding also carries what it does and where it applies, and the help
// overlay is built from that registry rather than from a second list. A
// shortcut that is added without a description shows up in the overlay as
// undescribed instead of quietly not being there at all.

const MAC = navigator.platform.toUpperCase().includes('MAC');
const bindings = [];
const docs = [];

// combo normalises an event into "mod+shift+d".
//
// Everything is lower-cased, named keys included: ev.key hands back
// "Enter" and "Escape", so comparing them as-is meant every binding for a
// named key silently never fired.
function combo(ev) {
  const parts = [];
  if (MAC ? ev.metaKey : ev.ctrlKey) parts.push('mod');
  if (ev.altKey) parts.push('alt');
  if (ev.shiftKey) parts.push('shift');
  let key = ev.key;
  if (key === ' ') key = 'space';
  parts.push(key.toLowerCase());
  return parts.join('+');
}

function inTextField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// bind registers a shortcut. fn returning false lets the event through.
//
// desc and group are what the help overlay shows; they are optional so a
// binding added in a hurry still works, and the overlay says so.
export function bind(keys, fn, { inField = false, when, desc, group } = {}) {
  const list = [].concat(keys);
  for (const k of list) {
    bindings.push({ key: k.toLowerCase(), fn, inField, when });
  }
  doc(list[0], desc || '(undescribed)', group || 'Other');
}

// doc registers a shortcut that is handled somewhere else — the grid and
// the SQL editor own their own keydown listeners — so that the overlay is
// still the whole truth about the keyboard.
export function doc(key, desc, group = 'Other') {
  docs.push({ key, desc, group });
}

// shortcuts returns everything the overlay draws, grouped in the order the
// groups were first seen.
export function shortcuts() {
  const groups = new Map();
  for (const d of docs) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

export function start() {
  document.addEventListener('keydown', (ev) => {
    const key = combo(ev);
    const field = inTextField(ev.target);

    for (const b of bindings) {
      if (b.key !== key) continue;
      if (field && !b.inField) continue;
      if (b.when && !b.when()) continue;
      if (b.fn(ev) === false) continue;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
  });
}

// label renders a shortcut the way this platform writes it.
export function label(key) {
  return key
    .replace('mod', MAC ? '⌘' : 'Ctrl')
    .replace('shift', MAC ? '⇧' : 'Shift')
    .replace('alt', MAC ? '⌥' : 'Alt')
    .split('+')
    .map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('+');
}
