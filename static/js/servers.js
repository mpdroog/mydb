// servers.js - the add/edit server dialog.
//
// Passwords are never sent back down from the server, so an empty password
// field means "keep whatever is already in config.toml". Saving rewrites
// the file atomically on the Go side.

import { h, $, modal, field, toast } from './dom.js';
import { api } from './api.js';
import { servers } from './state.js';
import { colourNames, paint } from './colour.js';

export function addServer(onSaved) {
  form(null, onSaved);
}

export function editServer(entry, onSaved) {
  form(typeof entry === 'string' ? servers.get(entry) : entry, onSaved);
}

// serverMenu is everything about one server, hung off the server itself.
// There is no rail any more, and these are not places to go: they are
// things to open, scoped to the connection you opened them from. "the
// query log for prod-eu-1" is a better answer than a global page.
export function serverMenu(s, anchor, actions) {
  const menu = $('#menu');
  menu.textContent = '';
  paint(menu, s.colour);

  menu.append(h('div', { class: 'who' },
    h('span', { class: 'swatch' }), s.name));

  const item = (label, fn, cls) => h('button', {
    type: 'button', class: cls || '', text: label,
    onclick: () => { hide(); fn?.(s.name); },
  });

  menu.append(
    item('Server health', actions.health),
    item('Query log', actions.log),
    item('Schema diagram', actions.schema),
    item('New SQL console', actions.console),
    h('div', { class: 'sep' }),
    item('Edit connection…', () => actions.edit(s.name)),
    h('div', { class: 'sep' }),
    item('Disconnect', async (name) => {
      try { await api.disconnect(name); } catch (e) { toast(e.message, 'err'); }
    }, 'danger'),
  );

  const box = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = box.left + 'px';
  menu.style.top = (box.bottom + 4) + 'px';

  const hide = () => {
    menu.hidden = true;
    document.removeEventListener('click', away, true);
    document.removeEventListener('keydown', esc, true);
  };
  const away = (ev) => { if (!menu.contains(ev.target)) hide(); };
  const esc = (ev) => { if (ev.key === 'Escape') hide(); };
  setTimeout(() => {
    document.addEventListener('click', away, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
}

function form(entry, onSaved) {
  const isNew = !entry;
  const s = entry || { name: '', host: '127.0.0.1', port: 3306, user: 'root', ssh: null };

  const name = h('input', { type: 'text', value: s.name, placeholder: 'prod-eu' });
  const host = h('input', { type: 'text', value: s.host, placeholder: '127.0.0.1' });
  const port = h('input', { type: 'number', value: s.port || 3306, min: 1, max: 65535 });
  const user = h('input', { type: 'text', value: s.user || '' });
  const pass = h('input', {
    type: 'password',
    placeholder: s.has_pass ? '(unchanged)' : '',
    autocomplete: 'new-password',
  });

  const production = h('input', { type: 'checkbox', checked: !!s.production });

  // The identity colour. Swatches rather than a dropdown of words: the
  // thing being chosen is a colour, and the six are far enough apart that
  // naming them adds nothing.
  let colour = s.colour_explicit ? s.colour : '';
  const hues = h('div', { class: 'hues' },
    ...colourNames.map((n) => h('button', {
      type: 'button',
      class: 'hue srv-' + n,
      title: n,
      'aria-label': 'Identity colour ' + n,
      'aria-pressed': String(n === (colour || s.colour)),
      onclick: (ev) => {
        colour = n;
        for (const b of hues.children) b.setAttribute('aria-pressed', String(b === ev.currentTarget));
      },
    })));
  const useSSH = h('input', { type: 'checkbox', checked: !!s.ssh });
  const sshHost = h('input', { type: 'text', value: s.ssh?.host || '', placeholder: 'bastion.example.com:22' });
  const sshUser = h('input', { type: 'text', value: s.ssh?.user || '' });
  const sshAgent = h('input', { type: 'checkbox', checked: s.ssh ? s.ssh.agent : true });
  const sshKey = h('input', { type: 'text', value: s.ssh?.key || '', placeholder: '~/.ssh/id_ed25519' });
  const sshPassphrase = h('input', {
    type: 'password',
    placeholder: s.ssh?.has_passphrase ? '(unchanged)' : '',
    autocomplete: 'new-password',
  });
  const sshPass = h('input', {
    type: 'password',
    placeholder: s.ssh?.has_pass ? '(unchanged)' : '',
    autocomplete: 'new-password',
  });

  const sshBox = h('div', {},
    field('SSH host', sshHost),
    field('SSH user', sshUser),
    field('Use ssh-agent', sshAgent),
    field('Key file', sshKey),
    field('Key passphrase', sshPassphrase),
    field('SSH password', sshPass),
    h('p', {
      class: 'note',
      text: 'The host key must already be in ~/.ssh/known_hosts — mydb will not '
        + 'trust an unknown one. Run `ssh <host>` once first.',
    }),
  );
  sshBox.hidden = !useSSH.checked;
  useSSH.addEventListener('change', () => { sshBox.hidden = !useSSH.checked; });

  const body = h('div', {},
    field('Name', name),
    field('MySQL host', host),
    field('Port', port),
    field('MySQL user', user),
    field('MySQL password', pass),
    h('p', { class: 'note', text: 'With SSH on, the host is resolved from the SSH server (usually 127.0.0.1).' }),
    field('Colour', hues),
    h('p', {
      class: 'note',
      text: 'What this server wears everywhere it appears: its row in the tree, '
        + 'every chip that belongs to it, and the top edge of the window. Leave '
        + 'it and mydb derives one from the name.',
    }),
    field('Production', production),
    h('p', {
      class: 'note',
      text: 'A production server is drawn in red everywhere it appears, and a '
        + 'statement that changes data without a WHERE asks you to type the '
        + 'server\'s name rather than click a button.',
    }),
    field('Via SSH tunnel', useSSH),
    sshBox,
  );

  const save = h('button', { type: 'button', text: isNew ? 'Add' : 'Save' });
  const foot = [h('button', { type: 'button', text: 'Cancel', onclick: () => close() })];

  if (!isNew) {
    foot.unshift(h('button', {
      type: 'button', class: 'danger', text: 'Delete',
      onclick: async () => {
        if (!confirm('Remove ' + s.name + ' from config.toml?')) return;
        try {
          await api.deleteServer(s.name);
          close();
          toast('Removed ' + s.name, 'ok');
          onSaved?.();
      document.dispatchEvent(new CustomEvent('mydb:servers-changed'));
        } catch (e) { toast(e.message, 'err'); }
      },
    }));
  }
  foot.push(save);

  const close = modal(isNew ? 'Add server' : 'Edit ' + s.name, body, foot);

  save.addEventListener('click', async () => {
    const payload = {
      name: name.value.trim(),
      host: host.value.trim(),
      port: Number(port.value) || 3306,
      user: user.value.trim(),
      pass: pass.value,
      colour,
      production: production.checked,
      ssh: useSSH.checked ? {
        host: sshHost.value.trim(),
        user: sshUser.value.trim(),
        agent: sshAgent.checked,
        key: sshKey.value.trim(),
        passphrase: sshPassphrase.value,
        pass: sshPass.value,
      } : null,
    };
    if (!payload.name || !payload.host) { toast('Name and host are required', 'err'); return; }

    save.disabled = true;
    try {
      if (isNew) await api.addServer(payload);
      else await api.updateServer(s.name, payload);
      close();
      toast('Saved to config.toml', 'ok');
      onSaved?.();
      document.dispatchEvent(new CustomEvent('mydb:servers-changed'));
    } catch (e) {
      save.disabled = false;
      toast(e.message, 'err');
    }
  });
}
