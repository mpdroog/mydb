// help.js - the keyboard overlay.
//
// It is built from the keymap's own registry, so a shortcut cannot be in
// the app and missing from this list. Bound to "?" because that is where
// every other tool put it.

import { h, modal } from './dom.js';
import { shortcuts, label } from './keymap.js';

export function openHelp() {
  const box = h('div', { class: 'keys' });

  for (const group of shortcuts()) {
    box.append(h('h3', { text: group.name }));
    const list = h('dl', {});
    for (const s of group.items) {
      list.append(
        h('dt', {}, h('kbd', { text: label(s.key) })),
        h('dd', { text: s.desc }),
      );
    }
    box.append(list);
  }

  const filter = h('input', {
    type: 'search',
    placeholder: 'Filter shortcuts…',
    spellcheck: false,
    autocomplete: 'off',
  });
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const dl of box.querySelectorAll('dl')) {
      let shown = 0;
      // dt and dd come in pairs, so they are hidden in pairs.
      for (let i = 0; i < dl.children.length; i += 2) {
        const dt = dl.children[i];
        const dd = dl.children[i + 1];
        const hit = !q || (dt.textContent + ' ' + dd.textContent).toLowerCase().includes(q);
        dt.hidden = !hit;
        dd.hidden = !hit;
        if (hit) shown++;
      }
      dl.previousElementSibling.hidden = shown === 0;
      dl.hidden = shown === 0;
    }
  });

  const body = h('div', { class: 'help' }, filter, box);
  const close = modal('Keyboard', body, [
    h('button', { type: 'button', text: 'Close', onclick: () => close() }),
  ]);
  filter.focus();
}
