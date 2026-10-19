// VPNMaster renderer: saved VPNs, the servers of the company's Cisco profile, the
// connection status, and connecting (with the questions Cisco asks along the way).
// All privileged work goes through window.api (see src/main/preload.js).

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

async function call(promise) {
  const r = await promise;
  if (!r.ok) {
    const e = new Error(r.message);
    e.code = r.code;
    throw e;
  }
  return r.data;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}

// ===========================================================================
// Prompt / confirm dialogs
// ===========================================================================

let dialogResolve = null;
let dialogQueue = Promise.resolve();

// One dialog at a time: a dialog opened while another is showing (e.g. a "Cisco was
// updated" notice during "Switch VPN?") waits its turn instead of cancelling it.
function openDialog(opts) {
  const shown = dialogQueue.then(() => showDialog(opts));
  dialogQueue = shown.catch(() => {});
  return shown;
}

// message: string or DOM node. check: label of an optional checkbox (result.checked).
function showDialog({ title, message = '', input = false, type = 'text', value = '', placeholder = '', okText = 'OK', okClass = 'primary', check = '', cancelText = 'Cancel' }) {
  const modal = $('#dialog-modal');
  const inp = $('#dialog-input');
  $('#dialog-title').textContent = title;
  const msg = $('#dialog-message');
  msg.replaceChildren(typeof message === 'string' ? document.createTextNode(message) : message);
  msg.hidden = !message;
  inp.hidden = !input;
  inp.type = type;
  inp.value = value;
  inp.placeholder = placeholder;
  $('#dialog-check-row').classList.toggle('hidden', !check);
  $('#dialog-check').checked = false;
  $('#dialog-check-label').textContent = check;
  const ok = $('#dialog-ok');
  ok.textContent = okText;
  ok.className = `btn ${okClass}`;
  $('#dialog-cancel').textContent = cancelText;
  $('#dialog-cancel').hidden = !cancelText;
  modal.classList.remove('hidden');
  setTimeout(() => (input ? inp.focus() : ok.focus()), 0);
  return new Promise((resolve) => {
    dialogResolve = (v) => {
      dialogResolve = null;
      modal.classList.add('hidden');
      inp.value = ''; // don't keep a typed password in the DOM
      resolve(v);
    };
  });
}

$('#dialog-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!dialogResolve) return;
  dialogResolve({ value: $('#dialog-input').value, checked: $('#dialog-check').checked });
});
$('#dialog-cancel').addEventListener('click', () => dialogResolve && dialogResolve(null));

const confirmDialog = async (opts) => (await openDialog(opts)) !== null;
const alertDialog = (title, message) => openDialog({ title, message: String(message && message.message || message), okText: 'Close', cancelText: '' });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#dialog-modal').classList.contains('hidden')) dialogResolve && dialogResolve(null);
  else if (!$('#vpn-modal').classList.contains('hidden')) closeEditor();
});

// ===========================================================================
// State
// ===========================================================================

let vpns = [];
let cisco = { installed: true, profileHosts: [] };
let status = { state: 'Unknown', connected: false };
let selected = null; // { id } or { profileName }
let connectedRef = null; // what VPNMaster last connected to, to mark it in the list
let session = null; // the connection attempt shown in the view: { ref, name, log, prompt, result }

const COLORS = ['', '#4f9df7', '#4cc38a', '#e5b454', '#e5604f', '#b67cf2', '#3cc7c7'];
const sameRef = (a, b) => !!a && !!b && (a.id ? a.id === b.id : !!a.profileName && a.profileName === b.profileName);
const refOf = (item) => (item.id ? { id: item.id } : { profileName: item.name });
const vpnById = (id) => vpns.find((v) => v.id === id);

function itemFor(ref) {
  if (!ref) return null;
  if (ref.id) return vpnById(ref.id) || null;
  const h = cisco.profileHosts.find((x) => x.name === ref.profileName);
  return h ? { ...h, host: h.address, auth: 'sso', fromProfile: true } : null;
}

async function loadCisco() {
  try { cisco = await call(api.cisco.info()); } catch { /* keep defaults */ }
  renderStoreInfo();
  renderView();
}

