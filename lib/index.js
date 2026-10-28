/**
 * dsh-session-groups - host half.
 *
 * Why this exists: a Session log belongs to whoever holds its write handle.
 * Opening the same Session on the other side (Desktop vs Web profile) makes
 * that side resume the Agent, which takes the write handle and leaves the
 * original side read-only by accident. This plugin makes "the other side"
 * intentional: a Session is assigned to a group ("webui" | "desktop" |
 * "shared", default shared) in a registry OUTSIDE the Session log, and the
 * non-owning side opens such a Session read-only - history renders, but this
 * host refuses to resume it, so no write handle is ever acquired and no
 * session-log write can be forwarded from that side. The owning side (and
 * every shared Session) behaves exactly as before.
 *
 * What this half owns, and why these seams:
 *   - the registry at ~/.dsh/session-groups.json (atomic replace; cache keyed
 *     by mtime+size so a hand edit or a second host is observed);
 *   - the routes under /api/plugins/dsh-session-groups, attached with the
 *     documented 'connection/request' waterfall (same seam dsh-webui-switch
 *     uses; it sits behind the app's own Host/Origin fence and browser auth);
 *   - the read-only guard: it wraps the Agent service's resume(), the single
 *     path that acquires a Session write handle (api-session-controller calls
 *     ctx.agents.resume() through resolveAgent/claim; both rethrow a
 *     SessionAlreadyOwnedError otherwise). Refusing here means the non-owning
 *     side never publishes/writes the Session; the client half is the second
 *     layer (composer hidden, write remotes rejected) so a stale UI cannot
 *     slip a write through either.
 *
 * Side detection: an explicit config.side wins (each profile's own
 * cordis.patch.yml sets it); otherwise the profile is read from the launcher
 * grammar (--profile <name>) or the Desktop host spawn arguments
 * (profiles/desktop), which both launchers pass through process.argv.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name; also the loader row id in the profile patch. */
export const name = 'session-groups'

/**
 * No service is required up front: a plugin must never be the reason an app
 * refuses to boot. The write guard attaches later through ctx.inject(['agents']).
 */
export const inject = []

/** Route root, below the shared /api prefix. */
export const ROUTE_PREFIX = '/plugins/dsh-session-groups'

/** The shared channel's mount point: the waterfall sees absolute URLs. */
const API_PREFIX = '/api'

/** Largest accepted registry-write body. */
const MAX_BODY_BYTES = 64 * 1024

/** The complete set of group names. */
export const GROUPS = Object.freeze(['webui', 'desktop', 'shared'])

const GROUP_SET = new Set(GROUPS)

/**
 * Normalize one group name.
 * @param value - raw value.
 * @returns the group name, or undefined when it is not one of GROUPS.
 */
export function normalizeGroup(value) {
  return typeof value === 'string' && GROUP_SET.has(value) ? value : undefined
}

/**
 * Which side this host runs on.
 * @param config - the profile row's config (side wins when valid).
 * @returns "webui" | "desktop" | "unknown".
 */
export function detectSide(config) {
  const configured = config !== null && typeof config === 'object' ? config.side : undefined
  if (configured === 'webui' || configured === 'desktop') return configured
  const argv = Array.isArray(process.argv) ? process.argv : []
  const marker = argv.indexOf('--profile')
  if (marker >= 0) {
    const profile = argv[marker + 1]
    if (profile === 'desktop') return 'desktop'
    if (profile === 'web') return 'webui'
    if (typeof profile === 'string' && profile.length > 0) return 'webui'
  }
  const joined = argv.join(' ') + ' ' + String(process.env.DSH_PROFILE ?? '') + ' ' + String(process.env.DSH_PROFILE_NAME ?? '')
  if (/dsh-desktop-host|profiles[\\/]+desktop/iu.test(joined)) return 'desktop'
  if (/profiles[\\/]+web(?:[\\/\s]|$)|--profile[ =]web\b/iu.test(joined)) return 'webui'
  return 'unknown'
}

/**
 * Absolute registry path.
 * @param config - the profile row's config (groupsFile wins when present).
 * @returns absolute path of the JSON registry.
 */
export function groupsFilePath(config) {
  const configured = config !== null && typeof config === 'object' ? config.groupsFile : undefined
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.dsh', 'session-groups.json')
}

/**
 * Validate and normalize one registry document.
 * @param raw - parsed JSON, or undefined when the file is absent.
 * @returns { version, updatedAt, groups } with only valid tags kept.
 */
export function normalizeStore(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const groups = {}
  const sourceGroups = source.groups !== null && typeof source.groups === 'object' ? source.groups : {}
  for (const [sessionId, group] of Object.entries(sourceGroups)) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id.length === 0 || id.length > 200) continue
    const normalized = normalizeGroup(group)
    if (normalized === undefined || normalized === 'shared') continue
    groups[id] = normalized
  }
  return {
    version: 1,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    groups,
  }
}

