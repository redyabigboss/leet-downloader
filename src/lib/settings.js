(function (g) {
  'use strict';

  const DEFAULTS = {
    quality: 'best',
    concurrency: 6,
    filenameTemplate: '{title} [{quality}]',
    disabledSites: [],
    position: 'corner',
    lang: 'auto',
  };

  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    s.concurrency = Math.min(16, Math.max(1, parseInt(s.concurrency, 10) || DEFAULTS.concurrency));
    if (!Array.isArray(s.disabledSites)) s.disabledSites = [];
    if (!['corner', 'controls'].includes(s.position)) s.position = DEFAULTS.position;
    if (!['auto', 'en', 'ru'].includes(s.lang)) s.lang = DEFAULTS.lang;
    delete s.subs;
    if (!String(s.filenameTemplate || '').trim()) s.filenameTemplate = DEFAULTS.filenameTemplate;
    return s;
  }

  function isSiteDisabled(list, host) {
    if (!host) return false;
    return list.some((d) => {
      d = String(d).trim().toLowerCase();
      return d && (host === d || host.endsWith('.' + d));
    });
  }

  function resolveLang(lang, navLang) {
    if (lang === 'en' || lang === 'ru') return lang;
    return String(navLang || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  }

  const api = { DEFAULTS, normalize, isSiteDisabled, resolveLang };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).settings = api;
})(typeof self !== 'undefined' ? self : globalThis);
