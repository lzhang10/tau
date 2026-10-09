/**
 * Extension WebSocket protocol test.
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
 *   - a valid edit responds success and the handler branches before sending
 *     the stashed text
 *   - the dispatched command line carries the entry id, never the text
 *   - a busy agent is rejected without dispatch
 *   - a missing entry is rejected
 *   - a non-user entry is rejected
 *   - a cancelled navigation discards the stash and broadcasts an error notice
 *   - an unchanged-text edit resends the original content
 */
import { test, before, after, beforeEach } from 'node:test';
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
//
// The mock pi records every call in a shared `events` log, in order. When
// sendUserMessage is called with a registered hidden command (e.g.
// "/tau-tree edit <id>"), the mock dispatches it to the registered handler
// with the mock ctx — emulating the pi dispatcher — so the test can observe
// the full command flow (branch, then send) through the same seam the browser
// uses.

function makeMocks() {
  const events = [];
  const commands = {};
  const handlers = {};

  const ctx = {
    // Test knobs (reset per test in beforeEach)
    _idle: true,
    _entries: [],
    _stale: false,
    _navResult: undefined,
    _forkResult: undefined,
    _switchResult: undefined,
    // Mirrors pi's ExtensionRunner.assertActive: throws once a session
    // replacement invalidates the ctx, so tests can exercise the stale-ctx
    // path a real resume triggers.
    assertActive: () => {
      if (ctx._stale) throw new Error('This extension ctx is stale after session replacement');
    },
    isIdle: () => { ctx.assertActive(); return ctx._idle; },
    waitForIdle: async () => {},
    switchSession: async (sessionPath, opts) => {
      events.push({ type: 'switchSession', sessionPath, opts });
      return ctx._switchResult ?? { cancelled: false };
    },
    navigateTree: async (entryId) => {
      events.push({ type: 'navigateTree', entryId });
      return ctx._navResult ?? { cancelled: false };
    },
    fork: async (entryId, opts) => {
      events.push({ type: 'fork', entryId, opts });
      return ctx._forkResult ?? { cancelled: false };
    },
    model: { id: 'test-model', provider: 'test-provider' },
    modelRegistry: { getAvailable: async () => [] },
    sessionManager: {
      getSessionFile: () => { ctx.assertActive(); return path.join(tmpHome, 'test-session.jsonl'); },
      getEntries: () => { ctx.assertActive(); return ctx._entries; },
      getBranch: () => { ctx.assertActive(); return ctx._entries; },
      getEntry: (id) => { ctx.assertActive(); return ctx._entries.find((e) => e.id === id); },
    },
    getContextUsage: () => { ctx.assertActive(); return null; },
    ui: { setStatus: () => {}, notify: () => {} },
    cwd: tmpHome,
    abort: () => {},
    compact: () => {},
  };

  const pi = {
    sendUserMessage: (message, options) => {
      events.push({ type: 'sendUserMessage', message, options });
      // Emulate the pi dispatcher for registered hidden commands.
      const m = /^\/([a-zA-Z0-9-]+)(?:\s+(.*))?$/.exec(message);
      if (m && commands[m[1]]) {
        const name = m[1];
        const argStr = m[2] ?? '';
        // Fire-and-forget, like the real dispatcher.
        Promise.resolve(commands[name].handler(argStr, ctx)).catch((e) => {
          events.push({ type: 'commandError', name, error: e?.message || String(e) });
        });
      }
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
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    on: (type, handler) => {
      (handlers[type] = handlers[type] || []).push(handler);
    },
  };

  return { pi, ctx, events, commands, handlers };
}

function waitFor(pred, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (pred()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('timeout waiting for condition'));
      setTimeout(poll, 10);
    })();
  });
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
let events;
let broadcasts;
let ctx;
let handlers;
let mock2; // Fresh module closure (adoption test)