api.cisco.onUpdated(({ from, to }) => {
  alertDialog('Cisco Secure Client was updated', `Cisco Secure Client was updated from ${from} to ${to} by your company's VPN server.`);
  loadCisco();
});

async function loadAll() {
  try {
    vpns = await call(api.vpns.list());
  } catch (e) {
    vpns = [];
    alertDialog('Cannot read your saved VPNs', e);
  }
  try { cisco = await call(api.cisco.info()); } catch { /* keep defaults */ }
  if (selected && !itemFor(selected)) selected = null;
  renderList();
  renderView();
}

// ===========================================================================
// Sidebar
// ===========================================================================

function vpnItem(item, ref) {
  const isSel = sameRef(selected, ref);
  const isConnected = status.connected && sameRef(connectedRef, ref);
  const node = el('div', {
    class: `vpn${isSel ? ' active' : ''}${item.color ? ' has-color' : ''}`,
    style: item.color ? `--c:${item.color}` : null,
    title: item.notes || null,
    onclick: () => { selected = ref; renderList(); renderView(); },
    ondblclick: () => connectTo(ref),
  },
  el('span', { class: `dot${isConnected ? ' on' : ''}` }),
  el('div', { class: 'vpn-main' },
    el('div', { class: 'vpn-name', text: item.name }),
    el('div', { class: 'vpn-host', text: item.userGroup ? `${item.host} · ${item.userGroup}` : item.host })),
  el('span', { class: `badge ${item.auth}`, text: item.auth === 'password' ? 'password' : 'SSO' }));
  return node;
}

function renderList() {
  const list = $('#vpn-list');
  const q = $('#vpn-search').value.trim().toLowerCase();
  const match = (x) => !q || [x.name, x.host, x.address, x.userGroup, x.notes].some((s) => (s || '').toLowerCase().includes(q));
  const out = [];

  out.push(el('div', { class: 'list-title' }, el('span', { text: 'My VPNs' })));
  const mine = vpns.filter(match);
  if (mine.length) mine.forEach((v) => out.push(vpnItem(v, { id: v.id })));
  else out.push(el('div', { class: 'empty', text: q ? 'No match' : 'No saved VPNs yet. Click + New.' }));

  const company = cisco.profileHosts.filter(match);
  if (company.length) {
    out.push(el('div', { class: 'list-title', title: 'The servers in the Cisco profile your company installed. Shown here so you can connect to everything from one place; they cannot be changed.' }, el('span', { text: 'Cisco profile' })));
    company.forEach((h) => out.push(vpnItem({ ...h, host: h.address, auth: 'sso' }, { profileName: h.name })));
  }
  list.replaceChildren(...out);
}

$('#vpn-search').addEventListener('input', renderList);
$('#btn-new-vpn').addEventListener('click', () => openEditor(null));

async function renderStoreInfo() {
  const box = $('#store-info');
  try {
    const info = await call(api.store.info());
    const auto = el('input', { type: 'checkbox', checked: cisco.autoConnect, onchange: (e) => api.cisco.setAutoConnect(e.target.checked).then(loadCisco) });
    box.replaceChildren(...[
      cisco.installed ? el('div', {
        class: 'cisco-version',
        title: 'Cisco Secure Client updates itself from your company\'s VPN server when you connect to it. VPNMaster tells you when that happened.',
        text: `Cisco Secure Client ${cisco.version || ''}`,
      }) : null,
      cisco.autoConnectAllowed ? el('label', { class: 'check-row', title: 'For external-login VPNs: the Cisco app connects as soon as VPNMaster opens it, so the login page appears without a click. Your own Cisco setting is put back right after.' },
        auto, 'Cisco connects by itself (SSO)') : null,
      cisco.installed ? el('label', { class: 'check-row', title: 'For external-login VPNs: once you are connected, VPNMaster closes the Cisco app it opened. The VPN stays connected: Cisco\'s background service keeps it.' },
        el('input', { type: 'checkbox', checked: cisco.closeAfterConnect, onchange: (e) => api.cisco.setCloseAfterConnect(e.target.checked).then(loadCisco) }),
        'Close Cisco after connecting (SSO)') : null,
      el('div', { class: 'row' }, el('span', { text: 'Saved in ' }), el('button', { class: 'link', title: info.file, onclick: () => api.store.reveal(), text: 'vpns.json' })),
      info.encrypted ? null : el('div', { class: 'warn', text: '⚠ No keychain: passwords would be saved unencrypted. Leave them empty to be asked.' }),
    ].filter(Boolean));
  } catch { box.replaceChildren(); }
}

