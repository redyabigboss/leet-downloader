(function () {
  'use strict';
  if (window.__vdlCS) return;
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const cs = {
    api,
    seen: new Map(),
    drm: { encrypted: false, keySystems: new Set() },
    settings: null,
    lang: 'en',
    disabled: false,
    ui: null,
  };
  window.__vdlCS = cs;

  const ch = '__vdl' + Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');
  const MAX_URL = 4096;

  try {
    const s = document.createElement('script');
    s.src = api.runtime.getURL('src/page/hook.js') + '#' + ch;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {}

  document.addEventListener(ch, (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'net' && typeof m.u === 'string' && m.u.length <= MAX_URL && /^https?:\/\//i.test(m.u)) {
      if (cs.seen.size > 60) cs.seen.delete(cs.seen.keys().next().value);
      cs.seen.set(m.u, Date.now());
    } else if (m.t === 'eme' && cs.drm.keySystems.size < 16) cs.drm.keySystems.add(String(m.ks).slice(0, 64));
  }, true);

  document.addEventListener('encrypted', () => { cs.drm.encrypted = true; }, true);
  document.addEventListener(ch + 's', (e) => {
    const root = e.target && e.target.openOrClosedShadowRoot;
    if (root) watchRoot(root);
  }, true);

  const isPlayer = (v, relaxed) => {
    const r = v.getBoundingClientRect();
    const w = relaxed ? 120 : 200; const h = relaxed ? 70 : 120;
    return r.width >= w && r.height >= h && v.isConnected && getComputedStyle(v).visibility !== 'hidden';
  };

  let initPromise = null;
  function init() {
    if (!initPromise) {
      initPromise = api.runtime.sendMessage({ type: 'vdl:init' }).then((r) => {
        cs.settings = r.settings;
        cs.lang = r.lang;
        cs.disabled = !!r.disabled;
      }).catch(() => {
        cs.settings = cs.settings || { position: 'corner' };
        cs.lang = /^ru/i.test(navigator.language || '') ? 'ru' : 'en';
        initPromise = null;
      });
    }
    return initPromise;
  }

  const tracked = new WeakSet();
  async function attachNow(v, force) {
    tracked.add(v);
    const inject = cs.ui || window.__vdlUI ? Promise.resolve() : api.runtime.sendMessage({ type: 'vdl:inject-ui' }).catch(() => {});
    await Promise.all([init(), inject]);
    if (cs.disabled) return;
    cs.ui = cs.ui || window.__vdlUI;
    if (cs.ui) cs.ui.attach(v, force);
  }
  async function consider(v, relaxed) { if (tracked.has(v) || !isPlayer(v, relaxed)) return; return attachNow(v, false); }

  const onMedia = (e) => { if (e.target && e.target.localName === 'video') consider(e.target); };
  const listen = (root) => { for (const t of ['loadeddata', 'loadedmetadata', 'canplay', 'play', 'playing']) root.addEventListener(t, onMedia, true); };
  const watched = new WeakSet();
  const roots = new Set();
  function watchRoot(root) {
    if (watched.has(root)) return;
    watched.add(root);
    roots.add(root);
    listen(root);
    for (const v of root.querySelectorAll('video')) if (v.readyState >= 2) consider(v);
  }

  function videosAt(x, y) {
    const out = new Set(); const seenRoots = new Set();
    const walk = (root) => {
      let els = [];
      try { els = root.elementsFromPoint(x, y); } catch { return; }
      for (const el of els) {
        if (el.localName === 'video') out.add(el);
        const sr = el.openOrClosedShadowRoot;
        if (sr && !seenRoots.has(sr)) { seenRoots.add(sr); walk(sr); }
      }
    };
    walk(document);
    return out;
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (roots.size < 2 && !document.getElementsByTagName('video').length) return;
    for (const v of videosAt(e.clientX, e.clientY)) if (!tracked.has(v)) consider(v, true);
  }, { capture: true, passive: true });

  function toast(text) {
    const h = document.createElement('div');
    h.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;right:0!important;bottom:24px!important;z-index:2147483647!important;display:flex!important;justify-content:center!important;pointer-events:none!important;';
    const r = h.attachShadow({ mode: 'closed' });
    r.innerHTML = '<div style="font:14px system-ui,sans-serif;color:#fff;background:rgba(18,18,22,.9);padding:10px 16px;border-radius:20px;max-width:90vw"></div>';
    r.firstChild.textContent = text;
    document.documentElement.appendChild(h);
    setTimeout(() => h.remove(), 3500);
  }
  api.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'vdl:force') return undefined;
    let n = 0;
    for (const root of roots) for (const v of root.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 50) { n++; attachNow(v, true); }
    }
    if (window === window.top) toast(cs.lang === 'ru'
      ? (n ? 'Видео найдено — кнопка показана' : 'Расширение работает, но <video> не найден (возможно, во вложенном фрейме)')
      : (n ? 'Video found — button shown' : 'Extension is working, but no <video> found (maybe in a nested frame)'));
    return undefined;
  });

  watchRoot(document);
  document.addEventListener('DOMContentLoaded', () => {
    for (const v of document.querySelectorAll('video')) if (v.readyState >= 2) consider(v);
  }, { once: true });
})();