before(async () => {
  const mock = makeMocks();
  events = mock.events;
  ctx = mock.ctx;
  handlers = mock.handlers;

  extension(mock.pi);

  // Fire the session_start handlers (title reset + auto-start). This also
  // pins latestCtx to the mock ctx, which the WS handler guards against.
  for (const h of handlers.session_start || []) await h({ type: 'session_start' }, ctx);

  await waitForServer(PORT);

  await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Collect every server-to-client message (responses + broadcasts).
  broadcasts = [];
  ws.on('message', (data) => {
    try {
      broadcasts.push(JSON.parse(data.toString()));
    } catch {
      /* ignore non-JSON */
    }
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

beforeEach(() => {
  events.length = 0;
  broadcasts.length = 0;
  ctx._idle = true;
  ctx._entries = [];
  ctx._stale = false;
  ctx._navResult = undefined;
  ctx._forkResult = undefined;
  ctx._switchResult = undefined;
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

// Helper: a user entry with the given id and text content.
const userEntry = (id, content) => ({ id, type: 'message', message: { role: 'user', content } });

// ── Tests ──

test('prompt with /skill:name reaches pi.sendUserMessage with expandPromptTemplates true', async () => {
  const resp = await sendCommand({ id: 1, type: 'prompt', message: '/skill:alpha do the thing' });
  assert.equal(resp.success, true);
  const call = events.at(-1);
  assert.equal(call.type, 'sendUserMessage');
  assert.equal(call.message, '/skill:alpha do the thing');
  assert.equal(call.options.expandPromptTemplates, true);
});

test('plain prompt reaches pi.sendUserMessage unexpanded', async () => {
  const resp = await sendCommand({ id: 2, type: 'prompt', message: 'hello world' });
  assert.equal(resp.success, true);
  const call = events.at(-1);
  assert.equal(call.type, 'sendUserMessage');
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

// ── inline, cancelable edit ──

test('valid edit responds success and the handler branches before sending the stashed text', async () => {
  ctx._entries = [userEntry('e1', 'original prompt')];
  const resp = await sendCommand({ id: 100, type: 'edit', entryId: 'e1', text: 'edited prompt' });
  assert.equal(resp.success, true);

  // The stashed text is sent through the normal user message path.
  await waitFor(() => events.some((e) => e.type === 'sendUserMessage' && e.message === 'edited prompt'));
  const navIdx = events.findIndex((e) => e.type === 'navigateTree' && e.entryId === 'e1');
  const sendIdx = events.findIndex((e) => e.type === 'sendUserMessage' && e.message === 'edited prompt');
  assert.ok(navIdx !== -1, 'navigateTree (branch) was called');
  assert.ok(sendIdx !== -1, 'stashed text was sent');
  assert.ok(navIdx < sendIdx, 'branch happens before the send');
  const send = events[sendIdx];
  assert.equal(send.options.expandPromptTemplates, true, 'sent with prompt template expansion');

  // A success notice is broadcast.
  await waitFor(() => broadcasts.some((m) => m.type === 'notice' && /sent on a new branch/.test(m.text)));
});

test('dispatched command line contains the entry id but not the text', async () => {
  ctx._entries = [userEntry('e7', 'original')];
  const resp = await sendCommand({ id: 101, type: 'edit', entryId: 'e7', text: 'the secret replacement text' });
  assert.equal(resp.success, true);
  const dispatch = events.find((e) => e.type === 'sendUserMessage' && e.message.startsWith('/tau-tree'));
  assert.ok(dispatch, 'a /tau-tree command was dispatched');
  assert.ok(dispatch.message.includes('e7'), 'command line contains the entry id');
  assert.ok(!dispatch.message.includes('the secret replacement text'), 'command line does not contain the text');
});

test('busy agent is rejected without dispatch', async () => {
  ctx._entries = [userEntry('e1', 'original')];
  ctx._idle = false;
  const resp = await sendCommand({ id: 102, type: 'edit', entryId: 'e1', text: 'edited' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /running/i);
  assert.ok(!events.some((e) => e.type === 'sendUserMessage' && e.message.startsWith('/tau-tree')), 'no dispatch while busy');
});

test('missing entry is rejected', async () => {
  ctx._entries = [];
  const resp = await sendCommand({ id: 103, type: 'edit', entryId: 'nope', text: 'edited' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not found/i);
  assert.ok(!events.some((e) => e.type === 'sendUserMessage' && e.message.startsWith('/tau-tree')), 'no dispatch for a missing entry');
});

test('non-user entry is rejected', async () => {
  ctx._entries = [{ id: 'e1', type: 'message', message: { role: 'assistant', content: 'hi' } }];
  const resp = await sendCommand({ id: 104, type: 'edit', entryId: 'e1', text: 'edited' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not a user message/i);
  assert.ok(!events.some((e) => e.type === 'sendUserMessage' && e.message.startsWith('/tau-tree')), 'no dispatch for a non-user entry');
});

test('cancelled navigation discards the stash and broadcasts an error notice', async () => {
  ctx._entries = [userEntry('e1', 'original')];
  ctx._navResult = { cancelled: true };
  const resp = await sendCommand({ id: 105, type: 'edit', entryId: 'e1', text: 'edited' });
  assert.equal(resp.success, true);
  const nav = events.find((e) => e.type === 'navigateTree');
  assert.ok(nav, 'navigateTree was called');
  // The error notice is broadcast and the stashed text is never sent.
  await waitFor(() => broadcasts.some((m) => m.type === 'notice' && m.level === 'error'));
  assert.ok(!events.some((e) => e.type === 'sendUserMessage' && e.message === 'edited'), 'stashed text not sent after cancellation');
});

test('unchanged-text edit resends the original content', async () => {
  const original = 'original prompt text';
  ctx._entries = [userEntry('e1', original)];
  const resp = await sendCommand({ id: 106, type: 'edit', entryId: 'e1', text: original });
  assert.equal(resp.success, true);
  await waitFor(() => events.some((e) => e.type === 'sendUserMessage' && e.message === original));
  const send = events.find((e) => e.type === 'sendUserMessage' && e.message === original);
  assert.ok(send, 'the original content was resent');
  assert.equal(send.options.expandPromptTemplates, true);
});

// ── resume_session ──

const sessionsDir = path.join(tmpHome, '.pi', 'agent', 'sessions');

function writeSessionFile(name, lines) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const sessionLines = (cwd, id = 's1') => [
  JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }),
];

test('resume_session: busy agent is rejected without dispatch', async () => {
  ctx._idle = false;
  const p = writeSessionFile('busy.jsonl', sessionLines(tmpHome));
  const resp = await sendCommand({ id: 200, type: 'resume_session', sessionFile: p });
  assert.equal(resp.success, false);
  assert.match(resp.error, /running/i);
  assert.ok(!events.some((e) => e.type === 'switchSession'), 'no switch while busy');
});

test('resume_session: path outside the session directory is rejected', async () => {
  const outside = path.join(tmpHome, 'outside.jsonl');
  fs.writeFileSync(outside, JSON.stringify({ type: 'session', id: 'x', cwd: tmpHome }) + '\n');
  const resp = await sendCommand({ id: 201, type: 'resume_session', sessionFile: outside });
  assert.equal(resp.success, false);
  assert.match(resp.error, /session directory/i);
  assert.ok(!events.some((e) => e.type === 'switchSession'), 'no switch for an outside path');
});

test('resume_session: missing file is rejected', async () => {
  const missing = path.join(sessionsDir, 'nope.jsonl');
  const resp = await sendCommand({ id: 202, type: 'resume_session', sessionFile: missing });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not found/i);
  assert.ok(!events.some((e) => e.type === 'switchSession'), 'no switch for a missing file');
});

test('resume_session: non-JSONL path is rejected', async () => {
  const p = writeSessionFile('notjsonl.jsonl', [
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
  ]);
  const resp = await sendCommand({ id: 203, type: 'resume_session', sessionFile: p });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not a session file/i);
  assert.ok(!events.some((e) => e.type === 'switchSession'), 'no switch for a non-JSONL file');
});

test('resume_session: missing recorded directory is rejected with a distinct error', async () => {
  const p = writeSessionFile('gonedocwd.jsonl', sessionLines(path.join(tmpHome, 'gone')));
  const resp = await sendCommand({ id: 204, type: 'resume_session', sessionFile: p });
  assert.equal(resp.success, false);
  assert.match(resp.error, /no longer exists/i);
  assert.ok(!events.some((e) => e.type === 'switchSession'), 'no switch for a missing recorded directory');
});

test('a valid resume_session reaches the session switch with the resolved path', async () => {
  const p = writeSessionFile('valid.jsonl', sessionLines(tmpHome));
  const resp = await sendCommand({ id: 205, type: 'resume_session', sessionFile: p });
  assert.equal(resp.success, true);
  assert.equal(resp.data.dispatched, true);
  // Dispatch goes through the hidden command line, like re-ask / edit / fork.
  const dispatch = events.find((e) => e.type === 'sendUserMessage' && e.message.startsWith('/tau-resume'));
  assert.ok(dispatch, 'a /tau-resume command was dispatched');
  assert.ok(dispatch.message.includes(p), 'command line contains the session path');
  await waitFor(() => events.some((e) => e.type === 'switchSession'));
  const sw = events.find((e) => e.type === 'switchSession');
  assert.equal(sw.sessionPath, path.resolve(p), 'switchSession got the resolved path');
});

test('a cancelled switch broadcasts an error notice', async () => {
  const p = writeSessionFile('cancelled.jsonl', sessionLines(tmpHome));
  ctx._switchResult = { cancelled: true };
  const resp = await sendCommand({ id: 206, type: 'resume_session', sessionFile: p });
  assert.equal(resp.success, true);
  await waitFor(() => broadcasts.some((m) => m.type === 'notice' && m.level === 'error'));
  const sw = events.find((e) => e.type === 'switchSession');
  assert.ok(sw, 'switchSession was attempted');
});

test('the mirror server survives a resume switch', async () => {
  // A real switch emits session_shutdown(reason: "resume") for the old
  // session. The server must stay up so the browser connection does not
  // drop and a restart notice cannot clobber the resume status line.
  for (const h of handlers.session_shutdown || []) await h({ type: 'session_shutdown', reason: 'resume' }, ctx);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ws.readyState, WebSocket.OPEN, 'the browser connection survives the resume switch');
});

test('a fresh module closure adopts the running server instead of restarting', async () => {
  // pi re-executes the extension module on every session switch (fresh
  // closure, same pid). The new closure must adopt the stashed server:
  // same port, same sockets, no second listener.
  const jiti2 = require('jiti')(import.meta.url);
  const ext2 = jiti2(new URL('../extensions/mirror-server.ts', import.meta.url).pathname).default;
  mock2 = makeMocks();
  ext2(mock2.pi);
  const before = broadcasts.length;
  for (const h of mock2.handlers.session_start || []) await h({ type: 'session_start' }, mock2.ctx);
  // Adoption re-broadcasts the snapshot over the surviving connections.
  await waitFor(() => broadcasts.slice(before).some((m) => m.type === 'mirror_sync'));
  assert.equal(ws.readyState, WebSocket.OPEN, 'the browser connection was not restarted');
  // No second listener on the next port.
  const probe = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT + 1, path: '/api/health' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
  });
  assert.equal(probe, null, 'no second server on the next port');
});

test('a new browser connection after a resume switch gets a snapshot (no stale-ctx crash)', async () => {
  // Invalidate the original ctx, like pi does on session replacement. The
  // surviving server's connection handler is the FIRST closure's; without
  // the shared-ctx fix it would read this stale ctx and throw from
  // assertActive instead of sending a snapshot.
  ctx._stale = true;

  // A fresh module closure adopts the running server; its session_start
  // handler pins the fresh ctx as the shared latestCtx.
  const jiti3 = require('jiti')(import.meta.url);
  const ext3 = jiti3(new URL('../extensions/mirror-server.ts', import.meta.url).pathname).default;
  const mock3 = makeMocks();
  ext3(mock3.pi);
  for (const h of mock3.handlers.session_start || []) await h({ type: 'session_start' }, mock3.ctx);

  // A NEW browser client connects after the switch. It must receive a
  // snapshot built from the fresh shared ctx, not crash on the stale one.
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no snapshot after resume reconnect')), 5000);
    ws2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'mirror_sync') { clearTimeout(timer); resolve(msg); }
    });
    ws2.on('error', reject);
  });
  await new Promise((resolve) => { ws2.on('close', resolve); ws2.close(); });
  assert.ok(snapshot, 'a fresh snapshot was sent to the reconnecting client');
  assert.equal(snapshot.sessionFile, path.join(tmpHome, 'test-session.jsonl'));
});

test('a quit stops the shared server', async () => {
  // The fresh closure now owns the shared server: its quit must stop it
  // (last test: teardown follows).
  for (const h of mock2.handlers.session_shutdown || []) await h({ type: 'session_shutdown', reason: 'quit' }, mock2.ctx);
  await waitFor(() => ws.readyState !== WebSocket.OPEN, 5000);
});
