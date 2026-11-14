// Kimi Auth Exporter — Background Service Worker
// Reads cookies for kimi.ai, captures the live Chat request headers (bearer
// token + x-msh-shield-data), and merges localStorage values from the tab.

const STORAGE_KEY = 'kimi_auth';
const CAPTURED = { authorization: '', shield: '', at: 0 };

// The SPA sends its access token and shield header on every Chat request.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    let authorization = '';
    let shield = '';
    for (const header of details.requestHeaders || []) {
      const name = String(header.name || '').toLowerCase();
      if (name === 'authorization') authorization = header.value || '';
      if (name === 'x-msh-shield-data') shield = header.value || '';
    }
    if (authorization) CAPTURED.authorization = authorization;
    if (shield) CAPTURED.shield = shield;
    CAPTURED.at = Date.now();
  },
  { urls: ['https://www.kimi.ai/apiv2/*', 'https://*.kimi.ai/apiv2/*'] },
  ['requestHeaders', 'extraHeaders']
);

function normalizeToken(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return String(parsed.value || parsed.token || parsed.access_token || parsed.accessToken || '').trim();
    }
    if (typeof parsed === 'string') return parsed.trim();
  } catch (e) { /* plain string */ }
  return String(raw).trim();
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp || 0) || null;
  } catch (e) {
    return null;
  }
}

async function readCookies() {
  const cookies = await new Promise((resolve) => chrome.cookies.getAll({ domain: 'kimi.ai' }, resolve));
  const list = (cookies || []).filter((c) => /(^|\.)kimi\.ai$/i.test(c.domain));
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

function findKimiTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['https://www.kimi.ai/*', 'https://*.kimi.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || tabs.length === 0) resolve(null);
      else resolve(tabs[0]);
    });
  });
}

async function readStorage(tabId) {
  if (tabId === null) return {};
  try {
    return await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, {
        action: 'readStorage',
        keys: [
          'token', 'access_token', 'accessToken', 'auth_token', 'refreshToken', 'refresh_token',
          'x-msh-shield-data', 'shield', 'deviceId', 'device_id', 'sessionId', 'session_id', 'trafficId', 'traffic_id',
        ],
      }, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
        else resolve((response && response.data) || {});
      });
    });
  } catch (e) {
    return {};
  }
}

function firstValue(store, keys) {
  for (const key of keys) {
    const value = normalizeToken(store[key]);
    if (value) return value;
  }
  return '';
}

async function buildAuth() {
  const tab = await findKimiTab();
  const store = await readStorage(tab ? tab.id : null);
  const token = normalizeToken(CAPTURED.authorization) || firstValue(store, ['token', 'access_token', 'accessToken', 'auth_token']);
  const refreshToken = firstValue(store, ['refreshToken', 'refresh_token']);
  const shield = CAPTURED.shield || firstValue(store, ['x-msh-shield-data', 'shield']);
  const auth = {
    token,
    refreshToken,
    cookie: await readCookies(),
    shield,
    deviceId: firstValue(store, ['deviceId', 'device_id']),
    sessionId: firstValue(store, ['sessionId', 'session_id']),
    trafficId: firstValue(store, ['trafficId', 'traffic_id']),
    tokenExpiresAt: decodeJwtExp(token),
    capturedAt: new Date().toISOString(),
    fromChatRequest: Boolean(CAPTURED.authorization),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: auth });
  return auth;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'refresh') {
    buildAuth().then((auth) => sendResponse({ ok: true, auth })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (request.action === 'get') {
    chrome.storage.local.get(STORAGE_KEY, (data) => sendResponse({ ok: true, auth: data[STORAGE_KEY] || null }));
    return true;
  }
  if (request.action === 'download') {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const auth = data[STORAGE_KEY];
      if (!auth) { sendResponse({ ok: false, error: 'Refresh first' }); return; }
      const clean = { ...auth };
      delete clean.capturedAt;
      delete clean.fromChatRequest;
      const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(clean, null, 2));
      chrome.downloads.download({ url, filename: 'kimi-auth.json', saveAs: true }, (id) => {
        sendResponse({ ok: Boolean(id), error: chrome.runtime.lastError?.message });
      });
    });
    return true;
  }
});
