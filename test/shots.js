// Screenshots for the README, against the fake Cisco (test/fake-cisco).
//   bash scripts/headless.sh electron test/shots.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpnmaster-shots-'));
Object.assign(process.env, {
  VPNMASTER_DATA_DIR: path.join(tmp, 'data'),
  VPNMASTER_CISCO_DIR: path.join(__dirname, 'fake-cisco'),
  VPNMASTER_PREFS_FILE: path.join(tmp, '.anyconnect'),
  VPNMASTER_FAKE_STATE: path.join(tmp, 'state'),
  VPNMASTER_NO_TRAY: '1',
});
fs.mkdirSync(process.env.VPNMASTER_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.VPNMASTER_DATA_DIR, 'vpns.json'), JSON.stringify({ version: 1, vpns: [
  { name: 'Klant A', host: 'vpn.klant-a.example', auth: 'sso', color: '#4f9df7', notes: 'Log in with your Klant A Microsoft account.' },
  { name: 'Klant B (lab)', host: 'pw.example.com', userGroup: 'full', auth: 'password', username: 'erin', color: '#e5b454' },
] }));
// Own profile folder, so a VPNMaster that is open on this machine doesn't hold the
// single-instance lock (and its settings aren't touched).
app.setPath('userData', path.join(tmp, 'userData'));
require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = path.join(__dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });

setTimeout(() => app.exit(3), 30000).unref();
app.whenReady().then(async () => {
  await wait(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (name) => { await wait(400); fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG()); console.log(`  ${name}`); };
  await shot('welcome.png');
  await js(`[...document.querySelectorAll('.vpn')].find((n) => n.textContent.includes('Klant B')).click(); document.querySelector('.btn.connect').click()`);
  await wait(1200);
  await js(`document.querySelector('#prompt-input').value = 'secret'; document.querySelector('.prompt-bar').requestSubmit()`);
  await wait(800);
  await shot('connect.png');
  await js(`[...document.querySelectorAll('.prompt-bar button')].find((b) => b.textContent === 'Accept').click()`);
  await wait(1500);
  await shot('connected.png');
  await js(`[...document.querySelectorAll('.vpn')].find((n) => n.textContent.includes('Klant A')).click(); `);
  await js(`document.querySelector('.vpn-head .btn').click()`);
  await shot('editor.png');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