/**
 * One registry file with a mtime+size cache.
 * @param file - absolute registry path.
 * @returns load / save / set / path.
 */
export function createStore(file) {
  let cache
  let stamp
  const load = () => {
    try {
      const stat = statSync(file)
      const key = String(stat.mtimeMs) + ':' + String(stat.size)
      if (cache !== undefined && stamp === key) return cache
      cache = normalizeStore(JSON.parse(readFileSync(file, 'utf8')))
      stamp = key
      return cache
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        if (cache === undefined) cache = normalizeStore(undefined)
        return cache
      }
      // A corrupt registry must not break the host: keep the last good
      // snapshot (or an empty one) and let the next save repair the file.
      if (cache === undefined) cache = normalizeStore(undefined)
      return cache
    }
  }
  const save = (store) => {
    const next = {
      version: 1,
      updatedAt: new Date().toISOString(),
      groups: { ...store.groups },
    }
    mkdirSync(dirname(file), { recursive: true })
    const temporary = file + '.' + String(process.pid) + '.tmp'
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(temporary, file)
    cache = next
    try {
      const stat = statSync(file)
      stamp = String(stat.mtimeMs) + ':' + String(stat.size)
    } catch {
      stamp = undefined
    }
    return next
  }
  return {
    file,
    load,
    save,
    /** Assign one Session; "shared" removes the tag (the default). */
    set(sessionId, group) {
      const current = load()
      const groups = { ...current.groups }
      if (group === 'shared') delete groups[sessionId]
      else groups[sessionId] = group
      return save({ ...current, groups })
    },
  }
}

/**
 * The request path with the /api mount point and the query removed.
 * @param url - request URL.
 * @returns the endpoint path, or undefined when the URL is unusable.
 */
export function routePath(url) {
  if (typeof url !== 'string') return undefined
  const path = url.split('?')[0]
  return path.startsWith(API_PREFIX + '/') ? path.slice(API_PREFIX.length) : path
}

/**
 * Read a bounded JSON body.
 * @param request - incoming request.
 * @returns the parsed value, or undefined when it is absent or malformed.
 */
function readJson(request) {
  return new Promise((resolve) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      resolve(undefined)
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        finish({})
        return
      }
      try {
        finish(JSON.parse(text))
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
  })
}

/**
 * Answer one request as JSON.
 * @param request - incoming request.
 * @param response - the response owned until this settles.
 * @param payload - JSON-serializable body.
 * @param status - HTTP status.
 */
function answer(request, response, payload, status) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

/**
 * Mount the plugin.
 * @param ctx - host context.
 * @param config - the profile patch row's config ({ side?, groupsFile? }).
 */
