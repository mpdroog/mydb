// servers.js - the add/edit server dialog.
//
// Passwords are never sent back down from the server, so an empty password
// field means "keep whatever is already in config.toml". Saving rewrites
// the file atomically on the Go side.

import { h, modal, field, toast } from './dom.js';
import { api } from './api.js';

export function addServer(onSaved) {
  form(null, onSaved);
}

export function editServer(entry, onSaved) {
  form(entry, onSaved);
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
