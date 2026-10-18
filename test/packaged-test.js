// Checks an installed VPNMaster: its node-pty works and it can drive Cisco's
// command-line client (the stand-in in test/fake-cisco) through a pseudo-terminal.
//   ELECTRON_RUN_AS_NODE=1 <installed VPNMaster> test/packaged-test.js <resources dir>
const fs = require('fs');
const os = require('os');
const path = require('path');

const resources = path.resolve(process.argv[2] || '');
const app = path.join(resources, 'app.asar');
if (!fs.existsSync(app)) { console.error(`no app.asar in ${resources}`); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpnmaster-packaged-'));
process.env.VPNMASTER_CISCO_DIR = path.join(__dirname, 'fake-cisco');
process.env.VPNMASTER_FAKE_STATE = path.join(tmp, 'state');
process.env.VPNMASTER_PREFS_FILE = path.join(tmp, '.anyconnect');

const cisco = require(path.join(app, 'src', 'main', 'anyconnect.js'));
setTimeout(() => { console.error('timed out'); process.exit(2); }, 60000).unref();

(async () => {
  const st = await cisco.status();
  if (st.state !== 'Disconnected' || st.version !== '5.1.20.333') throw new Error(`status: ${JSON.stringify(st)}`);
  console.log('  ✓ status through the installed app');
  const result = await new Promise((resolve) => {
    const conn = new cisco.CliConnection({ name: 'PW', host: 'pw.example.com', userGroup: 'full', username: 'u' }, 'secret', {
      onPrompt: (p) => conn.answer(p.id, 'y'),
      onDone: resolve,
    });
    conn.start();
  });
  if (!result.ok) throw new Error(`connect: ${result.message}`);
  console.log('  ✓ connected with node-pty from the installed app');
  if (!(await cisco.status()).connected) throw new Error('not connected after connect');
  await cisco.disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('packaged app OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
