(function () {
  'use strict';
  if (window.__vdlUI) return;
  const cs = window.__vdlCS;
  const api = cs.api;

  const STR = {
    en: {
      download: 'Download', preparing: 'Preparing…', saving: 'Saving…', done: 'Done', retry: 'Retry', cancel: 'Cancel',
      drm: 'DRM-protected, cannot download', nostream: 'No downloadable stream found',
      live: 'Live streams are not supported', denied: 'Server denied access', audioSeparate: 'Done (audio saved as a separate file)',
    },
    ru: {
      download: 'Скачать', preparing: 'Подготовка…', saving: 'Сохранение…', done: 'Готово', retry: 'Повторить', cancel: 'Отмена',
      drm: 'Защищено DRM — скачать нельзя', nostream: 'Загружаемый поток не найден',
      live: 'Прямые трансляции не поддерживаются', denied: 'Сервер отказал в доступе', audioSeparate: 'Готово (аудио сохранено отдельным файлом)',
    },
  };
  let T = STR.en;
  const coarse = matchMedia('(pointer: coarse)').matches || /Android/i.test(navigator.userAgent);

  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 4v10m-5-4 5 5 5-5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CSS = `
    :host{all:initial}
    .box{position:absolute;display:flex;opacity:0;pointer-events:none;transition:opacity .15s;font:14px/1.25 system-ui,-apple-system,sans-serif;color:#fff}
    .box.on{opacity:1}
    .grp{display:flex;border-radius:22px;background:rgba(18,18,22,.84);box-shadow:0 2px 10px rgba(0,0,0,.45);overflow:hidden;pointer-events:none;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
    .on .grp{pointer-events:auto}
    button{all:unset;box-sizing:border-box;min-width:36px;min-height:36px;padding:0 12px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;position:relative;white-space:nowrap;-webkit-tap-highlight-color:transparent}
    button:hover,button:focus-visible{background:rgba(255,255,255,.16)}
    @media (pointer:coarse){button{min-width:44px;min-height:44px}}
    .side{padding:0 10px;border-left:1px solid rgba(255,255,255,.18)}
    .side[hidden]{display:none}
    .bar{position:absolute;left:0;bottom:0;height:3px;width:0;background:#4ea1ff}
    .warn .main{color:#ffb4a8}.ok .main{color:#8ee6a0}
    .spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.spin{animation-duration:2s}.box{transition:none}}
  `;

  const controllers = new Set();
  let globalsOn = false;
  let lastMove = 0;

  const fmtSpeed = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : Math.round(b / 1024) + ' KB/s');
  const send = (m) => api.runtime.sendMessage(m);

  function fsTarget(video) {
    const fs = document.fullscreenElement;
    const docEl = document.documentElement;
    if (!fs) return docEl;
    const rn = video.getRootNode();
    if (rn && rn.host && (rn.host === fs || fs.contains(rn.host))) return rn;
    if (fs.contains(video) && !/^(video|iframe|img|input|canvas)$/i.test(fs.localName)) return fs;
    return docEl;
  }

  function drmFlag() {
    const d = cs.drm;
    if (!d.encrypted) return false;
    return !(d.keySystems.size && [...d.keySystems].every((k) => /clearkey/i.test(k)));
  }

  function collectInfo(v) {
    return {
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      src: v.currentSrc || '',
      title: v.title || v.getAttribute('aria-label') || '',
      height: v.videoHeight || 0,
      pageCands: [...cs.seen].map(([u, t]) => ({ u, t })),
      drm: drmFlag(),
    };
  }

  class Controller {
    constructor(video) {
      this.video = video;
      this.state = 'idle';
      this.jobId = 0;
      this.hideTimer = 0;
      this.stateTimer = 0;
      this.placeQueued = false;
      this.placed = '';
      this.pctEl = null;
      this.barEl = null;
      this.lastLabel = '';
      this.lastPct = -1;
      this.warmed = false;
      this.host = document.createElement('div');
      this.host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
      const root = this.host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style><div class="box"><div class="grp"><button class="main" type="button"></button><button class="side" type="button" hidden>✕</button></div></div>`;
      this.box = root.querySelector('.box');
      this.main = root.querySelector('.main');
      this.side = root.querySelector('.side');
      this.side.setAttribute('aria-label', T.cancel);
      this.main.setAttribute('aria-label', T.download);

      this.main.addEventListener('click', (e) => { e.stopPropagation(); this.onMain(); });
      this.side.addEventListener('click', (e) => { e.stopPropagation(); send({ type: 'vdl:cancel', jobId: this.jobId }); });
      for (const t of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'contextmenu']) this.host.addEventListener(t, (e) => e.stopPropagation());

      this.video.addEventListener('playing', () => this.show(3000));
      const onSwitch = () => {
        this.warmed = false;
        const limit = Date.now() - 20000;
        for (const [u, t] of cs.seen) if (t < limit) cs.seen.delete(u);
        send({ type: 'vdl:reset' }).catch(() => {});
        if (this.state === 'warn') this.setState('idle');
      };
      this.video.addEventListener('emptied', onSwitch);
      this.video.addEventListener('loadstart', onSwitch);
      this.reparent();
      this.render();
    }

    alive() {
      if (this.video.isConnected) return true;
      this.destroy();
      return false;
    }

    reparent() {
      const target = fsTarget(this.video);
      if (this.host.parentNode !== target) target.appendChild(this.host);
    }

    sticky() { return this.state === 'resolving' || this.state === 'progress' || this.state === 'saving'; }

    show(ms, intent) {
      if (!this.alive()) return;
      this.reparent();
      this.box.classList.add('on');
      this.place();
      clearTimeout(this.hideTimer);
      if (!this.sticky()) this.hideTimer = setTimeout(() => this.hide(), coarse ? Math.max(ms || 2500, 5000) : (ms || 2500));
      if (intent && !this.warmed) { this.warmed = true; this.warm(); }
    }

    hide() {
      if (this.sticky()) return;
      this.box.classList.remove('on');
    }

    place() {
      const r = this.video.getBoundingClientRect();
      if (r.width < 80 || r.height < 60 || r.bottom < 0 || r.top > innerHeight) { this.box.classList.remove('on'); return; }
      const right = Math.max(0, innerWidth - Math.min(r.right, innerWidth)) + 12 + 'px';
      const controls = cs.settings && cs.settings.position === 'controls';
      const top = controls ? 'auto' : Math.max(r.top, 0) + 12 + 'px';
      const bottom = controls ? Math.max(0, innerHeight - Math.min(r.bottom, innerHeight)) + (coarse ? 76 : 60) + 'px' : 'auto';
      const key = right + '|' + top + '|' + bottom;
      if (key === this.placed) return;
      this.placed = key;
      const s = this.box.style;
      s.right = right;
      s.top = top;
      s.bottom = bottom;
    }

    schedulePlace() {
      if (this.placeQueued || !this.box.classList.contains('on')) return;
      this.placeQueued = true;
      requestAnimationFrame(() => { this.placeQueued = false; if (this.alive()) this.place(); });
    }

    setState(state, data) {
      this.state = state;
      this.data = data || {};
      clearTimeout(this.stateTimer);
      if (state === 'done') this.stateTimer = setTimeout(() => { this.setState('idle'); this.hide(); }, 4000);
      if (state === 'error') this.stateTimer = setTimeout(() => { this.setState('idle'); this.hide(); }, 9000);
      this.render();
      if (state !== 'idle') this.show(state === 'warn' ? 5000 : 3000);
    }

    render() {
      const d = this.data || {};
      let html = ICON + (coarse ? '' : `<span>${T.download}</span>`);
      let cls = '';
      let side = false;
      switch (this.state) {
        case 'resolving': html = `<span class="spin"></span><span>${T.preparing}</span>`; break;
        case 'saving': html = `<span class="spin"></span><span>${T.saving}</span>`; break;
        case 'progress':
          html = '<span class="pct"></span><i class="bar"></i>';
          side = true;
          break;
        case 'done': html = `<span>✓ ${d.separateAudio ? T.audioSeparate : T.done}</span>`; cls = 'ok'; break;
        case 'error': html = `<span>⚠ ${esc(d.message || '')} · ${T.retry}</span>`; cls = 'warn'; break;
        case 'warn': html = `<span>⚠ ${esc(d.message || '')}</span>`; cls = 'warn'; break;
        default: break;
      }
      this.main.innerHTML = html;
      this.pctEl = null;
      this.barEl = null;
      this.lastLabel = '';
      this.lastPct = -1;
      this.box.classList.toggle('warn', cls === 'warn');
      this.box.classList.toggle('ok', cls === 'ok');
      this.side.hidden = !side;
      if (side) this.paintProgress();
    }

    paintProgress() {
      const d = this.data;
      const pct = d.pct || 0;
      if (!this.pctEl) { this.pctEl = this.main.querySelector('.pct'); this.barEl = this.main.querySelector('.bar'); }
      const text = `${pct}%${d.speed ? ' · ' + fmtSpeed(d.speed) : ''}`;
      if (this.pctEl && text !== this.lastLabel) { this.lastLabel = text; this.pctEl.textContent = text; }
      if (this.barEl && pct !== this.lastPct) { this.lastPct = pct; this.barEl.style.width = pct + '%'; }
    }

    reasonText(reason, status) {
      if (reason === 'http' && (status === 401 || status === 403)) return T.denied + ' (HTTP ' + status + ')';
      return T[reason] || null;
    }

    async warm() {
      let res;
      try { res = await send({ type: 'vdl:resolve', info: collectInfo(this.video) }); } catch { return; }
      if (res && !res.ok && res.reason === 'drm' && this.state === 'idle') this.setState('warn', { message: T.drm });
    }

    async start(req) {
      this.lastReq = req;
      this.jobId = 0;
      this.setState('resolving');
      let r;
      try { r = await send(Object.assign({ type: 'vdl:start', info: collectInfo(this.video) }, req)); } catch (e) { r = { ok: false, reason: 'error', message: String(e.message || e) }; }
      if (!r.ok) { this.setState(['drm', 'nostream', 'live'].includes(r.reason) ? 'warn' : 'error', { message: T[r.reason] || r.message || 'Error' }); return; }
      this.jobId = r.jobId;
    }

    onMain() {
      if (this.sticky()) return;
      this.start(this.state === 'error' && this.lastReq ? this.lastReq : {});
    }

    onEvent(m) {
      switch (m.state) {
        case 'start': this.setState('progress', { pct: 0 }); break;
        case 'progress': {
          const p = m.p;
          this.data = { pct: p.total ? Math.min(99, Math.floor((p.done / p.total) * 100)) : 0, speed: p.speed };
          if (this.state !== 'progress') this.setState('progress', this.data); else this.paintProgress();
          break;
        }
        case 'saving': this.setState('saving'); break;
        case 'done': this.setState('done', { separateAudio: m.separateAudio }); break;
        case 'cancelled': this.setState('idle'); this.hide(); break;
        case 'error': {
          const known = m.code === 'http' ? this.reasonText('http', m.status) : T[m.code];
          this.setState(['drm', 'live'].includes(m.code) ? 'warn' : 'error', { message: known || m.message });
          break;
        }
        default: break;
      }
    }

    destroy() {
      clearTimeout(this.hideTimer);
      clearTimeout(this.stateTimer);
      this.host.remove();
      controllers.delete(this);
      if (!controllers.size) removeGlobals();
    }
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function onPointer(e) {
    const now = Date.now();
    if (e.type === 'pointermove' && (now - lastMove < 120 || e.pointerType === 'touch')) return;
    lastMove = now;
    for (const c of controllers) {
      if (!c.alive()) continue;
      const r = c.video.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) c.show(2500, true);
    }
  }
  const onLayout = () => { for (const c of controllers) c.schedulePlace(); };
  const onFullscreen = () => { for (const c of controllers) { c.reparent(); c.schedulePlace(); } };
  function installGlobals() {
    if (globalsOn) return;
    globalsOn = true;
    document.addEventListener('pointermove', onPointer, { capture: true, passive: true });
    document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    document.addEventListener('fullscreenchange', onFullscreen, true);
    window.addEventListener('resize', onLayout, { passive: true });
    window.addEventListener('scroll', onLayout, { capture: true, passive: true });
  }
  function removeGlobals() {
    globalsOn = false;
    document.removeEventListener('pointermove', onPointer, true);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('fullscreenchange', onFullscreen, true);
    window.removeEventListener('resize', onLayout);
    window.removeEventListener('scroll', onLayout, true);
  }

  api.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'vdl:event') return;
    for (const c of controllers) {
      if (c.jobId === m.jobId || (!c.jobId && c.state === 'resolving')) { c.jobId = m.jobId; c.onEvent(m); }
    }
  });

  function attach(video, force) {
    for (const c of controllers) if (c.video === video) { if (c.alive()) c.show(force ? 6000 : 3000, true); return; }
    for (const c of [...controllers]) {
      if (!c.alive()) continue;
      const a = c.video.getBoundingClientRect();
      const b = video.getBoundingClientRect();
      const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const union = a.width * a.height + b.width * b.height - ix * iy;
      if (union > 0 && (ix * iy) / union > 0.7 && c.state === 'idle' && (c.video.paused || c.video.ended)) c.destroy();
    }
    T = STR[cs.lang === 'ru' ? 'ru' : 'en'];
    const c = new Controller(video);
    controllers.add(c);
    installGlobals();
    c.show(force ? 6000 : 3000, !!force);
  }

  api.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'vdl:save-file') return undefined;
    return (async () => {
      const r = await send({ type: 'vdl:get-save-blob', payload: m.payload });
      if (!r || !r.blob) return false;
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m.payload.filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      return true;
    })().catch(() => false);
  });

  window.__vdlUI = { attach };
})();
