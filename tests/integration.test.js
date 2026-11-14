'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Configure the proxy before requiring it (auth path, key, retries).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fkimi-test-'));
const authPath = path.join(tmp, 'kimi-auth.json');
fs.writeFileSync(authPath, JSON.stringify({ token: 'test-token', cookie: 'k=v', shield: 'sg:test' }));
process.env.KIMI_AUTH_PATH = authPath;
process.env.PROXY_API_KEY = 'test-key';
process.env.KIMI_MAX_EMPTY_RETRIES = '0';
process.env.KIMI_ACCOUNT_COOLDOWN_MS = '1000';
delete process.env.KIMI_AUTH_DIR;

const moduleUnderTest = require('../server.js');
const internals = moduleUnderTest.__test;
const AUTH = { authorization: 'Bearer test-key' };

let mode = 'text';
let capturedPrompts = [];
let lastBody = null;

function encodeFrame(obj) {
    return new Uint8Array(internals.frame(obj));
}

function upstreamStream() {
    const parts = [encodeFrame({ chat: { id: 'chat_test' } })];
    if (mode === 'text' || mode === 'tool') {
        parts.push(encodeFrame({ block: { think: { content: 'thinking' } } }));
        const content = mode === 'tool'
            ? '{"tool_call":{"name":"get_weather","arguments":{"city":"NY"}}}'
            : 'Hello from Kimi';
        parts.push(encodeFrame({ block: { text: { content } } }));
        parts.push(encodeFrame({ block: { text: { content: '!' } } }));
        parts.push(encodeFrame({ message: { role: 'assistant', id: 'msg_1', status: 'MESSAGE_STATUS_COMPLETED' } }));
    }
    const stream = new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/connect+json' } });
}

global.fetch = async (url, options = {}) => {
    if (!String(url).includes('ChatService/Chat')) {
        return new Response('unexpected upstream url', { status: 404 });
    }
    try {
        const body = Buffer.from(options.body);
        const len = body.readUInt32BE(1);
        lastBody = JSON.parse(body.subarray(5, 5 + len).toString('utf8'));
        capturedPrompts.push(lastBody.message?.blocks?.[0]?.text?.content || '');
    } catch (e) {
        lastBody = null;
    }
    return upstreamStream();
};

function request(port, method, pathname, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers: {
                ...AUTH,
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* stream or plain text */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

let port;

test.before(async () => {
    internals.loadAccounts();
    await new Promise((resolve) => moduleUnderTest.server.listen(0, '127.0.0.1', resolve));
    port = moduleUnderTest.server.address().port;
});

test.after(async () => {
    await new Promise((resolve) => moduleUnderTest.server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('health, models and capabilities are public/authorized', async () => {
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.service, 'FreeKimiAPI');
    assert.equal(health.json.config_ready, true);

    const models = await request(port, 'GET', '/v1/models');
    assert.equal(models.status, 200);
    assert.ok(models.json.data.some((m) => m.id === 'kimi-k2.5'));

    const caps = await request(port, 'GET', '/v1/model-capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.json.data['kimi-k2.5'].capabilities.tool_calls, true);

    const unauthorized = await request(port, 'GET', '/v1/models', undefined, { authorization: '' });
    assert.equal(unauthorized.status, 401);
});

test('OpenAI chat completion streams and non-streams', async () => {
    mode = 'text';
    const body = {
        model: 'kimi-k2.5',
        user: 'agent-openai',
        messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
    };
    const plain = await request(port, 'POST', '/v1/chat/completions', body);
    assert.equal(plain.status, 200);
    assert.equal(plain.json.choices[0].message.content, 'Hello from Kimi!');
    assert.equal(plain.json.choices[0].message.reasoning_content, 'thinking');
    assert.equal(plain.json.usage.completion_tokens_details.reasoning_tokens > 0, true);

    const streamed = await request(port, 'POST', '/v1/chat/completions', { ...body, user: 'agent-stream', stream: true });
    assert.equal(streamed.status, 200);
    assert.match(streamed.text, /data: /);
    assert.match(streamed.text, /"content":"Hello/);
    assert.match(streamed.text, /data: \[DONE\]/);
});

test('session reuse sends only the new turn with parent_id', async () => {
    mode = 'text';
    capturedPrompts = [];
    const first = [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'first question' },
    ];
    const r1 = await request(port, 'POST', '/v1/chat/completions', { model: 'kimi-k2.5', user: 'agent-reuse', messages: first });
    assert.equal(r1.status, 200);
    const firstPrompt = capturedPrompts[capturedPrompts.length - 1];
    assert.match(firstPrompt, /first question/);

    const second = [
        ...first,
        { role: 'assistant', content: 'Hello from Kimi!' },
        { role: 'user', content: 'second question' },
    ];
    const r2 = await request(port, 'POST', '/v1/chat/completions', { model: 'kimi-k2.5', user: 'agent-reuse', messages: second });
    assert.equal(r2.status, 200);
    const secondPrompt = capturedPrompts[capturedPrompts.length - 1];
    assert.match(secondPrompt, /second question/);
    assert.doesNotMatch(secondPrompt, /first question/);
    assert.equal(lastBody.chat_id, 'chat_test');
    assert.equal(lastBody.message.parent_id, 'msg_1');
});

test('tool definitions produce OpenAI tool_calls', async () => {
    mode = 'tool';
    const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'kimi-k2.5',
        user: 'agent-tools',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(res.json.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(JSON.parse(res.json.choices[0].message.tool_calls[0].function.arguments).city, 'NY');
    assert.match(capturedPrompts[capturedPrompts.length - 1], /TOOL REQUEST SYSTEM/);
});

test('Anthropic Messages and Responses shims work', async () => {
    mode = 'text';
    const anthropic = await request(port, 'POST', '/v1/messages', {
        model: 'kimi-k2.5',
        max_tokens: 100,
        system: 'Be brief.',
        messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(anthropic.status, 200);
    assert.equal(anthropic.json.type, 'message');
    assert.equal(anthropic.json.content[0].text, 'Hello from Kimi!');
    assert.equal(anthropic.json.stop_reason, 'end_turn');

    const responses = await request(port, 'POST', '/v1/responses', {
        model: 'kimi-k2.5',
        input: 'hi',
    });
    assert.equal(responses.status, 200);
    assert.equal(responses.json.object, 'response');
    assert.equal(responses.json.output_text, 'Hello from Kimi!');

    mode = 'tool';
    const tool = await request(port, 'POST', '/v1/messages', {
        model: 'kimi-k2.5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
    });
    assert.equal(tool.json.stop_reason, 'tool_use');
});

test('unknown models and /new are handled without an upstream call', async () => {
    const bad = await request(port, 'POST', '/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.type, 'invalid_model');

    const fresh = await request(port, 'POST', '/v1/chat/completions', {
        model: 'kimi-k2.5',
        user: 'agent-new',
        messages: [{ role: 'user', content: '/new' }],
    });
    assert.equal(fresh.status, 200);
    assert.match(fresh.json.choices[0].message.content, /Started a new chat/);
});
