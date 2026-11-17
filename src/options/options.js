'use strict';
const S = self.VDL.settings;
const ids = ['quality', 'concurrency', 'filenameTemplate', 'position', 'disabledSites'];
const $ = (id) => document.getElementById(id);

const STR = {
  en: {
    secDownload: 'Download', secInterface: 'Interface', secSaving: 'Saving', secSites: 'Sites', concurrencyHint: 'Adapts automatically; this is the upper limit',
    quality: 'Default quality', best: 'Best', worst: 'Lowest', concurrency: 'Parallel connections (1–16)',
    template: 'Filename template', position: 'Button position', posCorner: 'Corner of the video', posControls: 'Above the player controls',
    disabled: 'Disabled sites', disabledHint: 'One domain per line; subdomains included', saved: 'Saved',
  },
  ru: {
    secDownload: 'Загрузка', secInterface: 'Интерфейс', secSaving: 'Сохранение', secSites: 'Сайты', concurrencyHint: 'Подбирается автоматически; это верхний предел',
    quality: 'Качество по умолчанию', best: 'Лучшее', worst: 'Минимальное', concurrency: 'Параллельных соединений (1–16)',
    template: 'Шаблон имени файла', position: 'Положение кнопки', posCorner: 'В углу видео', posControls: 'Над панелью управления плеера',
    disabled: 'Отключить на сайтах', disabledHint: 'Один домен в строке; поддомены включены', saved: 'Сохранено',
  },
};
let T = STR.en;

function applyLang(lang) {
  T = STR[lang];
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T[el.dataset.i18n];
  for (const b of document.querySelectorAll('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}

async function load() {
  const raw = await browser.storage.local.get(null);
  const s = S.normalize(raw);
  if (Object.prototype.hasOwnProperty.call(raw, 'subs')) await browser.storage.local.remove('subs').catch(() => {});
  applyLang(S.resolveLang(s.lang, navigator.language));
  for (const id of ids) $(id).value = id === 'disabledSites' ? s.disabledSites.join('\n') : s[id];
}

let timer = 0;
async function save(extra) {
  const raw = Object.assign({}, await browser.storage.local.get(null));
  for (const id of ids) raw[id] = $(id).value;
  raw.disabledSites = raw.disabledSites.split(/\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  Object.assign(raw, extra);
  await browser.storage.local.set(S.normalize(raw));
  $('status').textContent = T.saved;
  clearTimeout(timer);
  timer = setTimeout(() => { $('status').textContent = ''; }, 1500);
}

for (const id of ids) $(id).addEventListener('change', () => save());
for (const b of document.querySelectorAll('.lang button')) {
  b.addEventListener('click', () => { applyLang(b.dataset.lang); save({ lang: b.dataset.lang }); });
}
load();