// ===========================================================================
// Status bar
// ===========================================================================

function renderStatus() {
  const bar = $('#status-bar');
  if (!status.installed) {
    bar.replaceChildren(el('span', { class: 'status-pill bad', text: '⚠ Cisco Secure Client is not installed' }));
    return;
  }
  const on = status.connected;
  const connectedItem = on ? itemFor(connectedRef) : null;
  const label = status.connecting ? `Connecting to ${status.connectingTo}…` : on ? `Connected${connectedItem ? ` to ${connectedItem.name}` : ''}` : status.state;
  bar.replaceChildren(...[
    el('span', { class: `status-pill ${on ? 'on' : status.connecting ? 'busy' : ''}` }, el('span', { class: `dot${on ? ' on' : ''}` }), label),
    on && status.server ? el('span', { class: 'status-detail mono', title: 'Server address', text: status.server }) : null,
    on && status.clientAddress ? el('span', { class: 'status-detail mono', title: 'Your address in the VPN', text: `you: ${status.clientAddress}` }) : null,
    on && status.duration ? el('span', { class: 'status-detail', title: 'Connected for', text: status.duration }) : null,
    on ? el('button', { class: 'btn small', onclick: disconnect }, 'Disconnect') : null,
    el('button', { class: 'btn small', title: 'Open Cisco Secure Client', onclick: () => api.cisco.openApp() }, status.guiRunning ? 'Cisco app ✓' : 'Open Cisco app'),
  ].filter(Boolean));
}

api.cisco.onStatus((st) => {
  const was = status.connected;
  status = st;
  if (st.version && st.version !== cisco.version) { cisco.version = st.version; renderStoreInfo(); }
  if (!st.connected && was) disconnected();
  if (st.connected && !connectedRef && session?.result?.handedOver) connectedRef = session.ref;
  if (st.connected && !was && session?.result?.handedOver) {
    session.result = { ok: true, message: `Connected${status.server ? ` (${status.server})` : ''}` };
  }
  renderStatus();
  renderList();
  if (session) renderView();
});

// The VPN went down (here, in the Cisco app or by the server): the message and Cisco
// output of the connection attempt no longer apply.
function disconnected() {
  connectedRef = null;
  if (session && !status.connecting && (session.result?.ok || session.result?.handedOver)) session = null;
}

async function disconnect() {
  try {
    toast('Disconnecting…');
    status = await call(api.cisco.disconnect());
    if (!status.connected) disconnected();
    toast(status.connected ? 'Cisco still reports the VPN as connected' : 'Disconnected');
  } catch (e) {
    alertDialog('Could not disconnect', e);
  }
  renderStatus();
  renderList();
  renderView();
}

// ===========================================================================
// Main view: the selected VPN
// ===========================================================================