export function apply(ctx, config) {
  const side = detectSide(config)
  const store = createStore(groupsFilePath(config))

  /** Whether this side must treat the Session as read-only. */
  const readOnly = (sessionId) => {
    if (side === 'unknown') return false
    const group = store.load().groups[sessionId]
    return typeof group === 'string' && group !== 'shared' && group !== side
  }

  // Live-handle sweep: a Session that was already resumed on this side before
  // it was assigned to the other group keeps its write handle - the resume
  // guard only refuses NEW resumptions. Handles captured from the original
  // resume() are released here as soon as the registry says the Session is
  // cross-group for this side. The client polls GET /state every 2.5 s, so an
  // assignment made on the OTHER host is observed too; POST /set sweeps
  // immediately for assignments made here. Own-side and shared Sessions are
  // never touched. Idempotent: the entry leaves the map before the
  // asynchronous dispose starts, so concurrent sweeps/repeated polls dispose
  // exactly once.
  const liveHandles = new Map()
  let sweeping = null
  const sweepCrossGroupHandles = () => {
    if (sweeping !== null) return sweeping
    // The .finally() (not a finally block inside the async body) clears the
    // in-flight marker: a sweep that finishes without ever awaiting must not
    // leave the marker set across the assignment that created it.
    sweeping = (async () => {
      for (const [sessionId, entry] of [...liveHandles]) {
        if (entry.disposed === true) {
          liveHandles.delete(sessionId)
          continue
        }
        if (!readOnly(sessionId)) continue
        entry.disposed = true
        liveHandles.delete(sessionId)
        try {
          await entry.handle.dispose()
          const group = store.load().groups[sessionId] ?? 'shared'
          ctx.logger?.info?.('session-groups: released live write handle for cross-group Session "' + sessionId + '" (group "' + group + '")')
        } catch (error) {
          ctx.logger?.warn?.('session-groups: disposing the write handle of "' + sessionId + '" failed: ' + String(error && error.message ? error.message : error))
        }
      }
    })().finally(() => {
      sweeping = null
    })
    return sweeping
  }

  const state = () => {
    const current = store.load()
    return { ok: true, side, groups: current.groups, updatedAt: current.updatedAt, file: store.file }
  }

  const handle = async (request, response) => {
    const url = typeof request.url === 'string' ? request.url : ''
    const method = String(request.method ?? 'GET').toUpperCase()
    const path = routePath(url)
    if (path === undefined) return false
    if (path === ROUTE_PREFIX + '/state' && (method === 'GET' || method === 'HEAD')) {
      // The client polls this route; sweeping here releases a live handle when
      // the assignment was made on the other host too.
      await sweepCrossGroupHandles()
      answer(request, response, state(), 200)
      return true
    }
    if (path === ROUTE_PREFIX + '/status' && (method === 'GET' || method === 'HEAD')) {
      const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
      const sessionId = new URLSearchParams(query).get('sessionId') ?? ''
      const group = store.load().groups[sessionId] ?? 'shared'
      answer(request, response, { ok: true, side, sessionId, group, readOnly: readOnly(sessionId) }, 200)
      return true
    }
    if (path === ROUTE_PREFIX + '/set' && method === 'POST') {
      const body = await readJson(request)
      if (body === undefined) {
        answer(request, response, { ok: false, error: 'invalid-json' }, 400)
        return true
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const group = normalizeGroup(body.group)
      if (sessionId.length === 0 || sessionId.length > 200) {
        answer(request, response, { ok: false, error: 'bad-session-id' }, 400)
        return true
      }
      if (group === undefined) {
        answer(request, response, { ok: false, error: 'bad-group', groups: GROUPS }, 400)
        return true
      }
      const saved = store.set(sessionId, group)
      // An assignment made here may demote a Session this host already has
      // live; release its write handle before answering.
      await sweepCrossGroupHandles()
      answer(request, response, { ...state(), sessionId, group: saved.groups[sessionId] ?? 'shared' }, 200)
      return true
    }
    return false
  }

  /** Attach the listener to a context or its webServer child. */
  const listen = (target) => {
    const listener = async (request, response, next) => {
      try {
        const answered = await handle(request, response)
        if (answered === true) return
      } catch (error) {
        try {
          answer(request, response, { ok: false, error: 'internal', message: String(error && error.message ? error.message : error) }, 500)
        } catch {
          // The response was already gone; nothing left to answer.
        }
        return
      }
      await next()
    }
    target.on('connection/request', listener)
    return () => {
      if (typeof target.off === 'function') target.off('connection/request', listener)
    }
  }

  ctx.effect(() => listen(ctx), 'session-groups: connection/request')
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => listen(webCtx), 'session-groups: webServer connection/request')
  })

  // The one write-attachment gate: resuming a cross-group Session is refused,
  // so this host never takes the write handle and never forwards a write for
  // it; a handle that was already live when the assignment happened is
  // released by sweepCrossGroupHandles(). The api-session-controller turns the
  // refusal into a session-level failure the client half renders; the client
  // also rejects the attempt before it reaches the transport.
  ctx.inject(['agents'], (agentCtx) => {
    const agents = agentCtx.get('agents')
    if (agents === undefined || typeof agents.resume !== 'function') {
      ctx.logger?.warn?.('session-groups: Agent service has no resume(); host guard not installed')
      return
    }
    const original = agents.resume
    try {
      agents.resume = function guardedResume(options) {
        const sessionId = options !== null && typeof options === 'object'
          ? (typeof options.resumeSessionId === 'string' ? options.resumeSessionId : options.sessionId)
          : undefined
        if (typeof sessionId === 'string' && readOnly(sessionId)) {
          const group = store.load().groups[sessionId]
          const error = new Error('session "' + sessionId + '" belongs to session group "' + group + '": the ' + side + ' side is read-only for it')
          error.code = 'SESSION_GROUP_READ_ONLY'
          error.sessionId = sessionId
          error.group = group
          throw error
        }
        const result = original.apply(this, arguments)
        if (result === null || typeof result !== 'object' || typeof result.then !== 'function') return result
        // Capture the AgentHandle so sweepCrossGroupHandles() can tear down
        // exactly this agent later (AgentHandle.dispose(), dsh-agent docs).
        return result.then((handle) => {
          if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') {
            const capturedId = typeof sessionId === 'string'
              ? sessionId
              : (handle.agent !== null && typeof handle.agent === 'object' && typeof handle.agent.id === 'string' ? handle.agent.id : undefined)
            if (capturedId !== undefined) liveHandles.set(capturedId, { handle, disposed: false })
          }
          return handle
        })
      }
      agentCtx.effect(() => () => {
        agents.resume = original
      }, 'session-groups: restore Agent.resume')
    } catch (error) {
      ctx.logger?.warn?.('session-groups: could not wrap Agent.resume(): ' + String(error && error.message ? error.message : error))
    }
  })

  ctx.logger?.info?.('session-groups: side=' + side + ' registry=' + store.file)
}

/** Test surface for the static checks (no behaviour outside these helpers). */
export const __test = { detectSide, normalizeGroup, normalizeStore, createStore, groupsFilePath, routePath, GROUPS }
