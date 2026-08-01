/*
 * RIDE AND BIKE — WebGL embed broker.
 *
 * Every 3D scene on this site is an iframe with its own WebGL2 context, its
 * own copy of three.js and its own render loop. That is the right isolation
 * for authoring and the wrong default for a phone, where three of them will
 * happily halve the frame rate and where the browser may revoke a context at
 * any moment under memory pressure.
 *
 * This broker owns when a scene exists at all:
 *
 *   mount    a scene is created only when it is close to being seen, with a
 *            preload margin so it is ready by the time it arrives rather than
 *            starting from zero at the moment the visitor gets there
 *   suspend  a scene that scrolls away stops rendering (its loop halts; it
 *            does not merely skip work inside a still-running frame callback)
 *   evict    beyond the device's context budget the least-wanted scene is
 *            unloaded entirely and its poster comes back
 *   poster   until a scene has drawn its first frame — and again if its
 *            context is lost — the visitor sees the product, never a hole
 *
 * Declarative use, so a page never has to know any of this:
 *
 *   <div data-scene
 *        data-scene-src="bike-scene.embed.html?..."
 *        data-scene-poster="electricbike.png"
 *        data-scene-title="..."
 *        data-scene-priority="hero">      // heroes outrank the rest
 *   </div>
 */
