(function (g) {
  'use strict';

  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const dec = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENT[m]);
  function parseXml(text) {
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.text += m[1];
      else if (m[2] !== undefined) { if (stack.length > 1) stack.pop(); }
      else if (m[3] !== undefined) {
        const el = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
        let a;
        attrRe.lastIndex = 0;
        while ((a = attrRe.exec(m[4] || ''))) el.attrs[a[1].replace(/^.*:/, '')] = dec(a[2] !== undefined ? a[2] : a[3]);
        top.children.push(el);
        if (!m[5]) stack.push(el);
      } else if (m[6] !== undefined && top.name !== '#root') top.text += dec(m[6]);
    }
    return root.children[0];
  }
  const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
  const kid = (el, name) => kids(el, name)[0];

  function isoDuration(s) {
    const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s || '');
    if (!m) return 0;
    return (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (parseFloat(m[6]) || 0);
  }
  const abs = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };

  function fill(str, vars) {
    return str.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (m, k, w) => {
      if (vars[k] === undefined) return m;
      const v = String(vars[k]);
      return w ? v.padStart(+w, '0') : v;
    }).replace(/\$\$/g, '$');
  }

  function range(s) {
    const m = /^(\d+)-(\d+)$/.exec(s || '');
    return m ? { offset: +m[1], length: +m[2] - +m[1] + 1 } : null;
  }

  function buildRep(rep, as, period, baseUrl, periodDur) {
    const attr = (k) => (rep.attrs[k] !== undefined ? rep.attrs[k] : as.attrs[k]);
    const id = rep.attrs.id;
    const bandwidth = parseInt(rep.attrs.bandwidth, 10) || 0;
    let base = baseUrl;
    for (const holder of [period, as, rep]) { const b = kid(holder, 'BaseURL'); if (b && b.text.trim()) base = abs(b.text.trim(), base); }
    const tpls = [period, as, rep].map((h) => kid(h, 'SegmentTemplate')).filter(Boolean);
    const tplEl = tpls[tpls.length - 1];
    const listEl = kid(rep, 'SegmentList') || kid(as, 'SegmentList') || kid(period, 'SegmentList');
    const out = {
      id, bandwidth, width: +attr('width') || 0, height: +attr('height') || 0, codecs: attr('codecs') || '', mimeType: attr('mimeType') || '',
      lang: as.attrs.lang || rep.attrs.lang || '', roles: kids(as, 'Role').concat(kids(rep, 'Role')).map((r) => r.attrs.value || ''), segments: [], map: null, duration: periodDur,
    };
    out.webm = /webm/i.test(out.mimeType);
    const vars = { RepresentationID: id, Bandwidth: bandwidth };
    if (tplEl) {
      const a = Object.assign({}, ...tpls.map((t) => t.attrs));
      const ts = +a.timescale || 1;
      const pto = +a.presentationTimeOffset || 0;
      const start = a.startNumber !== undefined ? +a.startNumber : 1;
      if (!a.media) throw new Error('SegmentTemplate without media');
      if (a.initialization) out.map = { uri: abs(fill(a.initialization, vars), base), range: null };
      const tl = tpls.slice().reverse().map((t) => kid(t, 'SegmentTimeline')).find(Boolean);
      let number = start;
      if (tl) {
        let t = 0;
        for (const S of kids(tl, 'S')) {
          if (S.attrs.t !== undefined) t = +S.attrs.t;
          const d = +S.attrs.d;
          let r = +(S.attrs.r || 0);
          if (r < 0) r = Math.max(0, Math.ceil((periodDur * ts + pto - t) / d) - 1);
          for (let i = 0; i <= r; i++, number++, t += d) {
            out.segments.push({ uri: abs(fill(a.media, Object.assign({ Number: number, Time: t }, vars)), base), range: null, key: null, map: out.map, seq: number, duration: d / ts });
          }
        }
      } else {
        const d = +a.duration;
        if (!d || !/\$(Number|Time)/.test(a.media)) throw new Error('Unsupported SegmentTemplate');
        const count = Math.ceil((periodDur * ts) / d);
        for (let i = 0; i < count; i++) {
          out.segments.push({ uri: abs(fill(a.media, Object.assign({ Number: start + i, Time: i * d }, vars)), base), range: null, key: null, map: out.map, seq: start + i, duration: d / ts });
        }
      }
    } else if (listEl) {
      const init = kid(listEl, 'Initialization');
      if (init) out.map = { uri: abs(init.attrs.sourceURL || base, base), range: range(init.attrs.range) };
      const ts = +listEl.attrs.timescale || 1;
      const d = (+listEl.attrs.duration || 0) / ts;
      kids(listEl, 'SegmentURL').forEach((u, i) => {
        out.segments.push({ uri: abs(u.attrs.media || base, base), range: range(u.attrs.mediaRange), key: null, map: out.map, seq: i, duration: d });
      });
    } else {
      out.segments.push({ uri: base, range: null, key: null, map: null, seq: 0, duration: periodDur });
    }
    out.protected = kids(rep, 'ContentProtection').length > 0 || kids(as, 'ContentProtection').length > 0;
    return out;
  }

  function parse(text, baseUrl) {
    const root = parseXml(text);
    if (!root || root.name !== 'MPD') throw new Error('Not an MPD');
    const total = isoDuration(root.attrs.mediaPresentationDuration);
    const result = { type: root.attrs.type === 'dynamic' ? 'dynamic' : 'static', duration: total, drm: false, video: [], audio: [] };
    let base = baseUrl;
    const mb = kid(root, 'BaseURL');
    if (mb && mb.text.trim()) base = abs(mb.text.trim(), base);
    const periods = kids(root, 'Period');
    if (!periods.length) return result;
    const pd = (p) => isoDuration(p.attrs.duration) || (periods.length === 1 ? total : 0);
    const period = periods.slice().sort((a, b) => pd(b) - pd(a))[0];
    const periodDur = pd(period) || total;
    result.duration = periodDur;
    for (const as of kids(period, 'AdaptationSet')) {
      const reps = kids(as, 'Representation');
      for (const rep of reps) {
        const mime = rep.attrs.mimeType || as.attrs.mimeType || '';
        const type = (as.attrs.contentType || mime.split('/')[0] || '').toLowerCase();
        if (type !== 'video' && type !== 'audio') continue;
        let r;
        try { r = buildRep(rep, as, period, base, periodDur); } catch { continue; }
        if (r.protected) result.drm = true;
        if (type === 'video') result.video.push(r);
        else if (type === 'audio') result.audio.push(r);
      }
    }
    result.video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    const prio = (r) => (r.roles.some((v) => /^(?:description|commentary|enhanced-audio-intelligibility)$/.test(v)) ? 2 : r.roles.includes('main') ? 0 : 1);
    const lead = result.audio.length ? result.audio.reduce((m, r) => (prio(r) < prio(m) ? r : m)) : null;
    const leadLang = lead ? lead.lang : '';
    result.audio.sort((a, b) => (prio(a) - prio(b)) || ((a.lang === leadLang ? 0 : 1) - (b.lang === leadLang ? 0 : 1)) || (b.bandwidth - a.bandwidth));
    return result;
  }

  function toPlaylist(rep) {
    return { type: 'media', endList: true, segments: rep.segments, duration: rep.segments.reduce((s, x) => s + (x.duration || 0), 0), webm: rep.webm };
  }

  const api = { parse, toPlaylist, parseXml, isoDuration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).mpd = api;
})(typeof self !== 'undefined' ? self : globalThis);
