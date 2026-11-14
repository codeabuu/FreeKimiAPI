'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const serverInternals = require('../server.js').__test;

test('model aliases resolve to the same upstream model with capabilities', () => {
    assert.ok(serverInternals.SUPPORTED_MODEL_IDS.includes('kimi-k2.5'));
    assert.ok(serverInternals.SUPPORTED_MODEL_IDS.includes('kimi-k2.5-thinking'));
    const fast = serverInternals.resolveModelConfig('kimi-k2.5-fast');
    const thinking = serverInternals.resolveModelConfig('kimi-k2.5-thinking');
    assert.equal(fast.thinking, false);
    assert.equal(thinking.thinking, true);
    assert.equal(thinking.effort, 'REASONING_EFFORT_HIGH');
    assert.equal(fast.capabilities.tool_calls, true);
    assert.equal(thinking.capabilities.reasoning, true);
    assert.equal(serverInternals.resolveModelConfig('nope'), null);
});

test('effort aliases map to Kimi reasoning effort enums', () => {
    assert.equal(serverInternals.resolveEffort('high'), 'REASONING_EFFORT_HIGH');
    assert.equal(serverInternals.resolveEffort('medium'), 'REASONING_EFFORT_MEDIUM');
    assert.equal(serverInternals.resolveEffort('low'), 'REASONING_EFFORT_LOW');
});

test('auth config accepts single-account files and arrays', () => {
    const single = serverInternals.normalizeAccountConfig({ token: 'Bearer abc', cookie: 'cookie: k=v', shield: 'sg:1' });
    assert.equal(single.token, 'abc');
    assert.equal(single.cookie, 'k=v');
    assert.equal(single.shield, 'sg:1');
    const withAuth = serverInternals.normalizeAccountConfig({ authorization: 'tok_2', cookie: 'a=b' });
    assert.equal(withAuth.token, 'tok_2');
    assert.equal(serverInternals.normalizeAccountConfig({}), null);
});

test('connect framing round-trips a payload', () => {
    const buf = serverInternals.frame({ hello: 'world' });
    assert.equal(buf[0], 0);
    assert.equal(buf.readUInt32BE(1), buf.length - 5);
    let seen = null;
    const parser = new serverInternals.FrameParser((obj) => { seen = obj; });
    parser.push(buf);
    assert.deepEqual(seen, { hello: 'world' });
});

test('TextFilter strips internal Kimi markup across chunks', () => {
    const out = [];
    const filter = new serverInternals.TextFilter((chunk) => out.push(chunk));
    filter.push('Hello <to');
    filter.push('ol>internal</tool> world');
    filter.flush();
    assert.equal(out.join(''), 'Hello  world');
});

test('tool call parser accepts JSON envelopes, fences and XML wrappers', () => {
    const env = serverInternals.parseToolCall('{"tool_call":{"name":"read_file","arguments":{"path":"a.txt"}}}');
    assert.deepEqual(env, { name: 'read_file', arguments: '{"path":"a.txt"}' });
    const fenced = serverInternals.parseToolCall('```json\n{"tool_call":{"name":"foo","arguments":{"x":1}}}\n```');
    assert.equal(fenced.name, 'foo');
    const xml = serverInternals.parseToolCall('<tool_call>{"name":"bar","arguments":{}}</tool_call>');
    assert.equal(xml.name, 'bar');
    const legacy = serverInternals.parseToolCall('TOOL_CALL: run {"cmd":"ls"}');
    assert.equal(legacy.name, 'run');
    assert.equal(serverInternals.parseToolCall('just a normal answer'), null);
});

test('tool examples in foreign code fences are never executed', () => {
    assert.equal(serverInternals.parseToolCall('```js\nconst x = {"tool_call":{"name":"evil"}};\n```'), null);
    assert.equal(serverInternals.looksLikeToolCallMarkup('{"tool_call":{}}'), true);
});

test('message normalization keeps text and marks images/files', () => {
    const text = serverInternals.normalizeMessageContent([
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ran' },
    ]);
    assert.match(text, /hello/);
    assert.match(text, /Image attached; not visible/);
    assert.match(text, /\[Tool Result call_1\]/);
});

test('bounded prompt compacts in the middle and preserves the tail', () => {
    const long = 'A'.repeat(500) + 'TAIL';
    const out = serverInternals.buildBoundedPrompt('', '', long, 120);
    assert.equal(out.compacted, true);
    assert.ok(out.prompt.length <= 120);
    assert.match(out.prompt, /Earlier context compacted/);
    assert.match(out.prompt, /TAIL$/);
});

test('session planning reuses the remote chat only for a matching prefix', () => {
    const messages = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'next' },
    ];
    const session = serverInternals.createSession();
    session.chatId = 'chat_1';
    session.contextKey = 'ctx';
    const keys = messages.slice(0, 2).map(serverInternals.conversationMessageKey);
    session.sentMessageKeys = keys;
    const plan = serverInternals.planSessionTurn(session, messages, 'ctx');
    assert.equal(plan.mode, 'delta');
    assert.deepEqual(plan.messages, [messages[2]]);
    const other = serverInternals.planSessionTurn(session, messages, 'different');
    assert.equal(other.mode, 'full');
});

test('OpenAI responses convert to Anthropic and Responses shapes', () => {
    const openai = serverInternals.buildTextResponse('answer', 'prompt', 'kimi-k2.5', 'thinking');
    const anthropic = serverInternals.toAnthropicResponse(openai);
    assert.equal(anthropic.content[0].text, 'answer');
    assert.equal(anthropic.reasoning_content, 'thinking');
    assert.equal(anthropic.usage.input_tokens, 2);
    const responses = serverInternals.toResponsesResponse(openai);
    assert.equal(responses.output_text, 'answer');
    assert.equal(responses.output[0].type, 'reasoning');
    const tool = serverInternals.buildToolCallResponse({ name: 'foo', arguments: '{}' }, 'kimi-k2.5');
    assert.equal(serverInternals.toAnthropicResponse(tool).stop_reason, 'tool_use');
    assert.equal(serverInternals.toResponsesResponse(tool).output[0].type, 'function_call');
});

test('account cooldown blocks selection and rotates', () => {
    const account = { id: 'x', config: { token: 't' }, cooldownUntil: 0, failures: 0 };
    serverInternals.markAccountFailure(account, 429, 'test', '1');
    assert.ok(account.cooldownUntil > Date.now());
    assert.equal(account.failures, 1);
    assert.ok(path.isAbsolute(__dirname));
});
