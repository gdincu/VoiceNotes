# VoiceNotes

A minimalist, installable, offline-first audio journal. Record voice memos
with one tap, watch a live waveform while you talk, and manage everything
from a simple list — all stored **only on your device**.

No backend. No accounts. No analytics. No network requests are made to
record, save, or play a note.

---

## Features

- One-tap recording with a large, obvious record button
- Real-time waveform visualization while recording (Web Audio API)
- Playback with progress, seek, and duration
- Share a recording as an audio file (Web Share API) or download it
- Fully offline after the first load — installable as a PWA
- Recordings persist locally in IndexedDB (never uploaded anywhere)
- Confirmation before deleting a recording
- Graceful handling of denied permissions, unsupported browsers, and storage errors
- Light and dark themes (follows system preference)
- Keyboard accessible, with visible focus states and ARIA labeling

## Project structure

```
voicenotes/
├── index.html            # App shell markup (home view + recording view)
├── manifest.webmanifest  # Web App Manifest (installability, icons, theme)
├── sw.js                 # Service worker — caches the app shell for offline use
├── css/
│   └── styles.css        # All styling (design tokens, layout, components)
├── js/
│   ├── app.js            # Orchestration: state, event wiring, playback
│   ├── recorder.js        # getUserMedia + MediaRecorder wrapper
│   ├── waveform.js        # AudioContext + AnalyserNode + canvas rendering
│   ├── db.js              # IndexedDB storage layer (CRUD for recordings)
│   ├── share.js           # Web Share API + download/export fallback
│   └── ui.js              # DOM rendering helpers (list items, toasts, dialog)
└── icons/                # App icons (regular + maskable + Apple touch icon)
```

Each browser API is isolated in its own module (`recorder.js`, `waveform.js`,
`db.js`, `share.js`). `app.js` is the only file that wires them together and
holds shared UI state; `ui.js` only renders DOM and never touches
IndexedDB, MediaRecorder, or the Web Audio graph directly. This keeps each
piece independently testable and easy to replace.

## Setup & development

VoiceNotes is a **zero-build, dependency-free** static site — plain HTML,
CSS, and ES modules. There is nothing to `npm install`.

Because it uses ES modules (`<script type="module">`), `MediaRecorder`, and
a Service Worker, it must be served over `http://localhost` or `https://`
— opening `index.html` directly via `file://` will not work (module and
service-worker scripts are blocked on the `file:` origin, and some browsers
also block microphone access there).

Serve the folder with any static file server, for example:

```bash
# Python (built in on most systems)
cd voicenotes
python3 -m http.server 8080

# or Node, if you have it
npx serve voicenotes
```

Then open `http://localhost:8080` in your browser. Chrome, Edge, and
Firefox all allow microphone access on `localhost` without HTTPS.

## "Build"

There is no build step. To deploy, upload the contents of this folder as-is
to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages, a plain
Nginx/Apache server, etc.). Two things matter for production:

1. **Serve over HTTPS.** `getUserMedia()` and Service Worker registration
   both require a secure context in production (`localhost` is exempt, but
   your real domain is not).
2. **Serve `sw.js` from the root of the scope you want it to control.** As
   shipped, `sw.js` sits next to `index.html` and controls the whole app.
   If you deploy under a subpath (e.g. `example.com/voicenotes/`), keep the
   relative paths in `manifest.webmanifest` and `sw.js` as-is — they use
   relative (`./`) URLs so they work unchanged from any subpath.

## Installing as a PWA

- **Android (Chrome):** open the site, tap the menu, choose "Add to Home
  screen" / "Install app".
- **iOS/iPadOS (Safari):** open the site, tap the Share icon, choose "Add
  to Home Screen".
- **Desktop (Chrome/Edge):** click the install icon in the address bar, or
  use the browser menu → "Install VoiceNotes…".

