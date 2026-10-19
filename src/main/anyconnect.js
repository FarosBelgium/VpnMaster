// Everything that talks to Cisco Secure Client (AnyConnect).
//
// Two ways to connect, depending on how a VPN logs in:
//
// - Username and password: through Cisco's command-line client (bin/vpn), started in a
//   pseudo-terminal. VPNMaster answers its prompts (group, username, password); other
//   prompts (a second password, a one-time code, a banner to accept) go to the window.
//   The password is only typed when the client asks for it, never put on a command line.
//
// - External login (SSO / SAML, e.g. a Microsoft login page): the command-line client
//   cannot show a login page, so VPNMaster hands over to Cisco's own app (bin/vpnui).
//   It writes the VPN into Cisco's user preferences (~/.vpn/.anyconnect) as the last used
//   server, which is what the Cisco app preselects, and opens the app. You click Connect
//   there and Cisco shows the login page. This is also why Cisco "forgets" a VPN that is
//   not in the company profile: it only remembers the last one you typed.
//
// If a password VPN turns out to want an external login, VPNMaster switches to the
// Cisco app by itself. When the company profile allows it, VPNMaster also has the Cisco
// app connect by itself when it opens ("AutoConnectOnStart"), so the login page appears
// without a click; the user's own setting is put back right after.
//
// Linux, macOS and Windows: only the install locations and the way the Cisco app is
// found, started and stopped differ.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ---- installation -------------------------------------------------------

function winDirs(...names) {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files'].filter(Boolean);
  return [...new Set(bases)].flatMap((b) => names.map((n) => path.join(b, 'Cisco', n)));
}

function programData(...parts) {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Cisco', ...parts);
}

// Where Cisco Secure Client (or the older AnyConnect) is installed, per platform.
// VPNMASTER_CISCO_DIR points at a stand-in for the tests (test/fake-cisco), whose
// programs are Node scripts: bin/vpn.js and bin/vpnui.js.
function paths() {
  const fake = process.env.VPNMASTER_CISCO_DIR;
  if (fake) {
    const dir = path.resolve(fake);
    return { dir, cli: path.join(dir, 'bin', 'vpn.js'), gui: path.join(dir, 'bin', 'vpnui.js'), guiNames: [], profileDirs: [path.join(dir, 'vpn', 'profile')], versionFile: '' };
  }
  if (IS_WIN) {
    const dir = winDirs('Cisco Secure Client', 'Cisco AnyConnect Secure Mobility Client').find((d) => fs.existsSync(path.join(d, 'vpncli.exe')));
    if (!dir) return null;
    // Secure Client 5: UI\csc_ui.exe; AnyConnect 4: vpnui.exe.
    const guis = [path.join(dir, 'UI', 'csc_ui.exe'), path.join(dir, 'vpnui.exe')];
    return {
      dir,
      cli: path.join(dir, 'vpncli.exe'),
      gui: guis.find((g) => fs.existsSync(g)) || guis[0],
      guiNames: ['csc_ui.exe', 'vpnui.exe'],
      profileDirs: [programData('Cisco Secure Client', 'VPN', 'Profile'), programData('Cisco AnyConnect Secure Mobility Client', 'Profile')],
      versionFile: path.join(dir, 'update.txt'),
    };
  }
  const dir = ['/opt/cisco/secureclient', '/opt/cisco/anyconnect'].find((d) => fs.existsSync(path.join(d, 'bin', 'vpn')));
  if (!dir) return null;
  const apps = ['/Applications/Cisco/Cisco Secure Client.app', '/Applications/Cisco/Cisco AnyConnect Secure Mobility Client.app'];
  return {
    dir,
    cli: path.join(dir, 'bin', 'vpn'),
    gui: IS_MAC ? apps.find((a) => fs.existsSync(a)) || apps[0] : path.join(dir, 'bin', 'vpnui'),
    guiNames: IS_MAC ? apps.map((a) => path.basename(a, '.app')) : ['vpnui'],
    profileDirs: [path.join(dir, 'vpn', 'profile'), path.join(dir, 'profile')],
    versionFile: path.join(dir, 'update.txt'),
  };
}

function requirePaths() {
  const p = paths();
  if (!p) {
    const where = IS_WIN ? 'C:\\Program Files (x86)\\Cisco' : '/opt/cisco/secureclient';
    const e = new Error(`Cisco Secure Client is not installed (not found in ${where})`);
    e.code = 'NO_CISCO';
    throw e;
  }
  return p;
}