function renderView() {
  const view = $('#view');
  const item = itemFor(selected);
  if (!item) return view.replaceChildren(welcome());
  const ref = selected;
  const isConnected = status.connected && sameRef(connectedRef, ref);
  const busy = !!status.connecting;
  const s = session && sameRef(session.ref, ref) ? session : null;

  const head = el('div', { class: `vpn-head${item.color ? ' has-color' : ''}`, style: item.color ? `--c:${item.color}` : null },
    el('div', { class: 'vpn-title' },
      el('h1', { text: item.name }),
      el('div', { class: 'mono muted selectable', text: item.userGroup ? `${item.host}  ·  group ${item.userGroup}` : item.host })),
    item.fromProfile ? el('span', { class: 'muted small', text: `from ${item.profile}` }) : el('button', { class: 'btn', onclick: () => openEditor(item) }, '✎ Edit'));

  const how = item.auth === 'password'
    ? `Connects with Cisco's command-line client${item.username ? ` as ${item.username}` : ''}${item.hasPassword ? ' with the saved password' : ''}. Questions Cisco asks (a code, a second password) appear below.`
    : cisco.autoConnect && cisco.autoConnectAllowed
      ? 'Logs in through an external page. VPNMaster selects this VPN in Cisco Secure Client and has it connect right away: log in on the page Cisco shows.'
      : 'Logs in through an external page. VPNMaster selects this VPN in Cisco Secure Client and opens it: click Connect there, then log in on the page Cisco shows.';

  const action = isConnected
    ? el('button', { class: 'btn big', onclick: disconnect }, 'Disconnect')
    : el('button', { class: 'btn big connect', disabled: busy || !status.installed, onclick: () => connectTo(ref) },
      item.auth === 'password' ? '⏻ Connect' : '⏻ Connect via Cisco');

  const parts = [head, el('div', { class: 'connect-row' }, action, busy && s ? el('button', { class: 'btn', onclick: () => api.cisco.cancel() }, 'Cancel') : null),
    el('p', { class: 'muted how', text: how })];

  if (s) {
    if (s.prompt) parts.push(promptBar(s));
    if (s.result) {
      parts.push(el('div', { class: `result ${s.result.ok ? 'ok' : 'bad'}` },
        el('span', { text: s.result.ok ? (s.result.handedOver ? '→ ' : '✔ ') : '✖ ' }), s.result.message || (s.result.ok ? 'Done' : 'Failed')));
    }
    if (s.log) {
      const pre = el('pre', { class: 'log selectable', text: s.log });
      parts.push(el('div', { class: 'section-title', text: 'Cisco output' }), pre);
      setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0);
    }
  }
  if (item.notes) parts.push(el('div', { class: 'notes selectable', text: item.notes }));
  if (item.lastUsed) parts.push(el('div', { class: 'muted small', text: `Last used ${fmtDate(item.lastUsed)}` }));
  view.replaceChildren(el('div', { class: 'vpn-view' }, ...parts));
  if (s?.prompt) setTimeout(() => $('#prompt-input')?.focus(), 0);
}

