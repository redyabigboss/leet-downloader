(function (g) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const m3u8 = isNode ? require('../lib/m3u8.js') : g.VDL.m3u8;
  const lazy = (name, file) => {
    let m = null;
    return () => m || (m = isNode ? require('../lib/' + file) : (g.VDL[name] || (importScripts('../lib/' + file), g.VDL[name])));
  };
  const getF = lazy('fmp4merge', 'fmp4merge.js');
  const getMpd = lazy('mpd', 'mpd.js');

  class DownloadError extends Error {
    constructor(code, message, extra) { super(message); this.name = 'DownloadError'; this.code = code; Object.assign(this, extra); }
  }

  const aborted = () => new DownloadError('aborted', 'Cancelled');
  const isAborted = (env, sig) => !!((env.signal && env.signal.aborted) || (sig && sig.aborted));
  const throwIfAborted = (env, sig) => { if (isAborted(env, sig)) throw aborted(); };
  const sleep = (ms, env, sig) => new Promise((res, rej) => {
    const signals = [env.signal, sig].filter(Boolean);
    const done = () => { clearTimeout(t); for (const s of signals) s.removeEventListener('abort', onAbort); };
    const onAbort = () => { done(); rej(aborted()); };
    const t = setTimeout(() => { done(); res(); }, ms);
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  });

  const SETTLE_MS = 100;
  const WINDOW_MS = 300;
  const UP_GAIN = 1.12;
  const DOWN_KEEP = 0.93;
  const HOLD_MS = 8000;
  const FAIL_GAP_MS = 1500;

  class Governor {
    constructor(max, clock) {
      this.max = Math.max(1, Math.min(16, parseInt(max, 10) || 6));
      this.now = clock || Date.now;
      this.limit = Math.min(this.max, 4);
      this.good = this.limit;
      this.ref = 0;
      this.mode = 'measure';
      this.walkDown = true;
      this.holdUntil = 0;
      this.lastFail = -1e9;
      this.inflight = 0;
      this.onLimit = null;
      this.rate = 0;
      this._reset();
    }

    _reset() { this.t0 = this.now() + SETTLE_MS; this.bytes = 0; this.peak = 0; }

    _set(l) {
      l = Math.max(1, Math.min(this.max, l));
      const grew = l > this.limit;
      this.limit = l;
      this._reset();
      if (grew && this.onLimit) this.onLimit();
    }

    _lower(l) { return l > 4 ? Math.floor(l * 0.75) : l - 1; }

    _hold() { this.mode = 'hold'; this.walkDown = false; this.holdUntil = this.now() + HOLD_MS; this._set(this.good); }

    _up() {
      if (this.limit >= this.max) { this._hold(); return; }
      this.mode = 'up';
      this._set(this.limit < 4 ? this.limit + 1 : Math.ceil(this.limit * 1.4));
    }

    add(n) {
      const t = this.now();
      if (t < this.t0) return;
      this.bytes += n;
      if (this.inflight > this.peak) this.peak = this.inflight;
      if (t - this.t0 >= WINDOW_MS) this._eval(t);
    }

    _eval(t) {
      const rate = (this.bytes * 1000) / (t - this.t0);
      const full = this.peak >= this.limit;
      this._reset();
      if (!full || rate <= 0) return;
      this.rate = rate;
      switch (this.mode) {
        case 'measure': this.good = this.limit; this.ref = rate; this._up(); break;
        case 'up':
          if (rate >= this.ref * UP_GAIN) { this.good = this.limit; this.ref = rate; this._up(); } else if (this.walkDown && this.good > 1) { this.mode = 'down'; this._set(this._lower(this.good)); } else this._hold();
          break;
        case 'down':
          if (rate >= this.ref * DOWN_KEEP) { this.good = this.limit; if (this.good > 1) this._set(this._lower(this.good)); else this._hold(); } else this._hold();
          break;
        default:
          this.ref = rate;
          if (t >= this.holdUntil) { this.good = this.limit; this._up(); }
      }
    }

    fail(e) {
      const t = this.now();
      if (t - this.lastFail < FAIL_GAP_MS) return;
      this.lastFail = t;
      const hard = !!e && (e.status === 429 || e.retryAfter > 0);
      this.good = Math.max(1, hard ? this.limit >> 1 : Math.min(this.limit - 1, Math.ceil(this.limit * 0.75)));
      this.ref = 0;
      this.mode = 'hold';
      this.walkDown = false;
      this.holdUntil = t + (hard ? 5000 : 1500);
      this._set(this.good);
    }
  }

  function retryAfterMs(value) {
    if (value == null || value === '') return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(15000, Math.max(0, seconds * 1000));
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.min(15000, Math.max(0, date - Date.now())) : 0;
  }

  function parseContentRange(value) {
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = m[3] === '*' ? null : Number(m[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total };
  }

  function parseUnsatisfiedRange(value) {
    const m = /^bytes\s+\*\/(\d+)$/i.exec(String(value || '').trim());
    if (!m) return null;
    const total = Number(m[1]);
    return Number.isSafeInteger(total) ? total : null;
  }

  async function request(env, url, init, o) {
    const retries = o.retries == null ? 4 : o.retries;
    const stallMs = o.stall || env.stallMs || 20000;
    const connectMs = o.connect || env.connectMs || 30000;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      throwIfAborted(env, o.signal);
      const ctrl = new AbortController();
      let timedOut = false;
      let timer = 0;
      const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms); };
      const onAbort = () => ctrl.abort();
      const signals = [env.signal, o.signal].filter(Boolean);
      for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
      arm(connectMs);
      try {
        const res = await env.fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
        if (!res.ok && !(o.allowStatus && o.allowStatus.includes(res.status))) {
          try { if (res.body) res.body.cancel().catch(() => {}); } catch {}
          throw new DownloadError('http', 'HTTP ' + res.status, { status: res.status, retryAfter: retryAfterMs(res.headers && res.headers.get && res.headers.get('retry-after')) });
        }
        arm(stallMs);
        return await o.read(res, () => arm(stallMs));
      } catch (e) {
        try { ctrl.abort(); } catch {}
        if (o.rollback) o.rollback();
        if (isAborted(env, o.signal)) throw aborted();
        lastErr = timedOut && !(e instanceof DownloadError) ? new DownloadError('timeout', 'No data received for ' + Math.round(stallMs / 1000) + ' s') : e;
        const st = lastErr.status;
        if (st && st >= 400 && st < 500 && st !== 408 && st !== 429 && attempt >= 1) break;
        if (attempt < retries) {
          if (o.onRetry && (!st || st === 408 || st === 429 || st >= 500)) o.onRetry(lastErr);
          await sleep(lastErr.retryAfter || Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250, env, o.signal);
        }
      } finally {
        clearTimeout(timer);
        for (const s of signals) s.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr instanceof DownloadError ? lastErr : new DownloadError('network', String((lastErr && lastErr.message) || lastErr));
  }

  const MAX_PREALLOC = 128 * 1024 * 1024;

  async function readBody(res, touch, onBytes) {
    if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); if (onBytes) onBytes(b.length); return b; }
    const reader = res.body.getReader();
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    let buf = len > 0 && len <= MAX_PREALLOC && !res.headers.get('content-encoding') ? new Uint8Array(len) : null;
    let parts = null;
    let n = 0;
    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { complete = true; break; }
        touch();
        if (onBytes) onBytes(value.length);
        if (buf && n + value.length <= buf.length) buf.set(value, n);
        else {
          if (buf) { parts = [buf.subarray(0, n)]; buf = null; }
          (parts || (parts = [])).push(value);
        }
        n += value.length;
      }
      if (buf) return n === buf.length ? buf : buf.subarray(0, n);
      if (!parts) return new Uint8Array(0);
      if (parts.length === 1) return parts[0];
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    } finally {
      if (!complete) try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }

  const STREAM_WRITE_BATCH = 256 * 1024;
  async function streamBody(res, touch, onBytes, write) {
    if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); write(b); if (onBytes) onBytes(b.length); return b.length; }
    const reader = res.body.getReader();
    let n = 0;
    let used = 0;
    let pending = null;
    let complete = false;
    const flush = () => {
      if (!used) return;
      write(pending.subarray(0, used));
      used = 0;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { complete = true; flush(); return n; }
        touch();
        if (onBytes) onBytes(value.length);
        if (!used && value.length >= STREAM_WRITE_BATCH) write(value);
        else {
          if (!pending) pending = new Uint8Array(STREAM_WRITE_BATCH);
          let offset = 0;
          while (offset < value.length) {
            const count = Math.min(STREAM_WRITE_BATCH - used, value.length - offset);
            pending.set(value.subarray(offset, offset + count), used);
            used += count;
            offset += count;
            if (used === STREAM_WRITE_BATCH) flush();
          }
        }
        n += value.length;
      }
    } finally {
      if (!complete) try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }

  const readText = (res) => res.text();
  const readSmall = (res, touch) => readBody(res, touch);

  function createProgress(env) {
    const p = { bytes: 0, done: 0, total: 0, samples: [], last: 0 };
    p.report = (force) => {
      const now = Date.now();
      if (!force && now - p.last < 250) return;
      p.last = now;
      p.samples.push([now, p.bytes]);
      while (p.samples.length > 2 && now - p.samples[0][0] > 3000) p.samples.shift();
      const [t0, b0] = p.samples[0];
      const speed = now > t0 ? ((p.bytes - b0) * 1000) / (now - t0) : 0;
      env.onProgress({ bytes: p.bytes, done: p.done, total: p.total, speed });
    };
    p.net = (n) => { p.bytes += n; p.report(false); };
    return p;
  }

  const BUF_CAP = 48 * 1024 * 1024;
  async function schedule(env, gov, total, work, consume, o) {
    const ordered = !!consume;
    const extra = o && o.extra != null ? o.extra : 2;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    const ext = o && o.signal;
    if (env.signal) env.signal.addEventListener('abort', onAbort, { once: true });
    if (ext) ext.addEventListener('abort', onAbort, { once: true });
    const results = new Map();
    const running = new Set();
    let next = 0; let inflight = 0; let head = 0; let buffered = 0; let finished = 0; let failure = null; let wake = null;
    const poke = () => { if (wake) { const w = wake; wake = null; w(); } };

    function pump() {
      while (!failure && next < total && inflight < gov.limit &&
        (!ordered || next === head || (next - head < gov.max + extra && buffered < BUF_CAP))) {
        const i = next++;
        inflight++; gov.inflight = inflight;
        const p = work(i, ctrl.signal).then((data) => {
          if (ordered) { results.set(i, data); buffered += data ? data.length : 0; } else finished++;
        }, (e) => {
          if (!failure) { failure = e; ctrl.abort(); }
        }).then(() => {
          running.delete(p); inflight--; gov.inflight = inflight; poke(); pump();
        });
        running.add(p);
      }
    }
    gov.onLimit = pump;
    try {
      pump();
      if (ordered) {
        for (let i = 0; i < total; i++) {
          while (!results.has(i)) { if (failure) throw failure; await new Promise((r) => { wake = r; }); }
          const data = results.get(i);
          results.delete(i);
          buffered -= data ? data.length : 0;
          head = i + 1;
          pump();
          await consume(i, data);
        }
      } else {
        while (finished < total) { if (failure) throw failure; await new Promise((r) => { wake = r; }); }
      }
      if (failure) throw failure;
    } finally {
      gov.onLimit = null;
      if (failure || (env.signal && env.signal.aborted) || next < total || inflight) ctrl.abort();
      await Promise.allSettled([...running]);
      gov.inflight = 0;
      if (env.signal) env.signal.removeEventListener('abort', onAbort);
      if (ext) ext.removeEventListener('abort', onAbort);
    }
  }

  function takePreloaded(env, url) {
    const p = env.preload && env.preload[url];
    if (p) delete env.preload[url];
    return p || null;
  }

  async function loadPlaylist(env, url) {
    const pre = takePreloaded(env, url);
    if (pre && (pre.type === 'master' || pre.type === 'media')) return pre;
    const text = await request(env, url, {}, { read: readText });
    return m3u8.parse(text, url);
  }

  function assertNotDrm(segments) {
    for (const s of segments) {
      if (s.key && m3u8.isDrmKey(s.key)) {
        throw new DownloadError('drm', 'Stream is DRM-protected or uses unsupported encryption (' + s.key.method + ' / ' + s.key.keyFormat + ')');
      }
    }
  }

  function makeFetcher(env, gov, prog) {
    const keyCache = new Map();

    const getKey = (uri) => {
      let p = keyCache.get(uri);
      if (!p) {
        p = request(env, uri, {}, { read: readSmall }).then((raw) => {
          if (raw.length !== 16) throw new DownloadError('drm', 'Unsupported key format (' + raw.length + ' bytes)');
          return env.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
        });
        p.catch(() => keyCache.delete(uri));
        keyCache.set(uri, p);
      }
      return p;
    };

    async function decrypt(data, key, seq) {
      try {
        const k = await getKey(key.uri);
        return new Uint8Array(await env.subtle.decrypt({ name: 'AES-CBC', iv: m3u8.computeIV(key, seq) }, k, data));
      } catch (e) {
        if (e instanceof DownloadError) throw e;
        throw new DownloadError('decrypt', 'Segment decryption failed');
      }
    }

    const warm = (key) => { if (key && key.method === 'AES-128') getKey(key.uri).catch(() => {}); };

    const fetchPart = async function (uri, range, key, seq, signal) {
      const init = range ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } } : {};
      const r = await request(env, uri, init, {
        signal, onRetry: (e) => gov.fail(e),
        read: async (res, touch) => ({ buf: await readBody(res, touch, (n) => { prog.net(n); gov.add(n); }), status: res.status, contentRange: res.headers.get('content-range') }),
      });
      let data = r.buf;
      if (range) {
        if (r.status === 200) {
          const end = range.offset + range.length;
          if (!Number.isSafeInteger(end) || data.length < end) throw new DownloadError('network', 'Range response is shorter than requested');
          data = data.subarray(range.offset, end);
        } else if (r.status === 206) {
          const cr = parseContentRange(r.contentRange);
          if (!cr || cr.start !== range.offset || cr.end !== range.offset + range.length - 1 || data.length !== range.length) throw new DownloadError('network', 'Invalid Content-Range response');
        } else throw new DownloadError('network', 'Server returned an invalid Range response');
      }
      if (key && key.method === 'AES-128') data = await decrypt(data, key, seq);
      return data;
    };
    fetchPart.warm = warm;
    return fetchPart;
  }

  async function runTrack(env, gov, mediaPl, sink, role, prog) {
    const segs = mediaPl.segments;
    assertNotDrm(segs);
    const fetchPart = makeFetcher(env, gov, prog);
    fetchPart.warm(segs[0].key);
    const seg0 = segs[0];
    const initP = seg0.map ? fetchPart(seg0.map.uri, seg0.map.range, seg0.key, seg0.seq, undefined) : null;
    if (initP) initP.catch(() => {});

    let mode = null; let tx = null;
    async function decideMode(first, seg) {
      if (seg.map) {
        await sink.write(await (seg === seg0 && initP ? initP : fetchPart(seg.map.uri, seg.map.range, seg.key, seg.seq, undefined)));
        return 'fmp4';
      }
      if (first[0] === 0x47) {
        try {
          const Tx = await env.loadTransmuxer();
          const t = new Tx();
          const chunks = t.push(first);
          if (!t.initialized) throw new Error('no init');
          tx = t;
          for (const c of chunks) await sink.write(c);
          return 'ts-mux';
        } catch (e) {
          if (isAborted(env)) throw aborted();
          return 'ts-raw';
        }
      }
      if (first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3) return 'webm';
      const head = String.fromCharCode(...first.subarray(4, 8));
      if (head === 'ftyp' || head === 'moof' || head === 'styp') return 'fmp4';
      if ((first[0] === 0xff && (first[1] & 0xf0) === 0xf0) || String.fromCharCode(...first.subarray(0, 3)) === 'ID3') return 'aac';
      throw new DownloadError('unsupported', 'Unknown segment format');
    }

    await schedule(env, gov, segs.length,
      (i, signal) => fetchPart(segs[i].uri, segs[i].range, segs[i].key, segs[i].seq, signal),
      async (i, data) => {
        if (!mode) {
          mode = await decideMode(data, segs[i]);
          if (mode === 'ts-mux') { prog.done++; prog.report(true); return; }
        }
        if (mode === 'ts-mux') for (const c of tx.push(data)) await sink.write(c);
        else await sink.write(data);
        prog.done++;
        prog.report(false);
        throwIfAborted(env);
      });
    if (tx) for (const c of tx.flush()) await sink.write(c);
    const ext = mode === 'ts-raw' ? 'ts' : mode === 'aac' ? 'aac' : (mode === 'webm' || mediaPl.webm) ? 'webm' : (role === 'audio' ? 'm4a' : 'mp4');
    return { ext, mode };
  }

  async function runHls(job, env) {
    env.preload = job.preload || null;
    const prog = createProgress(env);
    const gov = new Governor(job.concurrency, env.clock);
    let pl = await loadPlaylist(env, job.url);
    let audioUri = job.audioUri || null;
    if (pl.type === 'master') {
      const v = (job.variantUri && pl.variants.find((x) => x.uri === job.variantUri)) || m3u8.pickVariant(pl.variants, job.quality);
      if (!v) throw new DownloadError('empty', 'No variants in master playlist');
      if (!audioUri && v.audio && job.withAudio !== false) {
        const a = pl.media.filter((m) => m.type === 'AUDIO' && m.groupId === v.audio && m.uri);
        const pick = a.find((m) => m.isDefault) || a[0];
        if (pick) audioUri = pick.uri;
      }
      const [vp, ap] = await Promise.all([loadPlaylist(env, v.uri), audioUri ? loadPlaylist(env, audioUri) : null]);
      pl = vp;
      return finishHls(env, gov, prog, pl, ap);
    }
    return finishHls(env, gov, prog, pl, null);
  }

  async function finishHls(env, gov, prog, pl, apl) {
    if (pl.type !== 'media') throw new DownloadError('unsupported', 'Unexpected playlist type');
    if (!pl.endList) throw new DownloadError('live', 'Live streams are not supported');
    if (!pl.segments.length) throw new DownloadError('empty', 'Playlist has no segments');
    if (apl && (apl.type !== 'media' || !apl.segments.length)) apl = null;
    prog.total = pl.segments.length + (apl ? apl.segments.length : 0);
    return { files: await runTracks(env, gov, pl, apl, prog) };
  }

  async function runTracks(env, gov, mainPl, audioPl, prog) {
    const canMerge = audioPl && !mainPl.webm && !audioPl.webm && mainPl.segments[0].map && audioPl.segments[0].map;
    if (!canMerge || env.canMerge === false) return runSeparate(env, gov, mainPl, audioPl, prog);
    const merged = await runMerged(env, gov, mainPl, audioPl, prog);
    if (merged) { prog.report(true); return [merged]; }
    return runSeparate(env, gov, mainPl, audioPl, prog);
  }

  const NO_MERGE = new Error('merge unavailable');

  async function runMerged(env, gov, mainPl, audioPl, prog) {
    const vs = mainPl.segments;
    const as = audioPl.segments;
    assertNotDrm(vs);
    assertNotDrm(as);
    const fetchPart = makeFetcher(env, gov, prog);
    fetchPart.warm(vs[0].key);
    fetchPart.warm(as[0].key);
    const initP = Promise.all([
      fetchPart(vs[0].map.uri, vs[0].map.range, vs[0].key, vs[0].seq),
      fetchPart(as[0].map.uri, as[0].map.range, as[0].key, as[0].seq),
    ]).then(([v, a]) => getF().mergeInit(v, a));
    initP.catch(() => {});
    const order = [];
    for (let i = 0, j = 0; i < vs.length || j < as.length;) {
      if (j >= as.length || (i < vs.length && i * as.length <= j * vs.length)) order.push(i++);
      else order.push(-(j++) - 1);
    }
    const sink = await env.openSink('main');
    let started = false;
    try {
      await schedule(env, gov, order.length,
        (k, signal) => {
          const o = order[k];
          const s = o >= 0 ? vs[o] : as[-o - 1];
          return fetchPart(s.uri, s.range, s.key, s.seq, signal);
        },
        async (k, data) => {
          if (!started) {
            const init = await initP;
            if (!init) throw NO_MERGE;
            await sink.write(init);
            started = true;
          }
          for (const part of getF().cleanFragment(data, order[k] >= 0 ? 1 : 2)) await sink.write(part);
          prog.done++;
          prog.report(false);
          throwIfAborted(env);
        }, { extra: gov.max + 2 });
      return { role: 'main', name: sink.name, ext: 'mp4', size: await sink.close() };
    } catch (e) {
      await sink.abort();
      if (e === NO_MERGE) return null;
      throw e;
    }
  }

  async function runSeparate(env, gov, mainPl, audioPl, prog) {
    const files = [];
    for (const [role, p] of [['main', mainPl], ['audio', audioPl]]) {
      if (!p) continue;
      const sink = await env.openSink(role);
      try {
        const r = await runTrack(env, gov, p, sink, role, prog);
        files.push({ role, name: sink.name, ext: r.ext, size: await sink.close() });
      } catch (e) {
        await sink.abort();
        for (const f of files) if (env.discard) await env.discard(f.name);
        throw e;
      }
    }
    prog.report(true);
    return files;
  }

  function pickAudio(list, lang) {
    if (!list.length) return null;
    const l = String(lang || '').toLowerCase().split('-')[0];
    return (l && list.find((r) => String(r.lang).toLowerCase().split('-')[0] === l)) || list[0];
  }

  async function runDash(job, env) {
    env.preload = job.preload || null;
    const prog = createProgress(env);
    const gov = new Governor(job.concurrency, env.clock);
    const pre = takePreloaded(env, job.url);
    const mpd = pre && Array.isArray(pre.video) ? pre : getMpd().parse(await request(env, job.url, {}, { read: readText }), job.url);
    if (mpd.type === 'dynamic') throw new DownloadError('live', 'Live streams are not supported');
    if (mpd.drm) throw new DownloadError('drm', 'DASH stream is DRM-protected (ContentProtection)');
    const video = (job.variantId && mpd.video.find((r) => r.id === job.variantId)) || m3u8.pickVariant(mpd.video, job.quality);
    const audio = job.withAudio === false ? null : pickAudio(mpd.audio, job.audioLang);
    if (!video && !audio) throw new DownloadError('empty', 'No downloadable representations');
    const main = getMpd().toPlaylist(video || audio);
    const apl = video && audio ? getMpd().toPlaylist(audio) : null;
    prog.total = main.segments.length + (apl ? apl.segments.length : 0);
    return { files: await runTracks(env, gov, main, apl, prog) };
  }

  const MB = 1024 * 1024;
  async function runFile(job, env) {
    const prog = createProgress(env);
    const gov = new Governor(job.concurrency, env.clock);
    const PROBE = 4 * MB;
    const sink = await env.openSink('main');
    const restCtrl = new AbortController();
    let rest = null;
    let restFrom = 0;
    try {
      const onBytes = (n) => { prog.net(n); gov.add(n); };
      let written = 0;

      const startRest = (total, startAt) => {
        if (rest) return;
        restFrom = startAt;
        const CH = total > 2048 * MB ? 16 * MB : total > 512 * MB ? 8 * MB : 4 * MB;
        const n = Math.ceil((total - startAt) / CH);
        rest = schedule(env, gov, n, (i, signal) => {
          const start = startAt + i * CH;
          const end = Math.min(total, start + CH) - 1;
          let got = 0;
          return request(env, job.url, { headers: { Range: `bytes=${start}-${end}` } }, {
            signal, onRetry: (e) => gov.fail(e),
            rollback: () => { prog.done -= got; got = 0; },
            read: async (res, touch) => {
              if (res.status !== 206) throw new DownloadError('network', 'Server stopped honouring Range (HTTP ' + res.status + ')');
              const cr = parseContentRange(res.headers.get('content-range'));
              if (!cr || cr.start !== start || cr.end !== end || (cr.total !== null && cr.total !== total)) throw new DownloadError('network', 'Invalid Content-Range response');
              let at = start;
              const len = await streamBody(res, touch, onBytes, (u8) => { sink.writeAt(u8, at); at += u8.length; got += u8.length; prog.done += u8.length; });
              if (len !== end - start + 1) throw new DownloadError('network', 'Bad range response');
            },
          });
        }, null, { signal: restCtrl.signal });
        rest.catch(() => {});
      };

      const first = await request(env, job.url, { headers: { Range: `bytes=0-${PROBE - 1}` } }, {
        connect: 60000, onRetry: (e) => gov.fail(e),
        rollback: () => { prog.done -= written; written = 0; },
        read: async (res, touch) => {
          if (res.status === 206) {
            const cr = parseContentRange(res.headers.get('content-range'));
            if (!cr || cr.start !== 0) throw new DownloadError('network', 'Invalid Content-Range response');
            const total = cr.total || 0;
            if (total) prog.total = total;
            if (total) startRest(total, cr.end + 1);
            if (!rest) sink.truncate();
            let at = 0;
            written = await streamBody(res, touch, onBytes, (u8) => { sink.writeAt(u8, at); at += u8.length; prog.done += u8.length; });
            if (written !== cr.end + 1) throw new DownloadError('network', 'Bad initial range response');
            return { ranged: true, total, len: written, rangeEnd: cr.end };
          }
          if (rest) throw new DownloadError('network', 'Server stopped honouring Range (HTTP ' + res.status + ')');
          prog.total = parseInt(res.headers.get('content-length') || '0', 10);
          sink.truncate();
          written = await streamBody(res, touch, onBytes, (u8) => { sink.write(u8); prog.done += u8.length; });
          if (prog.total && written !== prog.total) throw new DownloadError('network', 'Incomplete response: ' + written + ' of ' + prog.total + ' bytes');
          return { ranged: false, total: written, len: written };
        },
      });

      let size;
      if (!first.ranged) size = first.total;
      else if (first.total) {
        if (!rest) startRest(first.total, first.len);
        else if (restFrom !== first.len) throw new DownloadError('network', 'Bad range response');
        await rest;
        size = first.total;
      } else {
        let off = first.rangeEnd + 1;
        for (let more = first.len > 0; more;) {
          throwIfAborted(env);
          let got = 0;
          const requestedEnd = off + PROBE - 1;
          const r = await request(env, job.url, { headers: { Range: `bytes=${off}-${requestedEnd}` } }, {
            allowStatus: [416], onRetry: (e) => gov.fail(e), rollback: () => { prog.done -= got; got = 0; },
            read: async (res, touch) => {
              if (res.status === 416) {
                try { if (res.body) await res.body.cancel(); } catch {}
                const total = parseUnsatisfiedRange(res.headers.get('content-range'));
                if (total === null || total !== off) throw new DownloadError('network', 'Unexpected end-of-file range');
                return { len: 0, eof: true };
              }
              if (res.status !== 206) throw new DownloadError('network', 'Server stopped honouring Range');
              const cr = parseContentRange(res.headers.get('content-range'));
              if (!cr || cr.start !== off || cr.end > requestedEnd) throw new DownloadError('network', 'Invalid Content-Range response');
              if (cr.total !== null) prog.total = cr.total;
              let at = off;
              const len = await streamBody(res, touch, onBytes, (u8) => { sink.writeAt(u8, at); at += u8.length; got += u8.length; prog.done += u8.length; });
              if (len !== cr.end - cr.start + 1) throw new DownloadError('network', 'Bad range response');
              return { len, eof: cr.total !== null && cr.end + 1 >= cr.total };
            },
          });
          off += r.len;
          more = !r.eof && r.len > 0;
        }
        size = off;
      }
      const closed = await sink.close();
      if (closed !== size) throw new DownloadError('network', 'Incomplete download: ' + closed + ' of ' + size + ' bytes');
      prog.total = prog.total || size;
      prog.done = size;
      prog.report(true);
      return { files: [{ role: 'main', name: sink.name, ext: job.ext || 'mp4', size: closed }] };
    } catch (e) {
      restCtrl.abort();
      if (rest) await rest.catch(() => {});
      await sink.abort();
      throw e;
    }
  }


  function run(job, env) {
    if (job.kind === 'hls') return runHls(job, env);
    if (job.kind === 'dash') return runDash(job, env);
    if (job.kind === 'file') return runFile(job, env);
    throw new DownloadError('unsupported', 'Unknown job kind');
  }

  const api = { run, DownloadError, Governor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).engine = api;
})(typeof self !== 'undefined' ? self : globalThis);
