// enhance.js — optional on-device speech enhancement via Desert Ant Clear.
//
// Clear (DeepFilterNet 3 fine-tune) denoises + dereverbs voice recordings and
// loudness-normalizes to a podcast target, 100% on-device (WebAssembly +
// LiteRT.js). No audio leaves the device.
//
// Usage: enhanceBlob(blob, { onProgress }) -> { blob, result }.
// Falls back to the original blob on any failure — callers should treat
// enhancement as best-effort.
//
// Notes:
// - The JS wrapper is loaded lazily from a pinned CDN (esm.sh) via dynamic
//   import, so the app shell stays zero-build and fast when enhancement is
//   never used. The service worker runtime-caches that CDN for offline use.
// - Weights (~24MB ONNX/TFLite) download from Hugging Face on first
//   Clear.load() and are cached by the SDK afterwards, so only the first
//   enhancement needs network. Fully offline after that.
// - Output is 48kHz mono 16-bit WAV. Input (usually Opus-in-WebM) is decoded
//   with the Web Audio API at its native rate; Clear resamples internally.

const CLEAR_VERSION = '4.2.1';
// esm.sh bundles @desert-ant-labs/clear + @litertjs/core into one ESM graph,
// including the `#platform` seam that plain CDN files can't resolve.
const CLEAR_CDN_URL = `https://esm.sh/@desert-ant-labs/clear@${CLEAR_VERSION}`;

const PREF_KEY = 'voicenotes.enhance-enabled';
// Default ON: user asked for cleanup-before-save as the standard path.
const DEFAULT_ENABLED = true;

let clearInstance = null;
let loadPromise = null;

export function isEnhancementSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    (typeof window.AudioContext !== 'undefined' ||
      typeof window.OfflineAudioContext !== 'undefined')
  );
}

export function getEnhancePreference() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw === null) return DEFAULT_ENABLED;
    return raw !== 'false';
  } catch {
    return DEFAULT_ENABLED;
  }
}

export function setEnhancePreference(enabled) {
  try {
    localStorage.setItem(PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // Private mode etc. — preference just won't persist.
  }
}

/**
 * Load (and cache) the Clear enhancer. Downloads weights on first use.
 * @param {(fraction:number)=>void} [onProgress] 0..1 download progress
 */
export async function ensureEnhancer(onProgress) {
  if (clearInstance) return clearInstance;
  if (loadPromise) {
    if (onProgress) {
      // Attach progress to the in-flight load without restarting it.
      loadPromise.progressHandlers.push(onProgress);
    }
    return loadPromise.promise;
  }

  const progressHandlers = onProgress ? [onProgress] : [];
  const emit = (f) => {
    const v = typeof f === 'number' && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
    for (const h of progressHandlers) {
      try { h(v); } catch { /* ignore */ }
    }
  };

  const promise = (async () => {
    let mod;
    try {
      mod = await import(/* @vite-ignore */ CLEAR_CDN_URL);
    } catch (err) {
      throw Object.assign(
        new Error('Could not load the cleanup engine. Check your connection and try again.'),
        { cause: err, code: 'enhance-load-failed' },
      );
    }
    const { Clear } = mod;
    if (!Clear || typeof Clear.load !== 'function') {
      throw new Error('Cleanup engine did not expose Clear.load().');
    }
    const clear = await Clear.load({ onProgress: emit });
    clearInstance = clear;
    return clear;
  })();

  promise.progressHandlers = progressHandlers;
  loadPromise = { promise, progressHandlers };
  try {
    return await promise;
  } finally {
    // Keep the resolved instance; drop the in-flight wrapper so a failure
    // can be retried (e.g. offline on first attempt).
    const result = loadPromise;
    loadPromise = null;
    if (!clearInstance && result) {
      // Load failed — allow retry next time.
    }
  }
}

/** Best-effort prewarm so stopping a recording doesn't pay model-load latency. */
export function prewarmEnhancer() {
  if (!getEnhancePreference() || !isEnhancementSupported()) return;
  // Idle-time, low-priority: never block UI or recording.
  const kick = () => ensureEnhancer().catch(() => {});
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(kick, { timeout: 8000 });
  } else {
    setTimeout(kick, 3000);
  }
}

export function disposeEnhancer() {
  try { clearInstance?.dispose(); } catch { /* ignore */ }
  clearInstance = null;
}

/**
 * Decode any recorded blob (webm/opus, mp4/aac, wav) to mono Float32 samples.
 * @returns {Promise<{samples:Float32Array, sampleRate:number}>}
 */
async function decodeToMono(blob) {
  const buffer = await blob.arrayBuffer();
  // Use an ephemeral OfflineAudioContext-free path: AudioContext.decodeAudioData
  // handles webm/opus + mp4/aac in all evergreen browsers.
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Audio decoding is not supported in this browser.');
  const ctx = new AC();
  try {
    // decodeAudioData detaches the ArrayBuffer; copy first so callers can retry.
    const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
    const { numberOfChannels, sampleRate, length } = audioBuffer;
    let mono;
    if (numberOfChannels === 1) {
      mono = audioBuffer.getChannelData(0).slice();
    } else {
      mono = new Float32Array(length);
      const chans = [];
      for (let c = 0; c < numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
      for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let c = 0; c < chans.length; c++) sum += chans[c][i];
        mono[i] = sum / chans.length;
      }
    }
    return { samples: mono, sampleRate };
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

/** Encode mono Float32 [-1,1] to a 16-bit PCM WAV Blob. */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    const s = Math.min(1, Math.max(-1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Enhance a recorded blob. Returns the enhanced WAV blob + Clear metrics.
 * Throws on failure — callers should fall back to the original recording.
 *
 * @param {Blob} blob
 * @param {{onProgress?:(f:number)=>void, signal?:AbortSignal}} [opts]
 */
export async function enhanceBlob(blob, opts = {}) {
  if (!blob || blob.size === 0) throw new Error('Nothing to clean up.');
  if (!isEnhancementSupported()) throw new Error('Audio cleanup is not supported in this browser.');
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const { samples, sampleRate } = await decodeToMono(blob);
  if (samples.length === 0) throw new Error('Could not decode this recording.');
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Guard against multi-hour recordings exhausting memory: the JS API takes
  // the full utterance as one Float32Array (~11MB/min at 48kHz). Past ~15min
  // we bail to the original rather than risk an OOM mid-save.
  const MAX_SAMPLES = 48000 * 60 * 15;
  if (samples.length > MAX_SAMPLES) {
    throw new Error('Recording is too long to clean up on-device; keeping the original.');
  }

  const clear = await ensureEnhancer(opts.onProgress);
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Default mastering targets Apple Podcasts (-19 LUFS, -1.5dBTP ceiling) —
  // sensible for voice notes. `strength: 1` is full studio cleanup.
  const result = await clear.enhance(samples, sampleRate);
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const outRate = result.sampleRate || 48000;
  const outBlob = encodeWav(result.samples, outRate);
  return {
    blob: outBlob,
    mimeType: 'audio/wav',
    duration: result.durationSec ?? samples.length / sampleRate,
    measuredLUFS: result.measuredLUFS ?? null,
    measuredTruePeakDBFS: result.measuredTruePeakDBFS ?? null,
    realtimeFactor: result.realtimeFactor ?? null,
  };
}
