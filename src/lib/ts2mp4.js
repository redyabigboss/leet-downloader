(function (g) {
  'use strict';

  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const UNSUPPORTED_TYPES = { 0x01: 'MPEG-1 video', 0x02: 'MPEG-2 video', 0x03: 'MPEG-1 audio', 0x04: 'MPEG-2 audio', 0x11: 'AAC LATM', 0x24: 'HEVC', 0x81: 'AC-3', 0x87: 'E-AC-3' };
  const TS_PKT = 188;

  class UnsupportedError extends Error {
    constructor(m) { super(m); this.name = 'UnsupportedError'; }
  }

  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  function concat(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  }
  function u32(...v) {
    const o = new Uint8Array(v.length * 4);
    const dv = new DataView(o.buffer);
    v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0));
    return o;
  }
  function u16(...v) {
    const o = new Uint8Array(v.length * 2);
    const dv = new DataView(o.buffer);
    v.forEach((x, i) => dv.setUint16(i * 2, x & 0xffff));
    return o;
  }
  const zeros = (n) => new Uint8Array(n);
  function box(type, ...parts) {
    const body = concat(parts);
    const o = new Uint8Array(8 + body.length);
    new DataView(o.buffer).setUint32(0, o.length);
    o.set(ascii(type), 4);
    o.set(body, 8);
    return o;
  }
  const fullBox = (type, ver, flags, ...parts) => box(type, u32(((ver & 0xff) << 24) | (flags & 0xffffff)), ...parts);
  const MDAT = ascii('mdat');
  const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

  class Bits {
    constructor(d) { this.d = d; this.p = 0; }
    u(n) { let v = 0; while (n--) { v = v * 2 + ((this.d[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
    ue() { let z = 0; while (this.u(1) === 0 && z < 32) z++; return z ? 2 ** z - 1 + this.u(z) : 0; }
    se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
  }
  function unescapeRbsp(nal) {
    const out = [];
    for (let i = 0, z = 0; i < nal.length; i++) {
      if (z >= 2 && nal[i] === 3) { z = 0; continue; }
      out.push(nal[i]);
      z = nal[i] === 0 ? z + 1 : 0;
    }
    return Uint8Array.from(out);
  }
  function parseSps(nal) {
    const b = new Bits(unescapeRbsp(nal.subarray(1)));
    const profile = b.u(8); const compat = b.u(8); const level = b.u(8);
    b.ue();
    let chroma = 1; let bitDepth = 8;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = b.ue();
      if (chroma === 3) b.u(1);
      bitDepth = b.ue() + 8; b.ue(); b.u(1);
      if (b.u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (b.u(1)) {
            let last = 8; let next = 8;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              if (next !== 0) next = (last + b.se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    b.ue();
    const poc = b.ue();
    if (poc === 0) b.ue();
    else if (poc === 1) { b.u(1); b.se(); b.se(); const n = b.ue(); for (let i = 0; i < n; i++) b.se(); }
    b.ue(); b.u(1);
    const wMbs = b.ue() + 1; const hMaps = b.ue() + 1;
    const frameMbsOnly = b.u(1);
    if (!frameMbsOnly) b.u(1);
    b.u(1);
    let cl = 0; let cr = 0; let ct = 0; let cb = 0;
    if (b.u(1)) { cl = b.ue(); cr = b.ue(); ct = b.ue(); cb = b.ue(); }
    const cux = chroma === 1 || chroma === 2 ? 2 : 1;
    const cuy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return {
      profile, compat, level, chroma, bitDepth,
      width: wMbs * 16 - cux * (cl + cr),
      height: (2 - frameMbsOnly) * hMaps * 16 - cuy * (ct + cb),
    };
  }

  function splitNals(d) {
    const nals = [];
    let start = -1;
    for (let k = d.indexOf(1, 2); k !== -1; k = d.indexOf(1, k + 1)) {
      if (d[k - 1] === 0 && d[k - 2] === 0) {
        if (start >= 0) nals.push(trimZeros(d, start, k - 2));
        start = k + 1;
      }
    }
    if (start >= 0 && start < d.length) nals.push(trimZeros(d, start, d.length));
    return nals.filter((n) => n.length);
  }
  function trimZeros(d, s, e) {
    while (e > s && d[e - 1] === 0) e--;
    return d.subarray(s, e);
  }

  function findSync(buf) {
    const lim = Math.min(buf.length - TS_PKT, TS_PKT * 10);
    for (let i = 0; i <= lim; i++) {
      if (buf[i] === 0x47 && (i + TS_PKT >= buf.length || buf[i + TS_PKT] === 0x47)) return i;
    }
    return -1;
  }
  function readTs(d, o) {
    return ((d[o] >> 1) & 7) * 1073741824 + (((d[o + 1] << 7) | (d[o + 2] >> 1)) * 32768) + ((d[o + 3] << 7) | (d[o + 4] >> 1));
  }

  class TsDemuxer {
    constructor() {
      this.pmtPid = -1;
      this.streams = new Map();
      this.hasVideo = false;
      this.hasAudio = false;
    }

    push(buf) {
      const out = { video: [], audio: [] };
      let p = findSync(buf);
      if (p < 0) throw new UnsupportedError('Not an MPEG-TS segment');
      while (p + TS_PKT <= buf.length) {
        if (buf[p] !== 0x47) {
          const n = findSync(buf.subarray(p));
          if (n < 0) break;
          p += n;
          continue;
        }
        this._packet(buf, p, out);
        p += TS_PKT;
      }
      for (const s of this.streams.values()) this._finish(s, out);
      return out;
    }

    _packet(buf, p, out) {
      const b1 = buf[p + 1];
      if (b1 & 0x80) return;
      const pusi = !!(b1 & 0x40);
      const pid = ((b1 & 0x1f) << 8) | buf[p + 2];
      const afc = (buf[p + 3] >> 4) & 3;
      let o = p + 4;
      const end = p + TS_PKT;
      if (afc & 2) o += 1 + buf[o];
      if (!(afc & 1) || o >= end) return;
      if (pid === 0) return this._pat(buf, o, pusi);
      if (pid === this.pmtPid) return this._pmt(buf, o, end, pusi);
      const s = this.streams.get(pid);
      if (!s) return;
      if (pusi) this._finish(s, out);
      s.chunks.push(buf.subarray(o, end));
    }

    _pat(buf, o, pusi) {
      if (this.pmtPid >= 0) return;
      let i = o;
      if (pusi) i += 1 + buf[i];
      const secLen = ((buf[i + 1] & 0x0f) << 8) | buf[i + 2];
      const stop = i + 3 + secLen - 4;
      for (let j = i + 8; j + 4 <= stop; j += 4) {
        if (((buf[j] << 8) | buf[j + 1]) !== 0) { this.pmtPid = ((buf[j + 2] & 0x1f) << 8) | buf[j + 3]; break; }
      }
    }

    _pmt(buf, o, end, pusi) {
      if (this.streams.size) return;
      let i = o;
      if (pusi) i += 1 + buf[i];
      const secLen = ((buf[i + 1] & 0x0f) << 8) | buf[i + 2];
      const pil = ((buf[i + 10] & 0x0f) << 8) | buf[i + 11];
      const stop = Math.min(i + 3 + secLen - 4, end);
      for (let j = i + 12 + pil; j + 5 <= stop;) {
        const type = buf[j];
        const pid = ((buf[j + 1] & 0x1f) << 8) | buf[j + 2];
        j += 5 + (((buf[j + 3] & 0x0f) << 8) | buf[j + 4]);
        if (UNSUPPORTED_TYPES[type]) throw new UnsupportedError('Unsupported codec: ' + UNSUPPORTED_TYPES[type]);
        if (type === 0x1b && !this.hasVideo) { this.hasVideo = true; this.streams.set(pid, { kind: 'video', chunks: [] }); }
        else if (type === 0x0f && !this.hasAudio) { this.hasAudio = true; this.streams.set(pid, { kind: 'audio', chunks: [] }); }
      }
    }

    _finish(s, out) {
      if (!s.chunks.length) return;
      const d = s.chunks.length === 1 ? s.chunks[0] : concat(s.chunks);
      s.chunks = [];
      if (d.length < 14 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
      const flags = d[7] >> 6;
      if (!(flags & 2)) return;
      const pts = readTs(d, 9);
      const dts = flags === 3 ? readTs(d, 14) : pts;
      const pesLen = (d[4] << 8) | d[5];
      const end = pesLen ? Math.min(d.length, 6 + pesLen) : d.length;
      out[s.kind].push({ pts, dts, data: d.subarray(9 + d[8], end) });
    }
  }

  function avcC(sps, pps, info) {
    const parts = [Uint8Array.of(1, info.profile, info.compat, info.level, 0xff, 0xe1), u16(sps.length), sps, Uint8Array.of(1), u16(pps.length), pps];
    if ([100, 110, 122, 144].includes(info.profile)) parts.push(Uint8Array.of(0xfc | info.chroma, 0xf8 | (info.bitDepth - 8), 0xf8 | (info.bitDepth - 8), 0));
    return box('avcC', ...parts);
  }

  function esds(acfg) {
    const asc = Uint8Array.of((acfg.objType << 3) | (acfg.sf >> 1), ((acfg.sf & 1) << 7) | (acfg.ch << 3));
    const dsi = Uint8Array.of(0x05, 2, ...asc);
    const dec = Uint8Array.of(0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi);
    const sl = Uint8Array.of(0x06, 1, 2);
    const es = Uint8Array.of(0x03, 3 + dec.length + sl.length, 0, 0, 0, ...dec, ...sl);
    return fullBox('esds', 0, 0, es);
  }

  function trakBox(id, timescale, kind, entry, width, height) {
    const isVideo = kind === 'video';
    const tkhd = fullBox('tkhd', 0, 3, u32(0, 0, id, 0, 0), u32(0, 0), u16(0, 0), u16(isVideo ? 0 : 0x0100, 0), MATRIX, u32(width << 16, height << 16));
    const mdhd = fullBox('mdhd', 0, 0, u32(0, 0, timescale, 0), u16(0x55c4, 0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'), zeros(12), ascii(isVideo ? 'VideoHandler\0' : 'SoundHandler\0'));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const stbl = box('stbl', fullBox('stsd', 0, 0, u32(1), entry), fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0, 0)), fullBox('stco', 0, 0, u32(0)));
    const minf = box('minf', isVideo ? fullBox('vmhd', 0, 1, u16(0, 0, 0, 0)) : fullBox('smhd', 0, 0, u16(0, 0)), dinf, stbl);
    return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  }

  function moovBox(t) {
    const traks = [];
    const trexes = [];
    if (t.video) {
      const { sps, pps, info } = t.video;
      const entry = box('avc1', zeros(6), u16(1), zeros(16), u16(info.width, info.height), u32(0x00480000, 0x00480000, 0), u16(1), zeros(32), u16(0x0018, 0xffff), avcC(sps, pps, info));
      traks.push(trakBox(t.video.id, 90000, 'video', entry, info.width, info.height));
      trexes.push(fullBox('trex', 0, 0, u32(t.video.id, 1, 0, 0, 0x01010000)));
    }
    if (t.audio) {
      const a = t.audio.cfg;
      const entry = box('mp4a', zeros(6), u16(1), u32(0, 0), u16(a.ch, 16, 0, 0), u32(a.rate > 65535 ? 0 : a.rate << 16), esds(a));
      traks.push(trakBox(t.audio.id, a.rate, 'audio', entry, 0, 0));
      trexes.push(fullBox('trex', 0, 0, u32(t.audio.id, 1, 0, 0, 0x02000000)));
    }
    const mvhd = fullBox('mvhd', 0, 0, u32(0, 0, 1000, 0, 0x00010000), u16(0x0100, 0), u32(0, 0), MATRIX, zeros(24), u32(traks.length + 1));
    return box('moov', mvhd, ...traks, box('mvex', ...trexes));
  }

  function trafBox(id, baseTime, samples, isVideo, dataOffset) {
    const entries = new Uint8Array(samples.length * (isVideo ? 16 : 8));
    const dv = new DataView(entries.buffer);
    let o = 0;
    for (const s of samples) {
      dv.setUint32(o, s.dur); dv.setUint32(o + 4, s.size);
      if (isVideo) { dv.setUint32(o + 8, s.key ? 0x02000000 : 0x01010000); dv.setInt32(o + 12, s.pts - s.dts); o += 16; } else o += 8;
    }
    const trun = fullBox('trun', 1, isVideo ? 0xf01 : 0x301, u32(samples.length, dataOffset), entries);
    return box('traf', fullBox('tfhd', 0, 0x020000, u32(id)), fullBox('tfdt', 1, 0, u32(Math.floor(baseTime / 4294967296), baseTime % 4294967296)), trun);
  }

  const unwrap = (ts, ref) => {
    if (ref === null) return ts;
    while (ts < ref - 4294967296) ts += 8589934592;
    return ts;
  };

  class Transmuxer {
    constructor() {
      this.demux = new TsDemuxer();
      this.sps = null; this.pps = null; this.vinfo = null; this.acfg = null;
      this.vq = []; this.aq = [];
      this.vStarted = false; this.vShift = 0; this.vLast = null; this.vRef = null; this.aRef = null;
      this.t0 = null; this.aTime = 0; this.seq = 1; this.initialized = false; this.lastDur = 3600;
      this.ids = { video: 1, audio: 2 };
    }

    push(buf) {
      const { video, audio } = this.demux.push(buf);
      if (!this.demux.hasVideo && !this.demux.hasAudio) throw new UnsupportedError('No supported audio/video streams');
      for (const p of video) this._video(p);
      for (const p of audio) this._audio(p);
      return this._emit(false);
    }

    flush() { return this._emit(true); }

    _video(pes) {
      let key = false;
      const kept = [];
      let size = 0;
      for (const nal of splitNals(pes.data)) {
        const t = nal[0] & 0x1f;
        if (t === 7) { if (!this.sps) { this.sps = nal.slice(); this.vinfo = parseSps(nal); } }
        else if (t === 8) { if (!this.pps) this.pps = nal.slice(); }
        else if (t !== 9 && t !== 12) { if (t === 5) key = true; kept.push(nal); size += 4 + nal.length; }
      }
      if (!kept.length) return;
      if (!this.vStarted) { if (!key) return; this.vStarted = true; }
      let dts = unwrap(pes.dts, this.vRef);
      let pts = unwrap(pes.pts, this.vRef);
      this.vRef = dts;
      if (this.vLast) {
        const delta = dts + this.vShift - this.vLast.dts;
        if (delta < 0 || delta > 900000) this.vShift += this.vLast.dts + this.lastDur - (dts + this.vShift);
      }
      dts += this.vShift; pts += this.vShift;
      const sample = { dts, pts, key, nals: kept, size, dur: 0 };
      this.vLast = sample;
      this.vq.push(sample);
    }

    _audio(pes) {
      const d = pes.data;
      const pts = unwrap(pes.pts, this.aRef);
      this.aRef = pts;
      let n = 0;
      for (let i = 0; i + 7 <= d.length;) {
        if (d[i] !== 0xff || (d[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
        const hdr = d[i + 1] & 1 ? 7 : 9;
        const flen = ((d[i + 3] & 3) << 11) | (d[i + 4] << 3) | (d[i + 5] >> 5);
        if (flen < hdr || i + flen > d.length) break;
        if (!this.acfg) {
          const sf = (d[i + 2] >> 2) & 0xf;
          if (sf >= AAC_RATES.length) throw new UnsupportedError('Bad AAC sample rate');
          this.acfg = { objType: ((d[i + 2] >> 6) & 3) + 1, sf, ch: ((d[i + 2] & 1) << 2) | (d[i + 3] >> 6), rate: AAC_RATES[sf] };
        }
        this.aq.push({ pts: pts + (n * 1024 * 90000) / this.acfg.rate, data: d.subarray(i + hdr, i + flen), size: flen - hdr, dur: 1024 });
        n++;
        i += flen;
      }
    }

    _ready() {
      const d = this.demux;
      if (d.hasVideo && !(this.sps && this.pps && (this.vq.length || this.initialized))) return false;
      if (d.hasAudio && !this.acfg) return false;
      if (!d.hasVideo && !this.initialized && !this.aq.length) return false;
      return true;
    }

    _emit(final) {
      if (!this._ready()) {
        if (final && !this.initialized) throw new Error('Not enough data to build MP4 (no keyframe/audio config)');
        return [];
      }
      const out = [];
      if (!this.initialized) out.push(this._init());
      const vs = this._takeVideo(final);
      const as = this._takeAudio();
      if (vs.length || as.length) out.push(...this._fragment(vs, as));
      return out;
    }

    _init() {
      const d = this.demux;
      this.t0 = d.hasVideo ? this.vq[0].dts : this.aq[0].pts;
      if (d.hasAudio) {
        const frame90 = (1024 * 90000) / this.acfg.rate;
        while (this.aq.length && this.aq[0].pts + frame90 <= this.t0) this.aq.shift();
        this.aTime = this.aq.length ? Math.max(0, Math.round(((this.aq[0].pts - this.t0) * this.acfg.rate) / 90000)) : 0;
      }
      this.ids = { video: 1, audio: d.hasVideo ? 2 : 1 };
      this.initialized = true;
      const tracks = {};
      if (d.hasVideo) tracks.video = { id: this.ids.video, sps: this.sps, pps: this.pps, info: this.vinfo };
      if (d.hasAudio) tracks.audio = { id: this.ids.audio, cfg: this.acfg };
      return concat([box('ftyp', ascii('isom'), u32(512), ascii('isomiso5iso6avc1mp41')), moovBox(tracks)]);
    }

    _takeVideo(final) {
      const q = this.vq;
      const n = final ? q.length : q.length - 1;
      if (n <= 0) return [];
      const take = q.splice(0, n);
      for (let i = 0; i < take.length; i++) {
        const next = i + 1 < take.length ? take[i + 1] : q[0];
        take[i].dur = Math.max(1, next ? next.dts - take[i].dts : this.lastDur);
      }
      this.lastDur = take[take.length - 1].dur;
      return take;
    }

    _takeAudio() {
      const as = this.aq.splice(0);
      return as;
    }

    _fragment(vs, as) {
      const tracks = [];
      let mdatSize = 0;
      if (vs.length) {
        tracks.push({ id: this.ids.video, base: vs[0].dts - this.t0, samples: vs, video: true });
        for (const s of vs) mdatSize += s.size;
      }
      if (as.length) {
        tracks.push({ id: this.ids.audio, base: this.aTime, samples: as, video: false });
        for (const s of as) mdatSize += s.size;
        this.aTime += as.length * 1024;
      }
      const build = (offsets) => box('moof', fullBox('mfhd', 0, 0, u32(this.seq)), ...tracks.map((t, i) => trafBox(t.id, Math.max(0, t.base), t.samples, t.video, offsets[i])));
      const moofSize = 24 + tracks.reduce((n, t) => n + 64 + t.samples.length * (t.video ? 16 : 8), 0);
      let off = moofSize + 8;
      const offsets = tracks.map((t) => { const o = off; for (const s of t.samples) off += s.size; return o; });
      const moof = build(offsets);
      const mdat = new Uint8Array(8 + mdatSize);
      const mdv = new DataView(mdat.buffer);
      mdv.setUint32(0, mdat.length);
      mdat.set(MDAT, 4);
      let p = 8;
      for (const t of tracks) {
        for (const s of t.samples) {
          if (s.nals) {
            for (const nal of s.nals) { mdv.setUint32(p, nal.length); mdat.set(nal, p + 4); p += 4 + nal.length; }
          } else { mdat.set(s.data, p); p += s.size; }
        }
      }
      this.seq++;
      return [moof, mdat];
    }
  }

  const api = { Transmuxer, UnsupportedError, parseSps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).ts2mp4 = api;
})(typeof self !== 'undefined' ? self : globalThis);
