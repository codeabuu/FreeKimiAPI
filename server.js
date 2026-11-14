'use strict';
// FreeKimiAPI — OpenAI-compatible local proxy for Kimi Web Chat (kimi.ai).
// Zero dependencies, Node.js 18+.
//
// Upstream: POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat
// Protocol: Connect over HTTP with application/connect+json framing
//   request/response frame = 1 flag byte + 4-byte big-endian length + JSON.
//
// The shape (endpoints, sessions, tool emulation, account pool, client) mirrors
// https://github.com/ForgetMeAI/FreeDeepseekAPI while speaking Kimi's protocol.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadDotEnv } = require('./lib/env');

// ── .env ────────────────────────────────────────────────────────────────────
loadDotEnv(path.join(__dirname, '.env'));

const env = process.env;
const num = (v, d, min = 0) => {
    const n = Number(v);
    return v === undefined || v === '' || !Number.isFinite(n) ? d : Math.max(min, n);
};
const isTruthy = (v) => typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

// ── config ──────────────────────────────────────────────────────────────────
const PORT = num(env.PORT, 9657, 0);
const HOST = env.HOST || '127.0.0.1';
const BASE = (env.KIMI_BASE_URL || 'https://www.kimi.ai').replace(/\/+$/, '');
const CHAT_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat';
const UPSTREAM_MODEL = env.KIMI_MODEL || 'k28-instant';
const DEFAULT_THINKING = !/^(0|false|no)$/i.test(env.KIMI_THINKING || '1');
const DEFAULT_EFFORT = env.KIMI_REASONING_EFFORT || 'REASONING_EFFORT_LOW';
const DEFAULT_SEARCH = !/^(0|false|no)$/i.test(env.KIMI_SEARCH || '1');
const REQUEST_TIMEOUT = num(env.KIMI_REQUEST_TIMEOUT_MS, 300000, 1000);
const IDLE_TIMEOUT = num(env.KIMI_STREAM_IDLE_TIMEOUT_MS, 120000, 1000);
const REQUEST_DEADLINE_MS = num(env.KIMI_REQUEST_DEADLINE_MS, 300000, 1000);
const STREAM_KEEPALIVE_MS = num(env.KIMI_STREAM_KEEPALIVE_MS, 10000, 1000);
const MAX_CONCURRENT = num(env.KIMI_MAX_CONCURRENT, 24, 1);
const MAX_EMPTY_RETRIES = num(env.KIMI_MAX_EMPTY_RETRIES, 2, 0);
const MIN_PROMPT_CHARS = num(env.KIMI_MIN_PROMPT_CHARS, 8000, 500);
const MAX_PROMPT_CHARS = num(env.KIMI_MAX_PROMPT_CHARS, 120000, MIN_PROMPT_CHARS);
const MAX_BODY_BYTES = num(env.KIMI_MAX_BODY_BYTES, 25 * 1024 * 1024, 1024);
const TZ = env.KIMI_TIMEZONE || 'America/New_York';
const LANG = env.KIMI_LANGUAGE || 'en-US';
const UA = env.KIMI_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const SESSION_TTL_MS = num(env.KIMI_SESSION_TTL_MS, 2 * 60 * 60 * 1000, 60000);
const MAX_MESSAGE_DEPTH = num(env.KIMI_MAX_MESSAGE_DEPTH, 100, 1);
const MAX_SESSION_CONTEXT_CHARS = num(env.KIMI_MAX_SESSION_CONTEXT_CHARS, 150000, 10000);
const MAX_HISTORY_LENGTH = num(env.KIMI_MAX_HISTORY_LENGTH, 15, 1);
const MAX_HISTORY_CHARS = num(env.KIMI_MAX_HISTORY_CHARS, 10000, 1000);
const MAX_HISTORY_ENTRY_CHARS = num(env.KIMI_MAX_HISTORY_ENTRY_CHARS, 2000, 200);
const DEFAULT_ACCOUNT_COOLDOWN_MS = num(env.KIMI_ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000, 1000);
const RATE_LIMIT_COOLDOWN_MS = num(env.KIMI_RATE_LIMIT_COOLDOWN_MS, 60 * 1000, 1000);

const WATERMARK = env.KIMI_WATERMARK || 't.me/forgetmeai';
const SERVICE_NAME = 'FreeKimiAPI';
const CONTEXT_COMPACTED_HEADER = 'X-FreeKimi-Context-Compacted';

