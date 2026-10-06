/**
 * Extension WebSocket protocol test (issue 183).
 *
 * Drives the mirror-server extension through its real WebSocket server with
 * a mocked ExtensionAPI (pi). This is the single test seam for command
 * routing: the same interface the browser uses.
 *
 * Asserts external behavior only:
 *   - a /skill:name prompt reaches pi.sendUserMessage with
 *     expandPromptTemplates true
 *   - a plain prompt reaches pi.sendUserMessage unexpanded
 *   - get_commands returns pi's command list
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const require = createRequire(import.meta.url);

// ── Sandbox + port BEFORE the extension module loads ──
// The extension reads settings and pins PORT/HOST at import time.

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const PORT = await getFreePort();
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-test-'));
process.env.HOME = tmpHome;
process.env.TAU_MIRROR_PORT = String(PORT);
process.env.TAU_HOST = '127.0.0.1';
process.env.TAU_STATIC_DIR = path.resolve(new URL('../public', import.meta.url).pathname);

const { WebSocket } = require('ws');
const jiti = require('jiti')(import.meta.url);
const extension = jiti(new URL('../extensions/mirror-server.ts', import.meta.url).pathname).default;

// ── Mocks ──

function makeMockPi() {
  const calls = { sendUserMessage: [] };
  const handlers = {};
  const pi = {
    sendUserMessage: (message, options) => {
      calls.sendUserMessage.push({ message, options });
    },
    getCommands: () => [
      { name: 'taustop', description: 'Stop the Tau mirror server', source: 'extension', sourceInfo: null },
      { name: 'greet', description: 'Greeting template', source: 'prompt', sourceInfo: null },
      { name: 'skill:alpha', description: 'Alpha test skill', source: 'skill', sourceInfo: null },
      { name: 'skill:beta', description: 'Beta test skill', source: 'skill', sourceInfo: null },
    ],
    getThinkingLevel: () => 'off',
    getSessionName: () => 'Test Session',
    setSessionName: () => {},
    registerCommand: () => {},
    on: (type, handler) => {
      (handlers[type] = handlers[type] || []).push(handler);
    },
  };
  return { pi, calls, handlers };
}

function makeMockCtx() {
  return {
    isIdle: () => true,
    model: { id: 'test-model', provider: 'test-provider' },
    modelRegistry: { getAvailable: async () => [] },
    sessionManager: {
      getSessionFile: () => path.join(tmpHome, 'test-session.jsonl'),
      getEntries: () => [],
    },
    getContextUsage: () => null,
    ui: { setStatus: () => {}, notify: () => {} },
    cwd: tmpHome,
    abort: () => {},
    compact: () => {},
  };
}

function waitForServer(port) {
  const deadline = Date.now() + 10000;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else poll();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start'));
        else setTimeout(poll, 100);
      });
    })();
  });
}

// ── Setup / teardown ──

let ws;
let calls;
let handlers;
let ctx;

before(async () => {
  const mock = makeMockPi();
  calls = mock.calls;
  handlers = mock.handlers;
  ctx = makeMockCtx();

  extension(mock.pi);

  // Fire the session_start handlers (title reset + auto-start)
  for (const h of handlers.session_start || []) await h({ type: 'session_start' }, ctx);

  await waitForServer(PORT);

  await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', resolve);
    ws.on('error', reject);
  });
});

after(async () => {
  if (ws) {
    await new Promise((resolve) => {
      ws.on('close', resolve);
      ws.close();
      setTimeout(resolve, 1000);
    });
  }
  for (const h of handlers.session_shutdown || []) await h({ type: 'session_shutdown' }, ctx);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function sendCommand(command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timeout waiting for response to ${command.type}`));
    }, 5000);
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'response' && msg.id === command.id) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(command));
  });
}

// ── Tests ──

test('prompt with /skill:name reaches pi.sendUserMessage with expandPromptTemplates true', async () => {
  const resp = await sendCommand({ id: 1, type: 'prompt', message: '/skill:alpha do the thing' });
  assert.equal(resp.success, true);
  const call = calls.sendUserMessage.at(-1);
  assert.equal(call.message, '/skill:alpha do the thing');
  assert.equal(call.options.expandPromptTemplates, true);
});

test('plain prompt reaches pi.sendUserMessage unexpanded', async () => {
  const resp = await sendCommand({ id: 2, type: 'prompt', message: 'hello world' });
  assert.equal(resp.success, true);
  const call = calls.sendUserMessage.at(-1);
  // The message is delivered exactly as typed — no expansion of any kind.
  assert.equal(call.message, 'hello world');
});

test('get_commands returns pi command list', async () => {
  const resp = await sendCommand({ id: 3, type: 'get_commands' });
  assert.equal(resp.success, true);
  assert.ok(Array.isArray(resp.data.commands));
  const alpha = resp.data.commands.find((c) => c.name === 'skill:alpha');
  assert.ok(alpha, 'skill:alpha present in command list');
  assert.equal(alpha.source, 'skill');
  assert.equal(alpha.description, 'Alpha test skill');
  assert.ok(resp.data.commands.some((c) => c.name === 'skill:beta'));
});
