// A stand-in for Cisco's command-line client (bin/vpn, vpncli.exe), for the tests.
// Runs on Linux, macOS and Windows. State lives in $VPNMASTER_FAKE_STATE.
//   pw.example.com   asks Group / Username / Password (secret), then a banner
//   otp.example.com  like pw.example.com, then asks "Answer:" (code 123456)
//   sso.example.com  needs an external login (refused like the real client)
const fs = require('fs');
const path = require('path');

const STATE = process.env.VPNMASTER_FAKE_STATE || path.join(__dirname, '..', 'state');
const read = (f, d = '') => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return d; } };
// Like the real agent, a disconnect takes a moment: "Disconnecting" for 1.5 s.
const state = () => {
  const s = read(STATE, 'Disconnected');
  const m = /^Disconnecting@(\d+)$/.exec(s);
  if (!m) return s;
  return Date.now() - Number(m[1]) > 1500 ? 'Disconnected' : 'Disconnecting';
};
const log = (line) => fs.appendFileSync(`${STATE}.log`, `${line}\n`);
// Like the Windows console (ConPTY): a new line is a cursor move, \x1b[<row>;1H, not "\n".
let row = 1;
const out = (s) => process.stdout.write(s.replace(/\n/g, () => `\x1b[${++row};1H`));

function banner() {
  out(`Cisco Secure Client (version ${process.env.VPNMASTER_FAKE_VERSION || read(`${STATE}.version`, '5.1.20.333')}) release.\n\nCopyright (c) 2004 - 2026, Cisco Systems, Inc. All rights reserved.\n\n\n  >> state: ${state()}\n  >> notice: Ready to connect.\n`);
}

function stats(s = state()) {
  const on = s === 'Connected';
  out(`\n[ Connection Information ]\n\n    Connection State:            ${s}\n    Tunnel Mode (IPv4):          Split Include\n    Duration:                    00:01:02\n\n[ Address Information ]\n\n    Client Address (IPv4):       ${on ? '10.8.0.12' : 'Not Available'}\n    Server Address:              ${on ? read(`${STATE}.server`) : 'Not Available'}\n\n`);
}

const cmd = process.argv[2];
if (cmd === 'stats') {
  // $STATE.slow: milliseconds this answer takes, reporting the state from when it was asked.
  const slow = Number(read(`${STATE}.slow`, '0'));
  const s = state();
  setTimeout(() => { banner(); stats(s); process.exit(0); }, slow);
  return;
}
if (cmd === 'state') { banner(); process.exit(0); }
if (cmd === 'disconnect') {
  banner();
  if (state() === 'Connected') fs.writeFileSync(STATE, `Disconnecting@${Date.now()}`);
  out('  >> state: Disconnecting\n  >> notice: Disconnect in progress, please wait...\n');
  process.exit(0);
}

// Interactive: read lines ourselves, so a password can be read without echo.
// Like vpncli.exe, anything typed before the first "VPN>" prompt is thrown away.
let ready = false;
let secret = false;
let line = '';
let waiting = null;
const stdin = process.stdin;
if (stdin.isTTY) stdin.setRawMode(true);
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  if (!ready) return;
  for (const ch of chunk) {
    if (ch === '\x03') process.exit(130);
    if (ch === '\r' || ch === '\n') {
      if (stdin.isTTY) out('\n');
      const l = line; line = '';
      const w = waiting; waiting = null;
      if (w) w(l);
      continue;
    }
    if (ch === '\x7f' || ch === '\b') { line = line.slice(0, -1); continue; }
    line += ch;
    if (stdin.isTTY && !secret) process.stdout.write(ch);
  }
});
stdin.on('end', () => process.exit(0));
const ask = (prompt, hidden = false) => new Promise((resolve) => {
  secret = hidden;
  out(prompt);
  waiting = (v) => { secret = false; resolve(v); };
});

async function connect(target) {
  const host = target.split('/')[0];
  log(`connect ${target}`);
  out(`  >> contacting host (${host}) for login information...\n`);
  if (host === 'sso.example.com') return out('  >> error: The server requires a web browser for single sign-on authentication.\n');
  if (host !== 'pw.example.com' && host !== 'otp.example.com') return out('  >> error: Connection attempt has failed due to server communication errors.\n');
  out('  >> Please enter your username and password.\n');
  if (target === host) log(`group=${await ask('    0) full\n    1) split\nGroup: [full] ')}`);
  log(`user=${await ask('Username: [] ')}`);
  const pass = await ask('Password: ', true);
  if (pass !== 'secret') return out('  >> Login failed.\n');
  if (host === 'otp.example.com' && await ask('Enter the code from your authenticator app\nAnswer: ') !== '123456') return out('  >> Login failed.\n');
  if (await ask('Welcome to the fake company network.\nUse is monitored.\n\naccept? [y/n]: ') !== 'y') return out('  >> state: Disconnected\n');
  out('  >> state: Connecting\n  >> notice: Establishing VPN session...\n');
  fs.writeFileSync(STATE, 'Connected');
  fs.writeFileSync(`${STATE}.server`, '203.0.113.7');
  out('  >> state: Connected\n');
}

(async () => {
  await new Promise((r) => setTimeout(r, 300)); // starting up
  banner();
  ready = true;
  for (;;) {
    const l = (await ask('VPN> ')).trim();
    if (l === 'exit' || l === 'quit') process.exit(0);
    if (l.startsWith('connect ')) await connect(l.slice(8).trim());
    else if (l) out('  >> error: Unknown command\n');
  }
})();
