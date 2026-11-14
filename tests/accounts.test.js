'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fkimi-accounts-'));
const authPath = path.join(tmp, 'accounts.json');
fs.writeFileSync(authPath, JSON.stringify({
    accounts: [
        { name: 'expired', token: 'bad-token', cookie: 'k=v' },
        { name: 'healthy', token: 'good-token', cookie: 'k=v' },
    ],
}));
process.env.KIMI_AUTH_PATH = authPath;
process.env.KIMI_ACCOUNT_COOLDOWN_MS = '60000';
process.env.KIMI_RATE_LIMIT_COOLDOWN_MS = '1000';
process.env.KIMI_MAX_EMPTY_RETRIES = '0';
delete process.env.PROXY_API_KEY;
delete process.env.KIMI_AUTH_DIR;

const moduleUnderTest = require('../server.js');
const internals = moduleUnderTest.__test;
let port;

global.fetch = async (url, options = {}) => {
    const auth = String(options.headers?.authorization || '');
    if (auth === 'Bearer bad-token') {
        return new Response(JSON.stringify({ code: 'unauthenticated', message: 'expired' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
        });
    }
    const textFrame = new Uint8Array(internals.frame({ block: { text: { content: 'rotated ok' } } }));
    const doneFrame = new Uint8Array(internals.frame({ message: { role: 'assistant', id: 'm1', status: 'MESSAGE_STATUS_COMPLETED' } }));
    return new Response(new ReadableStream({
        start(controller) { controller.enqueue(textFrame); controller.enqueue(doneFrame); controller.close(); },
    }), { status: 200 });
};

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: pathname, method,
            headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* ignore */ }
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test.before(async () => {
    internals.loadAccounts();
    assert.equal(internals.accounts.length, 2);
    await new Promise((resolve) => moduleUnderTest.server.listen(0, '127.0.0.1', resolve));
    port = moduleUnderTest.server.address().port;
});

test.after(async () => {
    await new Promise((resolve) => moduleUnderTest.server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('an expired account rotates to the healthy one', async () => {
    const res = await request('POST', '/v1/chat/completions', {
        model: 'kimi-k2.5',
        user: 'rotation-agent',
        messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.choices[0].message.content, 'rotated ok');

    const health = await request('GET', '/health');
    const expired = health.json.accounts.find((a) => a.id === 'account_1');
    const healthy = health.json.accounts.find((a) => a.id === 'account_2');
    assert.equal(expired.cooldown, true);
    assert.equal(healthy.ready, true);
    assert.equal(health.json.accounts.find((a) => a.id === 'account_1').failures, 1);
});