const SERVER_HOST = os.hostname();
const SERVER_PUBLIC_IP = (() => {
    try {
        for (const name of Object.keys(os.networkInterfaces())) {
            for (const iface of os.networkInterfaces()[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) { /* ignore */ }
    return 'localhost';
})();

function formatWatermark(prefix = SERVICE_NAME) { return `${prefix}: ${WATERMARK}`; }
function printBanner() {
    console.log(`\n  ${SERVICE_NAME} — OpenAI/Anthropic-compatible proxy for Kimi Web Chat`);
    console.log(`  ${formatWatermark()}\n`);
}

// ── proxy auth / CORS ───────────────────────────────────────────────────────
function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}
function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}
const PROXY_API_KEY = loadProxyApiKey();
const PROXY_CORS_ORIGINS = new Set(String(env.PROXY_CORS_ORIGINS || '')
    .split(',').map((value) => normalizeOrigin(value)).filter(Boolean));

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}
function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}
function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname);
    } catch (e) {
        return false;
    }
}
function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, x-agent-session, anthropic-version, anthropic-beta, x-stainless-lang, x-stainless-package-version');
    res.setHeader('Access-Control-Expose-Headers', `${CONTEXT_COMPACTED_HEADER}, Retry-After`);
}
function isProxyKeyMatch(suppliedKey, expectedKey) {
    if (typeof suppliedKey !== 'string') return false;
    const supplied = Buffer.from(suppliedKey, 'utf8');
    const expected = Buffer.from(String(expectedKey), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function isProxyAuthorized(authorization, expectedKey = PROXY_API_KEY, apiKeyHeader = undefined) {
    if (!expectedKey) return true;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')
        && isProxyKeyMatch(authorization.slice('Bearer '.length), expectedKey)) return true;
    return isProxyKeyMatch(apiKeyHeader, expectedKey);
}
function markContextCompacted(res) {
    // A live stream may already have sent its headers.
    if (!res.headersSent) res.setHeader(CONTEXT_COMPACTED_HEADER, '1');
}

// ── models ──────────────────────────────────────────────────────────────────
function modelConfig({ thinking = DEFAULT_THINKING, effort = DEFAULT_EFFORT, search = DEFAULT_SEARCH, legacy = null } = {}) {
    let realModel = 'Kimi K2.5 (kimi.ai web mode)';
    if (thinking) realModel += ' + thinking';
    if (search) realModel += ' + web search';
    if (legacy) realModel += `; legacy alias: ${legacy}`;
    return {
        thinking,
        effort,
        search,
        real_model: realModel,
        capabilities: { reasoning: thinking, web_search: search, files: false, vision: false, tool_calls: true },
        supported: true,
        deprecated: Boolean(legacy),
        unavailable_reason: null,
    };
}

const MODEL_CONFIGS = {
    'kimi-k2.5': modelConfig(),
    'kimi-k2.5-thinking': modelConfig({ thinking: true, effort: 'REASONING_EFFORT_HIGH' }),
    'kimi-k2.5-fast': modelConfig({ thinking: false }),
    'kimi-k2.5-search': modelConfig({ search: true }),
    'kimi-k2.5-fast-search': modelConfig({ thinking: false, search: true }),
    'kimi-k2.5-thinking-search': modelConfig({ thinking: true, effort: 'REASONING_EFFORT_HIGH', search: true }),
    'kimi-default': modelConfig({ legacy: 'use kimi-k2.5' }),
    'kimi': modelConfig({ legacy: 'use kimi-k2.5' }),
    'k28-instant': modelConfig({ legacy: 'internal web model id' }),
};
const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter((id) => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    upstream_model: UPSTREAM_MODEL,
    thinking_enabled: cfg.thinking,
    search_enabled: cfg.search,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    deprecated: cfg.deprecated === true,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function resolveModelConfig(name) {
    return MODEL_CONFIGS[String(name || 'kimi-k2.5').toLowerCase()] || null;
}
function isKnownModel(name) { return Boolean(resolveModelConfig(name)); }
function isSupportedModel(name) { const cfg = resolveModelConfig(name); return Boolean(cfg && cfg.supported); }
function resolveEffort(v) {
    const m = String(v || '').toLowerCase();
    if (m === 'high' || /high/.test(m)) return 'REASONING_EFFORT_HIGH';
    if (m === 'medium' || /medium/.test(m)) return 'REASONING_EFFORT_MEDIUM';
    if (m === 'low' || /low/.test(m)) return 'REASONING_EFFORT_LOW';
    return DEFAULT_EFFORT;
}

// ── account pool ────────────────────────────────────────────────────────────
const accounts = [];
let accountRoundRobin = 0;
let authFilesSignature = '';

function authFilesSignatureOf(paths) {
    return paths.map((file) => {
        try {
            const st = fs.statSync(file);
            return `${file}:${st.mtimeMs}:${st.size}`;
        } catch (e) {
            return `${file}:0:0`;
        }
    }).join('|');
}
function randDigits(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10);
    return s.replace(/^0/, '1');
}
function randBase36(n) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
    return s;
}
function stripBearer(value) { return String(value || '').replace(/^Bearer\s+/i, '').trim(); }
function normalizeCookie(value) {
    return String(value || '').replace(/^cookie:\s*/i, '').replace(/\s*\r?\n\s*/g, ' ').trim();
}
function normalizeAccountConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pick = (k) => (raw[k] !== undefined && raw[k] !== '' ? String(raw[k]) : '');
    const token = stripBearer(pick('token') || pick('authorization') || pick('accessToken') || pick('access_token'));
    const cookie = normalizeCookie(pick('cookie'));
    if (!token && !cookie) return null;
    return {
        name: pick('name') || pick('label') || '',
        token,
        refreshToken: pick('refreshToken') || pick('refresh_token'),
        cookie,
        deviceId: pick('deviceId') || pick('device_id') || randDigits(19),
        sessionId: pick('sessionId') || pick('session_id') || randDigits(19),
        shield: pick('shield'),
        trafficId: pick('trafficId') || pick('traffic_id') || randBase36(21),
        tokenExpiresAt: Number(raw.tokenExpiresAt || 0) || null,
    };
}
function discoverAuthPaths() {
    if (env.KIMI_AUTH_DIR) {
        try {
            return fs.readdirSync(env.KIMI_AUTH_DIR)
                .filter((f) => f.endsWith('.json')).sort()
                .map((f) => path.resolve(env.KIMI_AUTH_DIR, f));
        } catch (e) {
            console.error(`[kimi] Could not read KIMI_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    const configured = env.KIMI_AUTH_PATH;
    if (configured && configured.includes(',')) {
        return configured.split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(__dirname, p));
    }
    return [path.resolve(__dirname, configured || './kimi-auth.json')];
}
function loadAccounts({ fatal = false } = {}) {
    accounts.length = 0;
    accountRoundRobin = 0;
    const files = discoverAuthPaths();
    for (const file of files) {
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8').trim();
        } catch (e) {
            if (e.code !== 'ENOENT') console.error(`[kimi] Could not read ${file}: ${e.message}`);
            continue;
        }
        let parsed;
        try {
            parsed = raw.startsWith('{') || raw.startsWith('[') ? JSON.parse(raw) : { cookie: raw };
        } catch (e) {
            console.error(`[kimi] Invalid JSON in ${file}: ${e.message}`);
            continue;
        }
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.accounts) ? parsed.accounts : [parsed]);
        for (const item of list) {
            const config = normalizeAccountConfig(item);
            if (!config) continue;
            const id = `account_${accounts.length + 1}`;
            accounts.push({
                id,
                file,
                config,
                headers: buildAccountHeaders(config),
                cooldownUntil: 0,
                failures: 0,
                lastUsedAt: 0,
            });
        }
    }
    if (accounts.length > 0) {
        authFilesSignature = authFilesSignatureOf(files);
        console.log(`[kimi] Loaded ${accounts.length} auth account(s): ${accounts.map((a) => a.id).join(', ')}`);
        return true;
    }
    authFilesSignature = authFilesSignatureOf(files);
    if (fatal) throw new Error(`No Kimi auth config found. Expected ${files.join(', ') || './kimi-auth.json'}. Run "npm run auth".`);
    return false;
}
// The auth helper rewrites kimi-auth.json whenever the browser refreshes the
// short-lived Kimi token. Reload on file changes so a running proxy picks it up.
function maybeReloadAccounts() {
    const files = discoverAuthPaths();
    const signature = authFilesSignatureOf(files);
    if (signature !== authFilesSignature) {
        console.log('[kimi] Auth file changed; reloading accounts.');
        loadAccounts({ fatal: false });
    }
}
function buildAccountHeaders(config) {
    const headers = {
        accept: '*/*',
        'content-type': 'application/connect+json',
        'connect-protocol-version': '1',
        origin: BASE,
        referer: BASE + '/',
        'user-agent': UA,
        'r-timezone': TZ,
        'x-language': LANG,
        'x-msh-platform': 'web',
        'x-msh-version': '2.3.0',
        'x-msh-device-id': config.deviceId,
        'x-msh-session-id': config.sessionId,
        'x-traffic-id': config.trafficId,
    };
    if (config.shield) headers['x-msh-shield-data'] = config.shield;
    if (config.cookie) headers.cookie = config.cookie;
    if (config.token) headers.authorization = 'Bearer ' + config.token;
    return headers;
}
function hasAuthConfig() { return accounts.some((a) => a.config.token || a.config.cookie); }
function accountStatus(account) {
    return {
        id: account.id,
        name: account.config.name || null,
        ready: Boolean(account.config.token || account.config.cookie),
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        failures: account.failures,
        last_used_at: account.lastUsedAt || null,
    };
}
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : Math.max(1000, t - Date.now());
}
function markAccountFailure(account, status, reason = '', retryAfterRaw = null, fallbackCooldownMs = DEFAULT_ACCOUNT_COOLDOWN_MS) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : fallbackCooldownMs;
        account.cooldownUntil = Date.now() + cooldownMs;
        console.log(`[${account.id}] cooldown ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}`);
    }
}
function hasOtherReadyAccount(accountId, now = Date.now()) {
    return accounts.some((a) => a.id !== accountId && (a.config.token || a.config.cookie) && a.cooldownUntil <= now);
}
function isAccountLevelError(error) { return [401, 403, 429].includes(Number(error?.status)); }
function selectAccountForSession(session) {
    if (accounts.length === 0) loadAccounts({ fatal: false });
    const now = Date.now();
    if (session?.accountId) {
        const sticky = accounts.find((a) => a.id === session.accountId);
        if (sticky && (sticky.config.token || sticky.config.cookie) && sticky.cooldownUntil <= now) {
            sticky.lastUsedAt = now;
            return sticky;
        }
        resetRemoteSession(session);
        session.accountId = null;
    }
    const ready = accounts.filter((a) => (a.config.token || a.config.cookie) && a.cooldownUntil <= now);
    if (ready.length === 0) {
        const waiting = accounts
            .filter((a) => (a.config.token || a.config.cookie))
            .sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
            const err = new Error(`All Kimi auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const noAuth = new Error('No valid Kimi auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const account = ready[accountRoundRobin % ready.length];
    accountRoundRobin++;
    account.lastUsedAt = now;
    if (session) session.accountId = account.id;
    return account;
}

// ── connect framing ─────────────────────────────────────────────────────────
function frame(obj) {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const out = Buffer.alloc(5 + json.length);
    out[0] = 0;
    out.writeUInt32BE(json.length, 1);
    json.copy(out, 5);
    return out;
}

class FrameParser {
    constructor(onMessage, onEnd) {
        this.buf = Buffer.alloc(0);
        this.onMessage = onMessage;
        this.onEnd = onEnd || (() => {});
        this.ended = false;
    }
    push(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (this.buf.length >= 5) {
            const flags = this.buf[0];
            const len = this.buf.readUInt32BE(1);
            if (len > 64 * 1024 * 1024) throw new Error('connect: frame too large');
            if (this.buf.length < 5 + len) break;
            const body = this.buf.subarray(5, 5 + len).toString('utf8');
            this.buf = this.buf.subarray(5 + len);
            if (flags & 0x02) {
                this.ended = true;
                this.onEnd(body);
                return;
            }
            if (!body) continue;
            let obj;
            try { obj = JSON.parse(body); } catch { continue; }
            this.onMessage(obj);
        }
    }
}

// Kimi's agent skills sometimes emit raw <tool>…</tool> / <system>…</system>
// markup inside a text block instead of a structured tool block. Strip it so
// OpenAI clients only see the answer, including when it straddles deltas.
class TextFilter {
    constructor(emit) {
        this.emit = emit;
        this.buf = '';
    }
    push(chunk) {
        if (!chunk) return;
        this.buf += chunk;
        this._drain(false);
    }
    _drain(isFinal) {
        for (;;) {
            const closed = /<(tool|system|ref)\b[^>]*>[\s\S]*?<\/\1>/i.exec(this.buf);
            if (closed) {
                this.buf = this.buf.slice(0, closed.index) + this.buf.slice(closed.index + closed[0].length);
                continue;
            }
            const open = this.buf.search(/<(tool|system|ref)\b/i);
            let safe;
            if (open >= 0) {
                safe = this.buf.slice(0, open);
            } else {
                const partial = /<(?:r(?:e(?:f)?)?|t(?:o(?:o(?:l)?)?)?|s(?:y(?:s(?:t(?:e(?:m)?)?)?)?)?)$/i.exec(this.buf);
                safe = partial ? this.buf.slice(0, this.buf.length - partial[0].length) : this.buf;
            }
            this.buf = this.buf.slice(safe.length);
            if (safe) this.emit(safe);
            if (open >= 0) {
                if (isFinal) this.buf = '';
                break;
            }
            break;
        }
    }
    flush() { this._drain(true); if (this.buf) { this.emit(this.buf); this.buf = ''; } }
}

// ── upstream completion ─────────────────────────────────────────────────────
function buildPayload({ prompt, chatId, parentId, thinking, effort, search }) {
    const payload = {
        scenario: 'SCENARIO_CHAT',
        tools: search ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
        message: {
            role: 'user',
            blocks: [{ message_id: '', text: { content: prompt } }],
            scenario: 'SCENARIO_CHAT',
            is_goal: false,
        },
        options: {
            thinking: Boolean(thinking),
            enable_plugin: true,
            reasoning_effort: effort,
            model: UPSTREAM_MODEL,
        },
        project_id: '',
    };
    if (chatId) payload.chat_id = chatId;
    if (parentId) payload.message.parent_id = parentId;
    return payload;
}

function upstreamError(e, http, account) {
    if (http) {
        const snippet = String(http.body || '').replace(/\s+/g, ' ').slice(0, 400);
        const status = Number(http.status) || 502;
        let message = `Kimi upstream HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
        if (status === 401 || status === 403) {
            message += ' — session expired or rejected; run "npm run auth" (leave its Chrome window open for auto-refresh)';
        }
        if (status === 429) message += ' — Kimi account is throttled; retry later or add another account.';
        const err = new Error(message);
        err.status = status === 401 || status === 403 ? 401 : (status === 429 ? 429 : (status === 400 ? 400 : 502));
        err.upstreamStatus = status;
        err.type = err.status === 401 ? 'authentication_error' : (err.status === 429 ? 'rate_limit' : 'upstream_error');
        if (account) markAccountFailure(account, status, 'completion', http.retryAfter, status === 429 ? RATE_LIMIT_COOLDOWN_MS : DEFAULT_ACCOUNT_COOLDOWN_MS);
        return err;
    }
    const err = new Error(`Kimi upstream error: ${e?.message || e}`);
    err.status = 502;
    err.type = 'upstream_error';
    return err;
}

async function runCompletion(opts) {
    const account = opts.account;
    if (!account) {
        const err = new Error('No Kimi account selected. Run "npm run auth".');
        err.status = 503;
        err.type = 'no_auth';
        throw err;
    }
    if (!account.config.token && !account.config.cookie) {
        const err = new Error(`No Kimi session in ${account.file}. Run "npm run auth" (writes kimi-auth.json).`);
        err.status = 503;
        err.type = 'no_auth';
        throw err;
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('upstream timeout')), REQUEST_TIMEOUT);
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener('abort', () => controller.abort(opts.signal.reason), { once: true });
    }

    const state = {
        text: '',
        think: '',
        chatId: null,
        assistantId: null,
        done: false,
        upstreamError: null,
    };
    const notify = () => { if (opts.onProgress) opts.onProgress(state.text, state.think); };
    state.filter = new TextFilter((chunk) => {
        state.text += chunk;
        notify();
    });
    const parser = new FrameParser((obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.error) {
            state.upstreamError = typeof obj.error === 'string' ? obj.error : (obj.error.message || obj.error.msg || JSON.stringify(obj.error));
        }
        if (obj.chat && obj.chat.id) state.chatId = obj.chat.id;
        if (obj.message) {
            if (obj.message.role === 'assistant' && obj.message.id) state.assistantId = obj.message.id;
            if (obj.message.role === 'assistant' && obj.message.status === 'MESSAGE_STATUS_COMPLETED') {
                state.done = true;
                // A resumed/final snapshot may carry the whole answer: only use it
                // when no deltas were streamed, otherwise content would duplicate.
                if (!state.text && !state.think && Array.isArray(obj.message.blocks)) {
                    for (const b of obj.message.blocks) digestBlock(b, state, notify);
                }
            }
        }
        if (obj.block) digestBlock(obj.block, state, notify);
    }, () => { state.done = true; });

    let resp;
    try {
        resp = await fetch(BASE + CHAT_PATH, {
            method: 'POST',
            headers: account.headers,
            body: frame(buildPayload(opts)),
            signal: controller.signal,
        });
    } catch (e) {
        clearTimeout(deadline);
        throw upstreamError(e, null, account);
    }

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        clearTimeout(deadline);
        throw upstreamError(null, {
            status: resp.status,
            body,
            retryAfter: resp.headers.get('retry-after'),
        }, account);
    }

    let idle;
    const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new Error('stream idle timeout')), IDLE_TIMEOUT);
    };
    armIdle();
    const reader = resp.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            parser.push(Buffer.from(value));
            if (parser.ended || state.done) break;
        }
        if (!parser.ended) {
            try { await reader.cancel(); } catch { /* ignore */ }
        }
    } catch (e) {
        if (!state.text && !state.think) throw upstreamError(e, null, account);
    } finally {
        clearTimeout(deadline);
        clearTimeout(idle);
    }
    state.filter.flush();
    notify();
    if (state.upstreamError && !state.text.trim() && !state.think.trim()) {
        const err = new Error(`Kimi upstream error: ${state.upstreamError}`);
        err.status = 502;
        err.type = 'upstream_error';
        throw err;
    }
    return state;
}

function digestBlock(b, state, notify) {
    if (!b) return;
    if (b.messageId && !state.assistantId) state.assistantId = b.messageId;
    if (b.think && typeof b.think.content === 'string' && b.think.content) {
        state.think += b.think.content;
        notify();
    }
    if (b.text && typeof b.text.content === 'string' && b.text.content) {
        state.filter.push(b.text.content);
    }
}

// ── sessions ────────────────────────────────────────────────────────────────
const sessions = new Map();

function createSession() {
    return {
        id: null,
        chatId: null,
        parentMessageId: null,
        assistantId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        lastActivityAt: Date.now(),
        sentMessageKeys: [],
        contextKey: null,
        remoteChars: 0,
        busy: false,
    };
}
function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.chatId || session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.chatId = null;
    session.parentMessageId = null;
    session.assistantId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    return failed;
}
function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.chatId) return null;
    let reason = null;
    if (session.messageCount >= MAX_MESSAGE_DEPTH) reason = 'max_message_depth';
    else if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) reason = 'session_ttl';
    else if ((session.remoteChars || 0) >= MAX_SESSION_CONTEXT_CHARS) reason = 'max_context_chars';
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}
function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) sessions.set(agentId, createSession());
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    return session;
}
function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) console.log(`[kimi] swept ${removed} idle session(s); ${sessions.size} remain`);
    return removed;
}

// ── prompt helpers ──────────────────────────────────────────────────────────
function sanitizeContent(text) {
    return String(text || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}
function estimateTokens(text) { return text ? Math.ceil(String(text).length / 4) : 0; }
function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    return {
        prompt_tokens: promptTokens,
        completion_tokens: contentTokens + reasoningTokens,
        total_tokens: promptTokens + contentTokens + reasoningTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
    };
}
function isSystemRole(role) { return role === 'system' || role === 'developer'; }

function describeAttachment(kind, reference) {
    const value = typeof reference === 'string' ? reference.trim() : '';
    if (!value || value.startsWith('data:') || value.length > 512 || !/^(?:https?:\/\/|[\w.-]+$)/i.test(value)) {
        return `[${kind} attached; not visible through this proxy]`;
    }
    return `[${kind}: ${value}]`;
}
function describeImagePart(part) {
    const url = part?.image_url?.url ?? part?.image_url ?? part?.url;
    if (typeof url === 'string' && url.startsWith('data:')) return '[Image attached; not visible through this proxy]';
    return describeAttachment('Image', url ?? part?.source?.url);
}
function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'thinking' || part.type === 'redacted_thinking' || part.type === 'reasoning') return '';
            if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return describeImagePart(part);
            if (part.type === 'file' || part.type === 'input_file' || part.type === 'document') {
                return describeAttachment('File', part.file?.filename ?? part.filename ?? part.title ?? part.file_url ?? part.source?.url ?? part.source?.data);
            }
            if (typeof part.text === 'string') return part.text;
            if (part.content !== undefined) return normalizeMessageContent(part.content);
            return JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
        },
    })).filter((tool) => tool.function.name);
}
function normalizeResponsesTools(tools = []) {
    return (tools || []).map((tool) => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}
function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: item.content });
        } else if (item.role) {
            messages.push({ role: item.role, content: item.content });
        } else if (item.type === 'function_call') {
            messages.push({ role: 'assistant', content: null, tool_calls: [{
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) },
            }] });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        }
    }
    return messages;
}
function anthropicEffort(thinking) {
    const budget = Number(thinking?.budget_tokens || 0);
    if (thinking?.type && thinking.type !== 'enabled' && thinking.type !== 'adaptive') return undefined;
    if (budget >= 8000) return 'high';
    if (budget >= 2000) return 'medium';
    return thinking ? 'low' : undefined;
}
function normalizeApiParams(params, apiMode) {
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: params.system });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter((part) => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter((part) => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some((part) => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: part.content });
                    else messages.push({ role: 'user', content: [part] });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: msg.content });
            }
        }
        return {
            ...params,
            model: params.model || 'kimi-k2.5',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
            reasoning_effort: params.reasoning_effort || anthropicEffort(params.thinking),
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || 'kimi-k2.5',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return { ...params, model: params.model || 'kimi-k2.5' };
}

// ── tool emulation ──────────────────────────────────────────────────────────
const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
    'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);
function compactToolSchema(value) {
    if (Array.isArray(value)) return value.map(compactToolSchema);
    if (!value || typeof value !== 'object') return value;
    const compact = {};
    for (const [key, child] of Object.entries(value)) {
        if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
        if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]));
        } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            compact[key] = child.map(compactToolSchema);
        } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
            compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
        } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
                name, Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
            ]));
        } else {
            compact[key] = child;
        }
    }
    return compact;
}
const TOOL_CALL_FORMAT = '{"tool_call":{"name":"<function_name>","arguments":{...}}}';

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    const rawSchemaChars = tools.reduce((total, tool) => {
        try { return total + JSON.stringify(tool?.function?.parameters || {}).length; }
        catch (e) { return total; }
    }, 0);
    const compactSchemas = rawSchemaChars > Math.floor(MAX_PROMPT_CHARS * 0.4);
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server or need to change something there, REQUEST exactly one tool call using exactly this JSON format:\n';
    text += `${TOOL_CALL_FORMAT}\n\n`;
    text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += `3. The tool runs on ${SERVER_HOST} (${SERVER_PUBLIC_IP}), the local server — NOT on Kimi\n`;
    text += '4. After the tool executes, the result will be sent to you as a new message starting with [Tool Result]\n';
    text += '5. A tool request contains nothing but that JSON: no explanation before or after it, no Markdown code fence, one tool per response\n';
    text += '6. Arguments must be valid JSON: escape backslashes (C:\\\\Users\\\\me), double quotes and newlines (\\n) inside strings. Keep arguments compact.\n';
    text += '7. When no tool is needed (for example the task is finished), answer normally in plain text without any tool_call JSON\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
            text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += `\nREMEMBER: Request a tool only with ${TOOL_CALL_FORMAT}. Never simulate results.`;
    return text;
}
function formatToolReminder(tools) {
    const names = (tools || [])
        .filter((tool) => tool?.type === 'function' && tool.function?.name)
        .map((tool) => tool.function.name);
    if (names.length === 0) return '';
    let list = names.join(', ');
    if (list.length > 1500) list = list.substring(0, 1497) + '...';
    return `[Tool reminder] Available tools: ${list}. To use one, reply with ONLY ${TOOL_CALL_FORMAT} (valid JSON, one tool, nothing else). Otherwise answer normally. Never invent tool results.`;
}

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;

function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(startIndex, i + 1);
        }
    }
    return null;
}
function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES, accept = null) {
    const out = [];
    for (let i = 0; i < text.length && out.length < maxObjects; i++) {
        if (text[i] !== '{') continue;
        const raw = extractBalancedJsonAt(text, i);
        if (!raw) continue;
        if (!accept || accept(raw)) out.push(raw);
        i += raw.length - 1;
    }
    return out;
}
function parseJsonLenient(raw) {
    const text = String(raw || '').trim();
    try { return JSON.parse(text); } catch (e) { /* repair below */ }
    let repaired = text
        .replace(/^\uFEFF/, '')
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch (e) { /* fall through */ }
    // Single-quoted keys/strings (last resort, not nested-aware).
    repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, body) => `"${body.replace(/"/g, '\\"')}"`);
    try { return JSON.parse(repaired); } catch (e) { return null; }
}
function buildToolCall(name, args = {}) {
    if (!name || typeof name !== 'string') return null;
    return { name, arguments: JSON.stringify(args && typeof args === 'object' ? args : {}) };
}
function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        const first = obj.tool_calls[0];
        const fn = first?.function || first;
        if (fn?.name) return buildToolCall(fn.name, fn.arguments ?? fn.parameters ?? {});
    }
    const envelope = obj.tool_call || obj.function_call;
    if (envelope && typeof envelope === 'object') {
        const fn = envelope.function || envelope;
        if (fn.name) return buildToolCall(fn.name, fn.arguments ?? fn.parameters ?? envelope.arguments ?? {});
    }
    if (allowBare && obj.name && (obj.arguments !== undefined || obj.parameters !== undefined)) {
        return buildToolCall(obj.name, obj.arguments ?? obj.parameters);
    }
    return null;
}
function parseJsonToolCandidate(raw, { allowBare = false } = {}) {
    const parsed = parseJsonLenient(raw);
    if (!parsed) return null;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of candidates) {
        const tc = coerceToolCallObject(item, { allowBare });
        if (tc) return tc;
    }
    return null;
}
function stripForeignCodeFences(text) {
    return String(text || '').replace(/```([\w-]*)\r?\n([\s\S]*?)```/g, (match, lang) => (
        /^(?:json|json5|)$/i.test(lang) ? match : ''
    ));
}
function parseToolCall(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }
    const scanText = stripForeignCodeFences(text);

    const xmlMatch = scanText.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        let tc = parseJsonToolCandidate(inner, { allowBare: true });
        if (!tc) {
            const objectStart = inner.indexOf('{');
            const object = objectStart === -1 ? null : extractBalancedJsonAt(inner, objectStart);
            if (object && object !== inner) tc = parseJsonToolCandidate(object, { allowBare: true });
        }
        if (tc) return tc;
    }

    const fenceRe = /```([\w-]*)\r?\n([\s\S]*?)```/g;
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        if (!/^(?:json|json5|)$/i.test(fence[1])) continue;
        const body = fence[2].trim();
        if (!body.startsWith('{')) continue;
        const tc = parseJsonToolCandidate(body);
        if (tc) return tc;
    }

    const legacy = scanText.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (legacy) {
        const name = legacy[1];
        const afterMatch = scanText.substring(legacy.index + legacy[0].length);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                const args = parseJsonLenient(rawJson);
                const tc = buildToolCall(name, args || {});
                if (tc) return tc;
            }
        }
    }

    for (const rawJson of extractBalancedJsonObjects(scanText, MAX_TOOL_JSON_CANDIDATES, (object) => /["'](?:tool_call|tool_calls|function_call)["']\s*:/.test(object))) {
        const tc = parseJsonToolCandidate(rawJson);
        if (tc) return tc;
    }
    return null;
}
function looksLikeToolCallMarkup(text) {
    return /["'](?:tool_call|tool_calls|function_call)["']\s*:|<tool_call|TOOL_CALL:|[|｜]+\s*DSML\s*[|｜]+/i.test(String(text || ''));
}

// ── prompt construction ─────────────────────────────────────────────────────
function toolCallAsPromptText(toolCall) {
    const name = toolCall?.function?.name || toolCall?.name || '';
    let args = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
    if (typeof args === 'string') {
        try { args = JSON.parse(args || '{}'); } catch (e) { /* keep raw string */ }
    }
    return JSON.stringify({ tool_call: { name, arguments: args } });
}
function buildToolNameIndex(messages) {
    const names = new Map();
    for (const msg of messages || []) {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
            if (tc?.id && tc.function?.name) names.set(tc.id, tc.function.name);
        }
    }
    return names;
}
function formatConversation(messages, toolNames = buildToolNameIndex(messages)) {
    let conversation = '';
    for (const msg of messages || []) {
        if (!msg || isSystemRole(msg.role)) continue;
        if (msg.role === 'user') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `User: ${text}\n\n`;
        } else if (msg.role === 'assistant') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `Assistant: ${text}\n\n`;
            for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
                conversation += `Assistant: ${toolCallAsPromptText(tc)}\n\n`;
            }
        } else if (msg.role === 'tool' || msg.role === 'function') {
            const name = msg.name || toolNames.get(msg.tool_call_id) || '';
            conversation += `[Tool Result${name ? `: ${name}` : ''}]\n${normalizeMessageContent(msg.content)}\n\n`;
        }
    }
    return conversation.trim();
}
function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages || []) {
        if (msg && isSystemRole(msg.role) && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);
    return {
        prompt: formatConversation(messages),
        systemPrompt: systemPrompt.trim(),
        toolReminder: formatToolReminder(tools),
    };
}

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by FreeKimiAPI]\n\n';
function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}
function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }
    const historyDropped = history.length > 0;
    const separatorLength = system && conversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (conversation.length < conversationBudget) {
        conversationBudget = conversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }
    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = truncatePromptMiddle(conversation, conversationBudget, 0.25);
    let bounded = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return { prompt: bounded, compacted: true, historyDropped, originalChars: original.length, promptChars: bounded.length };
}
function buildDeltaPrompt(deltaMessages, allMessages, toolReminder, maxChars = MAX_PROMPT_CHARS, systemPrompt = '') {
    const body = formatConversation(deltaMessages, buildToolNameIndex(allMessages));
    const suffix = toolReminder ? `\n\n${toolReminder}` : '';
    const budget = Math.max(0, maxChars - suffix.length);
    if (systemPrompt) {
        const bounded = buildBoundedPrompt(systemPrompt, '', body, budget);
        return { prompt: bounded.prompt + suffix, compacted: bounded.compacted };
    }
    const bounded = truncatePromptMiddle(body, budget, 0.25);
    return { prompt: bounded + suffix, compacted: bounded.length < body.length };
}
function buildRecoveryHistoryPrefix(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    let prefix = '[Previous conversation]\n';
    for (const exchange of history) {
        prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`;
    }
    return prefix + '[Continue from here]\n\n';
}
function hasExplicitConversationHistory(messages) {
    return (messages || []).some((msg) => msg && msg.role === 'assistant');
}
function storeHistory(session, prompt, content, toolCall) {
    const assistantResponse = toolCall ? toolCallAsPromptText({ function: toolCall }) : content;
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    const shortAnswer = truncatePromptMiddle(assistantResponse, MAX_HISTORY_ENTRY_CHARS, 0.6);
    session.history.push({ user: shortPrompt, assistant: shortAnswer });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}
function hashText(value) { return crypto.createHash('sha256').update(String(value)).digest('base64'); }
function conversationMessageKey(msg) {
    const toolCalls = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map((tc) => [tc?.function?.name || '', String(tc?.function?.arguments ?? ''), tc?.id || ''])
        : [];
    return hashText(JSON.stringify([
        msg?.role || '',
        normalizeMessageContent(msg?.content),
        toolCalls,
        msg?.tool_call_id || '',
    ]));
}
function planSessionTurn(session, messages, contextKey) {
    const conversation = (messages || []).filter((msg) => msg && !isSystemRole(msg.role));
    const keys = conversation.map(conversationMessageKey);
    if (!session?.chatId) return { mode: 'full', reason: null, keys };
    if (!session.contextKey) return { mode: 'full', reason: 'remote chat has no completed turn yet', keys };
    const sent = Array.isArray(session.sentMessageKeys) ? session.sentMessageKeys : [];
    if (!conversation.some((msg) => msg.role === 'assistant')) {
        return { mode: 'delta', messages: conversation, keys, includeSystem: session.contextKey !== contextKey };
    }
    if (session.contextKey !== contextKey) return { mode: 'full', reason: 'system prompt or tools changed', keys };
    if (sent.length > 0 && sent.length < keys.length && sent.every((key, index) => keys[index] === key)) {
        let start = sent.length;
        while (start < conversation.length && conversation[start].role === 'assistant') start++;
        const delta = conversation.slice(start);
        if (delta.some((msg) => msg.role !== 'assistant')) return { mode: 'delta', messages: delta, keys };
        return { mode: 'full', reason: 'no new input after the last answer', keys };
    }
    return { mode: 'full', reason: 'conversation history diverged', keys };
}
function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}
function isRateLimitError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.type || ''}`;
    return /too\s+many\s+(?:messages|requests)|rate[\s_-]?limit|过于频繁/i.test(message);
}
function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

// ── response builders ───────────────────────────────────────────────────────
function buildToolCallResponse(toolCall, model = 'kimi-k2.5', prompt = '', reasoningContent = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    return {
        id: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
            },
            finish_reason: 'tool_calls',
        }],
        usage: buildUsage(prompt, '', reasoningContent),
        watermark: WATERMARK,
    };
}
function buildTextResponse(content, prompt, model = 'kimi-k2.5', reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason === 'length' ? 'length' : 'stop',
        }],
        usage: buildUsage(prompt, content, reasoningContent),
        watermark: WATERMARK,
    };
}
function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}
function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
        watermark: WATERMARK,
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}
function chunkText(text, size) {
    return String(text || '').match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) || [];
}
function toResponsesResponse(openaiResp, ids = {}) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: ids.reasoning || 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }], status: 'completed' });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
    } else {
        output.push({ id: ids.message || 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: ids.response || openaiResp.id.replace(/^chatcmpl-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
        watermark: WATERMARK,
    };
}
function sendJsonError(res, status, message, type, extra = {}, headers = {}) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message, type, ...extra } }));
}

