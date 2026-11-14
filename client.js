#!/usr/bin/env node
'use strict';
/**
 * FreeKimiAPI CLI client.
 *
 * Usage:
 *   node client.js "your prompt here"
 *   node client.js --model kimi-k2.5-thinking "reason about this"
 *   echo "summarize" | node client.js
 *   node client.js --think "show the reasoning too"
 *
 * Talks to Kimi's web gateway directly (no proxy required). Auth is read from
 * kimi-auth.json (written by `npm run auth`) or KIMI_AUTH_PATH / KIMI_AUTH_DIR.
 * Environment variables KIMI_TOKEN / KIMI_COOKIE override a single file.
 */

const readline = require('node:readline');
const { runCompletion, loadAccounts, accounts, __test } = require('./server.js');

const { resolveModelConfig, resolveEffort, normalizeAccountConfig } = __test;

function usage() {
    console.log('Usage: node client.js [--model <alias>] [--think] [--no-search] [prompt]');
    console.log('       echo "prompt" | node client.js');
    console.log('Aliases: ' + __test.SUPPORTED_MODEL_IDS.join(', '));
}

function parseArgs(argv) {
    const opts = { model: 'kimi-k2.5', showThink: false, search: undefined, promptParts: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        if (arg === '--think') { opts.showThink = true; continue; }
        if (arg === '--no-search') { opts.search = false; continue; }
        if (arg === '--model' || arg === '-m') { opts.model = argv[++i] || opts.model; continue; }
        if (arg.startsWith('--model=')) { opts.model = arg.slice('--model='.length); continue; }
        opts.promptParts.push(arg);
    }
    return opts;
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => { data += line + '\n'; });
        rl.on('close', () => resolve(data.trim()));
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return; }

    let prompt = opts.promptParts.join(' ').trim();
    if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
    if (!prompt) {
        usage();
        process.exitCode = 1;
        return;
    }

    const modelCfg = resolveModelConfig(opts.model);
    if (!modelCfg) {
        console.error(`Unknown model: ${opts.model}`);
        console.error('Supported: ' + __test.SUPPORTED_MODEL_IDS.join(', '));
        process.exit(1);
    }

    loadAccounts({ fatal: false });
    let account = accounts.find((a) => (a.config.token || a.config.cookie) && a.cooldownUntil <= Date.now());
    if (!account) {
        const config = normalizeAccountConfig({
            token: process.env.KIMI_TOKEN || process.env.KIMI_AUTHORIZATION,
            cookie: process.env.KIMI_COOKIE,
            shield: process.env.KIMI_SHIELD,
            deviceId: process.env.KIMI_DEVICE_ID,
            sessionId: process.env.KIMI_SESSION_ID,
            trafficId: process.env.KIMI_TRAFFIC_ID,
        });
        if (!config) {
            console.error('Error: Kimi auth is not set. Run `npm run auth`, or set KIMI_TOKEN/KIMI_COOKIE.');
            process.exit(1);
        }
        account = { id: 'env', file: 'environment', config, headers: __test.buildAccountHeaders(config), cooldownUntil: 0, failures: 0 };
    }

    let wrote = false;
    const state = await runCompletion({
        account,
        prompt,
        thinking: opts.showThink ? true : modelCfg.thinking,
        effort: resolveEffort(modelCfg.effort),
        search: opts.search === undefined ? modelCfg.search : opts.search,
        onProgress: (text, think) => {
            if (opts.showThink && think) {
                process.stderr.write(think);
                wrote = true;
            }
            if (text) {
                process.stdout.write(text);
                wrote = true;
            }
        },
    });

    if (!wrote && state.text) process.stdout.write(state.text);
    if (process.stdout.isTTY) process.stdout.write('\n');
}

main().catch((error) => {
    console.error('\nError:', error.message);
    process.exitCode = 1;
});
