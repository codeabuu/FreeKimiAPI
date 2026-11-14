#!/usr/bin/env node
/*
  Opens/reuses a separate Chrome profile for Kimi Web login and extracts the
  minimum auth metadata into kimi-auth.json.

  Usage:
    npm run auth
    # optional: CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" npm run auth
    # reuse a running auth Chrome: KIMI_REUSE_CHROME=1 npm run auth

  Flow:
    1. Log in at https://www.kimi.ai/ in the opened Chrome window.
    2. Send one short message (e.g. "ok") so the app issues an API request.
    3. Return to the terminal and press Enter.

  Kimi access tokens live ~15 minutes. With KIMI_AUTH_WATCH=1 (default) this
  script keeps running and rewrites kimi-auth.json whenever the browser
  refreshes the token. Leave its Chrome window open while the proxy runs.
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { loadDotEnv } = require('../lib/env');
const { defaultAuthOutputPath, secureWriteJson, stripBearer } = require('./auth_import');

const repoRoot = path.resolve(__dirname, '..');
loadDotEnv(path.join(repoRoot, '.env'));

const configuredProfile = process.env.KIMI_CHROME_PROFILE || path.join(repoRoot, '.chrome-for-testing-profile-kimi');
const configuredProfileDirectory = String(process.env.KIMI_CHROME_PROFILE_DIRECTORY || '').trim();

// Accept either a dedicated user-data-dir, a user-data-dir + profile directory,
// or a full path to an existing profile folder (…\User Data\Profile 29).
function resolveProfileLayout(value, directoryName) {
    const resolved = path.resolve(value);
    if (directoryName) return { userDataDir: resolved, profileDirectory: directoryName };
    const base = path.basename(resolved);
    const parent = path.dirname(resolved);
    const looksLikeProfile = /^(?:Default|Profile \d+|Guest Profile|System Profile)$/i.test(base);
    if (looksLikeProfile && fs.existsSync(path.join(parent, 'Local State'))) {
        return { userDataDir: parent, profileDirectory: base };
    }
    return { userDataDir: resolved, profileDirectory: '' };
}
const profileLayout = resolveProfileLayout(configuredProfile, configuredProfileDirectory);
const profileDir = profileLayout.userDataDir;
const profileDirectory = profileLayout.profileDirectory;
// Only the helper's own dedicated profile may ever be deleted. Pointing
// KIMI_CHROME_PROFILE at a real Chrome profile must never erase it.
const managedProfile = /^\.chrome-(?:for-testing-)?profile-/.test(path.basename(profileDir));
const port = Number(process.env.KIMI_CHROME_PORT || 9335);
const outPath = defaultAuthOutputPath(process.env, repoRoot);
const url = 'https://www.kimi.ai/';
const reuseChrome = /^(1|true|yes|on)$/i.test(process.env.KIMI_REUSE_CHROME || '');
const keepProfile = /^(1|true|yes|on)$/i.test(process.env.KIMI_KEEP_CHROME_PROFILE || '');
const watch = !/^(0|false|no|off)$/i.test(process.env.KIMI_AUTH_WATCH || '1');
const WATCH_MS = Number(process.env.KIMI_AUTH_WATCH_MS || 20000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve(ans); }));
}
function shellPatternSafe(s) { return String(s).replace(/[\\"']/g, '.'); }
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }

function killExistingTestingChrome() {
    if (process.platform === 'win32') return;
    for (const pattern of [`--remote-debugging-port=${port}`, profileDir].map(shellPatternSafe)) {
        try { execFileSync('pkill', ['-f', '--', pattern], { stdio: 'ignore' }); } catch {}
    }
    sleepSync(800);
}

async function devtoolsReady() {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        return r.ok ? r.json() : null;
    } catch { return null; }
}
async function closeChromeViaDevtools() {
    if (typeof WebSocket === 'undefined') return false;
    const version = await devtoolsReady();
    if (!version?.webSocketDebuggerUrl) return false;
    try {
        const browser = new CDP(version.webSocketDebuggerUrl);
        await Promise.race([browser.ready(), sleep(2000)]);
        await Promise.race([browser.send('Browser.close'), sleep(2000)]);
        browser.close();
    } catch {}
    for (let i = 0; i < 20 && (await devtoolsReady()); i++) await sleep(250);
    return true;
}

function removeProfileSafely(dir) {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            if (i === 4) {
                const staleDir = `${dir}.stale-${Date.now()}`;
                try { fs.renameSync(dir, staleDir); }
                catch (renameError) {
                    throw new Error(`Chrome profile ${dir} is still in use (${renameError.code || renameError.message}). Close the Kimi auth Chrome window and run again.`);
                }
                try { fs.rmSync(staleDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch {}
                console.log(`[auth] Old profile was busy; moved it aside: ${staleDir}`);
                return;
            }
        }
        sleepSync(300);
    }
}

function resolveChromePath() {
    if (process.env.KIMI_CHROME_PATH) return process.env.KIMI_CHROME_PATH;
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
        const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
        try {
            const candidates = fs.readdirSync(cacheRoot).flatMap((dir) => {
                const baseDir = path.join(cacheRoot, dir);
                if (process.platform === 'win32') return [path.join(baseDir, 'chrome-win64', 'chrome.exe')];
                if (process.platform === 'darwin') {
                    return [
                        path.join(baseDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                        path.join(baseDir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                    ];
                }
                return [path.join(baseDir, 'chrome-linux64', 'chrome')];
            }).filter((p) => p && fs.existsSync(p)).sort().reverse();
            if (candidates[0]) return candidates[0];
        } catch {}
    }
    if (process.platform === 'win32') {
        for (const c of [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ]) if (c && fs.existsSync(c)) return c;
    } else if (process.platform === 'darwin') {
        for (const c of [
            '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ]) if (fs.existsSync(c)) return c;
    }
    return '';
}
const chromePath = resolveChromePath();

async function fetchJson(u, opts) {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
    return await r.json();
}
async function waitDevtools() {
    for (let i = 0; i < 80; i++) {
        const v = await devtoolsReady();
        if (v) return v;
        await sleep(250);
    }
    throw new Error('Chrome DevTools endpoint did not start');
}
async function getPageTarget() {
    for (let i = 0; i < 40; i++) {
        const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
        const page = targets.find((t) => t.type === 'page' && /kimi\.ai/.test(t.url)) || targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
        await sleep(250);
    }
    throw new Error('No Chrome page target found');
}

class CDP {
    constructor(wsUrl) {
        if (typeof WebSocket === 'undefined') {
            throw new Error(`npm run auth needs Node.js 22+ (built-in WebSocket); this is Node ${process.versions.node}.`);
        }
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
                if (this.events.length > 3000) this.events.shift();
            }
        };
    }
    ready() {
        return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    close() { try { this.ws.close(); } catch {} }
}

function decodeJwt(token) {
    try {
        const p = String(token).split('.')[1] || '';
        return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch { return null; }
}
function normalizeToken(raw) {
    if (!raw) return '';
    let v = String(raw).trim();
    try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object') {
            v = parsed.value || parsed.token || parsed.access_token || parsed.accessToken || parsed.accessTokenValue || '';
            if (typeof v !== 'string') v = '';
        }
    } catch {}
    v = stripBearer(v);
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) ? v : '';
}

async function readPageState(cdp) {
    const res = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const out = {href: location.href, localStorage:{}, sessionStorage:{}};
          for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i);out.localStorage[k]=localStorage.getItem(k);}
          for (let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);out.sessionStorage[k]=sessionStorage.getItem(k);}
          return JSON.stringify(out);
        })()`,
        returnByValue: true,
    });
    try { return JSON.parse(res.result.value || '{}'); } catch { return {}; }
}

function scanNetwork(cdp) {
    const latest = {};
    const chat = {};
    for (const ev of cdp.events) {
        if (ev.method !== 'Network.requestWillBeSent') continue;
        const req = ev.params?.request;
        if (!req || !/kimi\.ai/i.test(req.url || '')) continue;
        const h = {};
        for (const [k, v] of Object.entries(req.headers || {})) h[k.toLowerCase()] = String(v);
        const picked = {
            authorization: h.authorization,
            shield: h['x-msh-shield-data'],
            deviceId: h['x-msh-device-id'],
            sessionId: h['x-msh-session-id'],
            trafficId: h['x-traffic-id'],
        };
        for (const [k, v] of Object.entries(picked)) if (v) latest[k] = v;
        if (/ChatService\/Chat/.test(req.url)) {
            for (const [k, v] of Object.entries(picked)) if (v) chat[k] = v;
            chat.at = ev.params.timestamp;
        }
    }
    return { latest, chat };
}

async function capture(cdp) {
    const page = await readPageState(cdp);
    const net = scanNetwork(cdp);
    const stores = [page.localStorage || {}, page.sessionStorage || {}];

    let token =
        stripBearer(net.chat.authorization || '') ||
        stripBearer(net.latest.authorization || '');

    if (!token) {
        for (const store of stores) {
            for (const key of ['token', 'access_token', 'accessToken', 'auth_token']) {
                token = normalizeToken(store[key]);
                if (token) break;
            }
            if (token) break;
        }
    }
    if (!token) {
        for (const store of stores) {
            for (const [k, v] of Object.entries(store)) {
                if (/token/i.test(k) && !/refresh/i.test(k)) {
                    token = normalizeToken(v);
                    if (token) break;
                }
            }
            if (token) break;
        }
    }

    let refreshToken = '';
    for (const store of stores) {
        for (const [k, v] of Object.entries(store)) {
            if (/refresh/i.test(k)) { refreshToken = normalizeToken(v) || String(v).trim(); if (refreshToken) break; }
        }
        if (refreshToken) break;
    }

    const claims = decodeJwt(token) || {};
    const cookieRes = await cdp.send('Network.getAllCookies');
    const cookies = (cookieRes.cookies || []).filter((c) => /(^|\.)kimi\.ai$/i.test(String(c.domain || '').trim()));
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    return {
        token,
        refreshToken,
        cookie,
        shield: net.chat.shield || net.latest.shield || '',
        deviceId: net.chat.deviceId || net.latest.deviceId || String(claims.device_id || ''),
        sessionId: net.chat.sessionId || net.latest.sessionId || String(claims.ssid || ''),
        trafficId: net.chat.trafficId || net.latest.trafficId || String(claims.sub || ''),
        baseUrl: 'https://www.kimi.ai',
        tokenExpiresAt: claims.exp || 0,
        capturedAt: new Date().toISOString(),
        href: page.href,
        cookiesCount: cookies.length,
        fromChatRequest: Boolean(net.chat.authorization),
    };
}

function chromeInstallHelp() {
    return `Chrome/Chrome for Testing not found.

How to fix:
  Windows PowerShell:
    $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; npm run auth
  macOS:
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run auth
  Linux:
    CHROME_PATH=$(which chromium) npm run auth`;
}

function statusLine(a) {
    const mins = a.tokenExpiresAt ? Math.round((a.tokenExpiresAt * 1000 - Date.now()) / 60000) : null;
    return `token ${a.token ? a.token.length + ' chars' : 'MISSING'}${mins !== null ? ` (~${mins} min left)` : ''}, ` +
        `cookie ${a.cookiesCount}, shield ${a.shield ? 'OK' : 'none'}, refresh ${a.refreshToken ? 'OK' : 'none'}`;
}

async function main() {
    if (!fs.existsSync(chromePath)) throw new Error(chromeInstallHelp());
    if (typeof WebSocket === 'undefined') throw new Error(`npm run auth needs Node.js 22+; this is Node ${process.versions.node}.`);

    if (!reuseChrome) {
        await closeChromeViaDevtools();
        killExistingTestingChrome();
        if (managedProfile && !keepProfile && fs.existsSync(profileDir)) {
            removeProfileSafely(profileDir);
            console.log(`[auth] Removed old Chrome profile: ${profileDir}`);
        } else if (!managedProfile) {
            console.log('[auth] External Chrome profile selected; it will not be removed.');
            if (await devtoolsReady()) {
                console.log(`[auth] WARNING: something is already answering on DevTools port ${port}; close it first.`);
            }
        }
    }
    fs.mkdirSync(profileDir, { recursive: true });

    if (reuseChrome && (await devtoolsReady())) {
        console.log(`[auth] Reusing Chrome DevTools on port ${port}`);
    } else {
        console.log(`[auth] Launching Chrome: ${chromePath}`);
        console.log(`[auth] User data: ${profileDir}${profileDirectory ? ` (profile: ${profileDirectory})` : ''}`);
        if (!managedProfile) {
            console.log('[auth] Using an existing Chrome profile requires ALL Chrome windows to be closed first.');
        }
        const chrome = spawn(chromePath, [
            `--user-data-dir=${profileDir}`,
            ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
            `--remote-debugging-port=${port}`,
            '--use-mock-keychain',
            '--password-store=basic',
            '--disable-sync',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            url,
        ], { stdio: 'ignore', detached: true });
        chrome.unref();
    }

    try {
        await waitDevtools();
    } catch (error) {
        throw new Error(`${error.message}. If you reused your main Chrome profile, close ALL Chrome windows first. Recent Chrome versions block remote debugging on the default user data directory — use the dedicated profile or the chrome-extension instead.`);
    }
    const target = await getPageTarget();
    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    console.log('\n[auth] Chrome is open. Log in to Kimi in THIS separate window.');
    console.log('[auth] Then send a short message, for example: ok');
    console.log('[auth] Waiting up to 5 minutes for the session...');

    let auth = null;
    for (let i = 0; i < 300; i++) {
        auth = await capture(cdp);
        if (auth.token) break;
        if (i && i % 15 === 0) console.log(`[auth] still waiting (${i}s) — log in and send a message in the Chrome window`);
        await sleep(1000);
    }

    if (!auth?.token) {
        console.log(`[auth] NOT saved: no access token found. ${outPath} left unchanged.`);
        console.log('[auth] Make sure you are logged in, then run npm run auth again.');
        cdp.close();
        process.exitCode = 2;
        return;
    }

    const { href, cookiesCount, ...persisted } = auth;
    secureWriteJson(outPath, persisted);
    console.log(`[auth] Saved: ${outPath}`);
    console.log(`[auth] ${statusLine(auth)}`);
    console.log(`[auth] source: ${auth.fromChatRequest ? 'live Chat request headers' : 'browser storage'}`);

    if (!watch) { cdp.close(); return; }

    console.log('\n[auth] Watch mode: leave this window open. Tokens refresh every ~15 min.');
    console.log('[auth] The auth file updates automatically. Press Ctrl+C to stop.\n');
    let last = auth.token;
    let lastShield = auth.shield;
    const timer = setInterval(async () => {
        try {
            const next = await capture(cdp);
            if (!next.token) return;
            if (next.token !== last || next.shield !== lastShield) {
                last = next.token;
                lastShield = next.shield;
                const { href: h, cookiesCount: c, ...p } = next;
                secureWriteJson(outPath, p);
                console.log(`[auth] ${new Date().toLocaleTimeString()} refreshed — ${statusLine(next)}`);
            }
        } catch (e) {
            console.log(`[auth] watch error: ${e.message}`);
        }
    }, WATCH_MS);

    process.on('SIGINT', () => {
        clearInterval(timer);
        console.log('\n[auth] Stopped watching. Chrome stays open; kimi-auth.json keeps its last token.');
        cdp.close();
        process.exit(0);
    });
}

main().catch((e) => {
    console.error('[auth] ERROR:', e.message || e);
    process.exit(1);
});