// ── streaming ───────────────────────────────────────────────────────────────
function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' };
function anthropicErrorType(type, status) {
    if (status === 429 || /rate/i.test(String(type))) return 'rate_limit_error';
    if (status === 401 || status === 403) return 'authentication_error';
    if (status === 400 || status === 413) return 'invalid_request_error';
    if (status === 503) return 'overloaded_error';
    return 'api_error';
}

function createStreamWriter(res, apiMode, { model = 'kimi-k2.5', promptTokens = 0, id = 'chatcmpl-' + Date.now(), created = Math.floor(Date.now() / 1000) } = {}) {
    const state = { started: false, ended: false, lastWriteAt: 0, reasoning: '', content: '', section: null, reasoningSource: null, pendingWhitespace: '', sources: 0 };
    const itemIds = { response: id.replace(/^chatcmpl-/, 'resp_'), reasoning: `rs_${id}`, message: `msg_${id}` };
    let roleSent = false;
    let blockIndex = -1;
    let outputIndex = -1;

    const sse = (event, data) => { writeSse(res, event, data); state.lastWriteAt = Date.now(); };
    const chunk = (delta, finishReason = null) => sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    const responseSkeleton = () => ({ id: itemIds.response, object: 'response', created_at: created, status: 'in_progress', model, output: [], watermark: WATERMARK });

    function start() {
        if (state.started) return;
        state.started = true;
        res.writeHead(200, SSE_HEADERS);
        state.lastWriteAt = Date.now();
        if (apiMode === 'anthropic') {
            sse('message_start', { type: 'message_start', message: { id: 'msg_' + id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 }, watermark: WATERMARK } });
        } else if (apiMode === 'responses') {
            sse('response.created', { type: 'response.created', response: responseSkeleton() });
            sse('response.in_progress', { type: 'response.in_progress', response: responseSkeleton() });
        }
    }
    function openaiRole(toolTurn) {
        if (roleSent) return;
        roleSent = true;
        chunk({ role: 'assistant', content: toolTurn ? null : '' });
    }
    function openSection(kind) {
        if (state.section === kind) return;
        closeSection();
        state.section = kind;
        if (apiMode === 'openai') {
            openaiRole(false);
        } else if (apiMode === 'anthropic') {
            blockIndex++;
            sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '[reasoning]\n' } });
        } else {
            outputIndex++;
            if (kind === 'reasoning') {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [], status: 'in_progress' } });
                sse('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
            } else {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
                sse('response.content_part.added', { type: 'response.content_part.added', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            }
        }
    }
    function closeSection() {
        const kind = state.section;
        if (!kind) return;
        state.section = null;
        if (apiMode === 'openai') return;
        if (apiMode === 'anthropic') {
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '\n[/reasoning]\n' } });
            sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            return;
        }
        if (kind === 'reasoning') {
            const part = { type: 'summary_text', text: state.reasoning };
            sse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, text: state.reasoning });
            sse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [part], status: 'completed' } });
        } else {
            const part = { type: 'output_text', text: state.content, annotations: [] };
            sse('response.output_text.done', { type: 'response.output_text.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, text: state.content });
            sse('response.content_part.done', { type: 'response.content_part.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'completed', content: [part] } });
        }
    }
    function emit(kind, text) {
        if (!text) return;
        start();
        openSection(kind);
        for (const piece of chunkText(text, apiMode === 'openai' ? 50 : 80)) {
            if (apiMode === 'openai') chunk(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece });
            else if (apiMode === 'anthropic') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: piece } });
            else if (kind === 'reasoning') sse('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, delta: piece });
            else sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemIds.message, output_index: outputIndex, content_index: 0, delta: piece });
        }
        state[kind] += text;
    }
    function pushReasoning(text, sourceId = null) {
        if (state.ended || state.content || state.section === 'content') return;
        if (sourceId !== null) {
            if (state.reasoningSource !== null && state.reasoningSource !== sourceId) return;
            if (text) state.reasoningSource = sourceId;
        }
        emit('reasoning', text);
    }
    function pushContent(text) {
        if (state.ended) return;
        if (!state.content) {
            const combined = state.pendingWhitespace + text;
            if (!combined.trim()) { state.pendingWhitespace = combined; return; }
            state.pendingWhitespace = '';
            text = combined;
        }
        emit('content', text);
    }

    return {
        get started() { return state.started; },
        get lastWriteAt() { return state.lastWriteAt; },
        get streamedContent() { return state.content; },
        source(kind) {
            const sourceId = ++state.sources;
            if (kind === 'content' && !state.content) state.pendingWhitespace = '';
            let consumed = 0;
            let carry = '';
            return (cumulative) => {
                const raw = String(cumulative || '');
                if (raw.length <= consumed) return;
                let piece = carry + raw.slice(consumed);
                consumed = raw.length;
                carry = '';
                if (/[\ud800-\udbff]$/.test(piece)) { carry = piece.slice(-1); piece = piece.slice(0, -1); }
                piece = sanitizeContent(piece);
                if (kind === 'reasoning') pushReasoning(piece, sourceId);
                else pushContent(piece);
            };
        },
        keepAlive() {
            if (state.ended) return;
            start();
            res.write(': keep-alive\n\n');
            state.lastWriteAt = Date.now();
        },
        finish(openaiResp) {
            if (state.ended) return;
            const choice = openaiResp.choices[0];
            const msg = choice.message || {};
            const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;
            const usage = { input_tokens: openaiResp.usage?.prompt_tokens || 0, output_tokens: openaiResp.usage?.completion_tokens || 0 };
            start();
            if (toolCalls) {
                closeSection();
                if (apiMode === 'openai') {
                    openaiRole(true);
                    chunk({ tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) });
                    chunk({}, 'tool_calls');
                } else if (apiMode === 'anthropic') {
                    for (const tc of toolCalls) {
                        blockIndex++;
                        sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
                        sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
                        sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                    }
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage });
                } else {
                    for (const tc of toolCalls) {
                        outputIndex++;
                        const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
                        sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
                        sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
                        sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
                        sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
                    }
                }
            } else {
                const reasoning = String(msg.reasoning_content || '');
                if (reasoning && !state.content && reasoning.startsWith(state.reasoning)) pushReasoning(reasoning.slice(state.reasoning.length));
                const content = String(msg.content || '');
                let rest = content;
                if (state.content) {
                    if (content.startsWith(state.content)) {
                        rest = content.slice(state.content.length);
                    } else {
                        let common = 0;
                        while (common < state.content.length && content[common] === state.content[common]) common++;
                        rest = content.slice(common);
                    }
                }
                start();
                openSection('content');
                if (rest) emit('content', rest);
                closeSection();
                if (apiMode === 'openai') {
                    chunk({}, choice.finish_reason === 'length' ? 'length' : 'stop');
                } else if (apiMode === 'anthropic') {
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage });
                }
            }
            if (apiMode === 'anthropic') {
                sse('message_stop', { type: 'message_stop' });
            } else if (apiMode === 'responses') {
                const streamed = toolCalls ? openaiResp : {
                    ...openaiResp,
                    choices: [{ ...choice, message: { ...msg, reasoning_content: state.reasoning || undefined, content: state.content } }],
                };
                sse('response.completed', { type: 'response.completed', response: toResponsesResponse(streamed, itemIds) });
                res.write('data: [DONE]\n\n');
            } else {
                res.write('data: [DONE]\n\n');
            }
            state.ended = true;
            res.end();
        },
        fail(status, error, headers = {}) {
            if (state.ended) return;
            state.ended = true;
            if (!state.started) {
                if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
                res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                res.end(JSON.stringify({ error }));
                return;
            }
            const message = error?.message || 'Kimi request failed';
            if (apiMode === 'anthropic') {
                writeSse(res, 'error', { type: 'error', error: { type: anthropicErrorType(error?.type, status), message } });
            } else if (apiMode === 'responses') {
                writeSse(res, 'error', { type: 'error', code: error?.type || 'server_error', message, param: null, error: { ...error, status } });
            } else {
                writeSse(res, null, { error: { ...error, code: status } });
                res.write('data: [DONE]\n\n');
            }
            res.end();
        },
    };
}
function sendCompletion(res, apiMode, stream, openaiResponse) {
    if (stream) {
        createStreamWriter(res, apiMode, { model: openaiResponse.model, promptTokens: openaiResponse.usage?.prompt_tokens || 0, id: openaiResponse.id, created: openaiResponse.created }).finish(openaiResponse);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (apiMode === 'anthropic') res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
    else if (apiMode === 'responses') res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
    else res.end(JSON.stringify(openaiResponse));
}

// ── HTTP server ─────────────────────────────────────────────────────────────
let inFlight = 0;
const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isBrowserOriginAllowed(requestOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Browser origin is not allowed', type: 'cors_error' } }));
        return;
    }
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(requestOrigin));
    setCorsResponseHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isPublicProbe = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/readyz');
    if (!isPublicProbe && !isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key'])) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: { message: 'Invalid or missing proxy API key', type: 'authentication_error' } }));
        return;
    }
    maybeReloadAccounts();

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const includePrivateStatus = !PROXY_API_KEY || isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key']);
        const health = { status: 'ok', service: SERVICE_NAME, watermark: WATERMARK };
        if (includePrivateStatus) Object.assign(health, {
            models: SUPPORTED_MODEL_IDS,
            unsupported_models: Object.keys(MODEL_CONFIGS).filter((id) => !MODEL_CONFIGS[id].supported),
            agents: sessions.size,
            in_flight: inFlight,
            accounts: accounts.map(accountStatus),
            config_ready: hasAuthConfig(),
            session_reuse: {
                strategy: 'sticky per x-agent-session/user',
                ttl_minutes: Math.round(SESSION_TTL_MS / 60000),
                max_messages: MAX_MESSAGE_DEPTH,
                reset_all: 'POST /reset-session?agent=all',
            },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter((a) => (a.config.token || a.config.cookie) && a.cooldownUntil <= now).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: ready > 0, ready_accounts: ready, total_accounts: accounts.length }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: 'list',
            data: SUPPORTED_MODEL_IDS.map((id) => ({
                id,
                object: 'model',
                created: 1700000000,
                owned_by: 'kimi-web',
                real_model: MODEL_CONFIGS[id].real_model,
                capabilities: MODEL_CONFIGS[id].capabilities,
            })),
        }));
        return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', watermark: WATERMARK, data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.chatId || session.id,
                message_count: session.messageCount,
                account: session.accountId,
                history_size: session.history.length,
                tracked_messages: (session.sentMessageKeys || []).length,
                remote_chars: session.remoteChars || 0,
                busy: session.busy === true,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        resetRemoteSession(session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount }));
        return;
    }

    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    if (inFlight >= MAX_CONCURRENT) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
        return;
    }

    const bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            bodyChunks.length = 0;
            sendJsonError(res, 413, 'Request body too large', 'payload_too_large', {}, { Connection: 'close' });
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('end', async () => {
        if (bodyTooLarge) return;
        const body = Buffer.concat(bodyChunks).toString('utf8');
        inFlight++;
        let clientGone = false;
        const requestAbort = new AbortController();
        res.on('close', () => {
            if (res.writableFinished) return;
            clientGone = true;
            requestAbort.abort(new Error('client disconnected'));
        });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        let lockedSession = null;
        let live = null;
        let keepAliveTimer = null;
        let remoteTouched = false;
        const respondError = (status, error, headers = {}) => {
            if (live) { live.fail(status, error, headers); return; }
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify({ error }));
        };

        try {
            let rawParams;
            try { rawParams = JSON.parse(body || '{}'); }
            catch (e) { sendJsonError(res, 400, `Request body is not valid JSON: ${e.message}`, 'invalid_request_error'); return; }
            if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
                sendJsonError(res, 400, 'Request body must be a JSON object', 'invalid_request_error');
                return;
            }
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = Array.isArray(params.messages)
                ? params.messages.filter((m) => m && typeof m === 'object')
                : [];
            if (messages.length === 0) {
                sendJsonError(res, 400, 'messages must be a non-empty array', 'invalid_request_error');
                return;
            }
            const tools = Array.isArray(params.tools) ? params.tools : [];
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'kimi-k2.5').toLowerCase();
            if (!isKnownModel(requestedModel)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this Kimi Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            const modelCfg = resolveModelConfig(requestedModel);
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const agentId = requestedSession
                ? String(requestedSession)
                : ((remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') ? 'dev-agent' : remoteAddr);
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;

            const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
            const lastUserText = lastUserMessage ? normalizeMessageContent(lastUserMessage.content).trim() : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                sendCompletion(res, apiMode, stream, confirmation);
                return;
            }

            const { prompt, systemPrompt, toolReminder } = formatMessages(messages, tools);
            const clientPromptText = messages.map((m) => normalizeMessageContent(m.content)).join('\n');
            const allowedToolNames = new Set(tools
                .filter((tool) => tool?.type === 'function' && tool.function?.name)
                .map((tool) => tool.function.name));

            if (stream) {
                live = createStreamWriter(res, apiMode, { model: requestedModel, promptTokens: estimateTokens(clientPromptText) });
                keepAliveTimer = setInterval(() => {
                    if (Date.now() - Math.max(requestStartedAt, live.lastWriteAt) >= STREAM_KEEPALIVE_MS) live.keepAlive();
                }, 1000);
                keepAliveTimer.unref();
            }
            const liveProgress = () => {
                if (!live || allowedToolNames.size > 0) return null;
                const pushReasoning = live.source('reasoning');
                const pushContent = live.source('content');
                return (content, reasoning) => { pushReasoning(reasoning); pushContent(content); };
            };

            const agentSession = getOrCreateAgentSession(agentId);
            const ephemeral = agentSession.busy === true;
            const session = ephemeral ? createSession() : agentSession;
            if (ephemeral) {
                console.log(`${agentTag} Agent session is busy; serving this concurrent request in a separate Kimi chat.`);
            } else {
                agentSession.busy = true;
                lockedSession = agentSession;
            }
            activeSession = session;

            const promptRollover = prepareSessionForPrompt(session);
            if (promptRollover) {
                console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}); recovery history preserved.`);
            }

            const recoveryHistoryPrefix = hasExplicitConversationHistory(messages) ? '' : buildRecoveryHistoryPrefix(agentSession.history);
            const freshPromptBuild = buildBoundedPrompt(systemPrompt, recoveryHistoryPrefix, prompt);
            const contextKey = hashText(systemPrompt);
            const plan = planSessionTurn(session, messages, contextKey);
            let fullPrompt;
            let promptCompacted;
            if (plan.mode === 'delta') {
                const delta = buildDeltaPrompt(plan.messages, messages, toolReminder, MAX_PROMPT_CHARS, plan.includeSystem ? systemPrompt : '');
                fullPrompt = delta.prompt;
                promptCompacted = delta.compacted;
                console.log(`${agentTag} Sending ${plan.messages.length} new message(s) to the existing Kimi chat (${fullPrompt.length} chars${delta.compacted ? ', compacted' : ''})`);
            } else {
                if (session.chatId) {
                    console.log(`${agentTag} Starting a fresh Kimi chat: ${plan.reason}.`);
                    resetRemoteSession(session);
                }
                fullPrompt = freshPromptBuild.prompt;
                promptCompacted = freshPromptBuild.compacted;
                if (freshPromptBuild.compacted) {
                    console.log(`${agentTag} Compacted upstream prompt ${freshPromptBuild.originalChars} -> ${freshPromptBuild.promptChars} chars${freshPromptBuild.historyDropped ? ' (recovery history dropped)' : ''}`);
                }
            }
            if (promptCompacted) markContextCompacted(res);

            let lastAccount = null;
            const callKimi = async (promptText, freshPrompt = promptText) => {
                for (let attempt = 0; ; attempt++) {
                    if (requestAbort.signal.aborted) throw requestAbort.signal.reason || new Error('client disconnected');
                    const account = selectAccountForSession(session);
                    // Account selection may have reset the remote chat (sticky
                    // account cooling down). A fresh chat must receive the full
                    // prompt, never the delta of an older conversation.
                    const useDelta = plan.mode === 'delta' && Boolean(session.chatId);
                    const promptForCall = useDelta ? promptText : freshPrompt;
                    try {
                        const state = await runCompletion({
                            account,
                            prompt: promptForCall,
                            chatId: useDelta ? session.chatId : undefined,
                            parentId: useDelta ? session.assistantId : undefined,
                            thinking: modelCfg.thinking,
                            effort: resolveEffort(params.reasoning_effort || modelCfg.effort),
                            search: modelCfg.search,
                            signal: requestAbort.signal,
                            onProgress: liveProgress(),
                        });
                        remoteTouched = true;
                        lastAccount = account;
                        return { ...state, account, promptUsed: promptForCall };
                    } catch (error) {
                        const failedAccountId = session.accountId;
                        if (!isAccountLevelError(error) || attempt + 1 >= accounts.length
                            || !hasOtherReadyAccount(failedAccountId) || requestAbort.signal.aborted || deadlineHit()) {
                            throw error;
                        }
                        console.log(`${agentTag} Account ${failedAccountId} failed (HTTP ${error.upstreamStatus || error.status}); retrying on another account.`);
                        resetRemoteSession(session);
                        session.accountId = null;
                        promptText = freshPrompt;
                    }
                }
            };

            let firstState;
            try {
                firstState = await callKimi(fullPrompt, freshPromptBuild.prompt);
            } catch (error) {
                if (!isContextTooLongError(error)) throw error;
                console.log(`${agentTag} Kimi rejected the prompt as too long; retrying with a compacted prompt.`);
                resetRemoteSession(session);
                firstState = { text: '', think: '', finishReason: null, modelError: { type: 'error', content: error.message } };
            }
            if (firstState.promptUsed && firstState.promptUsed !== fullPrompt) {
                fullPrompt = firstState.promptUsed;
                if (freshPromptBuild.compacted) { promptCompacted = true; markContextCompacted(res); }
            }

            let fullContent = sanitizeContent(firstState.text || '');
            let reasoningContent = sanitizeContent(firstState.think || '');
            let finishReason = firstState.finishReason || null;
            let modelError = firstState.modelError || null;

            if (firstState.chatId) {
                session.chatId = firstState.chatId;
                session.id = firstState.chatId;
            }
            if (firstState.assistantId) {
                session.assistantId = firstState.assistantId;
                session.parentMessageId = firstState.assistantId;
            }
            if (firstState.chatId || firstState.assistantId) {
                session.messageCount++;
                session.createdAt = session.createdAt || Date.now();
            }
            session.remoteChars = (session.remoteChars || 0) + fullContent.length + reasoningContent.length;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${Date.now() - requestStartedAt}ms (msg#${session.messageCount})`);

            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                if (clientGone) {
                    console.log(`${agentTag} client disconnected; abandoning empty-retry loop`);
                    resetRemoteSession(session);
                    return;
                }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                const contextTooLong = isContextTooLongError(modelError);
                if (!contextTooLong && isRateLimitError(modelError)) {
                    markAccountFailure(lastAccount, 429, 'rate limited in stream', null, RATE_LIMIT_COOLDOWN_MS);
                    if (!hasOtherReadyAccount(lastAccount?.id)) break;
                } else if (modelError && !contextTooLong) {
                    break;
                }
                if (retryAttempt >= MAX_EMPTY_RETRIES) break;
                retryAttempt++;

                const retryRatio = contextTooLong
                    ? Math.max(0.35, 0.8 - retryAttempt * 0.2)
                    : Math.max(0.5, 1 - retryAttempt * 0.2);
                const retryBudget = Math.max(MIN_PROMPT_CHARS, Math.floor(MAX_PROMPT_CHARS * retryRatio));
                const retryBuild = buildBoundedPrompt(systemPrompt, recoveryHistoryPrefix, prompt, retryBudget);
                if (retryBuild.compacted) { promptCompacted = true; markContextCompacted(res); }
                const reason = contextTooLong ? 'context-too-long response' : (modelError ? 'rate-limited response' : 'empty response');
                console.log(`${agentTag} ${reason} (retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryBuild.prompt.length} chars). Resetting session...`);
                resetRemoteSession(session);
                session.accountId = null;
                await new Promise((r) => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                const retryState = await callKimi(retryBuild.prompt);
                fullPrompt = retryBuild.prompt;
                modelError = retryState.modelError || null;
                finishReason = retryState.finishReason || null;
                if (retryState.chatId) { session.chatId = retryState.chatId; session.id = retryState.chatId; }
                if (retryState.assistantId) { session.assistantId = retryState.assistantId; session.parentMessageId = retryState.assistantId; }
                if (retryState.chatId || retryState.assistantId) { session.messageCount++; session.createdAt = session.createdAt || Date.now(); }
                fullContent = sanitizeContent(retryState.text || '');
                reasoningContent = sanitizeContent(retryState.think || '');
                session.remoteChars = (session.remoteChars || 0) + fullContent.length + reasoningContent.length;
                if (fullContent.trim()) console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                const errorType = isContextTooLongError(modelError) ? 'context_length_exceeded'
                    : (isRateLimitError(modelError) ? 'rate_limit_error' : (timedOut ? 'request_timeout' : 'empty_response'));
                const status = errorType === 'context_length_exceeded' ? 400 : (errorType === 'rate_limit_error' ? 429 : (timedOut ? 504 : 502));
                const failure = resetRemoteSession(session);
                const errorMessage = modelError?.content
                    || (timedOut
                        ? 'Kimi request deadline reached while recovering an empty response'
                        : `Kimi returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`);
                console.log(`${agentTag} ${errorType} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Giving up.`);
                const headers = {};
                if (status === 429) headers['Retry-After'] = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                respondError(status, {
                    message: errorMessage,
                    type: errorType,
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: agentSession.history.length,
                    account: failure.accountId,
                    retry_attempts: retryAttempt,
                    upstream_prompt_chars: fullPrompt.length,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: modelCfg.real_model,
                }, headers);
                return;
            }

            let toolCall = allowedToolNames.size > 0 ? parseToolCall(fullContent) : null;
            if (toolCall && !allowedToolNames.has(toolCall.name)) {
                console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; ignoring.`);
                toolCall = null;
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent) && !clientGone && !deadlineHit()) {
                console.log(`${agentTag} Tool-call markup detected but invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                resetRemoteSession(session);
                session.accountId = null;
                await new Promise((r) => setTimeout(r, 1000));
                const strictPrompt = buildBoundedPrompt(
                    `${systemPrompt}\n\n[STRICT INSTRUCTION] Your previous response contained incomplete or invalid tool-call markup. Keep arguments short and output ONLY strict JSON: ${TOOL_CALL_FORMAT} (escape backslashes and newlines inside strings). Available tools: ${[...allowedToolNames].join(', ').substring(0, 1500)}`,
                    '',
                    prompt,
                ).prompt;
                const retryState = await callKimi(strictPrompt);
                const retryContent = sanitizeContent(retryState.text || '');
                if (retryContent.trim()) {
                    const retryTc = parseToolCall(retryContent);
                    if (retryTc && allowedToolNames.has(retryTc.name)) {
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name}`);
                        fullContent = retryContent;
                        reasoningContent = sanitizeContent(retryState.think || '');
                        toolCall = retryTc;
                    } else if (!looksLikeToolCallMarkup(retryContent)) {
                        console.log(`${agentTag} Strict retry returned a plain answer instead of tool markup.`);
                        fullContent = retryContent;
                        reasoningContent = sanitizeContent(retryState.think || '');
                        finishReason = retryState.finishReason || null;
                    } else {
                        console.log(`${agentTag} Retry still has broken tool markup; returning a safe error instead of leaking it as text.`);
                        reasoningContent = sanitizeContent(retryState.think || '') || reasoningContent;
                    }
                }
                if (retryState.chatId) { session.chatId = retryState.chatId; session.id = retryState.chatId; }
                if (retryState.assistantId) { session.assistantId = retryState.assistantId; session.parentMessageId = retryState.assistantId; }
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                const failure = resetRemoteSession(session);
                respondError(502, {
                    message: 'Kimi returned malformed tool-call markup after one repair attempt',
                    type: 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: agentSession.history.length,
                    account: failure.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: modelCfg.real_model,
                });
                return;
            }

            if (clientGone) {
                resetRemoteSession(session);
                console.log(`${agentTag} client disconnected before the answer was sent; discarding it`);
                return;
            }
            if (!ephemeral) storeHistory(agentSession, prompt, fullContent, toolCall);
            if (session.chatId) {
                session.sentMessageKeys = plan.keys;
                session.contextKey = contextKey;
            }

            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, clientPromptText, reasoningContent)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason);

            if (live) live.finish(openaiResponse);
            else sendCompletion(res, apiMode, false, openaiResponse);
            console.log(`${agentTag} ${stream ? 'Streamed' : 'Response'} ${apiMode} (tool=${Boolean(toolCall)}, ${Date.now() - requestStartedAt}ms, ${fullContent.length} chars)`);
        } catch (e) {
            console.log('[kimi] Error:', e.message);
            const failure = remoteTouched && activeSession && (activeSession.chatId || activeSession.id) ? resetRemoteSession(activeSession) : null;
            if (clientGone) return;
            const timedOut = isTimeoutError(e);
            const status = e.status || (timedOut ? 504 : 500);
            const headers = {};
            if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
            respondError(status, {
                message: e.message,
                type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
                ...(failure ? {
                    agent: activeAgentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: failure.accountId,
                } : {}),
            }, headers);
        } finally {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (lockedSession) lockedSession.busy = false;
            inFlight--;
        }
    });
});

// ── startup ─────────────────────────────────────────────────────────────────
async function main() {
    printBanner();
    requireProxyApiKey(PROXY_API_KEY, isTruthy(env.REQUIRE_PROXY_API_KEY));
    if (!isLoopbackHost(HOST) && !PROXY_API_KEY) {
        console.warn(`[kimi] WARNING: HOST=${HOST} exposes the proxy without authentication. Set PROXY_API_KEY or bind to 127.0.0.1.`);
    }
    loadAccounts({ fatal: false });
    if (!hasAuthConfig()) {
        console.warn('[kimi] no Kimi session configured — run "npm run auth" (writes kimi-auth.json)');
    }
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') console.error(`[kimi] FATAL: port ${PORT} already in use. Set PORT=<other> or stop the other instance.`);
        else console.error('[kimi] server error:', err);
        process.exit(1);
    });
    setInterval(sweepIdleSessions, 10 * 60 * 1000).unref();
    server.listen(PORT, HOST, () => {
        console.log(`[kimi] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log(`[kimi] ${formatWatermark()}`);
        console.log(`[kimi] upstream ${BASE}${CHAT_PATH}  model=${UPSTREAM_MODEL}`);
        console.log('[kimi] POST /v1/chat/completions — OpenAI Chat Completions');
        console.log('[kimi] POST /v1/messages — Anthropic Messages shim');
        console.log('[kimi] POST /v1/responses — OpenAI Responses shim');
        console.log('[kimi] GET  /v1/models, /v1/model-capabilities, /v1/sessions');
        console.log('[kimi] POST /reset-session?agent=<id|all>');
    });
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[kimi] FATAL:', error.message);
        process.exit(1);
    });
}

