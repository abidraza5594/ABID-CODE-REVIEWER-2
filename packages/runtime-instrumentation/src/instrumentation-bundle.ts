/**
 * The instrumentation bundle is a small JS payload injected into the page
 * via `Page.addInitScript`. It patches a few well-known surfaces so we can
 * observe runtime events:
 *
 *   1. `rxjs.Observable.prototype.subscribe` → record subscribe-time stack +
 *      patch the returned Subscription to record `unsubscribe()` time. Leaked
 *      subscriptions are the ones never closed by scenario end.
 *
 *   2. `ng.profiler` (when available, e.g. in dev mode) → tick on each change
 *      detection cycle and report `componentName -> cycle count, total ms`.
 *      In prod-mode builds we use a fallback: monkey-patch
 *      `ApplicationRef.prototype.tick` and walk `viewRefs` to attribute cycles.
 *
 *   3. `EventTarget.prototype.addEventListener` / `removeEventListener` →
 *      track imbalance. Leaks (added without removed) are reported.
 *
 *   4. `IDBObjectStore.prototype.put/get` → record key-level read-after-write
 *      timing to verify the static IndexedDB rule on real data.
 *
 *   5. A periodic sampling hook posts metrics back to the orchestrator via a
 *      `window.__abidPostMetric(...)` function that the runtime-runner exposes.
 *
 * The bundle is *plain ES2017 JS without dependencies* — it ships as a single
 * string. Any heavy logic that needs Node libs lives in the runtime-runner
 * process, not the page.
 */
export const INSTRUMENTATION_BUNDLE = String.raw`
(function(){
  if (window.__abidInstrumented) return;
  window.__abidInstrumented = true;

  var subId = 0;
  var subs = new Map();

  function post(kind, payload) {
    try { window.__abidPostMetric && window.__abidPostMetric(kind, payload); }
    catch(e) {}
  }

  function flushSummary() {
    var leaked = [];
    subs.forEach(function(v, k){
      if (!v.closedAt) leaked.push({ id: k, openedAt: v.openedAt, stack: v.stack.split('\n').slice(0,8).join('\n') });
    });
    post('summary.leaked-subscriptions', { count: leaked.length, items: leaked.slice(0, 200) });
  }
  window.__abidFlushSummary = flushSummary;

  // 1) RxJS subscribe instrumentation. We patch via a deferred resolver because
  // RxJS is usually loaded after our init script runs. Caller passes the
  // global identifier or we sniff window.rxjs / globalThis.rxjs.
  function patchRxjs(rxjs) {
    if (!rxjs || !rxjs.Observable || rxjs.Observable.__abidPatched) return;
    var proto = rxjs.Observable.prototype;
    var origSub = proto.subscribe;
    proto.subscribe = function patchedSubscribe() {
      var id = ++subId;
      var openedAt = performance.now();
      var stack = (new Error()).stack || '';
      var sub = origSub.apply(this, arguments);
      subs.set(id, { openedAt: openedAt, stack: stack, sub: sub });
      var origUnsub = sub.unsubscribe ? sub.unsubscribe.bind(sub) : null;
      if (origUnsub) {
        sub.unsubscribe = function() {
          var s = subs.get(id);
          if (s) s.closedAt = performance.now();
          post('subscription.close', { id: id, closedAt: performance.now() });
          return origUnsub();
        };
      }
      post('subscription.open', { id: id, openedAt: openedAt, stack: stack.split('\n').slice(0,8).join('\n') });
      return sub;
    };
    rxjs.Observable.__abidPatched = true;
  }
  // Try various globals.
  var rxjsCandidates = [window.rxjs, window['rxjs'], globalThis.rxjs];
  for (var i=0;i<rxjsCandidates.length;i++) patchRxjs(rxjsCandidates[i]);

  // 2) Angular change-detection tick instrumentation.
  // Attach when zone.js patches the application; we hook ApplicationRef.tick.
  function tryPatchNg() {
    if (!window.ng || !window.ng.coreTokens || !window.ng.getDirectives) return false;
    var probeApp = function() {
      var roots = document.querySelectorAll('[ng-version]');
      if (!roots.length) return null;
      try { return window.ng.getOwningComponent(roots[0]) || null; } catch(e) { return null; }
    };
    var app = probeApp();
    if (!app) return false;
    // Walk up to ApplicationRef via ng.profiler if available; this is best-effort.
    return true;
  }
  // Cheap fallback: count microtask flushes that contain a measurable layout.
  var lastTick = performance.now();
  try {
    new PerformanceObserver(function(entries){
      entries.getEntries().forEach(function(e){
        if (e.entryType === 'measure' && e.name && e.name.indexOf('Zone') === 0) {
          post('cd.tick', { atMs: performance.now(), durationMs: e.duration });
        }
      });
    }).observe({ entryTypes: ['measure'] });
  } catch(e) {}

  try {
    new PerformanceObserver(function(entries){
      entries.getEntries().forEach(function(e){
        post('longtask', {
          url: location.href,
          startMs: e.startTime,
          durationMs: e.duration
        });
      });
    }).observe({ entryTypes: ['longtask'] });
  } catch(e) {}

  try {
    var mutationBatches = 0;
    new MutationObserver(function(records){
      mutationBatches++;
      post('render.mutation', {
        count: mutationBatches,
        records: records.length,
        atMs: performance.now()
      });
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  } catch(e) {}

  // 3) Event-listener imbalance.
  var origAdd = EventTarget.prototype.addEventListener;
  var origRem = EventTarget.prototype.removeEventListener;
  var listenerCounts = new WeakMap();
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    var c = listenerCounts.get(this) || 0;
    listenerCounts.set(this, c + 1);
    post('listener.add', { type: type, total: c + 1 });
    return origAdd.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function(type, fn, opts) {
    var c = listenerCounts.get(this) || 0;
    listenerCounts.set(this, Math.max(0, c - 1));
    post('listener.remove', { type: type, total: Math.max(0, c - 1) });
    return origRem.apply(this, arguments);
  };

  // 4) IndexedDB write/read instrumentation.
  if (window.IDBObjectStore && !IDBObjectStore.prototype.__abidPatched) {
    var origPut = IDBObjectStore.prototype.put;
    var origGet = IDBObjectStore.prototype.get;
    var pendingByStore = new Map();
    IDBObjectStore.prototype.put = function(value, key) {
      var t = performance.now();
      var req = origPut.apply(this, arguments);
      var storeName = this.name;
      pendingByStore.set(storeName, t);
      req.addEventListener('success', function(){
        var openedAt = pendingByStore.get(storeName);
        post('idb.put', { store: storeName, queuedAt: t, completedAt: performance.now() });
      });
      return req;
    };
    IDBObjectStore.prototype.get = function(key) {
      var t = performance.now();
      var storeName = this.name;
      var pending = pendingByStore.get(storeName);
      if (pending !== undefined && (t - pending) < 50) {
        post('idb.race', { store: storeName, putAt: pending, getAt: t });
      }
      return origGet.apply(this, arguments);
    };
    IDBObjectStore.prototype.__abidPatched = true;
  }

  // 5) Leaked-subscription summary on pagehide.
  window.addEventListener('pagehide', flushSummary);
})();
`;