Once installed, VoiceNotes launches in standalone mode (no browser chrome)
and works fully offline — including recording, playback, and deleting
existing notes — because the app shell is cached by the service worker and
all recordings live in IndexedDB on the device.

## How it works

- **Recording** — `navigator.mediaDevices.getUserMedia({ audio: true })`
  requests the microphone only when you tap record (never on load).
  `MediaRecorder` captures the stream; the best supported MIME type is
  chosen at runtime via `MediaRecorder.isTypeSupported()` (preferring
  `audio/webm;codecs=opus`, falling back through ogg/mp4/mpeg as needed).
  Recorded chunks are combined into a `Blob` when you stop.
- **Waveform** — while recording, a `MediaStreamAudioSourceNode` feeds an
  `AnalyserNode`; time-domain samples are drawn to a `<canvas>` every frame
  via `requestAnimationFrame`. The graph is fully torn down (audio context
  closed, nodes disconnected, animation loop cancelled) as soon as
  recording stops, so nothing keeps running or draining battery in the
  background.
- **Storage** — recordings (the audio `Blob`, MIME type, timestamp,
  duration) are saved directly to IndexedDB via a small storage module.
  Blobs are stored natively — never converted to base64 — since IndexedDB
  supports Blobs directly and base64 would waste ~33% more space and CPU.
- **Sharing** — `navigator.canShare({ files: […] })` is checked before
  offering the "Share" action. If file sharing isn't supported, the button
  automatically switches to "Download" instead of appearing but failing.
- **Offline** — a service worker caches the app shell (HTML/CSS/JS/icons)
  on install and serves it cache-first (network-first for navigations,
  with the cached shell as a fallback), so the app opens and fully
  functions with no network connection.

## Error handling & edge cases covered

| Situation | Behavior |
|---|---|
| Microphone permission denied | Clear message; user can retry |
| No microphone / device busy | Specific, human-readable error message |
| `MediaRecorder` unsupported | Record button disabled with an explanatory label |
| No supported MIME type reported | Falls back to the browser's own default recorder settings |
| IndexedDB unavailable | App still runs; a toast explains recordings won't persist |
| IndexedDB write fails / quota exceeded | Save error is surfaced, app doesn't crash |
| Web Share unsupported / can't share this file | Falls back to download; share UI never claims support it doesn't have |
| Page closed/refreshed mid-recording | `beforeunload` stops the recorder and releases the microphone |
| Rapid double-tap on record | Guarded so a second recording can't start while the first is initializing |
| Empty/corrupted recording | Zero-byte blobs are rejected before being saved; playback errors are caught and reported |
| Deleting a recording | Requires explicit confirmation via a dialog before removal |

## Browser compatibility

VoiceNotes relies on `MediaRecorder`, `AudioContext`/`AnalyserNode`,
IndexedDB, and Service Workers. Approximate support:

| Feature | Chrome/Edge | Firefox | Safari (macOS/iOS) |
|---|---|---|---|
| Recording (`MediaRecorder`) | ✅ | ✅ | ✅ (15.4+) |
| Waveform (Web Audio) | ✅ | ✅ | ✅ |
| IndexedDB storage | ✅ | ✅ | ✅ |
| Install / standalone PWA | ✅ | ✅ (limited) | ✅ (Add to Home Screen) |
| Offline via Service Worker | ✅ | ✅ | ✅ |
| `navigator.share()` with files | ✅ (desktop & mobile) | ❌ (falls back to download) | ✅ (iOS/iPadOS; limited on macOS) |

Where a feature genuinely isn't available (older Safari without file
sharing, Firefox without `navigator.share`), VoiceNotes degrades
gracefully — it never shows a control that doesn't work.

## Privacy

- Recordings never leave the device — there is no server component at all.
- The microphone is only accessed after you tap the record button, never
  on page load.
- No accounts, cookies, analytics, or third-party scripts.
- Deleting a recording removes it permanently from IndexedDB. 