module.exports = {
    __test: {
        loadAccounts,
        accounts,
        buildAccountHeaders,
        normalizeAccountConfig,
        maybeReloadAccounts,
        MODEL_CONFIGS,
        SUPPORTED_MODEL_IDS,
        ALL_MODEL_CAPABILITIES,
        resolveModelConfig,
        resolveEffort,
        frame,
        FrameParser,
        TextFilter,
        formatMessages,
        formatConversation,
        formatToolDefinitions,
        formatToolReminder,
        parseToolCall,
        looksLikeToolCallMarkup,
        buildBoundedPrompt,
        truncatePromptMiddle,
        planSessionTurn,
        conversationMessageKey,
        normalizeMessageContent,
        normalizeApiParams,
        toAnthropicResponse,
        toResponsesResponse,
        buildTextResponse,
        buildToolCallResponse,
        createStreamWriter,
        createSession,
        resetRemoteSession,
        prepareSessionForPrompt,
        sweepIdleSessions,
        sessions,
        selectAccountForSession,
        hasOtherReadyAccount,
        markAccountFailure,
        isProxyAuthorized,
        isBrowserOriginAllowed,
        isLoopbackHost,
        normalizeOrigin,
        setCorsResponseHeaders,
        loadDotEnv,
    },
    server,
    runCompletion,
    loadAccounts,
    accounts,
};
