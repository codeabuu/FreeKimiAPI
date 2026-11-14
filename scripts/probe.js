'use strict';
// Direct upstream probe — verifies the Kimi session without starting the proxy.
// Usage: npm run probe  [-- --no-shield]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadDotEnv } = require('../lib/env');

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

function authPaths() {
    if (process.env.KIMI_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.KIMI_AUTH_DIR)
                .filter((f) => f.endsWith('.json')).sort()
                .map((f) => path.resolve(process.env.KIMI_AUTH_DIR, f));
        } catch (e) { return []; }
    }
    return String(process.env.KIMI_AUTH_PATH || './kimi-auth.json')
        .split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(ROOT, p));
}

let auth = {};
let authPath = '';
for (const candidate of authPaths()) {
    try {
        const raw = fs.readFileSync(candidate, 'utf8').trim();
        const parsed = raw.startsWith('{') ? JSON.parse(raw) : { cookie: raw };
        const list = Array.isArray(parsed.accounts) ? parsed.accounts : [parsed];
        auth = list.find((a) => a && (a.token || a.authorization)) || {};
        if (auth.token || auth.authorization) { authPath = candidate; break; }
    } catch (e) { /* try the next file */ }
}
if (!authPath) {
    console.error(`No account with a token found in ${authPaths().join(', ') || './kimi-auth.json'}. Run: npm run auth`);
    process.exit(1);
}
const token = String(auth.token || auth.authorization || process.env.KIMI_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
if (!token) {
    console.error(`No "token" in ${authPath}. Run: npm run auth`);
    process.exit(1);
}

const BASE = String(process.env.KIMI_BASE_URL || 'https://www.kimi.ai').replace(/\/+$/, '');
const randDigits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('').replace(/^0/, '1');
const randBase36 = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[crypto.randomInt(0, 36)]).join('');

function frame(obj) {
    const json = Buffer.from(JSON.stringify(obj));
    const out = Buffer.alloc(5 + json.length);
    out.writeUInt32BE(json.length, 1);
    json.copy(out, 5);
    return out;
}

function parseFrames(buf, onObj, onEnd) {
    let off = 0;
    while (off + 5 <= buf.length) {
        const flags = buf[off];
        const len = buf.readUInt32BE(off + 1);
        if (off + 5 + len > buf.length) return off;
        const body = buf.subarray(off + 5, off + 5 + len).toString('utf8');
        off += 5 + len;
        if (flags & 0x02) { if (onEnd) onEnd(body); continue; }
        if (!body) continue;
        try { onObj(JSON.parse(body)); } catch { console.log('??', body.slice(0, 120)); }
    }
    return off;
}

const useShield = !process.argv.includes('--no-shield') && !!auth.shield;
const headers = {
    accept: '*/*',
    'content-type': 'application/connect+json',
    'connect-protocol-version': '1',
    origin: BASE,
    referer: BASE + '/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    'r-timezone': 'America/New_York',
    'x-language': 'en-US',
    'x-msh-platform': 'web',
    'x-msh-version': '2.3.0',
    'x-msh-device-id': auth.deviceId || randDigits(19),
    'x-msh-session-id': auth.sessionId || randDigits(19),
    'x-traffic-id': auth.trafficId || randBase36(21),
};
if (useShield) headers['x-msh-shield-data'] = auth.shield;
if (auth.cookie) headers.cookie = auth.cookie;
headers.authorization = 'Bearer ' + token;

const payload = {
    scenario: 'SCENARIO_CHAT',
    tools: [{ type: 'TOOL_TYPE_SEARCH', search: {} }, { type: 'TOOL_TYPE_CRON_JOB' }],
    message: { role: 'user', blocks: [{ message_id: '', text: { content: process.env.PROBE_PROMPT || 'Say exactly: PONG' } }], scenario: 'SCENARIO_CHAT', is_goal: false },
    options: { thinking: true, enable_plugin: true, reasoning_effort: 'REASONING_EFFORT_LOW', model: 'k28-instant' },
    project_id: '',
};

(async () => {
    console.log('shield:', useShield ? auth.shield.slice(0, 12) + '…' : 'none');
    console.log('token length:', token.length, ' cookie length:', (auth.cookie || '').length);
    const started = Date.now();
    const resp = await fetch(BASE + '/apiv2/kimi.gateway.chat.v1.ChatService/Chat', {
        method: 'POST', headers, body: frame(payload), signal: AbortSignal.timeout(120000),
    });
    console.log('HTTP', resp.status, resp.headers.get('content-type'), `${Date.now() - started}ms`);
    if (!resp.ok) {
        console.log((await resp.text()).slice(0, 1500));
        return;
    }
    let buf = Buffer.alloc(0);
    let text = '', think = '', frames = 0, ended = false;
    const reader = resp.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        const used = parseFrames(buf, (o) => {
            frames++;
            if (o.chat?.id) console.log('chat:', o.chat.id);
            if (o.message?.role === 'assistant' && o.message.id) console.log('assistant:', o.message.id, o.message.status || '');
            if (process.argv.includes('--dump')) console.log('EV', o.op || '', o.mask || '', JSON.stringify(o.block || o.message || o.chat || o).slice(0, 400));
            if (o.block?.think?.content) { think += o.block.think.content; }
            if (o.block?.text?.content) { text += o.block.text.content; }
        }, (body) => { ended = true; console.log('END', body.slice(0, 200)); });
        buf = buf.subarray(used);
        if (ended) break;
    }
    console.log('frames:', frames);
    console.log('THINK:', think.slice(0, 300));
    console.log('TEXT:', text.slice(0, 500));
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
