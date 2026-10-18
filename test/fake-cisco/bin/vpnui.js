// A stand-in for the Cisco app (vpnui): records which server was preselected and whether
// it would connect by itself, then idles until it is stopped.
const fs = require('fs');
const path = require('path');

const STATE = process.env.VPNMASTER_FAKE_STATE || path.join(__dirname, '..', 'state');
let prefs = '';
try { prefs = fs.readFileSync(process.env.VPNMASTER_PREFS_FILE, 'utf8'); } catch { /* none */ }
const host = (/<DefaultHostName>([^<]*)/.exec(prefs) || [])[1] || '';
const auto = /<ControllablePreferences>[\s\S]*<AutoConnectOnStart>true<\/AutoConnectOnStart>[\s\S]*<\/ControllablePreferences>/.test(prefs);
fs.writeFileSync(`${STATE}.gui`, `${host}\n`);
fs.writeFileSync(`${STATE}.gui-auto`, auto ? 'auto' : 'manual');
setInterval(() => {}, 1000);
