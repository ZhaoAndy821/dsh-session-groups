/**
 * dsh-session-groups - client half.
 *
 * Three small surfaces, all registered through ctx.slots, plus one guard on
 * the write remotes:
 *   - a group badge on every grouped Session row (sidebar.session.row.leading);
 *   - three "assign to group" rows in a Session row's "..." menu
 *     (sidebar.workspaces.session.menu.item);
 *   - a read-only pill in the conversation header
 *     (conversation.session.header.actions), which also puts
 *     data-session-groups-readonly="1" on <html> so the injected stylesheet
 *     hides the composer seat (no typing, no send, no attach);
 *   - a wrapper on remote.session write methods that rejects a cross-group
 *     Session before it reaches the host (the host's Agent.resume guard is the
 *     authoritative one; this is the stale-UI layer).
 *
 * All state comes from the host half over /api/plugins/dsh-session-groups
 * (polled; the payload is tiny). Contracts used (read from the shipped client
 * bundles, not assumed): slot register options {name, id, order, registrant};
 * session-scoped list seats pass {sessionId} plus the entry's inject() result;
 * MenuItemButton props {children, icon, disabled, separatorBefore, onSelect}.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-groups",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    var PLUGIN_ID = "dsh-session-groups";
    var ROUTE_PREFIX = "api/plugins/dsh-session-groups";
    var POLL_MS = 2500;
    var SLOT_ROW_BADGE = "sidebar.session.row.leading";
    var SLOT_MENU = "sidebar.workspaces.session.menu.item";
    var SLOT_HEADER_ACTIONS = "conversation.session.header.actions";
    var STYLE_TAG = PLUGIN_ID + "/read-only.css";
    var GROUPS = ["webui", "desktop", "shared"];

    // Registry snapshot shared by every component; polled from the host.
    var state = { side: "unknown", groups: {}, updatedAt: null, loaded: false };
    var listeners = new Set();
    function notify() {
      var all = Array.from(listeners);
      for (var i = 0; i < all.length; i++) {
        try { all[i](); } catch (err) { /* one broken component must not stop the rest */ }
      }
    }
    function subscribe(fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }
    function groupOf(sessionId) {
      var group = state.groups && typeof state.groups === "object" ? state.groups[sessionId] : undefined;
      return typeof group === "string" && group.length > 0 ? group : "shared";
    }
    function isReadOnly(sessionId) {
      var group = groupOf(sessionId);
      if (group === "shared") return false;
      if (state.side !== "webui" && state.side !== "desktop") return false;
      return group !== state.side;
    }
    function sideLabel() { return state.side === "unknown" ? "this side" : state.side; }

    function route(path) {
      try { return new URL(ROUTE_PREFIX + path, document.baseURI).toString(); }
      catch (err) { return ROUTE_PREFIX + path; }
    }
    async function refresh() {
      try {
        var response = await fetch(route("/state"), {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "same-origin"
        });
        if (!response.ok) return;
        var body = await response.json();
        if (!body || body.ok !== true) return;
        state.side = typeof body.side === "string" ? body.side : "unknown";
        state.groups = body.groups && typeof body.groups === "object" ? body.groups : {};
        state.updatedAt = typeof body.updatedAt === "string" ? body.updatedAt : null;
        state.loaded = true;
        notify();
      } catch (err) {
        // Host unreachable (profile shutting down, route not mounted yet):
        // keep the last snapshot instead of flapping every component.
      }
    }
    async function assign(sessionId, group) {
      try {
        var response = await fetch(route("/set"), {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ sessionId: sessionId, group: group })
        });
        var body = await response.json().catch(function () { return null; });
        await refresh();
        return Boolean(body && body.ok === true);
      } catch (err) {
        return false;
      }
    }

    function ensureStyle() {
      if (typeof document === "undefined") return;
      var selector = "style[data-plugin-css=" + JSON.stringify(STYLE_TAG) + "]";
      if (document.querySelector(selector) !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = STYLE_TAG;
      tag.textContent =
        "html[data-session-groups-readonly=\"1\"] [data-composer-seat]{display:none !important}" +
        "html[data-session-groups-readonly=\"1\"] [data-composer-overlay]{display:none !important}" +
        "html[data-session-groups-readonly=\"1\"] [data-composer-dock]{display:none !important}" +
        "html[data-session-groups-readonly=\"1\"] [data-composer-seat]{pointer-events:none !important}";
      document.head.appendChild(tag);
    }

    function useGroupState() {
      var pair = react.useState(0);
      var force = pair[1];
      react.useEffect(function () {
        return subscribe(function () { force(function (value) { return value + 1; }); });
      }, []);
      return state;
    }

    function badgeText(group) {
      if (group === "webui") return "WEBUI";
      if (group === "desktop") return "DESKTOP";
      return String(group).toUpperCase();
    }

    // Slot: leading mark on a Session row (session-scoped list; props.sessionId).
    function GroupBadge(props) {
      useGroupState();
      var sessionId = props && props.sessionId;
      if (!sessionId) return null;
      var group = groupOf(sessionId);
      if (group === "shared") return null;
      var readOnly = isReadOnly(sessionId);
      var title = "Session group: " + group + (readOnly
        ? " - read-only on " + sideLabel() + " (history only)"
        : " - writable on " + sideLabel());
      return h("span", {
        "data-session-group": group,
        title: title,
        style: {
          marginLeft: 4,
          padding: "0 4px",
          border: "1px solid currentColor",
          borderRadius: 4,
          fontSize: 10,
          lineHeight: "14px",
          opacity: readOnly ? 0.55 : 0.85,
          whiteSpace: "nowrap",
          flex: "none"
        }
      }, badgeText(group));
    }

    // Slot entry primitives; resolved lazily (load-order misses cost one render).
    var primitivesCache = null;
    function getPrimitives() {
      if (primitivesCache !== null) return primitivesCache;
      try { primitivesCache = require("@deepseek-ai/dsh-client-ui-primitives"); }
      catch (err) { primitivesCache = null; }
      return primitivesCache;
    }
    function MenuRow(props) {
      var primitives = getPrimitives();
      if (primitives && typeof primitives.MenuItemButton === "function") {
        return h(primitives.MenuItemButton, {
          disabled: props.disabled === true,
          separatorBefore: props.separatorBefore === true,
          onSelect: props.onSelect
        }, props.children);
      }
      return h("button", {
        type: "button",
        disabled: props.disabled === true,
        onClick: props.onSelect,
        style: {
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: 0,
          padding: "6px 12px",
          cursor: "pointer",
          color: "inherit"
        }
      }, props.children);
    }

    /**
     * One "assign to group" menu row. The label marks the current group; the
     * action writes the registry through the host and refreshes every badge.
     */
    function makeAssignRow(targetGroup, label) {
      return function AssignToGroupRow(props) {
        useGroupState();
        var sessionId = props && props.sessionId;
        var current = groupOf(sessionId);
        var isCurrent = current === targetGroup;
        var onSelect = react.useCallback(function () {
          if (typeof sessionId === "string" && sessionId.length > 0) void assign(sessionId, targetGroup);
        }, [sessionId]);
        return h(MenuRow, {
          disabled: isCurrent,
          separatorBefore: targetGroup === "webui",
          onSelect: onSelect
        }, (isCurrent ? "\u2713 " : "") + label);
      };
    }

    // Slot: read-only pill in the conversation header; also owns the <html>
    // attribute the stylesheet keys on, so the composer is hidden on this side.
    function ReadOnlyNotice(props) {
      useGroupState();
      var sessionId = props && props.sessionId;
      var readOnly = typeof sessionId === "string" && sessionId.length > 0 && isReadOnly(sessionId);
      react.useEffect(function () {
        if (typeof document === "undefined") return undefined;
        var root = document.documentElement;
        if (readOnly) root.setAttribute("data-session-groups-readonly", "1");
        else root.removeAttribute("data-session-groups-readonly");
        return function () { root.removeAttribute("data-session-groups-readonly"); };
      }, [readOnly, sessionId]);
      if (!readOnly) return null;
      var group = groupOf(sessionId);
      return h("span", {
        "data-session-group-readonly": group,
        title: "This Session belongs to group " + group + ". The " + sideLabel() +
          " side opens it read-only: history only, no composer, no writes.",
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "0 8px",
          border: "1px solid currentColor",
          borderRadius: 999,
          fontSize: 11,
          lineHeight: "18px",
          opacity: 0.8,
          whiteSpace: "nowrap"
        }
      }, "只读 · 属 " + group + " 组");
    }

    var REMOTE_WRITE_METHODS = ["prompt", "updateQueue", "cancel", "rename", "selectModel", "fork"];
    // The live guard: { service, methods: Map<method, { getter, guard }> }.
    var remoteGuard = null;
    var warnedRemoteShape = false;

    function readOnlyRejection(sessionId) {
      var group = groupOf(sessionId);
      return {
        ok: false,
        error: {
          code: "session/group-read-only",
          message: "session \"" + sessionId + "\" belongs to group \"" + group + "\"; the " + sideLabel() + " side is read-only for it",
          details: { sessionId: sessionId, group: group, side: state.side }
        }
      };
    }

    /**
     * Find the REAL RemoteNamespaceService behind the 'session' namespace.
     *
     * ctx.remote.session is a fresh nested-view proxy per access (Object.is
     * differs between accesses); ctx.get('remote').namespaces is the gateway's
     * own name -> { service } map, so that entry is the most direct handle.
     * Returns null until the api-gateway client namespace is mounted.
     */
    function recallNamespace(context) {
      var candidates = [];
      try {
        var remote = typeof context.get === "function" ? context.get("remote") : context.remote;
        var namespaces = remote && typeof remote === "object" ? remote.namespaces : undefined;
        if (namespaces && typeof namespaces.get === "function") {
          var record = namespaces.get("session");
          if (record && record.service) candidates.push(record.service);
        }
      } catch (err) { /* gateway client not mounted yet */ }
      try {
        if (typeof context.get === "function") {
          var direct = context.get("remote.session");
          if (direct) candidates.push(direct);
        }
      } catch (err) { /* service key not resolvable yet */ }
      try {
        var view = context.remote && context.remote.session;
        if (view) candidates.push(view);
      } catch (err) { /* nested namespace view not ready */ }
      for (var index = 0; index < candidates.length; index++) {
        var candidate = candidates[index];
        try {
          for (var methodIndex = 0; methodIndex < REMOTE_WRITE_METHODS.length; methodIndex++) {
            var descriptor = Object.getOwnPropertyDescriptor(candidate, REMOTE_WRITE_METHODS[methodIndex]);
            if (descriptor && (typeof descriptor.get === "function"
              || (typeof descriptor.value === "function" && descriptor.value.__sessionGroupsGuard === true))) {
              return candidate;
            }
          }
        } catch (err) { /* a view without descriptors is not usable */ }
      }
      return candidates.length > 0 ? candidates[0] : null;
    }

    /**
     * Build the guarded method. The original accessor's getter is re-invoked on
     * every ALLOWED call, so direct/scoped resolution stays dynamic (a
     * re-installed method group is honoured); a read-only Session returns the
     * standard rejection WITHOUT invoking the accessor or the transport.
     */
    function makeGuard(getter, service, method) {
      function guarded() {
        var request = arguments[0];
        var sessionId = request !== null && typeof request === "object"
          ? (typeof request.sessionId === "string" ? request.sessionId : (typeof request.id === "string" ? request.id : undefined))
          : undefined;
        if (typeof sessionId === "string" && isReadOnly(sessionId)) return Promise.resolve(readOnlyRejection(sessionId));
        var invoke = getter.call(service);
        return invoke.apply(this, arguments);
      }
      Object.defineProperty(guarded, "__sessionGroupsGuard", { value: true });
      Object.defineProperty(guarded, "__sessionGroupsGetter", { value: getter });
      return guarded;
    }

    /** True while every patched method still resolves to our guard. */
    function remoteGuardHealthy() {
      if (remoteGuard === null) return false;
      var healthy = true;
      remoteGuard.methods.forEach(function (record, method) {
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(remoteGuard.service, method); } catch (err) { descriptor = undefined; }
        if (!descriptor || descriptor.value !== record.guard) healthy = false;
      });
      return healthy;
    }

    /**
     * Install or repair the client write guard.
     *
     * The RemoteNamespaceService installs each method as a GETTER-ONLY accessor
     * on its own instance (dsh-api-gateway/lib/client.browser.js:1988-2011), so
     * a classic-script assignment to sessionNamespace[method] is a silent
     * no-op. Object.defineProperty is legal (the accessor is configurable) and
     * lands on the real service instance; every consumer view sees the guard.
     * Re-run on the 2.5 s poll because remove() deletes the property
     * (Reflect.deleteProperty, client.browser.js:2020-2021) and a namespace
     * remount creates a new service instance.
     */
    function ensureRemoteGuard(context) {
      var service = recallNamespace(context);
      if (!service) {
        if (!warnedRemoteShape) {
          warnedRemoteShape = true;
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[dsh-session-groups] api-gateway session namespace not mounted yet; the client write guard will retry on the 2.5 s poll");
          }
        }
        return false;
      }
      if (remoteGuard !== null && remoteGuard.service === service && remoteGuardHealthy()) return true;
      if (remoteGuard !== null) restoreRemoteGuard();
      var patched = new Map();
      REMOTE_WRITE_METHODS.forEach(function (method) {
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(service, method); } catch (err) { descriptor = undefined; }
        if (!descriptor) return;
        if (typeof descriptor.value === "function" && descriptor.value.__sessionGroupsGuard === true) {
          patched.set(method, { getter: descriptor.value.__sessionGroupsGetter, guard: descriptor.value });
          return;
        }
        if (typeof descriptor.get !== "function") return;
        var getter = descriptor.get;
        var guard = makeGuard(getter, service, method);
        try {
          Object.defineProperty(service, method, { configurable: true, enumerable: true, writable: true, value: guard });
        } catch (err) {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[dsh-session-groups] could not define the write guard for " + method + "(); the client guard will retry", err);
          }
          return;
        }
        var check = Object.getOwnPropertyDescriptor(service, method);
        if (!check || check.value !== guard) {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[dsh-session-groups] write guard for " + method + "() did not take on the namespace service");
          }
          return;
        }
        patched.set(method, { getter: getter, guard: guard });
      });
      if (patched.size === 0) {
        if (!warnedRemoteShape) {
          warnedRemoteShape = true;
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[dsh-session-groups] session namespace has no writable methods to guard; the host guard remains the boundary");
          }
        }
        return false;
      }
      remoteGuard = { service: service, methods: patched };
      return true;
    }

    /** Restore the original accessors (only where our guard is still in place). */
    function restoreRemoteGuard() {
      var patches = remoteGuard;
      remoteGuard = null;
      if (patches === null) return;
      patches.methods.forEach(function (record, method) {
        try {
          var descriptor = Object.getOwnPropertyDescriptor(patches.service, method);
          if (descriptor && descriptor.value === record.guard) {
            Object.defineProperty(patches.service, method, { configurable: true, enumerable: true, get: record.getter });
          }
        } catch (err) { /* leave whatever the runtime owns now */ }
      });
    }

    function apply(ctx) {
      ensureStyle();
      // Install the write guard now when the gateway namespace is mounted; the
      // 2.5 s poll below repairs it after a remove()/namespace remount and
      // re-reads the registry, so an assignment made on the OTHER host is
      // observed within one poll.
      ensureRemoteGuard(ctx);
      ctx.effect(function () {
        var stopped = false;
        var tick = function () {
          if (stopped) return;
          refresh().then(function () {
            if (!stopped) ensureRemoteGuard(ctx);
          }, function () { /* refresh() folds its own errors; keep polling */ });
        };
        refresh().then(function () { if (!stopped) ensureRemoteGuard(ctx); }, function () {});
        var timer = setInterval(tick, POLL_MS);
        return function () { stopped = true; clearInterval(timer); };
      }, "session-groups: poll registry and repair the write guard");

      ctx.effect(function () {
        return ctx.slots.inject(SLOT_ROW_BADGE, function () {
          return ctx.slots.register({
            name: SLOT_ROW_BADGE,
            id: PLUGIN_ID + ":badge",
            order: 20,
            registrant: PLUGIN_ID
          }, GroupBadge);
        });
      }, "session-groups: Session row badge");

      var rows = [
        ["webui", "Session group: WebUI"],
        ["desktop", "Session group: Desktop"],
        ["shared", "Session group: Shared (default)"]
      ];
      rows.forEach(function (entry, index) {
        ctx.effect(function () {
          return ctx.slots.inject(SLOT_MENU, function () {
            return ctx.slots.register({
              name: SLOT_MENU,
              id: PLUGIN_ID + ":assign-" + entry[0],
              order: 700 + index * 10,
              registrant: PLUGIN_ID
            }, makeAssignRow(entry[0], entry[1]));
          });
        }, "session-groups: assign " + entry[0]);
      });

      ctx.effect(function () {
        return ctx.slots.inject(SLOT_HEADER_ACTIONS, function () {
          return ctx.slots.register({
            name: SLOT_HEADER_ACTIONS,
            id: PLUGIN_ID + ":read-only",
            order: 5,
            registrant: PLUGIN_ID
          }, ReadOnlyNotice);
        });
      }, "session-groups: read-only notice");

      ctx.effect(function () {
        return function () { restoreRemoteGuard(); };
      }, "session-groups: restore the remote write guard");

      // Diagnostics for the post-restart acceptance check ONLY: a cross-group
      // prompt must be rejected HERE, before the transport. attemptPrompt()
      // refuses to run at all when the guard is not installed, so it can never
      // turn into a real write attempt.
      try {
        window.__DSH_SESSION_GROUPS__ = {
          isReadOnly: isReadOnly,
          groupOf: groupOf,
          state: function () { return { side: state.side, groups: state.groups }; },
          guardState: function () {
            return remoteGuard === null ? null : { service: remoteGuard.service, methods: Array.from(remoteGuard.methods.keys()) };
          },
          attemptPrompt: function (sessionId) {
            if (remoteGuard === null) return Promise.resolve({ ok: false, error: { code: "session-groups/guard-missing", message: "client write guard is not installed" } });
            if (!isReadOnly(sessionId)) return Promise.resolve({ ok: false, error: { code: "session-groups/not-read-only", message: "session is writable on this side; attemptPrompt is for a cross-group Session only" } });
            var view = ctx.remote && ctx.remote.session;
            if (!view || typeof view.prompt !== "function") return Promise.resolve({ ok: false, error: { code: "session-groups/no-remote", message: "remote.session is not mounted" } });
            return view.prompt({ sessionId: sessionId });
          }
        };
      } catch (err) { /* diagnostics only; never break the plugin */ }
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    exports.__test = {
      isReadOnly: isReadOnly,
      groupOf: groupOf,
      SLOT_ROW_BADGE: SLOT_ROW_BADGE,
      SLOT_MENU: SLOT_MENU,
      SLOT_HEADER_ACTIONS: SLOT_HEADER_ACTIONS,
      ROUTE_PREFIX: ROUTE_PREFIX,
      GROUPS: GROUPS,
      REMOTE_WRITE_METHODS: REMOTE_WRITE_METHODS,
      ensureRemoteGuard: ensureRemoteGuard,
      restoreRemoteGuard: restoreRemoteGuard,
      remoteGuardState: function () { return remoteGuard; }
    };
    return module.exports;
  }
});