(function () {
  'use strict';

  var scenes = [];
  var origin = location.origin === 'null' ? '*' : location.origin;

  /* ── device budget ──────────────────────────────────────────────────
     A WebGL context costs memory and a render loop costs a slice of a
     single core. Phones have little of either, and a browser that runs out
     of contexts does not warn — it silently kills the oldest one. */
  function deviceBudget() {
    var coarse = matchMedia('(pointer: coarse)').matches;
    var narrow = innerWidth < 900;
    var memory = navigator.deviceMemory || (coarse ? 4 : 8);
    var cores = navigator.hardwareConcurrency || (coarse ? 4 : 8);
    var saveData = !!(navigator.connection && navigator.connection.saveData);
    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Save-Data is an explicit request not to spend the visitor's money or
    // battery on decoration. Honour it literally: posters only.
    if (saveData) return { live: 0, reason: 'save-data' };
    if (memory <= 2 || cores <= 2) return { live: 1, reason: 'low-end' };
    if (coarse || narrow) return { live: reduced ? 1 : 2, reason: 'mobile' };
    return { live: 4, reason: 'desktop' };
  }

  var budget = deviceBudget();

  /* Pages may create WebGL contexts the broker does not manage — the hero on
     the homepage is two of them, and they must exist before any scrolling
     happens. Those count against the same device budget, so the broker is
     told about them rather than discovering the shortfall as jank. */
  var reserved = parseInt(document.documentElement.dataset.sceneReserved || '0', 10) || 0;
  budget.live = Math.max(0, budget.live - reserved);
  budget.reserved = reserved;

  var STYLE = [
    '[data-scene]{isolation:isolate;overflow:hidden}',
    '[data-scene] .scene-frame{position:absolute;inset:0;width:100%;height:100%;',
    '  border:0;background:transparent;opacity:0;transition:opacity .55s ease}',
    '[data-scene][data-scene-state="live"] .scene-frame{opacity:1}',
    /* The poster is the product, not a spinner: if the scene never arrives,
       what is left behind is still a picture of the thing being sold. */
    '[data-scene] .scene-poster{position:absolute;inset:0;display:grid;place-items:center;',
    '  transition:opacity .55s ease;pointer-events:none}',
    '[data-scene][data-scene-state="live"] .scene-poster{opacity:0}',
    '[data-scene] .scene-poster img{max-width:78%;max-height:78%;object-fit:contain;',
    '  filter:drop-shadow(0 18px 26px rgba(0,0,0,.45))}',
    '[data-scene] .scene-poster-status{position:absolute;inset:auto auto 12px 14px;',
    '  width:7px;height:7px;border-radius:50%;background:rgba(245,197,24,.55);opacity:0}',
    '[data-scene][data-scene-state="loading"] .scene-poster-status{opacity:1;',
    '  animation:scenePulse 1.4s ease-in-out infinite}',
    '@keyframes scenePulse{50%{opacity:.25;transform:scale(.6)}}',
    '@media (prefers-reduced-motion:reduce){',
    '  [data-scene] .scene-poster-status{animation:none}}'
  ].join('');

  var styleTag = document.createElement('style');
  styleTag.textContent = STYLE;
  (document.head || document.documentElement).appendChild(styleTag);

  function buildPoster(host) {
    var poster = document.createElement('div');
    poster.className = 'scene-poster';
    var image = host.dataset.scenePoster;
    if (image) {
      var img = document.createElement('img');
      img.src = image;
      img.alt = host.dataset.sceneTitle || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      poster.appendChild(img);
    }
    var status = document.createElement('span');
    status.className = 'scene-poster-status';
    poster.appendChild(status);
    host.appendChild(poster);
    return poster;
  }

  function mount(scene) {
    if (scene.frame) return;
    var frame = document.createElement('iframe');
    frame.className = 'scene-frame';
    frame.title = scene.host.dataset.sceneTitle || '';
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('allowtransparency', 'true');
    frame.src = scene.src;
    scene.host.appendChild(frame);
    scene.frame = frame;
    scene.mountedAt = performance.now();
    scene.host.dataset.sceneState = 'loading';
  }

  function unmount(scene) {
    if (!scene.frame) return;
    // Removing the element is the only way to actually give the context back;
    // blanking src leaves the renderer alive in some engines.
    scene.frame.remove();
    scene.frame = null;
    scene.ready = false;
    scene.host.dataset.sceneState = 'poster';
  }

  function post(scene, message) {
    if (!scene.frame || !scene.frame.contentWindow) return;
    try { scene.frame.contentWindow.postMessage(message, origin); } catch (e) { /* not ready */ }
  }

  function setActive(scene, active) {
    if (scene.active === active) return;
    scene.active = active;
    post(scene, { type: 'ride-scene-active', active: active });
  }

  /* A host the layout has hidden must never be given a context. Responsive
     rules routinely drop a decorative scene on small screens, and mounting it
     anyway spends a context and a render loop on pixels nobody can see. */
  function rendered(scene) {
    if (scene.host.offsetParent === null &&
        getComputedStyle(scene.host).position !== 'fixed') return false;
    var box = scene.host.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  }

  /* Decide which scenes deserve a context right now. Heroes first, then
     whatever is most visible; everything else gets unloaded. */
  function rebalance() {
    var wanted = scenes
      .filter(rendered)
      .filter(function (s) { return s.ratio > 0 || s.priority === 'hero'; })
      .sort(function (a, b) {
        if (a.priority !== b.priority) return a.priority === 'hero' ? -1 : 1;
        return b.ratio - a.ratio;
      });

    var live = wanted.slice(0, budget.live);
    var liveSet = new Set(live);

    scenes.forEach(function (scene) {
      if (!rendered(scene)) { setActive(scene, false); unmount(scene); return; }
      if (liveSet.has(scene)) {
        mount(scene);
        setActive(scene, scene.ratio > 0);
      } else if (scene.frame) {
        // Suspend before unmounting: a scene that is merely off-screen may
        // come straight back, and re-creating a context is far dearer than
        // pausing one.
        setActive(scene, false);
        if (scene.ratio === 0) unmount(scene);
      }
    });
  }

  function observe(scene) {
    // Two observers with different jobs: one decides when to start loading
    // (early, with a generous margin), one reports how visible it is now.
    var preload = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        scene.near = entry.isIntersecting;
        if (entry.isIntersecting) rebalance();
      });
    }, { rootMargin: '150% 0px', threshold: 0 });

    var visibility = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        scene.ratio = entry.isIntersecting ? Math.max(entry.intersectionRatio, 0.01) : 0;
      });
      rebalance();
    }, { threshold: [0, 0.01, 0.25, 0.6, 1] });

    preload.observe(scene.host);
    visibility.observe(scene.host);
  }

  function register(host) {
    var src = host.dataset.sceneSrc;
    if (!src) return;
    var scene = {
      host: host,
      src: src,
      priority: host.dataset.scenePriority || 'normal',
      frame: null,
      ready: false,
      active: false,
      ratio: 0,
      near: false
    };
    /* Only establish a containing block if the page has not already done so.
       Forcing position:relative from here would silently override a host the
       page deliberately positioned absolutely, collapsing it to zero height. */
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.dataset.sceneState = 'poster';
    scene.poster = buildPoster(host);
    scenes.push(scene);

    if (budget.live === 0) return;   // posters only on this device
    if (!('IntersectionObserver' in window)) { mount(scene); setActive(scene, true); return; }
    observe(scene);
  }

  function findScene(source) {
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i].frame && scenes[i].frame.contentWindow === source) return scenes[i];
    }
    return null;
  }

  addEventListener('message', function (event) {
    if (event.origin !== location.origin && event.origin !== 'null') return;
    var data = event.data || {};
    var scene = findScene(event.source);
    if (!scene) return;

    if (data.type === 'scene-first-frame') {
      // Only now is it safe to drop the poster: the canvas has real pixels.
      scene.ready = true;
      scene.host.dataset.sceneState = 'live';
    } else if (data.type === 'scene-context-lost') {
      /* The browser took the context back. Show the product again instead of
         a black rectangle, and let the scene tell us when it has recovered. */
      scene.ready = false;
      scene.host.dataset.sceneState = 'poster';
    } else if (data.type === 'scene-context-restored') {
      scene.host.dataset.sceneState = scene.ready ? 'live' : 'loading';
    }
  });

  function boot() {
    document.querySelectorAll('[data-scene]').forEach(register);
    // A tab in the background should cost nothing at all.
    document.addEventListener('visibilitychange', function () {
      scenes.forEach(function (scene) {
        if (document.hidden) setActive(scene, false);
        else if (scene.ratio > 0) setActive(scene, true);
      });
    });
    var resizeTimer = 0;
    addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebalance, 220);
    }, { passive: true });
    addEventListener('pagehide', function () {
      scenes.forEach(function (scene) { setActive(scene, false); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.RideScenes = {
    budget: budget,
    scenes: scenes,
    state: function () {
      return scenes.map(function (s) {
        return {
          src: s.src.split('?')[0],
          priority: s.priority,
          mounted: !!s.frame,
          ready: s.ready,
          active: s.active,
          ratio: +s.ratio.toFixed(2),
          state: s.host.dataset.sceneState
        };
      });
    }
  };
})();