// How to start one of Cisco's programs. The test stand-ins are Node scripts, run with
// this app's own runtime, or with VPNMASTER_NODE: on Windows Electron is a GUI program
// whose output never reaches a pseudo-terminal, so the tests use node.exe there.
function command(file, args = []) {
  if (file.endsWith('.js')) return { file: process.env.VPNMASTER_NODE || process.execPath, args: [file, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { file, args, env: {} };
}

// Cisco's per-user preferences: ~/.vpn/.anyconnect (Secure Client 5 on Linux and macOS),
// ~/.anyconnect (older AnyConnect), %LOCALAPPDATA%\Cisco\…\preferences.xml (Windows).
function prefsFile() {
  if (process.env.VPNMASTER_PREFS_FILE) return path.resolve(process.env.VPNMASTER_PREFS_FILE);
  const candidates = IS_WIN
    ? ['Cisco Secure Client\\VPN', 'Cisco AnyConnect Secure Mobility Client'].map((d) => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Cisco', d, 'preferences.xml'))
    : [path.join(os.homedir(), '.vpn', '.anyconnect'), path.join(os.homedir(), '.anyconnect')];
  return candidates.find((f) => fs.existsSync(f)) || candidates[0];
}

// ---- XML helpers (Cisco's files are small and flat; no parser needed) ----

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlUnescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  return m ? xmlUnescape(m[1].trim()) : '';
}

// ---- the company profile's servers ------------------------------------------

// The servers in the Cisco profile(s) your company installed, e.g. "Company VPN (Full)".
function profileHosts() {
  const p = paths();
  if (!p) return [];
  const hosts = [];
  for (const dir of p.profileDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xml')).sort(); } catch { continue; }
    for (const file of files) {
      let xml;
      try { xml = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
      const list = /<ServerList>([\s\S]*?)<\/ServerList>/.exec(xml);
      if (!list) continue;
      for (const m of list[1].matchAll(/<HostEntry>([\s\S]*?)<\/HostEntry>/g)) {
        const name = tagText(m[1], 'HostName');
        const address = tagText(m[1], 'HostAddress');
        if (!name && !address) continue;
        hosts.push({ name: name || address, address, userGroup: tagText(m[1], 'UserGroup'), profile: file });
      }
    }
  }
  return hosts;
}

// ---- preferences: preselect a server in the Cisco app -----------------------

function readPrefs() {
  const file = prefsFile();
  let xml = '';
  try { xml = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  return {
    file,
    exists: !!xml,
    defaultHostName: tagText(xml, 'DefaultHostName'),
    defaultHostAddress: tagText(xml, 'DefaultHostAddress'),
    defaultGroup: tagText(xml, 'DefaultGroup'),
    defaultUser: tagText(xml, 'DefaultUser'),
  };
}

const EMPTY_PREFS = `<?xml version="1.0" encoding="UTF-8"?>
<AnyConnectPreferences>
<DefaultUser></DefaultUser>
<DefaultSecondUser></DefaultSecondUser>
<ClientCertificateThumbprint></ClientCertificateThumbprint>
<MultipleClientCertificateThumbprints></MultipleClientCertificateThumbprints>
<ServerCertificateThumbprint></ServerCertificateThumbprint>
<DefaultHostName></DefaultHostName>
<DefaultHostAddress></DefaultHostAddress>
<DefaultGroup></DefaultGroup>
<ProxyHost></ProxyHost>
<ProxyPort></ProxyPort>
<SDITokenType>none</SDITokenType>
<ControllablePreferences></ControllablePreferences>
</AnyConnectPreferences>
`;

// Sets only the given elements; everything else in Cisco's file stays as it is.
// The first time, the original file is kept next to it as .anyconnect.vpnmaster-backup.
function writePrefs(values) {
  const file = prefsFile();
  let xml;
  try { xml = fs.readFileSync(file, 'utf8'); } catch { xml = EMPTY_PREFS; }
  if (!/<AnyConnectPreferences>/.test(xml)) throw new Error(`${file} is not a Cisco preferences file; it was left unchanged`);
  const backup = `${file}.vpnmaster-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);

  for (const [tag, value] of Object.entries(values)) {
    if (value == null) continue;
    const el = `<${tag}>${xmlEscape(value)}</${tag}>`;
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[^<]*</${tag}>|<${tag}\\s*/>`);
    xml = re.test(xml) ? xml.replace(re, () => el) : xml.replace('</AnyConnectPreferences>', `${el}\n</AnyConnectPreferences>`);
  }
  atomicWrite(file, xml);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o664 });
  fs.renameSync(tmp, file);
}