function promptBar(s) {
  const p = s.prompt;
  const isYesNo = p.kind === 'accept';
  const input = el('input', { id: 'prompt-input', type: p.secret ? 'password' : 'text', spellcheck: 'false', autocomplete: 'off' });
  const save = p.canSave ? el('input', { type: 'checkbox', id: 'prompt-save' }) : null;
  const send = async (value) => {
    s.prompt = null; // Cisco echoes the answer (not a password) in its output
    renderView();
    try { await call(api.cisco.answer(p.id, value, save?.checked)); } catch (e) { toast(e.message); }
  };
  return el('form', { class: 'prompt-bar', onsubmit: (e) => { e.preventDefault(); send(input.value); } },
    el('pre', { class: 'prompt-text selectable', text: p.text }),
    isYesNo
      ? el('div', { class: 'row' }, el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn', onclick: () => send('n') }, 'No'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => send('y') }, 'Accept'))
      : el('div', { class: 'row' }, input,
        save ? el('label', { class: 'check-row small' }, save, 'Save') : null,
        el('button', { type: 'submit', class: 'btn primary' }, 'Send')));
}

function welcome() {
  return el('div', { class: 'welcome' },
    el('img', { class: 'welcome-logo', src: 'assets/icon.svg', alt: '' }),
    el('h1', { text: 'VPNMaster' }),
    el('p', { class: 'muted', text: 'Save the VPNs Cisco Secure Client keeps forgetting, and connect to any of them in one click.' }),
    !status.installed ? el('p', { class: 'warn', text: 'Cisco Secure Client was not found in /opt/cisco/secureclient. Install it first (your company provides it).' }) : null,
    el('div', { class: 'welcome-steps' },
      el('div', {}, el('b', { text: '1. ' }), 'Click ', el('b', { text: '+ New' }), ' and fill in the server address, as you would type it in Cisco.'),
      el('div', {}, el('b', { text: '2. ' }), 'Choose how it logs in: an ', el('b', { text: 'external login' }), ' page (SSO), or a username and password.'),
      el('div', {}, el('b', { text: '3. ' }), 'Select it and click ', el('b', { text: 'Connect' }), ', or double-click it. The tray icon has the same list.')),
    el('button', { class: 'btn primary big', onclick: () => openEditor(null) }, '+ Save a VPN'));
}

// ===========================================================================
// Connecting
// ===========================================================================

async function connectTo(ref, opts = {}) {
  const item = itemFor(ref);
  if (!item) return;
  selected = ref;
  session = { ref, name: item.name, log: '', prompt: null, result: null };
  renderList();
  renderView();
  try {
    let res = await api.cisco.connect(ref, opts);
    if (!res.ok && res.code === 'CONNECTED') {
      const current = itemFor(connectedRef);
      const ok = await confirmDialog({
        title: 'Switch VPN?',
        message: `You are connected${current ? ` to ${current.name}` : status.server ? ` to ${status.server}` : ''}. Disconnect and connect to ${item.name}?`,
        okText: 'Disconnect & connect',
      });
      if (!ok) { session = null; return renderView(); }
      res = await api.cisco.connect(ref, { ...opts, disconnectFirst: true });
    }
    if (!res.ok) throw new Error(res.message);
    if (res.data.mode === 'cli') connectedRef = null;
  } catch (e) {
    session.result = { ok: false, message: e.message };
  }
  renderView();
}

api.cisco.onStart(() => { if (session) { session.log = ''; renderView(); } });
api.cisco.onOutput((text) => {
  if (!session) return;
  session.log = (session.log + text).slice(-200000);
  // Only the log changes: append to it instead of redrawing everything.
  const pre = $('#view .log');
  if (pre) { pre.textContent = session.log; pre.scrollTop = pre.scrollHeight; } else renderView();
});
api.cisco.onPrompt((p) => { if (session) { session.prompt = p; renderView(); } });
api.cisco.onDone((r) => {
  if (!session) return;
  session.prompt = null;
  session.result = r;
  if (r.ok && !r.handedOver) { connectedRef = session.ref; toast(r.message); }
  if (r.handedOver) {
    connectedRef = session.ref; // marked as soon as Cisco reports "Connected"
    if (status.connected) session.result = { ok: true, message: `Connected${status.server ? ` (${status.server})` : ''}` };
  }
  loadAll();
});
api.cisco.onTrayConnect((ref) => connectTo(ref));
api.cisco.onClosed(() => toast('Connected. The Cisco app was closed; the VPN stays connected.'));

// ===========================================================================
// VPN editor
// ===========================================================================

const form = $('#vpn-form');
const f = form.elements; // form.id / form.name would be the form's own attributes
let editing = null;

function setColor(c) {
  f.color.value = c;
  for (const b of $('#color-options').children) b.classList.toggle('active', b.dataset.color === c);
}
$('#color-options').replaceChildren(...COLORS.map((c) => el('button', {
  type: 'button', class: `color-chip${c ? '' : ' none'}`, dataset: { color: c }, style: c ? `background:${c}` : null,
  title: c || 'No colour', onclick: () => setColor(c),
})));

function syncAuthFields() {
  const pw = f.auth.value === 'password';
  $('.pw-field').classList.toggle('hidden', !pw);
  f.username.placeholder = pw ? 'leave empty to be asked' : 'optional: prefilled in Cisco';
}
for (const r of form.querySelectorAll('input[name=auth]')) r.addEventListener('change', syncAuthFields);

function openEditor(v) {
  editing = v;
  form.reset();
  $('#vpn-form-title').textContent = v ? `Edit ${v.name}` : 'New VPN';
  f.id.value = v?.id || '';
  f.name.value = v?.name || '';
  f.host.value = v?.host || '';
  f.userGroup.value = v?.userGroup || '';
  f.username.value = v?.username || '';
  f.notes.value = v?.notes || '';
  f.auth.value = v?.auth || 'sso';
  setColor(v?.color || '');
  $('#btn-delete-vpn').hidden = !v;
  $('#btn-forget-pw').hidden = !v?.hasPassword;
  $('#pw-hint').textContent = v?.hasPassword ? 'A password is saved. Type a new one to replace it.' : '';
  $('#vpn-form-error').textContent = '';
  syncAuthFields();
  $('#vpn-modal').classList.remove('hidden');
  setTimeout(() => (v ? f.name : f.host).focus(), 0);
}

function closeEditor() {
  $('#vpn-modal').classList.add('hidden');
  f.password.value = '';
  editing = null;
}

form.querySelector('[data-close]').addEventListener('click', closeEditor);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    const saved = await call(api.vpns.save(data));
    closeEditor();
    selected = { id: saved.id };
    await loadAll();
    toast(`Saved ${saved.name}`);
  } catch (err) {
    $('#vpn-form-error').textContent = err.message;
  }
});
$('#btn-forget-pw').addEventListener('click', async () => {
  if (!editing) return;
  try {
    const saved = await call(api.vpns.save({ ...editing, clearPassword: true }));
    editing = saved;
    $('#btn-forget-pw').hidden = true;
    $('#pw-hint').textContent = 'Saved password removed.';
    await loadAll();
  } catch (err) { $('#vpn-form-error').textContent = err.message; }
});
$('#btn-delete-vpn').addEventListener('click', async () => {
  if (!editing) return;
  const v = editing;
  if (!await confirmDialog({ title: 'Delete VPN?', message: `Delete ${v.name} (${v.host})? Its saved password is removed too.`, okText: 'Delete', okClass: 'danger' })) return;
  try {
    await call(api.vpns.remove(v.id));
    closeEditor();
    if (sameRef(selected, { id: v.id })) selected = null;
    await loadAll();
  } catch (err) { $('#vpn-form-error').textContent = err.message; }
});

