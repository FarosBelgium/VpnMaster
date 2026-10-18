// End-to-end tests against a stand-in for Cisco Secure Client (test/fake-cisco):
//   npm test                 (opens a window briefly)
//   npm run test:headless    (on a virtual display; needs xvfb)
// The real Cisco installation and your real preferences are never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// Windows: Electron is a GUI program, so the Cisco stand-ins run with node.exe there.
if (process.platform === 'win32' && !process.env.VPNMASTER_NODE) {
  try { process.env.VPNMASTER_NODE = require('child_process').execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { /* not found */ }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpnmaster-test-'));
const FAKE = path.join(__dirname, 'fake-cisco');
const STATE = path.join(tmp, 'cisco-state');
const PREFS = path.join(tmp, 'home', '.vpn', '.anyconnect');
Object.assign(process.env, {
  VPNMASTER_DATA_DIR: path.join(tmp, 'data'),
  VPNMASTER_CISCO_DIR: FAKE,
  VPNMASTER_PREFS_FILE: PREFS,
  VPNMASTER_FAKE_STATE: STATE,
  VPNMASTER_NO_TRAY: '1',
});
fs.mkdirSync(path.dirname(PREFS), { recursive: true });
fs.writeFileSync(PREFS, `<?xml version="1.0" encoding="UTF-8"?>
<AnyConnectPreferences>
<DefaultUser>someone@example.com</DefaultUser>
<DefaultHostName>Fake Company VPN (Full)</DefaultHostName>
<DefaultHostAddress></DefaultHostAddress>
<DefaultGroup></DefaultGroup>
<SDITokenType>none</SDITokenType>
<ControllablePreferences></ControllablePreferences>
</AnyConnectPreferences>
`);

// Own profile folder, so a VPNMaster that is open on this machine doesn't hold the
// single-instance lock (and its settings aren't touched).
app.setPath('userData', path.join(tmp, 'userData'));
require('../src/main/main.js'); // the real app: window, IPC, store
const cisco = require('../src/main/anyconnect');
const { Store } = require('../src/main/store');

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 5).join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const resetCisco = async () => {
  await cisco.stopGui();
  for (const f of [STATE, `${STATE}.log`, `${STATE}.gui`, `${STATE}.gui-auto`, `${STATE}.server`, `${STATE}.version`, `${STATE}.slow`]) fs.rmSync(f, { force: true });
};

// Connects with the command-line client; answers prompts with `answers` (by kind or text).
function cliConnect(vpn, password, answers = {}) {
  return new Promise((resolve) => {
    const prompts = [];
    let out = '';
    const conn = new cisco.CliConnection(vpn, password, {
      onOutput: (t) => { out += t; },
      onPrompt: (p) => {
        prompts.push(p);
        const a = answers[p.kind] ?? Object.entries(answers).find(([k]) => p.text.includes(k))?.[1];
        setTimeout(() => (a == null ? conn.cancel() : conn.answer(p.id, a)), 10);
      },
      onDone: (r) => resolve({ ...r, prompts, out }),
    });
    conn.start();
  });
}

async function run() {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], 10000, 'window');
  await until(() => !win.webContents.isLoading(), 10000, 'page load');
  const js = (code) => win.webContents.executeJavaScript(code);

  console.log('\nCisco files');
  await test('reads the servers of the company profile', () => {
    eq(cisco.profileHosts().map((h) => [h.name, h.address, h.userGroup]), [
      ['Fake Company VPN (Split)', 'portal.example.com', ''],
      ['Fake Company VPN (Full)', 'portal.example.com', 'full'],
    ], 'hosts');
  });
  await test('reads the status from vpn stats', async () => {
    await resetCisco();
    const st = await cisco.status();
    eq([st.installed, st.state, st.connected, st.server], [true, 'Disconnected', false, ''], 'status');
    const real = cisco.parseStats('  >> state: Connected\n    Connection State:            Connected\n    Server Address:              198.51.100.4\n    Client Address (IPv4):       10.1.2.3\n    Duration:                    01:02:03\n');
    eq([real.connected, real.server, real.clientAddress, real.duration], [true, '198.51.100.4', '10.1.2.3', '01:02:03'], 'parsed');
  });
  await test('preselecting a server changes only those preferences and keeps a backup', () => {
    const before = read(PREFS);
    cisco.writePrefs({ DefaultHostName: 'vpn.klant.be/a&b', DefaultHostAddress: 'vpn.klant.be', DefaultGroup: '' });
    const after = read(PREFS);
    assert(after.includes('<DefaultHostName>vpn.klant.be/a&amp;b</DefaultHostName>'), 'host name written (escaped)');
    assert(after.includes('<DefaultUser>someone@example.com</DefaultUser>'), 'user kept');
    assert(after.includes('<SDITokenType>none</SDITokenType>'), 'other settings kept');
    eq(cisco.readPrefs().defaultHostName, 'vpn.klant.be/a&b', 'read back');
    eq(read(`${PREFS}.vpnmaster-backup`), before, 'backup of the original');
    cisco.writePrefs({ DefaultHostName: 'other' });
    eq(read(`${PREFS}.vpnmaster-backup`), before, 'backup is only made once');
  });
  await test('reads the Cisco version', async () => {
    eq(cisco.parseVersion('Cisco Secure Client (version 5.1.20.333) release.'), '5.1.20.333', 'from vpn output');
    eq(cisco.parseVersion('5,1,20,333\n'), '5.1.20.333', 'from update.txt');
    eq((await cisco.status()).version, '5.1.20.333', 'status');
  });
  await test('auto-connect is switched on for the Cisco app and the user\'s own value put back', () => {
    assert(cisco.profileAllowsAutoConnect(), 'the fake profile lets the user control it');
    eq(cisco.readControllable('AutoConnectOnStart'), null, 'not set at first');
    cisco.enableAutoConnect();
    eq(cisco.readControllable('AutoConnectOnStart'), 'true', 'on');
    assert(cisco.restoreAutoConnect(), 'restored');
    eq(cisco.readControllable('AutoConnectOnStart'), null, 'removed again');
    assert(read(PREFS).includes('<DefaultUser>someone@example.com</DefaultUser>'), 'rest kept');
    cisco.writePrefs({ DefaultHostName: 'x' });
    const before = read(PREFS).replace('<ControllablePreferences></ControllablePreferences>', '<ControllablePreferences><AutoConnectOnStart>false</AutoConnectOnStart></ControllablePreferences>');
    fs.writeFileSync(PREFS, before);
    cisco.enableAutoConnect();
    cisco.enableAutoConnect(); // twice: still remembers the original "false"
    cisco.restoreAutoConnect();
    eq(cisco.readControllable('AutoConnectOnStart'), 'false', 'own value back');
    assert(!cisco.restoreAutoConnect(), 'nothing to restore twice');
  });
  await test('target: profile name, host, or host/group', () => {
    eq(cisco.target({ profileName: 'X (Full)', host: 'h' }), 'X (Full)', 'profile');
    eq(cisco.target({ host: 'vpn.a.be' }), 'vpn.a.be', 'host');
    eq(cisco.target({ host: 'vpn.a.be', userGroup: 'eng' }), 'vpn.a.be/eng', 'group');
  });

  console.log('\nSaved VPNs');
  await test('saves VPNs; the password never reaches the window', async () => {
    const store = new Store(path.join(tmp, 'store-test'));
    const v = store.save({ name: 'Klant', host: 'https://vpn.klant.be/', auth: 'password', username: 'me', password: 'pw1' });
    eq(v.host, 'vpn.klant.be', 'host normalised');
    assert(!('password' in v) && v.hasPassword, 'public record has no password');
    eq(store.get(v.id).password, 'pw1', 'decrypted in main');
    const raw = JSON.parse(read(store.vpnsFile)).vpns[0].password;
    if (store.canEncrypt()) assert(raw.startsWith('enc:'), 'encrypted on disk');
    if (process.platform !== 'win32') eq((fs.statSync(store.vpnsFile).mode & 0o777).toString(8), '600', 'file mode');
    store.save({ ...v, name: 'Klant 2', password: '' });
    eq(store.get(v.id).password, 'pw1', 'empty password keeps the saved one');
    store.save({ ...v, auth: 'sso' });
    eq(store.get(v.id).password, '', 'external login: no password kept');
    let err = '';
    try { store.save({ host: 'bad host' }); } catch (e) { err = e.message; }
    assert(/cannot contain spaces/.test(err), `validation: ${err}`);
    const w = store.save({ host: 'two.example.com' });
    eq(store.move(w.id, 0).map((x) => x.name), ['two.example.com', 'Klant'], 'reorder');
  });

  console.log('\nConnecting with the command-line client');
  await test('username + password: answers group, username and password; banner is asked', async () => {
    await resetCisco();
    const r = await cliConnect({ name: 'PW', host: 'pw.example.com', userGroup: 'split', username: 'alice', auth: 'password' }, 'secret', { accept: 'y' });
    assert(r.ok, `connected: ${r.message}\n${r.out}`);
    eq(r.prompts.map((p) => p.kind), ['accept'], 'only the banner went to the user');
    assert(r.prompts[0].text.includes('Use is monitored'), 'banner text shown');
    const log = read(`${STATE}.log`);
    assert(log.includes('connect pw.example.com/split'), `group in the address: ${log}`);
    assert(log.includes('user=alice'), 'username answered');
    assert(!r.out.includes('secret'), 'password not echoed in the output');
    eq((await cisco.status()).connected, true, 'agent connected');
    const after = await cisco.disconnect();
    eq([after.connected, after.state], [false, 'Disconnected'], 'waited until disconnected');
  });
  await test('group list: picks the saved group', async () => {
    await resetCisco();
    fs.writeFileSync(`${STATE}.log`, '');
    // A group-less target makes the fake ask "Group:"; "userGroup" empty -> Enter (default).
    const r = await cliConnect({ name: 'PW', host: 'pw.example.com', username: 'bob', auth: 'password' }, 'secret', { accept: 'y' });
    assert(r.ok, r.message);
    assert(read(`${STATE}.log`).includes('group=\n') || read(`${STATE}.log`).includes('group='), 'Enter for the default group');
  });
  await test('no saved username/password: both are asked; wrong password fails clearly', async () => {
    await resetCisco();
    const r = await cliConnect({ name: 'PW', host: 'pw.example.com/full', auth: 'password' }, '', { username: 'carol', password: 'wrong' });
    assert(!r.ok, 'not connected');
    eq(r.prompts.map((p) => [p.kind, p.secret]), [['username', false], ['password', true]], 'prompts');
    assert(/Login failed/.test(r.message), r.message);
    eq((await cisco.status()).connected, false, 'still disconnected');
  });
  await test('a one-time code is asked in the window', async () => {
    await resetCisco();
    const r = await cliConnect({ name: 'OTP', host: 'otp.example.com/full', username: 'dave', auth: 'password' }, 'secret', { 'Answer:': '123456', accept: 'y' });
    assert(r.ok, `${r.message}\n${r.out}`);
    eq(r.prompts.map((p) => p.kind), ['other', 'accept'], 'prompts');
    assert(r.prompts[0].text === 'Answer:', `prompt text ${r.prompts[0].text}`);
    await cisco.disconnect();
  });
  await test('an external-login server is recognised', async () => {
    await resetCisco();
    const r = await cliConnect({ name: 'SSO', host: 'sso.example.com', auth: 'password' }, 'x');
    assert(!r.ok && r.sso, `sso detected: ${JSON.stringify(r)}`);
  });

  console.log('\nHanding over to the Cisco app (external login)');
  await test('selects the server in the Cisco app and (re)starts it', async () => {
    await resetCisco();
    const r = await cisco.openInCisco({ name: 'K', host: 'vpn.klant.be', userGroup: 'eng', username: 'me@klant.be' });
    await until(() => read(`${STATE}.gui`).trim(), 10000, 'Cisco app started');
    eq(read(`${STATE}.gui`).trim(), 'vpn.klant.be/eng', 'preselected in the app');
    eq([r.autoConnect, read(`${STATE}.gui-auto`)], [true, 'auto'], 'the app connects by itself');
    eq(cisco.readPrefs().defaultUser, 'me@klant.be', 'username prefilled');
    cisco.restoreAutoConnect();
    const first = await until(async () => { const p = await cisco.guiPids(); return p.length ? p : null; }, 10000, 'Cisco app process');
    eq(first.length, 1, 'one Cisco app running');
    await cisco.openInCisco({ name: 'Company', profileName: 'Fake Company VPN (Split)', host: 'portal.example.com' }, { autoConnect: false });
    await until(() => read(`${STATE}.gui`).trim() === 'Fake Company VPN (Split)', 10000, 'second handover');
    eq(read(`${STATE}.gui-auto`), 'manual', 'auto-connect off when asked');
    const second = await until(async () => { const p = await cisco.guiPids(); return p.length ? p : null; }, 10000, 'restarted app');
    assert(second.length === 1 && second[0] !== first[0], 'the app was restarted to read the new server');
    await cisco.stopGui();
    eq((await cisco.guiPids()).length, 0, 'stopped');
  });

  console.log('\nThe window');
  await test('shows the company profile servers and saves a new VPN through the form', async () => {
    await resetCisco();
    await until(() => js(`document.querySelectorAll('#vpn-list .vpn').length === 2`), 5000, 'profile servers listed');
    await js(`document.querySelector('#btn-new-vpn').click()`);
    await js(`(() => {
      const f = document.querySelector('#vpn-form').elements;
      f.name.value = 'Klant SSO'; f.host.value = 'sso.example.com';
      document.querySelector('#vpn-form').requestSubmit();
    })()`);
    await until(() => js(`[...document.querySelectorAll('.vpn-name')].some((n) => n.textContent === 'Klant SSO')`), 5000, 'saved VPN in the list');
    eq(await js(`document.querySelector('.vpn-title h1').textContent`), 'Klant SSO', 'selected after saving');
  });
  await test('Connect on an external-login VPN opens the Cisco app with it selected', async () => {
    await js(`document.querySelector('.btn.connect').click()`);
    await until(() => read(`${STATE}.gui`).trim() === 'sso.example.com', 40000, 'handover');
    await until(() => js(`document.querySelector('.result')?.textContent.includes('Log in on the page Cisco shows')`), 5000, 'hint shown');
    await cisco.stopGui();
  });
  await test('Connect on a password VPN: Cisco questions appear in the window', async () => {
    await resetCisco();
    await js(`document.querySelector('#btn-new-vpn').click()`);
    await js(`(() => {
      const form = document.querySelector('#vpn-form'); const f = form.elements;
      f.name.value = 'Klant PW'; f.host.value = 'pw.example.com'; f.userGroup.value = 'full';
      f.auth.value = 'password'; f.username.value = 'erin'; f.password.value = 'secret';
      form.requestSubmit();
    })()`);
    await until(() => js(`document.querySelector('.vpn-title h1')?.textContent === 'Klant PW'`), 5000, 'selected');
    await js(`document.querySelector('.btn.connect').click()`);
    await until(() => js(`!!document.querySelector('.prompt-bar')`), 10000, 'banner question');
    assert(await js(`document.querySelector('.prompt-text').textContent.includes('fake company network')`), 'banner text');
    await js(`[...document.querySelectorAll('.prompt-bar button')].find((b) => b.textContent === 'Accept').click()`);
    await until(() => js(`document.querySelector('.result.ok')?.textContent.includes('Connected to Klant PW')`), 10000, 'connected');
    await until(() => js(`document.querySelector('.status-pill.on')?.textContent.includes('Klant PW')`), 10000, 'status bar');
    assert(!(await js(`document.body.innerText`)).includes('secret'), 'password not shown anywhere');
    await js(`[...document.querySelectorAll('#status-bar button')].find((b) => b.textContent === 'Disconnect').click()`);
    await until(() => js(`!document.querySelector('.status-pill.on')`), 10000, 'disconnected');
  });
  await test('after an SSO connect, disconnecting clears the "Connected" message', async () => {
    await resetCisco();
    await js(`[...document.querySelectorAll('.vpn')].find((n) => n.textContent.includes('Klant SSO')).click()`);
    await js(`document.querySelector('.btn.connect').click()`);
    await until(() => read(`${STATE}.gui`).trim() === 'sso.example.com', 40000, 'handover');
    // The user logs in in the Cisco app; VPNMaster sees Cisco connect.
    fs.writeFileSync(STATE, 'Connected');
    fs.writeFileSync(`${STATE}.server`, '94.143.189.252');
    await js(`api.cisco.status()`);
    await until(() => js(`document.querySelector('.result.ok')?.textContent.includes('Connected (94.143.189.252)')`), 5000, '"Connected" message');
    await js(`[...document.querySelectorAll('#status-bar button')].find((b) => b.textContent === 'Disconnect').click()`);
    await until(() => js(`document.querySelector('#toast').textContent === 'Disconnected'`), 10000, '"Disconnected"');
    eq(await js(`[!!document.querySelector('.result'), !!document.querySelector('.log')]`), [false, false], 'message and output cleared');
    await cisco.stopGui();
  });
  await test('Disconnect waits for Cisco and ignores a status asked just before', async () => {
    await resetCisco();
    fs.writeFileSync(STATE, 'Connected');
    fs.writeFileSync(`${STATE}.server`, '203.0.113.7');
    await js(`api.cisco.status()`);
    await until(() => js(`!!document.querySelector('.status-pill.on')`), 5000, 'connected');
    // A status check that is on its way while you click Disconnect still says "Connected".
    fs.writeFileSync(`${STATE}.slow`, '2500');
    js(`api.cisco.status()`);
    await wait(300);
    fs.rmSync(`${STATE}.slow`);
    await js(`[...document.querySelectorAll('#status-bar button')].find((b) => b.textContent === 'Disconnect').click()`);
    await until(() => js(`document.querySelector('#toast').textContent === 'Disconnected'`), 10000, '"Disconnected"');
    await wait(3000); // the slow, stale answer has arrived by now
    assert(!(await js(`!!document.querySelector('.status-pill.on')`)), 'not shown as connected again');
    eq(await js(`document.querySelector('.status-pill').textContent`), 'Disconnected', 'status bar');
    eq(await js(`[!!document.querySelector('.result'), !!document.querySelector('.log')]`), [false, false], '"Connected" message and Cisco output cleared');
    eq((await cisco.status()).state, 'Disconnected', 'agent');
  });
  await test('the window shows the Cisco version and says when Cisco was updated', async () => {
    await until(() => js(`document.querySelector('.cisco-version')?.textContent === 'Cisco Secure Client 5.1.20.333'`), 5000, 'version');
    fs.writeFileSync(`${STATE}.version`, '5.1.25.12');
    await js(`api.cisco.status()`);
    await until(() => js(`document.querySelector('#dialog-title').textContent === 'Cisco Secure Client was updated'`), 8000, 'update notice');
    assert(await js(`document.querySelector('#dialog-message').textContent.includes('from 5.1.20.333 to 5.1.25.12')`), 'versions named');
    await js(`document.querySelector('#dialog-ok').click()`);
    fs.rmSync(`${STATE}.version`);
  });
  await test('switching while connected asks first', async () => {
    await resetCisco();
    fs.writeFileSync(STATE, 'Connected\n');
    fs.writeFileSync(`${STATE}.server`, '203.0.113.9\n');
    await js(`[...document.querySelectorAll('.vpn')].find((n) => n.textContent.includes('Klant SSO')).click()`);
    await js(`document.querySelector('.btn.connect').click()`);
    await until(() => js(`!document.querySelector('#dialog-modal').classList.contains('hidden')`), 5000, 'confirmation');
    await js(`document.querySelector('#dialog-ok').click()`);
    await until(() => read(`${STATE}.gui`).trim() === 'sso.example.com', 40000, 'handover after disconnect');
    eq((await cisco.status()).state, 'Disconnected', 'disconnected first');
  });

  await resetCisco();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: still in use */ }
  app.exit(failed.length ? 1 : 0);
}

setTimeout(() => { console.log('timed out'); app.exit(2); }, 300000).unref();
run().catch((e) => { console.error(e); app.exit(1); });
