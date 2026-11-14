#!/usr/bin/env node
// Local diagnostics without touching the network unless asked.
const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('../lib/env');

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

function authPaths() {
    if (process.env.KIMI_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.KIMI_AUTH_DIR)
                .filter((f) => f.endsWith('.json'))
                .sort()
                .map((f) => path.resolve(process.env.KIMI_AUTH_DIR, f));
        } catch (e) {
            return [];
        }
    }
    const configured = process.env.KIMI_AUTH_PATH || './kimi-auth.json';
    return configured.split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(ROOT, p));
}

function decode(jwt) {
    try {
        const p = String(jwt).split('.')[1] || '';
        return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch { return null; }
}

let bad = 0;
const ok = (m) => console.log('  ok   ' + m);
const warn = (m) => console.log('  warn ' + m);
const fail = (m) => { bad++; console.log('  FAIL ' + m); };

console.log('FreeKimiAPI doctor\n');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`node ${process.versions.node}`); else fail(`node ${process.versions.node} (need >= 18)`);

let auth = null;
const paths = authPaths();
if (paths.length === 0) fail('no auth files found (KIMI_AUTH_DIR is empty)');
for (const authPath of paths) {
    try {
        const raw = fs.readFileSync(authPath, 'utf8').trim();
        const parsed = raw.startsWith('{') ? JSON.parse(raw) : { cookie: raw };
        const list = Array.isArray(parsed.accounts) ? parsed.accounts : [parsed];
        ok(`auth file ${authPath} (${list.length} account${list.length === 1 ? '' : 's'})`);
        if (!auth) auth = list.find((a) => a && (a.token || a.authorization || a.cookie)) || null;
    } catch (e) {
        fail(`auth file unreadable: ${authPath} — ${e.message}`);
    }
}

if (!auth && paths.length > 0) fail('no account with a token/cookie — run "npm run auth"');
if (auth) {
    const token = String(auth.token || auth.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (token) ok(`token (${token.length} chars)`); else fail('token missing — run "npm run auth"');
    if (auth.refreshToken || auth.refresh_token) ok('refresh token present'); else warn('no refresh token (token will expire in ~15 min)');
    if (auth.cookie) ok(`cookie (${auth.cookie.split(';').filter(Boolean).length} entries)`); else warn('no cookie');
    if (auth.shield) ok('shield header captured'); else warn('no shield header captured');
    if (token) {
        const claims = decode(token);
        if (claims?.exp) {
            const mins = Math.round((claims.exp * 1000 - Date.now()) / 60000);
            // Kimi's JWT clock runs behind local time; this is advisory only.
            if (mins > 0) ok(`token JWT valid for ~${mins} min`);
            else warn(`token JWT exp was ${Math.abs(mins)} min ago (run "npm run auth" if requests return 401)`);
        }
    }
}

console.log(bad ? `\n${bad} problem(s) found.` : '\nEverything looks good. Start with: npm start');
process.exitCode = bad ? 1 : 0;
