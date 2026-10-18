const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const { Store } = require('./store');
const cisco = require('./anyconnect');
const updater = require('./updater');

// The OS keyring key used to encrypt saved passwords is tied to the app name, so keep it
// fixed: renaming the app would make every saved password undecryptable.
app.setName('vpnmaster');

// Data lives inside the tool's own folder (./data) unless overridden.
// A packaged build cannot write into its own bundle, so it uses the per-user app data dir.
function dataDir() {
  if (process.env.VPNMASTER_DATA_DIR) return path.resolve(process.env.VPNMASTER_DATA_DIR);
  if (app.isPackaged) return path.join(app.getPath('userData'), 'data');
  return path.join(__dirname, '..', '..', 'data');
}

const ICON = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');
const POLL_MS = 5000;

let store;
let win;
let tray;
let lastStatus = { installed: !!cisco.paths(), state: 'Unknown', connected: false };
let active = null; // the connection attempt in progress: { vpn, conn, restartGui }

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#12151b',
    title: 'VPNMaster',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never navigate away from the app or open new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- status -----------------------------------------------------------------

// Cisco Secure Client updates itself from the company's VPN server when you connect.
// VPNMaster remembers the version it last saw, so it can tell you when that happened.
function noticeCiscoVersion(version) {
  if (!version) return;
  const seen = store.getSetting('ciscoVersion');
  if (seen === version) return;
  store.setSetting('ciscoVersion', version);
  store.setSetting('ciscoVersionSince', Date.now());
  if (seen) send('cisco:updated', { from: seen, to: version });
}

let pollPromise = null;
// Raised by every connect and disconnect: a status asked for before it is out of date
// when it arrives, and is dropped instead of showing "Connected" after a disconnect.
let epoch = 0;
let wasConnected = false;

async function poll() {
  const asked = epoch;
  let st;
  try {
    st = await cisco.status();
  } catch (e) {
    st = { installed: !!cisco.paths(), state: 'Unknown', connected: false, error: String(e.message || e) };
  }
  return asked === epoch ? publishStatus(st) : lastStatus;
}

// fresh: true = the answer must be asked after this call (not one already on its way).
async function refreshStatus({ fresh = false } = {}) {
  // While the command-line client is logging in, leave Cisco's agent to it.
  if (active) return publishStatus(lastStatus);
  if (pollPromise) {
    if (!fresh) return pollPromise;
    await pollPromise;
  }
  pollPromise = poll().finally(() => { pollPromise = null; });
  return pollPromise;
}

async function disconnectVpn() {
  epoch++;
  try {
    const st = await cisco.disconnect();
    epoch++;
    return publishStatus(st);
  } finally {
    epoch++;
  }
}

function publishStatus(st) {
  lastStatus = st;
  lastStatus.connecting = !!active;
  lastStatus.connectingTo = active ? active.vpn.name : '';
  noticeCiscoVersion(lastStatus.version);
  if (lastStatus.connected && !wasConnected) setTimeout(() => cisco.restoreAutoConnect(), 5000);
  wasConnected = !!lastStatus.connected;
  send('status', lastStatus);
  updateTray();
  return lastStatus;
}

// ---- connecting -----------------------------------------------------------------

// ref: { id } of a saved VPN, or { profileName } of a server in the company's Cisco profile.
function resolve(ref) {
  if (ref && ref.id) return store.get(ref.id);
  const host = cisco.profileHosts().find((h) => h.name === ref?.profileName);
  if (!host) throw new Error('That server is no longer in the Cisco profile');
  return { name: host.name, host: host.address, userGroup: host.userGroup, profileName: host.name, auth: 'sso' };
}

