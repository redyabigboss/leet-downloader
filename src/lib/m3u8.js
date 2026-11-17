(function (g) {
  'use strict';

  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) {
      let v = m[2];
      if (v[0] === '"') v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function resolveUrl(u, base) {
    try { return new URL(u, base).href; } catch { return u; }
  }

  const SIMPLE_REL = /^[\w][\w.%~-]*(?:\/[\w][\w.%~-]*)*(?:\?[\w=&%.~,+:;\/-]*)?$/;
  function makeResolver(base) {
    let dir = null;
    try {
      const b = new URL(base);
      if (b.protocol === 'https:' || b.protocol === 'http:') dir = b.origin + b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1);
    } catch {}
    return (u) => (dir !== null && SIMPLE_REL.test(u) ? dir + u : resolveUrl(u, base));
  }

  function parseRange(s, prevEnd) {
    const [len, off] = String(s).split('@');
    return { length: parseInt(len, 10), offset: off !== undefined ? parseInt(off, 10) : prevEnd || 0 };
  }

  function parse(text, baseUrl) {
    const src = String(text).replace(/^\uFEFF/, '');
    const lines = src.split(/\r?\n/);
    if (!lines[0] || !lines[0].trim().startsWith('#EXTM3U')) throw new Error('Not an M3U8 playlist');
    return src.includes('#EXT-X-STREAM-INF:') ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
  }

  function parseMaster(lines, baseUrl) {
    const variants = [];
    const media = [];
    const children = [];
    let pending = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pending = parseAttrs(line.slice(18));
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(line.slice(13));
        const uri = a.URI ? resolveUrl(a.URI, baseUrl) : null;
        if (uri) children.push(uri);
        if (a.TYPE !== 'AUDIO' && a.TYPE !== 'VIDEO') continue;
        media.push({
          type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME || a.LANGUAGE || a['GROUP-ID'], language: a.LANGUAGE || '',
          uri,
          isDefault: a.DEFAULT === 'YES', autoselect: a.AUTOSELECT === 'YES', forced: a.FORCED === 'YES',
        });
      } else if (line[0] !== '#' && pending) {
        const res = /^(\d+)x(\d+)$/.exec(pending.RESOLUTION || '');
        variants.push({
          uri: resolveUrl(line, baseUrl),
          bandwidth: parseInt(pending.BANDWIDTH, 10) || 0,
          width: res ? +res[1] : 0,
          height: res ? +res[2] : 0,
          codecs: pending.CODECS || '',
          frameRate: parseFloat(pending['FRAME-RATE']) || 0,
          audio: pending.AUDIO || null,
        });
        pending = null;
      }
    }
    return { type: 'master', variants, media, children };
  }

  function parseMedia(lines, baseUrl) {
    const pl = { type: 'media', segments: [], targetDuration: 0, mediaSequence: 0, endList: false, playlistType: null, duration: 0 };
    const resolve = makeResolver(baseUrl);
    let key = null;
    let map = null;
    let duration = null;
    let range = null;
    let disc = false;
    const lastEnd = {};
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line[0] === '#') {
        if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
        else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
        else if (line.startsWith('#EXT-X-KEY:')) {
          const a = parseAttrs(line.slice(11));
          key = a.METHOD === 'NONE' ? null : {
            method: a.METHOD, uri: a.URI ? resolveUrl(a.URI, baseUrl) : null, iv: a.IV || null, keyFormat: a.KEYFORMAT || 'identity',
          };
        } else if (line.startsWith('#EXT-X-MAP:')) {
          const a = parseAttrs(line.slice(11));
          const uri = resolveUrl(a.URI, baseUrl);
          map = { uri, range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null };
        } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.mediaSequence = parseInt(line.slice(22), 10) || 0;
        else if (line.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDuration = parseInt(line.slice(22), 10) || 0;
        else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) pl.playlistType = line.slice(21);
        else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) disc = true;
        else if (line.startsWith('#EXT-X-ENDLIST')) pl.endList = true;
        continue;
      }
      if (duration === null) continue;
      const uri = resolve(line);
      let r = null;
      if (range) {
        r = parseRange(range, lastEnd[uri]);
        lastEnd[uri] = r.offset + r.length;
      }
      pl.segments.push({ uri, duration, seq: pl.mediaSequence + pl.segments.length, range: r, key, map, discontinuity: disc });
      pl.duration += duration;
      duration = null;
      range = null;
      disc = false;
    }
    return pl;
  }

  function isDrmKey(key) {
    if (!key) return false;
    if (key.method !== 'AES-128') return true;
    return key.keyFormat !== 'identity';
  }

  function variantLabel(v) {
    if (v.height) return v.height + 'p';
    if (v.bandwidth) return Math.round(v.bandwidth / 1000) + ' kbps';
    return 'default';
  }

  function sortVariants(variants) {
    return variants.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  }

  function pickVariant(variants, pref) {
    const sorted = sortVariants(variants);
    if (!sorted.length) return null;
    if (pref === 'worst') return sorted[sorted.length - 1];
    if (/^\d+$/.test(String(pref))) {
      const target = +pref;
      return sorted.find((v) => v.height && v.height <= target) || sorted[sorted.length - 1];
    }
    return sorted[0];
  }

  function computeIV(key, seq) {
    const iv = new Uint8Array(16);
    if (key.iv) {
      const hex = key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      let n = seq;
      for (let i = 15; i >= 8 && n > 0; i--) { iv[i] = n % 256; n = Math.floor(n / 256); }
    }
    return iv;
  }

  const api = { parse, resolveUrl, pickVariant, sortVariants, variantLabel, computeIV, isDrmKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).m3u8 = api;
})(typeof self !== 'undefined' ? self : globalThis);