// What the Cisco app should show as server: a profile entry by its name, or an
// address, with the tunnel group as path ("vpn.example.com/engineering").
function target(vpn) {
  if (vpn.profileName) return vpn.profileName;
  return vpn.userGroup ? `${vpn.host}/${vpn.userGroup}` : vpn.host;
}

// ---- running the command-line client ----------------------------------------

function clean(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*\x07/g, '') // window titles (Windows console)
    // Windows' terminal (ConPTY) moves the cursor to the next line instead of writing a
    // line break: \x1b[<row>;<col>H. Without this, "Username:" would not start a line.
    .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, '\n')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r+\n/g, '\n') // a terminal turns "\r\n" into "\r\r\n"
    .replace(/\r/g, '\n');
}

function runCli(args, input, timeout = 20000) {
  const c = command(requirePaths().cli, args);
  return new Promise((resolve, reject) => {
    const child = execFile(c.file, c.args, { timeout, maxBuffer: 1024 * 1024, env: { ...cliEnv(), ...c.env }, windowsHide: true }, (err, stdout, stderr) => {
      const out = clean(`${stdout}${stderr}`);
      if (err && err.killed) return reject(new Error(`Cisco's vpn command did not answer within ${timeout / 1000} s`));
      if (err && !out.trim()) return reject(err);
      resolve(out);
    });
    if (input != null) child.stdin.end(input);
  });
}

function cliEnv() {
  return { ...process.env, LANG: 'C', LC_ALL: 'C' }; // English prompts, so they can be recognised
}

// Parses `vpn stats`: connection state, server, duration and addresses.
function parseStats(text) {
  const t = clean(text);
  const field = (label) => {
    const m = new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, 'mi').exec(t);
    return m ? m[1] : '';
  };
  let state = field('Connection State');
  if (!state) {
    const all = [...t.matchAll(/>>\s*state:\s*(.+)/g)];
    state = all.length ? all[all.length - 1][1].trim() : 'Unknown';
  }
  const na = (v) => (/^not available$/i.test(v) ? '' : v);
  // "  >> notice: Connected to vpn.example.com/group." or "…to Company VPN (Full)."
  const notices = [...t.matchAll(/>>\s*notice:\s*Connected to (.+?)\.?\s*$/gm)];
  return {
    state,
    connected: /^connected$/i.test(state),
    connectedTarget: /^connected$/i.test(state) && notices.length ? notices[notices.length - 1][1].trim() : '',
    server: na(field('Server Address')),
    clientAddress: na(field('Client Address \\(IPv4\\)')) || na(field('Client Address \\(IPv6\\)')),
    duration: field('Duration'),
    tunnelMode: na(field('Tunnel Mode \\(IPv4\\)')),
  };
}

// "Cisco Secure Client (version 5.1.20.333) release." at the top of every vpn output.
function parseVersion(text) {
  const m = /\(version ([0-9][0-9.]*)\)/i.exec(text);
  if (m) return m[1];
  const f = /^\s*(\d+)[,.](\d+)[,.](\d+)[,.](\d+)\s*$/.exec(text); // update.txt: 5,1,20,333
  return f ? f.slice(1).join('.') : '';
}

function installedVersion() {
  const p = paths();
  if (!p || !p.versionFile) return '';
  try { return parseVersion(fs.readFileSync(p.versionFile, 'utf8')); } catch { return ''; }
}

async function status() {
  const p = paths();
  if (!p) return { installed: false, state: 'Not installed', connected: false, guiRunning: false, version: '' };
  const out = await runCli(['stats']);
  return { installed: true, ...parseStats(out), version: parseVersion(out) || installedVersion(), guiRunning: (await guiPids()).length > 0 };
}

