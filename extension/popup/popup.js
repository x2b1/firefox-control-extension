'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);
const ask = (msg, isError) => {
  $('msg').textContent = msg || '';
  $('msg').style.color = isError ? '#ff8080' : '#8fd18f';
};
const askBg = (m) => api.runtime.sendMessage(m);

function render(state) {
  const dot = $('dot');
  dot.className = `dot ${state.connected ? 'on' : 'off'}`;
  $('state').textContent = state.connected
    ? `attached ${(state.clientId || '').slice(0, 6)}`
    : state.lastError || 'offline';
  $('stats').textContent = `${state.commands} cmds · ${state.events} events`;
  if (state.policy) {
    $('mode').textContent = state.policy.mode === 'allow-all' ? 'ALL DOMAINS' : 'locked';
    $('mode').style.color = state.policy.mode === 'allow-all' ? '#ffb454' : '';
    const box = $('chips');
    box.textContent = '';
    if (!state.policy.allow.length) {
      const e = document.createElement('span');
      e.className = 'empty';
      e.textContent = 'no domains enabled — bridge is inert';
      box.appendChild(e);
    }
    for (const host of state.policy.allow) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const b = document.createElement('b');
      b.textContent = host;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = `deny ${host}`;
      x.onclick = async () => {
        await askBg({ op: 'bridge.deny', host });
        refresh();
      };
      chip.append(b, x);
      box.appendChild(chip);
    }
  }
}

async function refresh() {
  const res = await askBg({ op: 'bridge.status' });
  if (res?.ok) render(res.state);
}

async function init() {
  const stored = await api.storage.local.get(['token', 'label']);
  $('token').value = stored.token || '';
  $('label').value = stored.label || '';
  refresh();

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  $('taburl').textContent = tab?.url ? new URL(tab.url).hostname : '—';
  api.tabs.onUpdated.addListener(refresh);

  // Surface page errors here: a silent bridge is the worst failure mode.
  api.runtime.onMessage.addListener((msg) => {
    if (msg.op === 'bridge.policy') refresh();
  });
}

$('toggle').onclick = () => {
  const i = $('token');
  i.type = i.type === 'password' ? 'text' : 'password';
};

$('connect').onclick = async () => {
  const token = $('token').value.trim();
  const label = $('label').value.trim() || 'firefox';
  if (token && !/^[a-f0-9]{64}$/i.test(token)) {
    return ask('token must be 64 hex characters (printed by the server)', true);
  }
  const res = await askBg({ op: 'bridge.configure', token, label });
  if (!res?.ok) return ask(res?.error || 'configure failed', true);
  ask(res.connected ? 'connected' : 'connecting…');
  setTimeout(refresh, 600);
};

$('allow').onclick = async () => {
  const host = $('domain').value.trim();
  if (!host) return ask('enter a hostname first', true);
  const res = await askBg({ op: 'bridge.allow', host });
  if (res?.ok) { $('domain').value = ''; ask(`${host} enabled`); }
  else ask(res?.error || 'failed', true);
  refresh();
};

$('lock').onclick = async () => {
  await askBg({ op: 'bridge.lock' });
  ask('all domains revoked — bridge is inert');
  refresh();
};

$('inpage').onclick = async () => {
  const res = await askBg({ op: 'bridge.probeActiveTab' });
  ask(res?.ok ? res.info : (res?.error || 'failed'), !res?.ok);
};

$('docs').onclick = (e) => {
  e.preventDefault();
  open('README.md');
};

init();
