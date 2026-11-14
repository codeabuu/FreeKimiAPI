'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const serverInternals = require('../server.js').__test;

test('image parts become markers and never leak base64', () => {
    const marker = serverInternals.normalizeMessageContent([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(2000) } },
    ]);
    assert.equal(marker, '[Image attached; not visible through this proxy]');
    assert.equal(marker.includes('AAAA'), false);
});

test('remote image URLs are described without downloading them', () => {
    const marker = serverInternals.normalizeMessageContent([
        { type: 'input_image', image_url: 'https://example.com/pic.png' },
    ]);
    assert.equal(marker, '[Image: https://example.com/pic.png]');
});

test('vision capability is advertised as unavailable', () => {
    const cfg = serverInternals.resolveModelConfig('kimi-k2.5');
    assert.equal(cfg.capabilities.vision, false);
    assert.equal(cfg.capabilities.files, false);
});