// `vpn disconnect` returns while Cisco is still "Disconnecting" (taking the tunnel down
// and restoring the network takes a few seconds), so wait for the end state.
async function disconnect({ waitMs = 20000 } = {}) {
  const out = await runCli(['disconnect'], null, 30000);
  const end = Date.now() + waitMs;
  for (;;) {
    const st = await status();
    const settling = /disconnecting|reconnecting|unknown/i.test(st.state);
    if (!st.connected && !settling) return st;
    if (Date.now() > end) {
      if (st.connected && /not available|another .*application/i.test(out)) {
        throw new Error('Cisco did not allow the disconnect from here. Disconnect in the Cisco Secure Client window.');
      }
      return st;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

// ---- the Cisco app (vpnui) -------------------------------------------------

function execText(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });
}

// This user's processes: [{ pid, name, cmd }].
async function processes() {
  if (process.platform === 'linux') {
    const uid = process.getuid();
    const list = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const uidLine = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${name}/status`, 'utf8'));
        if (!uidLine || Number(uidLine[1]) !== uid) continue;
        list.push({ pid: Number(name), name: fs.readFileSync(`/proc/${name}/comm`, 'utf8').trim(), cmd: fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ') });
      } catch { /* process ended */ }
    }
    return list;
  }
  if (IS_WIN) {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let rows = [];
    try { rows = JSON.parse(out || '[]'); } catch { /* none */ }
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, name: String(r.Name || ''), cmd: String(r.CommandLine || '') }));
  }
  const out = await execText('ps', ['-x', '-o', 'pid=,comm=']); // macOS: comm is the full program path
  const args = await execText('ps', ['-x', '-o', 'pid=,args=']);
  const cmds = new Map(args.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), name: path.basename(m[2].trim()), cmd: cmds.get(Number(m[1])) || m[2] }));
}

// Process ids of this user's Cisco app.
async function guiPids() {
  const p = paths();
  if (!p) return [];
  const names = p.guiNames.map((n) => n.toLowerCase());
  const gui = p.gui.toLowerCase();
  return (await processes())
    .filter((x) => x.pid !== process.pid && (names.includes(x.name.toLowerCase()) || x.cmd.toLowerCase().includes(gui)))
    .map((x) => x.pid);
}

function kill(pid, force) {
  // Windows: closing the Cisco window only hides it in the tray, so always end it.
  if (IS_WIN) return execText('taskkill', ['/PID', String(pid), '/T', '/F']);
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ }
  return Promise.resolve();
}

async function stopGui() {
  const pids = await guiPids();
  if (!pids.length) return false;
  await Promise.all(pids.map((pid) => kill(pid, false)));
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!(await guiPids()).length) return true;
  }
  await Promise.all((await guiPids()).map((pid) => kill(pid, true)));
  return true;
}

function startGui() {
  const { gui } = requirePaths();
  if (!fs.existsSync(gui)) throw new Error(`The Cisco app was not found (${gui})`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const c = IS_MAC && gui.endsWith('.app') ? { file: 'open', args: ['-a', gui], env: {} } : command(gui);
  const child = spawn(c.file, c.args, { detached: true, stdio: 'ignore', env: { ...env, ...c.env }, windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

// ---- connecting by itself when the Cisco app opens ---------------------------

// The setting lives inside <ControllablePreferences>; Cisco only honours it when the
// company profile marks AutoConnectOnStart as UserControllable.
const AUTO = 'AutoConnectOnStart';
const autoMarker = () => `${prefsFile()}.vpnmaster-autoconnect`;

function profileAllowsAutoConnect() {
  const p = paths();
  if (!p) return false;
  for (const dir of p.profileDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xml')); } catch { continue; }
    for (const f of files) {
      try {
        if (/<AutoConnectOnStart[^>]*UserControllable="true"/i.test(fs.readFileSync(path.join(dir, f), 'utf8'))) return true;
      } catch { /* unreadable */ }
    }
  }
  return false;
}

function readControllable(tag) {
  let xml = '';
  try { xml = fs.readFileSync(prefsFile(), 'utf8'); } catch { return null; }
  const block = /<ControllablePreferences>([\s\S]*?)<\/ControllablePreferences>/.exec(xml);
  if (!block) return null;
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block[1]);
  return m ? m[1].trim() : null;
}

// value null = remove the element (Cisco then uses the profile's default).
function writeControllable(tag, value) {
  const file = prefsFile();
  let xml;
  try { xml = fs.readFileSync(file, 'utf8'); } catch { xml = EMPTY_PREFS; }
  if (!/<AnyConnectPreferences>/.test(xml)) throw new Error(`${file} is not a Cisco preferences file; it was left unchanged`);
  xml = xml.replace(/<ControllablePreferences\s*\/>/, '<ControllablePreferences></ControllablePreferences>');
  if (!/<ControllablePreferences>/.test(xml)) xml = xml.replace('</AnyConnectPreferences>', '<ControllablePreferences></ControllablePreferences>\n</AnyConnectPreferences>');
  xml = xml.replace(/<ControllablePreferences>([\s\S]*?)<\/ControllablePreferences>/, (_m, inner) => {
    const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
    const el = value == null ? '' : `<${tag}>${xmlEscape(value)}</${tag}>`;
    return `<ControllablePreferences>${re.test(inner) ? inner.replace(re, el) : inner + el}</ControllablePreferences>`;
  });
  atomicWrite(file, xml);
}

// Turns on "connect when the Cisco app starts" and remembers the user's own value.
function enableAutoConnect() {
  if (!fs.existsSync(autoMarker())) fs.writeFileSync(autoMarker(), JSON.stringify({ original: readControllable(AUTO) }));
  writeControllable(AUTO, 'true');
}

// Puts the user's own value back. Safe to call any time; does nothing when VPNMaster
// did not change it.
function restoreAutoConnect() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(autoMarker(), 'utf8')); } catch { return false; }
  try { writeControllable(AUTO, saved.original ?? null); } catch { return false; }
  fs.rmSync(autoMarker(), { force: true });
  return true;
}

// Preselects the VPN in the Cisco app and opens it, so its own login (SSO) can run.
// The app only reads the preferences when it starts, so an open one is restarted.
// autoConnect: let the Cisco app connect by itself (when the company profile allows it).
async function openInCisco(vpn, { autoConnect = true } = {}) {
  requirePaths();
  const values = { DefaultHostName: target(vpn), DefaultHostAddress: vpn.profileName ? '' : vpn.host, DefaultGroup: '' };
  if (vpn.username) values.DefaultUser = vpn.username;
  await stopGui();
  restoreAutoConnect(); // a previous handover that never finished
  writePrefs(values);
  const auto = autoConnect && profileAllowsAutoConnect();
  if (auto) enableAutoConnect();
  startGui();
  return { handedOver: true, target: target(vpn), autoConnect: auto };
}

// ---- connecting with the command-line client ---------------------------------

// Recognised prompts of `vpn` (it prints them without a newline and waits).
const PROMPTS = [
  { kind: 'group', re: /(?:^|\n)[ \t]*Group:[ \t]*(?:\[[^\]\n]*\][ \t]*)?$/ },
  { kind: 'username', re: /(?:^|\n)[ \t]*Username:[ \t]*(?:\[[^\]\n]*\][ \t]*)?$/ },
  { kind: 'password', re: /(?:^|\n)[ \t]*Password:[ \t]*$/ },
  { kind: 'accept', re: /accept\?[ \t]*\[y\/n\]:[ \t]*$/i },
  // Anything else ending in ":" or "?" waiting for input: a second password, a code…
  { kind: 'other', re: /(?:^|\n)([^\n>]{2,80}[:?])[ \t]*$/ },
];
const SSO_HINT = /single.?sign.?on|\bSAML\b|\bSSO\b|external browser|web browser|use the GUI/i;
const NOT_AVAILABLE = /Connect not available|another .*(application|client) is running/i;

// A connection attempt with the command-line client. Events (all optional):
//   onOutput(text)                     raw client output, for the log in the window
//   onPrompt({ id, kind, text })       the client asks something VPNMaster cannot answer
//   onDone({ ok, state, message, sso }) finished; sso: true = needs the Cisco app instead
class CliConnection {
  constructor(vpn, password, events) {
    this.vpn = vpn;
    this.password = password || '';
    this.events = events;
    this.buf = '';
    this.out = '';
    this.passwordSent = 0;
    this.promptSeq = 0;
    this.pending = null;
    this.done = false;
    this.connectSent = false;
  }

  start() {
    const c = command(requirePaths().cli);
    const pty = require('node-pty');
    this.proc = pty.spawn(c.file, c.args, { name: 'dumb', cols: 200, rows: 50, cwd: os.homedir(), env: { ...cliEnv(), ...c.env } });
    this.proc.onData((d) => this._data(d));
    this.proc.onExit(() => this._exited());
    this.timer = setTimeout(() => this._finish({ ok: false, message: 'Connecting took too long and was stopped' }), CONNECT_TIMEOUT_MS);
    // Only type the connect command once the client asks for it ("VPN>"): on Windows it
    // throws away anything typed before that. Fallback for a client that never shows it.
    this.connectTimer = setTimeout(() => this._connect(), 20000);
  }

  _connect() {
    if (this.connectSent || this.done) return;
    this.connectSent = true;
    clearTimeout(this.connectTimer);
    this._send(`connect ${target(this.vpn)}`);
  }

  _send(line) {
    if (this.proc && !this.done) this.proc.write(`${line}\r`);
  }

  _data(d) {
    const text = clean(d);
    this.out += text;
    this.buf += text;
    this.events.onOutput?.(text);
    if (this.done) return;
    if (!this.connectSent) {
      if (/(?:^|\n)\s*VPN>\s*$/.test(this.out)) this._connect();
      return;
    }

    if (/>>\s*state:\s*Connected\b/i.test(this.buf)) {
      this._send('exit'); // the tunnel stays up; only this client stops
      return this._finish({ ok: true, state: 'Connected', message: `Connected to ${this.vpn.name || target(this.vpn)}` });
    }
    if (NOT_AVAILABLE.test(this.buf)) {
      return this._finish({ ok: false, guiBlocking: true, message: 'Another Cisco window is controlling the VPN. Close the Cisco Secure Client window and try again.' });
    }
    if (SSO_HINT.test(this.buf) && !/>>\s*state:\s*Connected/i.test(this.buf)) {
      return this._finish({ ok: false, sso: true, message: 'This VPN logs in through an external login page' });
    }
    const failed = /(?:>>\s*)?(Login failed|Authentication failed)[^\n]*/i.exec(this.buf);
    if (failed && this.passwordSent) {
      return this._finish({ ok: false, message: failed[0].replace(/^>>\s*/, '').trim() });
    }
    const err = />>\s*error:\s*([^\n]+)/i.exec(this.buf);
    if (err && /\nVPN>\s*$/.test(this.buf)) return this._finish({ ok: false, message: err[1].trim() });

    this._answerPrompt();
  }

  _answerPrompt() {
    if (this.pending) return;
    const tail = this.buf.slice(-400);
    if (/\nVPN>\s*$/.test(tail) || /^VPN>\s*$/.test(tail)) return;
    for (const p of PROMPTS) {
      const m = p.re.exec(tail);
      if (!m) continue;
      this.buf = '';
      if (p.kind === 'group') return this._send(this.vpn.userGroup || '');
      if (p.kind === 'username' && this.vpn.username) return this._send(this.vpn.username);
      if (p.kind === 'password' && this.password && this.passwordSent === 0) {
        this.passwordSent++;
        return this._send(this.password);
      }
      // VPNMaster cannot answer this one: ask in the window.
      // A banner is shown in full; for other questions the question itself is enough.
      const lines = tail.trim().split('\n');
      const text = p.kind === 'accept' ? lines.slice(-12).join('\n') : p.kind === 'other' ? m[1].trim() : lines[lines.length - 1].trim();
      const secret = p.kind === 'password' || (p.kind === 'other' && /password|passcode|\bpin\b/i.test(m[1]));
      this.pending = { id: ++this.promptSeq, kind: p.kind, secret, text };
      this.events.onPrompt?.(this.pending);
      return;
    }
  }

  answer(id, value) {
    if (!this.pending || this.pending.id !== id) return false;
    if (this.pending.kind === 'password') this.passwordSent++;
    this.pending = null;
    this._send(value);
    return true;
  }

  cancel() {
    this._finish({ ok: false, cancelled: true, message: 'Cancelled' });
  }

  _exited() {
    if (!this.done) this._finish({ ok: false, message: lastLine(this.out) || 'Cisco\'s vpn command stopped' });
  }

  _finish(result) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    clearTimeout(this.connectTimer);
    this.pending = null;
    if (!result.ok && this.proc) {
      // Stops an unfinished login; the agent then goes back to "Disconnected".
      try { this.proc.write('\x03'); } catch { /* exited */ }
    }
    setTimeout(() => { try { this.proc.kill(); } catch { /* exited */ } }, result.ok ? 1500 : 300);
    this.events.onDone?.(result);
  }
}

function lastLine(text) {
  const lines = clean(text).split('\n').map((l) => l.replace(/^\s*>>\s*/, '').trim()).filter((l) => l && !/^VPN>/.test(l));
  return lines[lines.length - 1] || '';
}

module.exports = {
  paths, prefsFile, profileHosts, readPrefs, writePrefs, target,
  parseStats, parseVersion, installedVersion, status, disconnect, guiPids, stopGui, startGui, openInCisco,
  enableAutoConnect, restoreAutoConnect, readControllable, profileAllowsAutoConnect,
  CliConnection, clean,
};
