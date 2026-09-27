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

  // Anchor to the button, then keep the whole menu on screen. A sidebar
  // is near the left edge on a desktop and near the right one on a narrow
  // device, and a menu that opens past the edge is a menu you cannot use.
  menu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(box.left, window.innerWidth - size.width - pad));
  const below = box.bottom + 4;
  const top = below + size.height + pad > window.innerHeight
    ? Math.max(pad, box.top - size.height - 4)   // flip above rather than run off the bottom
    : below;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

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
  // A socket is an alternative address, not an extra one, so it is a mode
  // rather than a field: host/port and the tunnel are meaningless while it
  // is on, and a form that still showed them would be asking for a
  // combination the server refuses.
  const useSock = h('input', { type: 'checkbox', checked: !!s.socket });
  const sock = h('input', {
    type: 'text',
    value: s.socket || '',
    placeholder: '/run/mysqld/mysqld.sock',
  });
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

  const hostRow = field('MySQL host', host);
  const portRow = field('Port', port);
  const sockRow = field('Socket path', sock);
  const tunnelRow = field('Via SSH tunnel', useSSH);
  const hostNote = h('p', {
    class: 'note',
    text: 'With SSH on, the host is resolved from the SSH server (usually 127.0.0.1).',
  });
  const sockNote = h('p', {
    class: 'note',
    text: 'For a MySQL on this machine that listens on a socket instead of a port '
      + '(skip-networking). No tunnel and no TLS: the connection never leaves the box.',
  });

  // One switch drives which half of the dialog is real.
  const mode = () => {
    const on = useSock.checked;
    hostRow.hidden = on;
    portRow.hidden = on;
    hostNote.hidden = on;
    sockRow.hidden = !on;
    sockNote.hidden = !on;
    tunnelRow.hidden = on;
    sshBox.hidden = on || !useSSH.checked;
  };
  useSock.addEventListener('change', mode);
  useSSH.addEventListener('change', mode);

  const body = h('div', {},
    field('Name', name),
    field('Unix socket', useSock),
    hostRow,
    portRow,
    sockRow,
    sockNote,
    field('MySQL user', user),
    field('MySQL password', pass),
    hostNote,
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
    tunnelRow,
    sshBox,
  );
  mode();

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
    const onSock = useSock.checked;
    const payload = {
      name: name.value.trim(),
      // Exactly one address goes to the server. Sending the leftovers of
      // the half that is hidden would be rejected, and rightly so.
      host: onSock ? '' : host.value.trim(),
      port: onSock ? 0 : Number(port.value) || 3306,
      socket: onSock ? sock.value.trim() : '',
      user: user.value.trim(),
      pass: pass.value,
      colour,
      production: production.checked,
      ssh: !onSock && useSSH.checked ? {
        host: sshHost.value.trim(),
        user: sshUser.value.trim(),
        agent: sshAgent.checked,
        key: sshKey.value.trim(),
        passphrase: sshPassphrase.value,
        pass: sshPass.value,
      } : null,
    };
    if (!payload.name || !(payload.host || payload.socket)) {
      toast(onSock ? 'Name and socket path are required' : 'Name and host are required', 'err');
      return;
    }

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