async function connect(ref, opts = {}) {
  if (active) throw new Error(`Already connecting to ${active.vpn.name}`);
  const vpn = resolve(ref);
  const st = await refreshStatus({ fresh: true });
  if (st.connected) {
    if (!opts.disconnectFirst) return { ok: false, code: 'CONNECTED', message: `The VPN is connected${st.server ? ` to ${st.server}` : ''}. Disconnect first?` };
    send('connect:output', `Disconnecting${st.server ? ` from ${st.server}` : ''}…\n`);
    if ((await disconnectVpn()).connected) throw new Error('The VPN is still connected; disconnect in Cisco Secure Client first');
  }
  epoch++;
  if (vpn.id) store.touch(vpn.id);

  if (vpn.auth !== 'password') return handOver(vpn);

  const restartGui = await cisco.stopGui(); // the Cisco window would block the command-line client
  active = { vpn, restartGui };
  send('connect:start', { name: vpn.name, target: cisco.target(vpn) });
  const conn = new cisco.CliConnection(vpn, vpn.password, {
    onOutput: (text) => send('connect:output', text),
    onPrompt: (p) => send('connect:prompt', { ...p, canSave: !!vpn.id && p.kind === 'password' }),
    onDone: (r) => finishCli(vpn, r),
  });
  active.conn = conn;
  try {
    conn.start();
  } catch (e) {
    active = null;
    if (restartGui) cisco.startGui();
    throw e;
  }
  refreshStatus();
  return { ok: true, data: { mode: 'cli' } };
}

async function handOver(vpn) {
  const r = await cisco.openInCisco(vpn, { autoConnect: store.getSetting('autoConnect') !== false });
  // The Cisco app has read the setting once it is up; put the user's own value back.
  if (r.autoConnect) setTimeout(() => cisco.restoreAutoConnect(), 15000);
  send('connect:done', {
    ok: true,
    handedOver: true,
    message: r.autoConnect
      ? `Cisco Secure Client is connecting to ${r.target}. Log in on the page Cisco shows.`
      : `Opened Cisco Secure Client with ${r.target} selected. Click Connect there and log in.`,
  });
  setTimeout(refreshStatus, 1500);
  return { ok: true, data: { mode: 'cisco', target: r.target } };
}

async function finishCli(vpn, result) {
  const { restartGui } = active || {};
  active = null;
  if (result.sso) {
    send('connect:output', '\nThis VPN uses an external login. Switching to the Cisco app…\n');
    try { await handOver(vpn); } catch (e) { send('connect:done', { ok: false, message: String(e.message || e) }); }
    return;
  }
  if (restartGui) { try { cisco.startGui(); } catch { /* not essential */ } }
  send('connect:done', result);
  setTimeout(refreshStatus, 500);
}

// ---- tray --------------------------------------------------------------------

function updateTray() {
  if (!tray) return;
  const st = lastStatus;
  tray.setToolTip(`VPNMaster: ${st.connecting ? `connecting to ${st.connectingTo}` : st.state}${st.connected && st.server ? ` (${st.server})` : ''}`);
  let vpns = [];
  try { vpns = store.list(); } catch { /* broken file: shown in the window */ }
  const item = (label, ref) => ({ label, enabled: !st.connecting, click: () => trayConnect(ref) });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: st.connected ? `● Connected${st.server ? ` – ${st.server}` : ''}` : `○ ${st.state}`, enabled: false },
    { type: 'separator' },
    ...vpns.map((v) => item(v.name, { id: v.id })),
    ...(vpns.length ? [{ type: 'separator' }] : []),
    ...cisco.profileHosts().map((h) => item(`${h.name} (Cisco profile)`, { profileName: h.name })),
    { type: 'separator' },
    { label: 'Disconnect', enabled: !!st.connected, click: () => disconnectVpn().catch(() => refreshStatus({ fresh: true })) },
    { label: 'Open VPNMaster', click: showWindow },
    { label: 'Quit', role: 'quit' },
  ]));
}

async function trayConnect(ref) {
  showWindow();
  send('tray:connect', ref); // the window asks for confirmation if already connected
}

// ---- IPC -------------------------------------------------------------------------

function toIpcError(e) {
  return { ok: false, code: e.code || 'ERROR', message: String(e.message || e) };
}

// Wraps an IPC handler so errors reach the renderer as {ok:false,...} instead of throwing.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const res = await fn(event, ...args);
      return res && typeof res === 'object' && 'ok' in res ? res : { ok: true, data: res };
    } catch (e) {
      return toIpcError(e);
    }
  });
}

