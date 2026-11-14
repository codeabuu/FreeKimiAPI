#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const { loadDotEnv } = require('../lib/env');
const { defaultAuthOutputPath } = require('./auth_import');

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));
const AUTH_PATH = defaultAuthOutputPath(process.env, ROOT);
const PROFILE_DIR = process.env.KIMI_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-kimi');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function divider() { console.log('======================================================'); }
function loadAuth() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, 'utf8');
    return raw.trim().startsWith('{') ? JSON.parse(raw) : { cookie: raw };
  } catch { return null; }
}
function decode(jwt) {
  try {
    const p = String(jwt).split('.')[1] || '';
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}
function status() {
  const auth = loadAuth();
  console.log('\nKimi account:');
  if (!auth) {
    console.log('  ❌ kimi-auth.json not found');
  } else {
    const token = String(auth.token || auth.authorization || '').replace(/^Bearer\s+/i, '');
    console.log(`  ✅ auth file: ${AUTH_PATH}`);
    console.log(`  token: ${token ? 'OK (' + token.length + ' chars)' : 'MISSING'}`);
    const claims = decode(token);
    if (claims?.exp) {
      const mins = Math.round((claims.exp * 1000 - Date.now()) / 60000);
      console.log(`  expires: ${mins > 0 ? 'in ' + mins + ' min' : Math.abs(mins) + ' min ago'}`);
    }
    console.log(`  cookies: ${auth.cookie ? 'OK' : 'MISSING'}`);
    console.log(`  shield: ${auth.shield ? 'OK' : 'not captured'}`);
    console.log(`  Chrome profile: ${fs.existsSync(PROFILE_DIR) ? PROFILE_DIR : 'not found'}`);
  }
}
function runDirectAuth() {
  const script = path.join(__dirname, 'kimi_chrome_auth.js');
  return spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env }).status === 0;
}
function runImportAuth() {
  const script = path.join(__dirname, 'auth_import.js');
  return spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env }).status === 0;
}
function removeLocalAuth() {
  if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { force: true });
  console.log('Removed kimi-auth.json. Chrome profile kept so the browser is not logged out unnecessarily.');
}
function printHelp() {
  divider();
  console.log('FreeKimiAPI — Kimi Web login manager');
  divider();
  console.log('Options:');
  console.log('  --login     Open Chrome and capture/refresh auth');
  console.log('  --import    Import an existing kimi-auth.json / cookie / cURL');
  console.log('  --status    Show auth status');
  console.log('  --remove    Delete the local kimi-auth.json');
  console.log('  --help      Help');
  console.log('Runs an interactive menu when no options are given.');
  divider();
}
async function menu() {
  while (true) {
    divider();
    status();
    divider();
    console.log('Menu:');
    console.log('1 - Log in / refresh Kimi login');
    console.log('2 - Import auth file / cookies / cURL');
    console.log('3 - Show status');
    console.log('4 - Delete the local auth file');
    console.log('5 - Exit');
    const choice = (await prompt('Your choice (Enter = 5): ')) || '5';
    if (choice === '1') runDirectAuth();
    else if (choice === '2') runImportAuth();
    else if (choice === '3') { status(); await prompt('\nPress Enter to return to the menu...'); }
    else if (choice === '4') removeLocalAuth();
    else if (choice === '5') break;
  }
}
(async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) return printHelp();
  if (args.has('--login') || args.has('--add') || args.has('--relogin')) return void runDirectAuth();
  if (args.has('--import')) return void runImportAuth();
  if (args.has('--status') || args.has('--list')) return status();
  if (args.has('--remove')) return removeLocalAuth();
  await menu();
})();
