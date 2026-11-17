(function () {
  'use strict';
  const cur = document.currentScript;
  const EVT = cur && cur.src ? cur.src.split('#')[1] : '';
  if (!EVT || window.__vdlHook) return;
  window.__vdlHook = true;

  const emit = (o) => { try { document.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(o) })); } catch {} };
  const INTERESTING = /\.(?:m3u8|mp4|webm|mkv|m4v)(?:$|[?#])|m3u8|mpegurl/i;
  const abs = (u) => { try { return new URL(String(u), location.href).href; } catch { return null; } };
  const report = (u) => {
    if (typeof u !== 'string' || !INTERESTING.test(u)) return;
    const a = abs(u);
    if (a && /^https?:/.test(a)) emit({ t: 'net', u: a });
  };

  const MEDIA_CT = /mpegurl|dash\+xml|^video\//i;
  const STATIC = /\.(?:js|mjs|css|map|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|wasm|html?)(?:$|[?#])/i;
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input) {
      let url = null;
      try { url = typeof input === 'string' ? input : input && input.url; report(url); } catch {}
      const p = origFetch.apply(this, arguments);
      if (url && !STATIC.test(url)) {
        p.then((r) => { try { if (MEDIA_CT.test(r.headers.get('content-type') || '')) { const a = abs(url); if (a && /^https?:/.test(a)) emit({ t: 'net', u: a }); } } catch {} }, () => {});
      }
      return p;
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const su = String(url);
      report(su);
      if (!STATIC.test(su)) this.addEventListener('readystatechange', function onState() {
        if (this.readyState !== 2) return;
        this.removeEventListener('readystatechange', onState);
        try { if (MEDIA_CT.test(this.getResponseHeader('content-type') || '')) { const a = abs(String(url)); if (a && /^https?:/.test(a)) emit({ t: 'net', u: a }); } } catch {}
      });
    } catch {}
    return xhrOpen.apply(this, arguments);
  };

  if (navigator.requestMediaKeySystemAccess) {
    const rmksa = navigator.requestMediaKeySystemAccess;
    navigator.requestMediaKeySystemAccess = function (keySystem) {
      emit({ t: 'eme', ks: String(keySystem) });
      return rmksa.apply(this, arguments);
    };
  }

  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const root = attach.apply(this, arguments);
    try { this.dispatchEvent(new CustomEvent(EVT + 's')); } catch {}
    return root;
  };
})();