// ===========================================================================
// App updates: a clear button in the top bar
// ===========================================================================

function renderUpdate(st) {
  const area = $('#update-area');
  const check = () => api.updates.check().then((r) => r.ok && renderUpdate(r.data));
  const version = el('span', { text: `VPNMaster ${st.version}` });
  let parts;
  switch (st.state) {
    case 'dev': parts = [version, el('span', { class: 'small', text: '(from source)' })]; break;
    case 'checking': parts = [version, el('button', { class: 'btn small update-btn', disabled: true }, 'Checking…')]; break;
    case 'downloading':
      parts = [el('span', { text: `Downloading ${st.newVersion || 'update'}…` }), el('div', { class: 'update-progress' }, el('div', { style: `width:${st.percent || 0}%` }))];
      break;
    case 'ready':
      parts = [el('button', {
        class: 'btn small update-btn available',
        title: st.platform === 'linux' ? 'Installs the update (asks for your password) and restarts VPNMaster' : 'Restarts VPNMaster with the new version',
        onclick: () => api.updates.install(),
      }, `⬆ Update to ${st.newVersion} & restart`)];
      break;
    case 'available-manual':
      parts = [el('button', { class: 'btn small update-btn available', onclick: () => api.updates.install() }, `⬆ Download ${st.newVersion}`)];
      break;
    case 'error':
      parts = [version, el('button', { class: 'btn small update-btn', title: st.message, onclick: check }, '⚠ Update check failed · retry')];
      break;
    case 'up-to-date':
      parts = [version, el('button', { class: 'btn small update-btn', title: `Up to date${st.checkedAt ? ` (checked ${fmtTime(st.checkedAt)})` : ''}. Click to check again.`, onclick: check }, '✓ Up to date')];
      break;
    default:
      parts = [version, el('button', { class: 'btn small update-btn', onclick: check }, 'Check for updates')];
  }
  area.replaceChildren(...parts);
}
api.updates.onStatus(renderUpdate);
api.updates.status().then((r) => r.ok && renderUpdate(r.data));

// ===========================================================================
// Start
// ===========================================================================

(async () => {
  await loadAll();
  await loadCisco();
  try { status = await call(api.cisco.status()); } catch { /* polled again shortly */ }
  renderStatus();
  renderList();
  renderView();
})();
