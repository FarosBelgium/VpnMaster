// Local, file-based storage for saved VPNs.
//
// Everything lives in a single data directory (default: ./data next to the app):
//   vpns.json      saved VPNs (human-readable JSON)
//   settings.json  app settings and what VPNMaster remembers about Cisco
//
// Passwords are encrypted with the operating system's keychain via Electron safeStorage
// when one is available, and are written as "enc:<base64>". You may type a plaintext
// password into vpns.json by hand; it is encrypted automatically the next time the app
// starts. Files are written atomically with 0600 permissions (directory 0700).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const ENC_PREFIX = 'enc:';
const AUTH_MODES = ['sso', 'password'];

class Store {
  constructor(dir) {
    this.dir = dir;
    this.vpnsFile = path.join(dir, 'vpns.json');
    this.settingsFile = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not supported on this FS */ }
    this._migratePlaintextSecrets();
  }

  // ---- encryption -------------------------------------------------------

  canEncrypt() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux without a keyring Electron falls back to a hard-coded key,
    // which is obfuscation rather than encryption. Treat it as unavailable.
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
        && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  }

  seal(value) {
    if (!value) return '';
    if (!this.canEncrypt()) return value;
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  }

  // Returns '' when the value cannot be decrypted (e.g. vpns.json copied from another
  // machine or user account); the user is then asked for it when connecting.
  unseal(value) {
    if (!value) return '';
    if (!value.startsWith(ENC_PREFIX)) return value;
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      return '';
    }
  }

  // ---- file helpers -----------------------------------------------------

  _read() {
    if (!fs.existsSync(this.vpnsFile)) return { version: 1, vpns: [] };
    const text = fs.readFileSync(this.vpnsFile, 'utf8');
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new Error(`vpns.json is not valid JSON (${e.message}). Fix or remove it; it will not be overwritten.`);
    }
    if (!doc || typeof doc !== 'object') doc = { version: 1 };
    if (!Array.isArray(doc.vpns)) doc.vpns = [];
    return doc;
  }

  _write(doc, file = this.vpnsFile) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  }

  // ---- settings ---------------------------------------------------------------

  _settings() {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {}; // missing or broken: settings are not precious
    }
  }

  getSetting(key) {
    return this._settings()[key];
  }

  setSetting(key, value) {
    const s = this._settings();
    s[key] = value;
    this._write(s, this.settingsFile);
  }

  _migratePlaintextSecrets() {
    if (!fs.existsSync(this.vpnsFile)) return;
    let doc;
    try { doc = this._read(); } catch { return; } // surfaced later via list()
    let changed = false;
    for (const v of doc.vpns) {
      if (!v.id) { v.id = crypto.randomUUID(); changed = true; }
      if (this.canEncrypt() && v.password && !v.password.startsWith(ENC_PREFIX)) { v.password = this.seal(v.password); changed = true; }
    }
    if (changed) this._write(doc);
  }

  // ---- VPNs -----------------------------------------------------------------

  // VPNs as seen by the UI: the password is never sent to the renderer.
  list() {
    return this._read().vpns.map(publicVpn);
  }

  // Full record including the decrypted password (main process only).
  get(id) {
    const v = this._read().vpns.find((x) => x.id === id);
    if (!v) throw new Error('VPN not found');
    return { ...v, password: this.unseal(v.password) };
  }

  // input.password: string = set, null/undefined/'' = keep.  input.clearPassword: true = remove.
  save(input) {
    const doc = this._read();
    const existing = input.id ? doc.vpns.find((x) => x.id === input.id) : null;
    const host = normalizeHost(input.host);

    const vpn = {
      id: existing ? existing.id : crypto.randomUUID(),
      name: str(input.name) || host,
      host,
      userGroup: str(input.userGroup).replace(/^\/+|\/+$/g, ''),
      auth: AUTH_MODES.includes(input.auth) ? input.auth : 'sso',
      username: str(input.username),
      password: existing?.password || '',
      color: /^#[0-9a-f]{6}$/i.test(str(input.color)) ? str(input.color).toLowerCase() : '',
      notes: str(input.notes),
      lastUsed: existing?.lastUsed || 0,
    };

    if (!vpn.host) throw new Error('Server address is required');
    if (/[\s"'<>\\]/.test(vpn.host)) throw new Error('Server address cannot contain spaces, quotes, < > or \\');
    if (/[\s"'<>\\/]/.test(vpn.userGroup)) throw new Error('Group cannot contain spaces, quotes, slashes, < > or \\');
    if (/[\r\n]/.test(vpn.username)) throw new Error('Username cannot contain line breaks');

    if (input.clearPassword || vpn.auth === 'sso') vpn.password = '';
    else if (typeof input.password === 'string' && input.password) {
      if (/[\r\n]/.test(input.password)) throw new Error('Password cannot contain line breaks');
      vpn.password = this.seal(input.password);
    }

    if (existing) doc.vpns[doc.vpns.indexOf(existing)] = vpn;
    else doc.vpns.push(vpn);
    this._write(doc);
    return publicVpn(vpn);
  }

  remove(id) {
    const doc = this._read();
    doc.vpns = doc.vpns.filter((x) => x.id !== id);
    this._write(doc);
  }

  // Saves a password typed when connecting ("Save this password").
  setPassword(id, password) {
    const doc = this._read();
    const v = doc.vpns.find((x) => x.id === id);
    if (!v || !password || /[\r\n]/.test(password)) return;
    v.password = this.seal(password);
    this._write(doc);
  }

  touch(id) {
    const doc = this._read();
    const v = doc.vpns.find((x) => x.id === id);
    if (!v) return;
    v.lastUsed = Date.now();
    this._write(doc);
  }

  // Moves a VPN to another place in the list.
  move(id, toIndex) {
    const doc = this._read();
    const i = doc.vpns.findIndex((x) => x.id === id);
    if (i === -1) return this.list();
    const [v] = doc.vpns.splice(i, 1);
    doc.vpns.splice(Math.max(0, Math.min(doc.vpns.length, toIndex)), 0, v);
    this._write(doc);
    return this.list();
  }
}

// "https://vpn.example.com/" -> "vpn.example.com"; a path stays (it selects a group URL).
function normalizeHost(v) {
  return str(v).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function publicVpn(v) {
  const { password, ...rest } = v;
  return { ...rest, hasPassword: !!password };
}

module.exports = { Store, normalizeHost };
