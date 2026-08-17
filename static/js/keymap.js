// keymap.js - one keydown listener for the whole app.
//
// Every binding calls preventDefault, including the ones the browser wants
// for itself (Ctrl/Cmd+D is "bookmark page"). Bindings are skipped while a
// text field has focus unless they are explicitly marked inField.

const MAC = navigator.platform.toUpperCase().includes('MAC');
const bindings = [];

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
export function bind(keys, fn, { inField = false, when } = {}) {
  for (const k of [].concat(keys)) {
    bindings.push({ key: k.toLowerCase(), fn, inField, when });
  }
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
  return key.replace('mod', MAC ? '⌘' : 'Ctrl').replace(/\+/g, '+');
}
