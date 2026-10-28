/**
 * F1 proof: the client write guard is installed on the REAL
 * RemoteNamespaceService (real cordis 0.2.1 runtime service) and rejects a
 * cross-group Session without invoking the transport, while an allowed call
 * still reaches it. Also proves self-healing after remove() and restore on
 * dispose.
 *
 * Run: node test/f1-client-guard.mjs
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH = process.env.DSH_TEST_MODULES ?? join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- real cordis ---------------------------------------------------------
const cordis = await import(pathToFileURL(DSH + '/cordis/lib/index.js').href);

// --- real api-gateway client bundle, with its namespace service exported ---
let gatewaySource = fs.readFileSync(DSH + '/dsh-api-gateway/lib/client.browser.js', 'utf8');
const lastReturn = gatewaySource.lastIndexOf('return module.exports;');
if (lastReturn < 0) throw new Error('gateway bundle tail marker moved');
const newline = String.fromCharCode(10);
gatewaySource = gatewaySource.slice(0, lastReturn)
  + 'exports.RemoteNamespaceService = RemoteNamespaceService;' + newline + '\t\t'
  + gatewaySource.slice(lastReturn);
let gatewayModule;
const fakeWindow = { __ModuleLoader__: { load(module) { gatewayModule = module; } } };
new Function('window', gatewaySource)(fakeWindow);
const gateway = gatewayModule.factory((id) => {
  if (id === '@deepseek-ai/cordis') return cordis;
  throw new Error('gateway client asked for unexpected module ' + id);
});
check('real RemoteNamespaceService extracted', typeof gateway.RemoteNamespaceService === 'function');

// --- a real cordis context: 'remote' service + 'remote.session' service ---
const ctx = new cordis.Context();
const transportCalls = [];
const invokeRemote = (direct, scoped, caller, args) => {
  transportCalls.push({ endpoint: direct && direct.descriptor ? direct.descriptor.method : 'scoped', args });
  return Promise.resolve({ ok: true, value: { transport: true } });
};
let namespaceService;
class RemoteStub extends cordis.Service {
  constructor(sub) { super(sub, 'remote'); this.namespaces = new Map(); }
}
await ctx.plugin({ name: 'test-remote', apply: (sub) => { new RemoteStub(sub); } });
await ctx.plugin({
  name: 'test-remote-session',
  apply: (sub) => { namespaceService = new gateway.RemoteNamespaceService(sub, 'session', invokeRemote); }
});
ctx.get('remote').namespaces.set('session', { service: namespaceService });
const tokens = {};
for (const method of ['prompt', 'updateQueue', 'cancel', 'rename', 'selectModel', 'fork']) {
  const token = { active: true, abort: new AbortController() };
  tokens[method] = token;
  namespaceService.installDirect({ namespace: 'session', method }, token);
}
check('namespace methods installed as getter-only accessors',
  ['prompt', 'rename'].every((method) => typeof Object.getOwnPropertyDescriptor(namespaceService, method)?.get === 'function'));
const originalPromptGetter = Object.getOwnPropertyDescriptor(namespaceService, 'prompt').get;

// --- the plugin's real client module ------------------------------------
let pluginModule;
const pluginWindow = { __ModuleLoader__: { load(module) { pluginModule = module; } } };
new Function('window', fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(pluginWindow);
const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] }),
  useState: () => [0, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
};
const plugin = pluginModule.factory((id) => {
  if (id === 'react') return reactStub;
  throw new Error('plugin asked for unexpected module ' + id);
});
check('plugin client module id matches the package name', pluginModule.id === 'dsh-session-groups');

// --- browser-ish environment: registry state + minimal DOM --------------
const registry = { s1: 'desktop' };
globalThis.document = {
  baseURI: 'http://127.0.0.1:4115/',
  documentElement: { setAttribute() {}, removeAttribute() {} },
  head: { appendChild() {} },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
};
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => ({
    ok: true,
    side: 'webui',
    groups: registry,
    updatedAt: null,
  }),
});

const disposers = [];
const fakeCtx = {
  effect(fn) { const value = fn(); if (typeof value === 'function') disposers.push(value); return () => {}; },
  get: (name) => ctx.get(name),
  remote: ctx.get('remote'),
  slots: { inject(seat, cb) { cb(); return () => {}; }, register() { return () => {}; } },
  logger: { info() {}, warn() {} },
};
plugin.apply(fakeCtx);
await sleep(120);

const guardState = plugin.__test.remoteGuardState();
check('guard installed on the real namespace service', guardState !== null && guardState.service === namespaceService, guardState && Object.keys(guardState.methods));
check('descriptor after install is the guarded value',
  (() => { const d = Object.getOwnPropertyDescriptor(namespaceService, 'prompt'); return Boolean(d && d.value && d.value.__sessionGroupsGuard === true); })());

// read-only Session: rejected locally, transport untouched
transportCalls.length = 0;
const rejected = await ctx.remote.session.prompt({ sessionId: 's1' });
check('read-only prompt rejected with session/group-read-only',
  rejected && rejected.ok === false && rejected.error && rejected.error.code === 'session/group-read-only', rejected);
check('transport NOT called for the read-only Session', transportCalls.length === 0, transportCalls);
const rejectedRename = await ctx.remote.session.rename({ sessionId: 's1', title: 'x' });
check('read-only rename rejected too', rejectedRename && rejectedRename.ok === false && rejectedRename.error.code === 'session/group-read-only', rejectedRename);

// allowed Session: passes through to the transport
transportCalls.length = 0;
const allowed = await ctx.remote.session.prompt({ sessionId: 's2' });
check('allowed prompt reaches the transport', transportCalls.length === 1 && allowed && allowed.ok === true, { calls: transportCalls, allowed });

// a second independent view of the namespace sees the guard
const secondView = ctx.remote.session;
check('second independent view sees the guarded method',
  typeof secondView.prompt === 'function' && secondView.prompt.__sessionGroupsGuard === true);

// remove() deletes the property; the 2.5 s poll must repair it
namespaceService.remove('direct', 'prompt', tokens.prompt);
check('remove() dropped the guard (as the gateway does)',
  Object.getOwnPropertyDescriptor(namespaceService, 'prompt') === undefined);
// a namespace remount re-installs the accessor with a fresh getter
namespaceService.installDirect({ namespace: 'session', method: 'prompt' }, tokens.prompt);

// immediate manual repair (same code the poll runs)
plugin.__test.ensureRemoteGuard(fakeCtx);
check('ensureRemoteGuard() repairs after remove()',
  (() => { const d = Object.getOwnPropertyDescriptor(namespaceService, 'prompt'); return Boolean(d && d.value && d.value.__sessionGroupsGuard === true); })());

// poll repair without manual help: drop it again and wait one poll interval
namespaceService.remove('direct', 'prompt', tokens.prompt);
// a namespace remount re-installs the accessor with a fresh getter
namespaceService.installDirect({ namespace: 'session', method: 'prompt' }, tokens.prompt);
const remountedGetter = Object.getOwnPropertyDescriptor(namespaceService, 'prompt').get;
await sleep(2800);
check('the 2.5 s poll repaired the guard',
  (() => { const d = Object.getOwnPropertyDescriptor(namespaceService, 'prompt'); return Boolean(d && d.value && d.value.__sessionGroupsGuard === true); })());
transportCalls.length = 0;
const pollRejected = await ctx.remote.session.prompt({ sessionId: 's1' });
check('guarded rejection still works after poll repair',
  pollRejected && pollRejected.ok === false && pollRejected.error.code === 'session/group-read-only' && transportCalls.length === 0, { pollRejected, transportCalls });

// dispose restores the original accessor
for (const dispose of disposers.reverse()) { try { dispose(); } catch (error) { /* best effort */ } }
check('dispose restored the accessor that was there before the guard',
  (() => { const d = Object.getOwnPropertyDescriptor(namespaceService, 'prompt'); return Boolean(d && d.get === remountedGetter); })());
transportCalls.length = 0;
const afterDispose = await ctx.remote.session.prompt({ sessionId: 's1' });
check('after dispose the call reaches the transport again (restore is real)',
  transportCalls.length === 1 && afterDispose && afterDispose.ok === true, { calls: transportCalls, afterDispose });

const failed = results.filter((entry) => !entry.ok);
console.log(JSON.stringify({ checks: results.length, failed: failed.length, failedChecks: failed, results }, null, 1));
if (failed.length > 0) process.exitCode = 2;
