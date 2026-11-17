'use strict';
importScripts('../lib/m3u8.js', 'core.js');

let ctrl = null;

async function createSink(name) {
  let root = null;
  try { root = await navigator.storage.getDirectory(); } catch {}
  if (!root || typeof FileSystemFileHandle === 'undefined' || !FileSystemFileHandle.prototype.createSyncAccessHandle) return createMemorySink(name);
  const fh = await root.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  h.truncate(0);
  let pos = 0;
  const writeAll = (u8, at) => {
    let n = h.write(u8, { at });
    if (n === u8.length) return;
    let w = n;
    while (w < u8.length) {
      n = h.write(u8.subarray(w), { at: at + w });
      if (!n) throw new Error('OPFS write failed (disk full?)');
      w += n;
    }
  };
  return {
    name,
    write(u8) { writeAll(u8, pos); pos += u8.length; },
    writeAt(u8, at) { writeAll(u8, at); pos = Math.max(pos, at + u8.length); },
    readAt(buf, at) { h.read(buf, { at }); },
    truncate() { h.truncate(0); pos = 0; },
    async close() { h.flush(); h.close(); return pos; },
    async abort() { try { h.close(); } catch {} try { await root.removeEntry(name); } catch {} },
  };
}

function createMemorySink(name) {
  const parts = [];
  let size = 0;
  return {
    name,
    memory: true,
    write(u8) { parts.push(u8.slice()); size += u8.length; },
    writeAt(u8, at) { parts.push({ at, data: u8.slice() }); size = Math.max(size, at + u8.length); },
    truncate() { parts.length = 0; size = 0; },
    async close() {
      const sparse = parts.some((p) => p && p.at !== undefined);
      if (sparse) {
        const all = new Uint8Array(size);
        let seq = 0;
        for (const p of parts) { if (p.at !== undefined) all.set(p.data, p.at); else { all.set(p, seq); seq += p.length; } }
        self.__memBlobs[name] = new Blob([all]);
      } else self.__memBlobs[name] = new Blob(parts);
      return size;
    },
    async abort() { parts.length = 0; },
  };
}
self.__memBlobs = {};

onmessage = async (ev) => {
  const m = ev.data;
  if (m.cmd === 'cancel') { if (ctrl) ctrl.abort(); return; }
  if (m.cmd !== 'start') return;
  const job = m.job;
  ctrl = new AbortController();
  const env = {
    canMerge: !!(navigator.storage && typeof FileSystemFileHandle !== 'undefined' && FileSystemFileHandle.prototype.createSyncAccessHandle),
    signal: ctrl.signal,
    subtle: self.crypto.subtle,
    fetch: (url, init) => fetch(url, Object.assign({}, init, {
      credentials: 'include', cache: 'no-store', headers: Object.assign({}, init && init.headers, { 'X-VDL-Job': job.token }),
    })),
    openSink: (role) => createSink(`vdl-${job.fileId || job.id}-${role}.part`),
    discard: async (name) => { try { await (await navigator.storage.getDirectory()).removeEntry(name); } catch {} },
    loadTransmuxer: async () => {
      if (!self.VDL.ts2mp4) importScripts('../lib/ts2mp4.js');
      return self.VDL.ts2mp4.Transmuxer;
    },
    onProgress: (p) => postMessage({ type: 'progress', p }),
  };
  try {
    const res = await self.VDL.engine.run(job, env);
    for (const f of res.files) if (self.__memBlobs[f.name]) f.blob = self.__memBlobs[f.name];
    postMessage({ type: 'done', files: res.files });
  } catch (e) {
    postMessage({ type: 'error', code: e.code || 'error', message: String((e && e.message) || e), status: e.status });
  }
};
