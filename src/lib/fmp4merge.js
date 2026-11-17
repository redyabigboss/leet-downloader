(function (g) {
  'use strict';

  function walk(buf, start, end) {
    const out = [];
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let p = start; p + 8 <= end;) {
      let size = dv.getUint32(p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      if (size === 1) size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
      if (size === 0) size = end - p;
      if (size < 8 || p + size > end) break;
      out.push({ type, start: p, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (buf, box, type) => walk(buf, box.start + 8, box.end).filter((b) => b.type === type);
  const concat = (parts) => {
    const o = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let p = 0;
    for (const a of parts) { o.set(a, p); p += a.length; }
    return o;
  };
  const box = (type, ...parts) => {
    const body = concat(parts);
    const o = new Uint8Array(8 + body.length);
    new DataView(o.buffer).setUint32(0, o.length);
    for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    o.set(body, 8);
    return o;
  };

  function parseInit(buf) {
    const top = walk(buf, 0, buf.length);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) return null;
    const traks = child(buf, moov, 'trak');
    const mvex = child(buf, moov, 'mvex')[0];
    const mvhd = child(buf, moov, 'mvhd')[0];
    if (traks.length !== 1 || !mvex || !mvhd) return null;
    const trex = child(buf, mvex, 'trex')[0];
    if (!trex) return null;
    return { ftyp: top.find((b) => b.type === 'ftyp'), mvhd, trak: traks[0], trex };
  }

  function setTrackId(bytes, kind, id) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (kind === 'tkhd') dv.setUint32(8 + 4 + (bytes[8] === 1 ? 16 : 8), id);
    else if (kind === 'trex') dv.setUint32(12, id);
    else if (kind === 'mvhd') dv.setUint32(bytes[8] === 1 ? 116 : 104, id);
    return bytes;
  }

  function mergeInit(video, audio) {
    const v = parseInit(video);
    const a = parseInit(audio);
    if (!v || !a) return null;
    const slice = (buf, b) => buf.slice(b.start, b.end);
    const vtrak = slice(video, v.trak);
    const atrak = slice(audio, a.trak);
    const fix = (trak, id) => {
      const tk = walk(trak, 8, trak.length).find((b) => b.type === 'tkhd');
      if (!tk) return false;
      setTrackId(trak.subarray(tk.start, tk.end), 'tkhd', id);
      return true;
    };
    if (!fix(vtrak, 1) || !fix(atrak, 2)) return null;
    const vt = setTrackId(slice(video, v.trex), 'trex', 1);
    const at = setTrackId(slice(audio, a.trex), 'trex', 2);
    const mvhd = setTrackId(slice(video, v.mvhd), 'mvhd', 3);
    const ftyp = v.ftyp ? slice(video, v.ftyp) : box('ftyp', Uint8Array.from('isom', (c) => c.charCodeAt(0)), new Uint8Array([0, 0, 2, 0]), Uint8Array.from('isomiso5iso6', (c) => c.charCodeAt(0)));
    return concat([ftyp, box('moov', mvhd, vtrak, atrak, box('mvex', vt, at))]);
  }

  function cleanFragment(frag, id) {
    const parts = [];
    for (const b of walk(frag, 0, frag.length)) {
      if (b.type !== 'moof' && b.type !== 'mdat') continue;
      const view = frag.subarray(b.start, b.end);
      if (b.type === 'moof') {
        const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
        for (const traf of child(view, { start: 0, end: view.length }, 'traf')) {
          const tfhd = child(view, traf, 'tfhd')[0];
          if (!tfhd) continue;
          const flags = ((view[tfhd.start + 9] << 16) | (view[tfhd.start + 10] << 8) | view[tfhd.start + 11]) >>> 0;
          if (flags & 1) throw new Error('Fragment uses absolute base-data-offset: cannot merge');
          dv.setUint32(tfhd.start + 12, id);
        }
      }
      parts.push(view);
    }
    return parts;
  }

  const api = { mergeInit, cleanFragment };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).fmp4merge = api;
})(typeof self !== 'undefined' ? self : globalThis);
