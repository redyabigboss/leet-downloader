# leet downloader

[![Latest release](https://img.shields.io/badge/release-1337-2ea043?style=flat-square)](https://github.com/redyabigboss/leet-downloader/releases/latest)
[![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-ff7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://www.mozilla.org/firefox/)
[![Manifest V2](https://img.shields.io/badge/Manifest-V2-6e56cf?style=flat-square)](manifest.json)
[![No telemetry](https://img.shields.io/badge/telemetry-none-2ea043?style=flat-square)](README.md)

[English](#english) | [Русский](#russian)

---

<a id="english"></a>

## 🇬🇧 English

### 📌 Overview
**leet downloader** is a browser extension (Manifest V2, primarily for Firefox/Gecko, including Firefox for Android) that adds a **Download** button to HTML5 video players and helps download available media streams.  
It targets common web video delivery formats: **HLS (M3U8)**, **DASH (MPD)**, and direct **video files** (e.g. MP4/WebM/MKV where available).

> Manifest notes: *No telemetry, no remote code.*

- **Name:** leet downloader  
- **Version:** 1337  
- **Gecko ID:** `video-download-button@example.invalid`  
- **Minimum versions:** Firefox 140+, Firefox for Android 142+

### ✨ Features
- Detects media candidates from network requests (`webRequest`) and in-page interception (`fetch`/`XMLHttpRequest`/EME hooks).
- Adds an on-video overlay button with states: preparing, progress, saving, done, retry/cancel, and warnings/errors.
- Supports:
  - **HLS:** master/media playlists, variant selection, segment download, AES-128 decryption (identity key format) where applicable.
  - **DASH:** MPD parsing, representation selection, segmented downloads.
  - **Direct files:** HTTP download with Range support and integrity checks.
- Attempts to merge separate fMP4 video/audio tracks when possible; otherwise saves audio as a separate file.
- MPEG-TS to fMP4 remuxing support for compatible streams.
- Adaptive parallel connection governor (speed/error-aware) with configurable upper limit.
- Filename templating and sanitization.
- UI and options localization: **English / Russian**.
- Site disable list (domain and subdomains).

### ⚠️ Limitations
- **DRM-protected content cannot be downloaded** (e.g. Widevine/EME-protected streams, protected HLS/DASH cases are detected and blocked).
- **Live streams are not supported** (HLS without `#EXT-X-ENDLIST`, dynamic DASH MPD).

### 🔐 Permissions
- `<all_urls>` — detect and fetch media/resources from sites you use.
- `webRequest`, `webRequestBlocking` — observe media requests and adjust request headers for download jobs.
- `downloads` — save files via the browser downloads API when available.
- `storage` — store extension settings.

### 📦 Installation
#### From release (recommended)
1. Download `leet-downloader.xpi` from the [Releases](https://github.com/redyabigboss/leet-downloader/releases/latest) page.
2. Open the file with Firefox and confirm installation.

#### From source
1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json` from this project folder.

### ⚙️ Settings
Available in the extension options page:
- **Default quality:** Best / 1080p / 720p / 480p / 360p / Lowest
- **Parallel connections (1–16):** upper limit (actual concurrency adapts automatically)
- **Button position:** video corner or above player controls
- **Filename template:** default `{title} [{quality}]`  
  Tokens: `{title}`, `{quality}`, `{host}`, `{date}`
- **Disabled sites:** one domain per line (subdomains included)
- **Language:** auto / EN / RU

### 🗂️ Project structure
```text
manifest.json
icons/
  icon.svg
src/
  background/background.js   # detection, stream selection, job orchestration, saving
  content/content.js         # injects hook, tracks videos, messaging
  content/ui.js              # in-page overlay button/UI
  engine/core.js             # HLS/DASH/file download & assembly engine
  engine/worker.js           # worker runtime, OPFS/memory sinks
  lib/                      # parsing/classification/helpers (m3u8, mpd, ts2mp4, fmp4merge, etc.)
  options/                   # options page (HTML/CSS/JS)
  page/hook.js               # page-context hooks (fetch/XHR/EME/shadow DOM)
```

### 📝 Notes
- Intermediate download data may be stored in OPFS (or memory fallback) and cleaned up automatically.
- On some platforms/cases (e.g. Android or when `downloads` API is unavailable), saving may be handled via the page context.

---

<a id="russian"></a>

## 🇷🇺 Русский

### 📌 Обзор
**leet downloader** — браузерное расширение (Manifest V2, в первую очередь для Firefox/Gecko, включая Firefox для Android), которое добавляет кнопку **Скачать** к HTML5-видеоплеерам и помогает загружать доступные медиапотоки.  
Поддерживаются распространённые форматы веб-видео: **HLS (M3U8)**, **DASH (MPD)** и прямые **видеофайлы** (например, MP4/WebM/MKV, когда они доступны).

> В манифесте указано: *без телеметрии и без удалённого кода.*

- **Название:** leet downloader  
- **Версия:** 1337  
- **Gecko ID:** `video-download-button@example.invalid`  
- **Минимальные версии:** Firefox 140+, Firefox для Android 142+

### ✨ Возможности
- Обнаружение медиа через сетевые запросы (`webRequest`) и перехват в контексте страницы (`fetch`/`XMLHttpRequest`/EME-хуки).
- Оверлей-кнопка на видео с состояниями: подготовка, прогресс, сохранение, готово, повтор/отмена, предупреждения/ошибки.
- Поддержка:
  - **HLS:** master/media плейлисты, выбор качества, загрузка сегментов, расшифровка AES-128 (формат ключа identity) при возможности.
  - **DASH:** разбор MPD, выбор представлений, сегментная загрузка.
  - **Прямые файлы:** загрузка по HTTP с поддержкой Range и проверкой целостности.
- Попытка объединения раздельных fMP4 видео/аудио дорожек; при невозможности аудио сохраняется отдельным файлом.
- Ремультиплексинг MPEG-TS в fMP4 для совместимых потоков.
- Адаптивный регулятор параллельных соединений (с учётом скорости/ошибок) с настраиваемым верхним пределом.
- Шаблоны имён файлов и санитизация.
- Локализация интерфейса и настроек: **английский / русский**.
- Список сайтов, на которых расширение отключено (домен и поддомены).

### ⚠️ Ограничения
- **Контент, защищённый DRM, скачать нельзя** (например, потоки с Widevine/EME; защищённые случаи HLS/DASH определяются и блокируются).
- **Прямые трансляции (live) не поддерживаются** (HLS без `#EXT-X-ENDLIST`, dynamic DASH MPD).

### 🔐 Разрешения
- `<all_urls>` — обнаружение и получение медиа/ресурсов на сайтах.
- `webRequest`, `webRequestBlocking` — наблюдение за медиазапросами и корректировка заголовков для загрузки.
- `downloads` — сохранение файлов через API загрузок браузера (когда доступно).
- `storage` — хранение настроек расширения.

### 📦 Установка
#### Из релиза (рекомендуется)
1. Скачайте `leet-downloader.xpi` со страницы [Releases](https://github.com/redyabigboss/leet-downloader/releases/latest).
2. Откройте файл в Firefox и подтвердите установку.

#### Из исходников
1. Откройте `about:debugging#/runtime/this-firefox` в Firefox.
2. Нажмите **Загрузить временное дополнение…** и выберите `manifest.json` из папки проекта.

### ⚙️ Настройки
Доступны на странице настроек расширения:
- **Качество по умолчанию:** Лучшее / 1080p / 720p / 480p / 360p / Минимальное
- **Параллельные соединения (1–16):** верхний предел (фактическое значение подбирается автоматически)
- **Положение кнопки:** в углу видео или над панелью управления плеера
- **Шаблон имени файла:** по умолчанию `{title} [{quality}]`  
  Токены: `{title}`, `{quality}`, `{host}`, `{date}`
- **Отключённые сайты:** один домен в строке (поддомены включены)
- **Язык:** авто / EN / RU

### 🗂️ Структура проекта
```text
manifest.json
icons/
  icon.svg
src/
  background/background.js   # обнаружение, выбор потока, управление загрузкой, сохранение
  content/content.js         # внедрение hook, отслеживание видео, обмен сообщениями
  content/ui.js              # оверлей-кнопка и интерфейс на странице
  engine/core.js             # движок загрузки и сборки HLS/DASH/файлов
  engine/worker.js           # воркер, запись в OPFS/память
  lib/                      # парсеры/классификация/утилиты (m3u8, mpd, ts2mp4, fmp4merge и др.)
  options/                   # страница настроек (HTML/CSS/JS)
  page/hook.js               # хуки в контексте страницы (fetch/XHR/EME/shadow DOM)
```

### 📝 Примечания
- Промежуточные данные загрузки могут храниться в OPFS (или в памяти при отсутствии поддержки) и очищаются автоматически.
- На некоторых платформах/в некоторых случаях (например, Android или при недоступности API `downloads`) сохранение может выполняться через контекст страницы.
