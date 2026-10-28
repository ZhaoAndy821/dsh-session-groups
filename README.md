# dsh-session-groups

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets you
assign a Session to a **group** (`webui`, `desktop`, or `shared`) so the side that does
*not* own it opens it **read-only**: history renders normally, but no write handle is
ever acquired and no prompt / queue / rename / model-select / fork can be submitted.

## Why

DSH enforces one writer per Session. When both the Desktop app and `dsh web` run against
the same workspace, clicking a Session in one side takes the write handle and locks the
other side out ("This session is already in use"). This plugin makes that intentional:
tag a Session to the side you use it from, and the other side becomes a read-only viewer.

## How it works

- **Group registry** — `~/.dsh/session-groups.json` (outside the Session log; the storage
  format is never touched). Default is `shared` (untagged) = old behaviour.
- **Host guard** — wraps `agents.resume()` (the single write-handle acquisition point)
  and refuses it for cross-group Sessions. An already-live handle is released by a
  sweep triggered from `GET /state` (the client polls it every 2.5 s), so re-tagging
  a Session takes effect within seconds even on the side that already had it open.
- **Client guard** — hides the composer seat, rejects the six write remotes before
  they reach the transport, shows a `read-only` pill and per-row group badges, and
  offers group-assignment rows in the Session row's "…" menu.

## Installation

Mounted via the standard DSH bundle route in **both** profiles:

1. `link:` dependency + `dsh.profile.bundles` entry + junction in each profile's
   `node_modules`;
2. a profile-local `cordis.patch.yml` row supplying the side identity:
   `- id: session-groups / config: { side: webui | desktop }`.

The package's own `dsh.bundle.patch` inserts the host loader row; the client half is
served automatically from the `./client` export.

## Usage

1. Open a Session row's "…" menu → **Session group: WebUI / Desktop / Shared (default)**.
2. The row shows a `WEBUI` / `DESKTOP` badge.
3. Open the Session on the other side: history renders, the composer is hidden, and the
   header shows a `read-only` pill.

### HTTP API

| Method | Route | Body / Query |
|---|---|---|
| GET | `/api/plugins/dsh-session-groups/state` | — |
| POST | `/api/plugins/dsh-session-groups/set` | `{ sessionId, group }` |
| GET | `/api/plugins/dsh-session-groups/status?sessionId=…` | — |

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4115/api/plugins/dsh-session-groups/set' `
  -ContentType 'application/json' -Body '{"sessionId":"<session-id>","group":"webui"}'
```

### Browser self-check

```js
window.__DSH_SESSION_GROUPS__.guardState()           // { side, groups, ... }
await window.__DSH_SESSION_GROUPS__.attemptPrompt('<session-id>')  // session/group-read-only
```

## Notes

- Assign the group **before** the other side opens the Session (a stale UI can still
  show the old composer; the host guard is the authoritative boundary).
- A cross-process read-only view is a **snapshot** (DSH has no file-watch tail); re-open
  to refresh.
- The owning side and `shared` Sessions are completely unchanged.

## Tests

```bash
node test/f1-client-guard.mjs   # 16 checks: real RemoteNamespaceService guard
node test/f2-live-handle.mjs   # 13 checks: live-handle release on cross-group
```

## License

MIT