'use strict';
const { classify: C, m3u8: M, mpd: D, filename: FN, settings: S } = VDL;

const MAX_CANDS_PER_TAB = 80;
const SWITCH_KEEP_MS = 20000;
const STALE_OPFS_MS = 30 * 60 * 1000;

const tabs = new Map();
const ctxs = new Map();
const jobs = new Map();
let jobSeq = 0;
let keepAlive = null;

const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[vdl] ' + name + ' unavailable:', e && e.message); } };

let settingsCache = null;
function getSettings() {
  if (!settingsCache) {
    const pending = browser.storage.local.get(null).then(S.normalize);
    settingsCache = pending;
    pending.catch(() => { if (settingsCache === pending) settingsCache = null; });
  }
  return settingsCache;
}
safe('storage.onChanged', () => {
  browser.storage.onChanged.addListener((_c, area) => { if (area === 'local') settingsCache = null; });
});

const SESSION = (browser.storage && browser.storage.session) || null;
let persistTimer = 0;
function persistNow() {
  persistTimer = 0;
  if (!SESSION) return;
  const o = {};
  for (const [id, st] of tabs) if (st.cands.size) o['t' + id] = [...st.cands.values()].map((c) => [c.url, c.kind, c.frameId, c.ts, c.size || 0, c.ct || '']);
  SESSION.set({ vdlTabs: o }).catch(() => {});
}
function persistSoon() { if (SESSION && !persistTimer) persistTimer = setTimeout(persistNow, 400); }
const restored = SESSION
  ? SESSION.get('vdlTabs').then((r) => {
    for (const [k, rows] of Object.entries((r && r.vdlTabs) || {})) {
      const st = tabState(+k.slice(1));
      for (const [url, kind, frameId, ts, size, ct] of rows) if (!st.cands.has(url.replace(/#.*$/, ''))) st.cands.set(url.replace(/#.*$/, ''), { url, kind, frameId, ts, size, ct });
    }
  }).catch(() => {})
  : Promise.resolve();

function tabState(id) {
  let t = tabs.get(id);
  if (!t) { t = { cands: new Map() }; tabs.set(id, t); }
  return t;
}

function addCandidate(tabId, c) {
  const st = tabState(tabId);
  const key = c.url.replace(/#.*$/, '');
  const old = st.cands.get(key);
  if (old) {
    old.ts = Math.max(old.ts, c.ts);
    if (c.size) old.size = Math.max(old.size || 0, c.size);
    return;
  }
  st.cands.set(key, c);
  if (st.cands.size > MAX_CANDS_PER_TAB) st.cands.delete(st.cands.keys().next().value);
  persistSoon();
}

function prune(tabId, frameId, maxAgeMs) {
  const st = tabs.get(tabId);
  if (!st) return;
  const limit = Date.now() - maxAgeMs;
  let removed = false;
  for (const [k, c] of st.cands) if (c.ts < limit && (frameId === undefined || c.frameId === frameId)) { st.cands.delete(k); removed = true; }
  if (removed) persistSoon();
}

function onHeaders(d) {
  if (d.tabId < 0 || d.statusCode >= 400 || d.statusCode === 204) return;
  let ct = ''; let len = 0; let total = 0;
  for (const h of d.responseHeaders || []) {
    const l = h.name.length;
    if (l !== 12 && l !== 13 && l !== 14) continue;
    const n = h.name.toLowerCase();
    if (n === 'content-type') ct = h.value || '';
    else if (n === 'content-length') len = parseInt(h.value, 10) || 0;
    else if (n === 'content-range') total = parseInt(/\/(\d+)/.exec(h.value || '')?.[1], 10) || 0;
  }
  const kind = C.classify(d.url, ct);
  if (!kind || C.isAd(d.url)) return;
  addCandidate(d.tabId, { url: d.url, kind, frameId: d.frameId, ts: Date.now(), size: total || len, ct });
}

const MEDIA_URL_PATTERNS = ['*://*/*.m3u8*', '*://*/*.mpd*', '*://*/*.mp4*', '*://*/*.webm*', '*://*/*.mkv*', '*://*/*.m4v*'];
safe('onHeadersReceived', () => {
  browser.webRequest.onHeadersReceived.addListener((d) => onHeaders(d), { urls: MEDIA_URL_PATTERNS, types: ['xmlhttprequest', 'other'] }, ['responseHeaders']);
});
safe('onHeadersReceived(media)', () => {
  browser.webRequest.onHeadersReceived.addListener(onHeaders, { urls: ['<all_urls>'], types: ['media'] }, ['responseHeaders']);
});

safe('onBeforeRequest', () => {
  browser.webRequest.onBeforeRequest.addListener((d) => { if (tabs.delete(d.tabId)) persistSoon(); }, { urls: ['<all_urls>'], types: ['main_frame'] });
});
safe('tabs.onRemoved', () => {
  browser.tabs.onRemoved.addListener((id) => {
    if (tabs.delete(id)) persistSoon();
    for (const k of ctxs.keys()) if (k.startsWith(`r:${id}:`)) ctxs.delete(k);
  });
});
safe('tabs.onUpdated', () => {
  const cb = (id, change) => { if (change.url) prune(id, undefined, SWITCH_KEEP_MS); };
  try { browser.tabs.onUpdated.addListener(cb, { properties: ['url'] }); } catch { browser.tabs.onUpdated.addListener(cb); }
});

safe('onBeforeSendHeaders', () => {
  browser.webRequest.onBeforeSendHeaders.addListener((d) => {
    const hs = d.requestHeaders;
    let token = null;
    for (let i = 0; i < hs.length; i++) {
      if (hs[i].name.toLowerCase() === 'x-vdl-job') { token = hs[i].value; hs.splice(i, 1); break; }
    }
    if (token === null) return undefined;
    const ctx = ctxs.get(token);
    if (ctx) {
      setHeader(hs, 'Referer', ctx.referer);
      if (ctx.origin && ctx.origin !== 'null') setHeader(hs, 'Origin', ctx.origin);
    }
    return { requestHeaders: hs };
  }, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'], tabId: -1 }, ['blocking', 'requestHeaders']);
});

function setHeader(hs, name, value) {
  const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (h) h.value = value; else hs.push({ name, value });
}

function ctxFor(token, frameUrl) {
  let origin = 'null';
  try { origin = new URL(frameUrl).origin; } catch {}
  ctxs.set(token, { referer: frameUrl, origin });
}

async function bgFetchText(url, token) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { 'X-VDL-Job': token } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function loadPlaylist(url, token) {
  return M.parse(await bgFetchText(url, token), url);
}

const analysisCache = new Map();
const ANALYSIS_TTL = 10 * 60 * 1000;
function analyzeCached(c, token, quality) {
  const ck = c.url + '|' + quality;
  const hit = analysisCache.get(ck);
  if (hit && Date.now() - hit.ts < ANALYSIS_TTL) return hit.p;
  const ts = Date.now();
  const p = (c.kind === 'dash' ? analyzeDash(c, token) : analyzeHls(c, token, quality)).then((e) => Object.assign(e, { fetchedAt: ts }));
  analysisCache.set(ck, { ts, p });
  p.catch(() => analysisCache.delete(ck));
  if (analysisCache.size > 24) analysisCache.delete(analysisCache.keys().next().value);
  return p;
}

async function analyzeDash(c, token) {
  const mpd = D.parse(await bgFetchText(c.url, token), c.url);
  return { mpd, duration: mpd.duration, live: mpd.type === 'dynamic', drm: mpd.drm, pre: { [c.url]: mpd } };
}

async function analyzeHls(c, token, quality) {
  const pl = await loadPlaylist(c.url, token);
  let media = pl;
  const pre = { [c.url]: pl };
  if (pl.type === 'master') {
    const best = M.pickVariant(pl.variants, quality || 'best');
    if (!best) throw new Error('empty master');
    media = await loadPlaylist(best.uri, token);
    pre[best.uri] = media;
  }
  const drm = media.segments.some((s) => s.key && M.isDrmKey(s.key));
  return { master: pl.type === 'master' ? pl : null, duration: media.duration, live: !media.endList, drm, pre };
}

async function resolveFull(tabId, frameId, frameUrl, info) {
  await restored;
  const quality = (await getSettings()).quality;
  const st = tabState(tabId);
  const token = `r:${tabId}:${frameId}`;
  ctxFor(token, frameUrl);
  const now = Date.now();

  for (const { u, t } of info.pageCands || []) {
    const kind = C.classify(u);
    if (kind && !C.isAd(u)) addCandidate(tabId, { url: u, kind, frameId, ts: t || now, size: 0 });
  }
  const src = info.src && /^https?:/.test(info.src) && !C.isAd(info.src) ? info.src : null;
  if (src) addCandidate(tabId, { url: src, kind: C.classify(src) || 'file', frameId, ts: now, size: 0 });

  const all = [...st.cands.values()];
  const ranked = all
    .filter((c) => (c.kind === 'hls' || c.kind === 'dash' || c.kind === 'file') && C.sizeOk(c))
    .map((c) => ({ c, s: C.score(c, { frameId, now }) + (src && c.url === src ? 100 : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);

  if (!ranked.length) {
    return { ok: false, reason: info.drm ? 'drm' : 'nostream' };
  }

  const evals = (await Promise.allSettled(ranked.filter((r) => r.c.kind !== 'file').slice(0, 4).map((r) => analyzeCached(r.c, token, quality).then((e) => Object.assign({}, e, { cand: r.c, kind: r.c.kind, s: r.s })))))
    .filter((r) => r.status === 'fulfilled').map((r) => r.value);

  const children = new Set();
  for (const e of evals) if (e.master) { for (const v of e.master.variants) children.add(v.uri); for (const u of e.master.children) children.add(u); }
  const hls = evals.filter((e) => !e.live && !children.has(e.cand.url));
  const files = ranked.filter((r) => r.c.kind === 'file').map((r) => ({ cand: r.c, kind: 'file', duration: 0, s: r.s }));

  const vd = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : 0;
  const fit = (e) => {
    if (e.kind === 'file') return -0.1;
    if (vd) return -Math.abs(e.duration - vd) / vd;
    return e.duration / 10000;
  };
  const pool = hls.concat(files);
  if (!pool.length) return { ok: false, reason: evals.some((e) => e.live) ? 'live' : 'nostream' };
  pool.sort((a, b) => (fit(b) - fit(a)) || (b.s - a.s));
  const top = fit(pool[0]);
  const best = pool.filter((e) => fit(e) >= top - 0.03).sort((a, b) => (b.cand.ts - a.cand.ts))[0];
  const drm = best.drm || !!info.drm;
  if (drm) return { ok: false, reason: 'drm' };

  const variants = best.master ? M.sortVariants(best.master.variants) : best.mpd ? best.mpd.video : [];
  const res = { kind: best.kind, url: best.cand.url, variants, duration: best.duration || vd, frameUrl, ct: best.cand.ct || '', pre: best.pre || null, fetchedAt: best.fetchedAt || 0 };
  return { ok: true, kind: res.kind, res };
}

async function resolve(tabId, frameId, frameUrl, info) {
  const out = await resolveFull(tabId, frameId, frameUrl, info);
  return out.ok ? { ok: true, kind: out.kind } : { ok: false, reason: out.reason };
}

async function getResolved(tabId, frameId, frameUrl, info) {
  const out = await resolveFull(tabId, frameId, frameUrl, info);
  return out.ok ? { r: out.res } : { error: out.reason };
}

function notify(job, msg) {
  browser.tabs.sendMessage(job.tabId, Object.assign({ type: 'vdl:event', jobId: job.id }, msg), { frameId: job.frameId }).catch(() => {});
}

function startKeepAlive() {
  if (!keepAlive) keepAlive = setInterval(() => { browser.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}
function stopKeepAlive() {
  if (keepAlive && !jobs.size) { clearInterval(keepAlive); keepAlive = null; }
}

function extFromUrl(url, ct) {
  const m = /\.(mp4|webm|mkv|m4v|mov)(?:$|[?#])/i.exec(url);
  if (m) return m[1].toLowerCase();
  if (/webm/.test(ct)) return 'webm';
  if (/matroska/.test(ct)) return 'mkv';
  return 'mp4';
}

const PRELOAD_MAX_AGE = 45 * 1000;

async function startJob(sender, req) {
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  const frameUrl = sender.url && /^https?:/.test(sender.url) ? sender.url : sender.tab.url;
  const worker = new Worker(browser.runtime.getURL('src/engine/worker.js'));
  let settings;
  let got;
  let tabInfo;
  try {
    settings = await getSettings();
    [got, tabInfo] = await Promise.all([getResolved(tabId, frameId, frameUrl, req.info || {}), browser.tabs.get(tabId).catch(() => null)]);
  } catch (e) {
    try { worker.terminate(); } catch {}
    throw e;
  }
  if (got.error) { try { worker.terminate(); } catch {} return { ok: false, reason: got.error }; }
  const r = got.r;

  const id = ++jobSeq;
  const token = `j:${id}`;
  const fileId = Date.now().toString(36) + '-' + id;
  ctxFor(token, frameUrl);

  const job = { id, token, fileId, tabId, frameId, worker: null, base: '', files: [], cancelled: false };
  let wjob;
  let quality = '';
  const fresh = r.pre && Date.now() - r.fetchedAt < PRELOAD_MAX_AGE ? r.pre : null;
  if (r.kind === 'dash') {
    const v = r.variants.length ? M.pickVariant(r.variants, settings.quality) : null;
    if (v) quality = M.variantLabel(v);
    wjob = { kind: 'dash', url: r.url, variantId: v && v.id, quality: settings.quality, concurrency: settings.concurrency, preload: fresh };
  } else if (r.kind === 'hls') {
    const v = r.variants.length ? M.pickVariant(r.variants, settings.quality) : null;
    if (v) quality = M.variantLabel(v);
    wjob = { kind: 'hls', url: r.url, variantUri: v && v.uri, quality: settings.quality, concurrency: settings.concurrency, preload: fresh };
  } else {
    wjob = { kind: 'file', url: r.url, ext: extFromUrl(r.url, r.ct), concurrency: settings.concurrency };
    if (req.info && req.info.height) quality = req.info.height + 'p';
  }
  Object.assign(wjob, { id, token, fileId });

  const title = (tabInfo && tabInfo.title) || (req.info && req.info.title) || '';
  let host = '';
  try { host = new URL(sender.tab.url).hostname; } catch {}
  job.base = FN.build(settings.filenameTemplate, { title: title || host, quality, host, date: new Date().toISOString().slice(0, 10) }, '');

  jobs.set(id, job);
  startKeepAlive();
  job.worker = worker;
  worker.onmessage = (ev) => onWorker(job, ev.data, settings);
  worker.onerror = (ev) => finishJob(job, { state: 'error', code: 'error', message: ev.message || 'Worker crashed' });
  worker.postMessage({ cmd: 'start', job: wjob });
  notify(job, { state: 'start' });
  cleanupOpfs().catch(() => {});
  return { ok: true, jobId: id };
}

function finishJob(job, msg) {
  if (!jobs.has(job.id)) return;
  jobs.delete(job.id);
  ctxs.delete(job.token);
  try { job.worker.terminate(); } catch {}
  stopKeepAlive();
  if (msg) notify(job, msg);
  if (msg && msg.state !== 'done') purgeJobFiles(job.fileId);
}

async function purgeJobFiles(fileId, retry = true) {
  try {
    const root = await navigator.storage.getDirectory();
    let busy = false;
    for await (const [name] of root.entries()) {
      if (!name.startsWith(`vdl-${fileId}-`)) continue;
      try { await root.removeEntry(name); } catch { busy = true; }
    }
    if (busy && retry) setTimeout(() => purgeJobFiles(fileId, false), 500);
  } catch {}
}

async function onWorker(job, m, settings) {
  if (m.type === 'progress') { notify(job, { state: 'progress', p: m.p }); return; }
  if (m.type === 'error') {
    finishJob(job, job.cancelled ? { state: 'cancelled' } : { state: 'error', code: m.code, message: m.message, status: m.status });
    return;
  }
  if (m.type !== 'done') return;
  const files = m.files;
  try {
    for (const f of files) {
      const name = FN.sanitize(job.base) + (f.role === 'audio' ? ' (audio)' : '') + '.' + f.ext;
      notify(job, { state: 'saving' });
      await saveFile(job, f, name, settings);
    }
    finishJob(job, { state: 'done', separateAudio: files.some((f) => f.role === 'audio') });
  } catch (e) {
    finishJob(job, { state: 'error', code: 'save', message: String((e && e.message) || e) });
  }
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.cancelled = true;
  job.worker.postMessage({ cmd: 'cancel' });
  setTimeout(() => finishJob(job, { state: 'cancelled' }), 3000);
}

const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(label + ' timed out')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

let osPromise = null;
const getOs = () => osPromise || (osPromise = browser.runtime.getPlatformInfo().then((i) => i.os, () => ''));

async function saveFile(job, f, filename, settings) {
  const os = await getOs();
  if (os === 'android' || !browser.downloads) return sendNativeSave(job, f, filename);
  let root = null;
  let file = f.blob || null;
  if (!file) {
    root = await navigator.storage.getDirectory();
    file = await (await root.getFileHandle(f.name)).getFile();
  }
  const url = URL.createObjectURL(file);
  let keep = false;
  try {
    const id = await withTimeout(browser.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }), 15000, 'downloads.download');
    keep = await waitDownload(id);
  } catch {
    URL.revokeObjectURL(url);
    await sendNativeSave(job, f, filename);
    return;
  }
  if (keep) setTimeout(() => URL.revokeObjectURL(url), 15 * 60 * 1000); else URL.revokeObjectURL(url);
  if (root) { if (keep) setTimeout(() => root.removeEntry(f.name).catch(() => {}), 15 * 60 * 1000); else await root.removeEntry(f.name).catch(() => {}); }
}

function waitDownload(id) {
  return new Promise((resolve, reject) => {
    let silent = 0;
    let timer = 0;
    const finish = (fn, v) => { clearInterval(timer); try { browser.downloads.onChanged.removeListener(onChanged); } catch {} fn(v); };
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') finish(resolve, false);
      else if (d.state.current === 'interrupted') finish(reject, new Error('Download interrupted'));
    };
    try { browser.downloads.onChanged.addListener(onChanged); } catch {}
    timer = setInterval(async () => {
      try {
        const [d] = await browser.downloads.search({ id });
        if (d && d.state === 'complete') return finish(resolve, false);
        if (d && d.state === 'interrupted') return finish(reject, new Error('Download interrupted'));
        if (d && d.state === 'in_progress') silent = 0; else silent++;
      } catch { silent++; }
      if (silent >= 4) finish(reject, new Error('Download state unavailable'));
      return undefined;
    }, 1000);
  });
}

const pendingBlobs = new Map();

async function sendNativeSave(job, f, filename) {
  const payload = { filename };
  let expiryTimer = 0;
  if (f.blob) {
    payload.mem = 'm' + Date.now() + Math.random().toString(36).slice(2);
    pendingBlobs.set(payload.mem, f.blob);
    expiryTimer = setTimeout(() => pendingBlobs.delete(payload.mem), 30 * 60 * 1000);
  } else payload.opfs = f.name;
  try {
    return await browser.tabs.sendMessage(job.tabId, { type: 'vdl:save-file', payload }, { frameId: job.frameId });
  } finally {
    if (payload.mem) {
      pendingBlobs.delete(payload.mem);
      clearTimeout(expiryTimer);
    }
  }
}

let opfsCleanupAt = 0;
let opfsCleanupPromise = null;
function cleanupOpfs() {
  if (opfsCleanupPromise) return opfsCleanupPromise;
  if (Date.now() - opfsCleanupAt < STALE_OPFS_MS) return Promise.resolve();
  opfsCleanupPromise = (async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, h] of root.entries()) {
      if (!name.startsWith('vdl-') || h.kind !== 'file') continue;
      const age = Date.now() - (await h.getFile()).lastModified;
      if (age > STALE_OPFS_MS) await root.removeEntry(name).catch(() => {});
    }
    opfsCleanupAt = Date.now();
  })().catch(() => {}).finally(() => { opfsCleanupPromise = null; });
  return opfsCleanupPromise;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg && msg.type) {
    case 'vdl:init':
      return (async () => {
        const settings = await getSettings();
        let tabHost = '';
        try { tabHost = new URL(sender.tab.url).hostname; } catch {}
        let frameHost = '';
        try { frameHost = new URL(sender.url).hostname; } catch {}
        return {
          settings,
          lang: S.resolveLang(settings.lang, navigator.language),
          disabled: S.isSiteDisabled(settings.disabledSites, tabHost) || S.isSiteDisabled(settings.disabledSites, frameHost),
        };
      })();
    case 'vdl:inject-ui':
      return browser.tabs.executeScript(tabId, { file: '/src/content/ui.js', frameId: sender.frameId, matchAboutBlank: true }).then(() => true);
    case 'vdl:resolve':
      return resolve(tabId, sender.frameId, sender.url && /^https?:/.test(sender.url) ? sender.url : sender.tab.url, msg.info || {})
        .catch((e) => ({ ok: false, reason: 'error', message: String(e.message || e) }));
    case 'vdl:get-save-blob':
      return (async () => {
        const p = msg.payload || {};
        if (p.mem) return pendingBlobs.has(p.mem) ? { blob: pendingBlobs.get(p.mem) } : { error: 'bad file' };
        if (!p.opfs || !/^vdl-[\w-]+\.part$/.test(p.opfs)) return { error: 'bad file' };
        const root = await navigator.storage.getDirectory();
        return { blob: await (await root.getFileHandle(p.opfs)).getFile() };
      })().catch((e) => ({ error: String(e && e.message || e) }));
    case 'vdl:reset':
      prune(tabId, sender.frameId, SWITCH_KEEP_MS);
      return Promise.resolve(true);
    case 'vdl:start':
      return startJob(sender, msg).catch((e) => ({ ok: false, reason: 'error', message: String(e.message || e) }));
    case 'vdl:cancel':
      cancelJob(msg.jobId);
      return Promise.resolve(true);
    default:
      return undefined;
  }
});

safe('browserAction.onClicked', () => browser.browserAction.onClicked.addListener(async (tab) => {
  const os = await getOs();
  if (os === 'android') {
    try {
      const [t] = tab && tab.id ? [tab] : await browser.tabs.query({ active: true, currentWindow: true });
      if (t) await browser.tabs.sendMessage(t.id, { type: 'vdl:force' });
    } catch {}
    return;
  }
  browser.runtime.openOptionsPage();
}));
