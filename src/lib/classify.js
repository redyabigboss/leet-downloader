(function (g) {
  'use strict';

  const HLS_RE = /\.m3u8(?:$|[?#])/i;
  const FILE_RE = /\.(?:mp4|webm|mkv|m4v|mov)(?:$|[?#])/i;
  const DASH_RE = /\.mpd(?:$|[?#])/i;
  const SEGMENT_RE = /\.(?:ts|m4s|aac|m4a|cmfv|cmfa|key)(?:$|[?#])/i;
  const AD_HOST_RE = /(?:^|[./-])(?:doubleclick|googlesyndication|googleadservices|adservice|imasdk|moatads|adnxs|adsrvr|amazon-adsystem|pubmatic|rubiconproject|openx|taboola|outbrain|scorecardresearch|innovid|spotxchange|springserve|adform|criteo|teads|smartadserver|adsafeprotected|serving-sys)\./i;
  const AD_PATH_RE = /(?:^|[/_.=-])(?:vast|vpaid|preroll|midroll|postroll|adserver|adverts?|advertising|ads?)(?:[/_.?&=-]|$)/i;

  const MIN_FILE_BYTES = 1024 * 1024;

  function classify(url, contentType) {
    if (!/^https?:/i.test(url)) return null;
    const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (HLS_RE.test(url) || ct.includes('mpegurl')) return 'hls';
    if (DASH_RE.test(url) || ct === 'application/dash+xml') return 'dash';
    if (SEGMENT_RE.test(url)) return null;
    if (ct === 'video/mp2t' || ct === 'video/iso.segment') return null;
    if (FILE_RE.test(url) || ct.startsWith('video/')) return 'file';
    return null;
  }

  function isAd(url) {
    try {
      const u = new URL(url);
      return AD_HOST_RE.test(u.hostname + '.') || AD_PATH_RE.test(u.pathname + u.search);
    } catch { return false; }
  }

  function sizeOk(c) {
    return c.kind !== 'file' || !c.size || c.size >= MIN_FILE_BYTES;
  }

  function score(c, ctx) {
    let s = c.kind === 'hls' ? 30 : c.kind === 'file' ? 20 : 0;
    if (c.frameId === ctx.frameId) s += 40;
    const age = ctx.now - c.ts;
    s += Math.max(0, 20 - age / 3000);
    if (c.kind === 'file' && c.size) s += Math.min(20, c.size / (50 * 1024 * 1024) * 20);
    if (/master|playlist|index/i.test(c.url.split('?')[0])) s += 5;
    return s;
  }

  const api = { classify, isAd, sizeOk, score, MIN_FILE_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).classify = api;
})(typeof self !== 'undefined' ? self : globalThis);
