(function (g) {
  'use strict';

  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

  function sanitize(name, max = 150) {
    let s = String(name == null ? '' : name)
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
      .replace(/\s*:\s*/g, ' - ')
      .replace(/[\\/<>|]+/g, '-')
      .replace(/[*?]+/g, '')
      .replace(/"/g, "'")
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s]+$/g, '');
    s = Array.from(s).slice(0, max).join('').replace(/[.\s]+$/g, '');
    if (!s) return 'video';
    if (RESERVED.test(s)) s += '_';
    return s;
  }

  function build(template, vars, ext) {
    let s = String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));
    s = s.replace(/\[\s*\]|\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
    s = sanitize(s);
    return ext ? s + '.' + ext : s;
  }

  const api = { sanitize, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (g.VDL = g.VDL || {}).filename = api;
})(typeof self !== 'undefined' ? self : globalThis);
