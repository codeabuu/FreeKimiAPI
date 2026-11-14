#!/usr/bin/env node
// Import a Kimi session from a JSON file, a raw cookie string, or a "Copy as
// cURL" text file, and write a normalized kimi-auth.json.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { loadDotEnv } = require('../lib/env');

const ROOT = path.resolve(__dirname, '..');
if (require.main === module) loadDotEnv(path.join(ROOT, '.env'));

function defaultAuthOutputPath(env = process.env, root = ROOT) {
  if (env.KIMI_AUTH_DIR) return path.join(env.KIMI_AUTH_DIR, 'kimi-auth.json');
  const first = String(env.KIMI_AUTH_PATH || '').split(',').map(s => s.trim()).find(Boolean);
  return first || path.join(root, 'kimi-auth.json');
}
const DEFAULT_OUT = defaultAuthOutputPath();

function argValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    for (const name of names) {
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return '';
}
function hasArg(args, ...names) { return args.some(a => names.includes(a)); }
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let answered = false;
    rl.question(question, ans => { answered = true; rl.close(); resolve(ans); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}
function stripBearer(v) { return String(v || '').trim().replace(/^Bearer\s+/i, ''); }

// Parse a "Copy as cURL (bash)" blob.
function parseCurl(text) {
  const out = {};
  const headerRe = /-H\s+(['"])([\s\S]*?)\1/g;
  let m;
  while ((m = headerRe.exec(text))) {
    const idx = m[2].indexOf(':');
    if (idx < 0) continue;
    const k = m[2].slice(0, idx).trim().toLowerCase();
    const v = m[2].slice(idx + 1).trim();
    if (k === 'authorization') out.authorization = stripBearer(v);
    if (k === 'cookie') out.cookie = v;
    if (k === 'x-msh-shield-data') out.shield = v;
    if (k === 'x-msh-device-id') out.deviceId = v;
    if (k === 'x-msh-session-id') out.sessionId = v;
    if (k === 'x-traffic-id') out.trafficId = v;
  }
  return out;
}

function normalizeAuth(input, extra = {}) {
  if (typeof input === 'string') input = input.trim().startsWith('{') ? JSON.parse(input) : { cookie: input };
  const token = stripBearer(
    input.token || input.access_token || input.accessToken || input.auth_token ||
    input.authorization || extra.token || process.env.KIMI_TOKEN || '',
  );
  let refreshToken = String(input.refreshToken || input.refresh_token || extra.refreshToken || '').trim();
  const cookie = String(input.cookie || input.cookies || extra.cookie || '').trim();
  return {
    token,
    refreshToken,
    cookie,
    shield: String(input.shield || input['x-msh-shield-data'] || extra.shield || '').trim(),
    deviceId: String(input.deviceId || input['x-msh-device-id'] || extra.deviceId || '').trim(),
    sessionId: String(input.sessionId || input['x-msh-session-id'] || extra.sessionId || '').trim(),
    trafficId: String(input.trafficId || input['x-traffic-id'] || extra.trafficId || '').trim(),
    baseUrl: 'https://www.kimi.ai',
  };
}
function validateAuth(auth) {
  const errors = [];
  if (!auth.token) errors.push('token/authorization missing');
  return errors;
}
function secureWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
function printHelp() {
  console.log(`FreeKimiAPI auth import

Usage:
  npm run auth:import -- --input ./chat.curl.txt
  npm run auth:import -- --input ./kimi-auth.json
  KIMI_TOKEN="<jwt>" npm run auth:import -- --input ./cookies.json

Options:
  --input, -i   Source: kimi-auth.json, cookie JSON/string, or "Copy as cURL" text
  --output, -o  Target auth path (default: ${DEFAULT_OUT})

Tip: npm run auth opens a dedicated Chrome window and fills this file for you.
`);
}
async function main(argv = process.argv.slice(2)) {
  if (hasArg(argv, '--help', '-h')) { printHelp(); return 0; }
  let inputPath = argValue(argv, '--input', '-i');
  const outputPath = path.resolve(argValue(argv, '--output', '-o') || DEFAULT_OUT);
  if (!inputPath) inputPath = await ask('Path to auth JSON / cookie file / cURL text: ');
  if (!String(inputPath || '').trim()) {
    console.error('[auth:import] No input file given. Use --input <file>.');
    return 2;
  }
  inputPath = path.resolve(inputPath.trim());
  const raw = fs.readFileSync(inputPath, 'utf8');
  let source;
  if (/curl\s/i.test(raw) && /-H\s/.test(raw)) source = parseCurl(raw);
  else if (raw.trim().startsWith('{') || raw.trim().startsWith('"')) source = JSON.parse(raw);
  else source = { cookie: raw.trim() };

  const auth = normalizeAuth(source);
  const errors = validateAuth(auth);
  if (errors.length) {
    console.error(`[auth:import] Invalid auth import: ${errors.join(', ')}`);
    console.error('[auth:import] The Kimi access token is required (Authorization header / localStorage).');
    return 2;
  }
  secureWriteJson(outputPath, auth);
  console.log(`[auth:import] Imported auth to ${outputPath}`);
  console.log(`[auth:import] token: OK (${auth.token.length} chars)`);
  console.log(`[auth:import] cookie: ${auth.cookie ? 'OK (' + auth.cookie.split(';').filter(Boolean).length + ' cookies)' : 'none'}`);
  console.log(`[auth:import] shield: ${auth.shield ? 'OK' : 'none (re-run npm run auth to capture it)'}`);
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error('[auth:import] ERROR:', e.message); process.exit(1); });
}
module.exports = { normalizeAuth, validateAuth, secureWriteJson, defaultAuthOutputPath, parseCurl, stripBearer };
