/**
 * F2 proof: the host guard captures the AgentHandle from the original
 * agents.resume() and releases it (AgentHandle.dispose()) exactly when the
 * Session is/becomes cross-group; own-side and shared Sessions keep their
 * handle; disposal is idempotent; a later resume is still refused.
 *
 * Run: node test/f2-live-handle.mjs
 */
import { apply } from '../lib/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });

const directory = mkdtempSync(join(tmpdir(), 'session-groups-f2-'));
const file = join(directory, 'session-groups.json');
const disposes = new Map();
const disposers = [];
let handler;
const fakeAgents = {
  calls: [],
  async resume(options) {
    this.calls.push(options);
    const id = options && typeof options.resumeSessionId === 'string' ? options.resumeSessionId : options.sessionId;
    const handle = {
      agent: { id },
      disposeCount: 0,
      async dispose() { this.disposeCount += 1; disposes.set(id, (disposes.get(id) ?? 0) + 1); }
    };
    return handle;
  }
};
const ctx = {
  logger: { info() {}, warn() {} },
  on(event, fn) { if (event === 'connection/request') handler = fn; return () => {}; },
  off() {},
  effect(fn) { const value = fn(); if (typeof value === 'function') disposers.push(value); return () => {}; },
  inject(services, callback) {
    if (services.includes('webServer')) return;
    if (services.includes('agents')) {
      callback({ get: (name) => (name === 'agents' ? fakeAgents : undefined), effect: (fn) => { const value = fn(); if (typeof value === 'function') disposers.push(value); return () => {}; } });
    }
  }
};
apply(ctx, { side: 'desktop', groupsFile: file });

function mockResponse() {
  return { status: undefined, body: undefined, writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
}
async function call(method, url, body) {
  const request = new EventEmitter();
  request.url = url; request.method = method; request.headers = {};
  const response = mockResponse();
  const pending = handler(request, response, () => {});
  if (method !== 'GET' && method !== 'HEAD') {
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  }
  await pending;
  return { status: response.status, json: response.body === undefined ? undefined : JSON.parse(response.body) };
}
const state = () => call('GET', '/api/plugins/dsh-session-groups/state');
const set = (sessionId, group) => call('POST', '/api/plugins/dsh-session-groups/set', { sessionId, group });
const resume = async (id) => { try { await fakeAgents.resume({ resumeSessionId: id }); return { ok: true }; } catch (error) { return { ok: false, code: error && error.code }; } };

// 1. untagged (shared) session: resume allowed, handle captured
check('untagged resume allowed', (await resume('s_live')).ok === true);
check('no disposal yet', (disposes.get('s_live') ?? 0) === 0);

// 2. own-side assignment keeps the handle
await set('s_live', 'desktop');
await state();
check('own-side assignment does not dispose the handle', (disposes.get('s_live') ?? 0) === 0);

// 3. cross-group assignment: POST /set sweeps and disposes exactly once
const setCross = await set('s_live', 'webui');
check('cross-group POST /set returns 200', setCross.status === 200, setCross);
check('captured handle disposed on cross-group assignment', (disposes.get('s_live') ?? 0) === 1, [...disposes]);

// 4. idempotence: repeated GET /state sweeps do not dispose again
await state();
await state();
check('disposal is idempotent across repeated sweeps', (disposes.get('s_live') ?? 0) === 1, [...disposes]);

// 5. a later resume of the now-cross-group Session is still refused
const later = await resume('s_live');
check('later resume still refused', later.ok === false && later.code === 'SESSION_GROUP_READ_ONLY', later);

// 6. own-side and shared live handel are never disposed
await resume('s_own');
await set('s_own', 'desktop');
await state();
check('own-side live handle survives assignment', (disposes.get('s_own') ?? 0) === 0);
await resume('s_shared');
await set('s_shared', 'shared');
await state();
check('shared live handle survives', (disposes.get('s_shared') ?? 0) === 0);

// 7. assignment made on the OTHER host: detected by the GET /state sweep
await resume('s_remote_live');
writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), groups: {
  s_live: 'webui', s_own: 'desktop', s_remote_live: 'webui'
} }, null, 2), 'utf8');
await state();
check('other-host assignment observed on GET /state and disposed', (disposes.get('s_remote_live') ?? 0) === 1, [...disposes]);
await state();
check('other-host disposal also idempotent', (disposes.get('s_remote_live') ?? 0) === 1, [...disposes]);
const remoteLater = await resume('s_remote_live');
check('resume refused after other-host assignment', remoteLater.ok === false && remoteLater.code === 'SESSION_GROUP_READ_ONLY', remoteLater);

// 8. a refused resume never captures a handle
const beforeRefused = disposes.size;
const refused = await resume('s_live');
check('refused resume does not produce a captured handle', refused.ok === false && disposes.size === beforeRefused, refused);

for (const dispose of disposers.reverse()) { try { dispose(); } catch (error) { /* best effort */ } }
rmSync(directory, { recursive: true, force: true });
const failed = results.filter((entry) => !entry.ok);
console.log(JSON.stringify({ checks: results.length, failed: failed.length, failedChecks: failed, disposes: [...disposes], results }, null, 1));
if (failed.length > 0) process.exitCode = 2;