function registerIpc() {
  handle('vpns:list', () => store.list());
  handle('vpns:save', (_e, v) => { const r = store.save(v); updateTray(); return r; });
  handle('vpns:delete', (_e, id) => { store.remove(id); updateTray(); });
  handle('vpns:move', (_e, id, to) => { const r = store.move(id, to); updateTray(); return r; });
  handle('cisco:info', () => {
    const p = cisco.paths();
    return {
      installed: !!p, dir: p?.dir || '', prefsFile: cisco.prefsFile(), prefs: cisco.readPrefs(), profileHosts: cisco.profileHosts(),
      version: lastStatus.version || cisco.installedVersion(), versionSince: store.getSetting('ciscoVersionSince') || 0,
      autoConnect: store.getSetting('autoConnect') !== false, autoConnectAllowed: cisco.profileAllowsAutoConnect(),
    };
  });
  handle('settings:set', (_e, key, value) => {
    if (key !== 'autoConnect') throw new Error('Unknown setting');
    store.setSetting(key, !!value);
  });
  handle('cisco:status', () => refreshStatus({ fresh: true }));
  handle('cisco:connect', (_e, ref, opts) => connect(ref, opts));
  handle('cisco:answer', (_e, id, value, save) => {
    if (!active?.conn) throw new Error('Nothing is waiting for an answer');
    const pending = active.conn.pending;
    if (save && pending?.kind === 'password' && active.vpn.id) store.setPassword(active.vpn.id, value);
    return active.conn.answer(id, value);
  });
  handle('cisco:cancel', () => { active?.conn?.cancel(); });
  handle('cisco:disconnect', () => disconnectVpn());
  handle('cisco:openApp', () => { cisco.startGui(); setTimeout(refreshStatus, 1500); });
  handle('store:info', () => ({ dir: store.dir, file: store.vpnsFile, encrypted: store.canEncrypt() }));
  handle('store:reveal', () => shell.showItemInFolder(store.vpnsFile));

  handle('update:status', () => updater.getStatus());
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());
  handle('app:openExternal', (_e, url) => {
    if (!/^https:\/\/github\.com\/FarosBelgium\/VpnMaster(\/|$)/i.test(url)) throw new Error('Not allowed');
    return shell.openExternal(url);
  });
}

// ---- command line: vpnmaster --connect "<name>" ---------------------------------

function connectArg(argv) {
  const i = argv.indexOf('--connect');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function connectByName(name) {
  const lower = name.toLowerCase();
  const saved = store.list().find((v) => v.name.toLowerCase() === lower || v.host.toLowerCase() === lower);
  const profile = cisco.profileHosts().find((h) => h.name.toLowerCase() === lower);
  const ref = saved ? { id: saved.id } : profile ? { profileName: profile.name } : null;
  if (!ref) return dialog.showErrorBox('VPNMaster', `No saved VPN called "${name}"`);
  send('tray:connect', ref);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    const name = connectArg(argv);
    if (name && store) connectByName(name);
  });

  app.whenReady().then(() => {
    const isMac = process.platform === 'darwin';
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    ]));
    try {
      store = new Store(dataDir());
    } catch (e) {
      dialog.showErrorBox('VPNMaster', `Cannot open data directory: ${e.message}`);
      app.quit();
      return;
    }
    cisco.restoreAutoConnect(); // left over from a handover that never finished
    registerIpc();
    createWindow();
    if (!process.env.VPNMASTER_NO_TRAY) {
      try {
        tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
        tray.on('click', showWindow);
        updateTray();
      } catch { tray = null; /* no system tray on this desktop */ }
    }
    refreshStatus();
    setInterval(refreshStatus, POLL_MS).unref();
    const name = connectArg(process.argv);
    if (name) win.webContents.once('did-finish-load', () => setTimeout(() => connectByName(name), 300));
    updater.init((status) => send('update:status', status));
  });

  app.on('window-all-closed', () => {
    active?.conn?.cancel();
    app.quit();
  });
}

module.exports = { connect, refreshStatus, get store() { return store; } };
