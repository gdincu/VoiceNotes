// app.js — application entry point. Wires together storage, recording,
// waveform, and sharing modules, and owns the small amount of shared state
// (current recording, current playback) that spans them.

import * as db from './db.js';
import { Recorder, isRecordingSupported, describeMediaError } from './recorder.js';
import { WaveformVisualizer } from './waveform.js';
import { shareRecording, downloadRecording, isFileShareSupported } from './share.js';
import {
  renderRecordingItem, renderEmptyState, showToast, confirmDialog, promptForName,
  setPlayButtonState, updatePlaybackProgress, updateRecordingCardMeta,
  formatDuration, formatTimestamp,
} from './ui.js';

const els = {
  recordBtn: document.getElementById('record-btn'),
  recordBtnLabel: document.getElementById('record-btn-label'),
  homeView: document.getElementById('home-view'),
  recordingView: document.getElementById('recording-view'),
  timer: document.getElementById('recording-timer'),
  waveformCanvas: document.getElementById('waveform-canvas'),
  stopBtn: document.getElementById('stop-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  list: document.getElementById('recordings-list'),
};

const state = {
  recorder: new Recorder(),
  visualizer: null,
  timerInterval: null,
  recordingStartedAt: 0,
  currentAudioEl: null,
  currentPlayingLi: null,
  storageReady: false,
  startInFlight: false,
};

// ---------------------------------------------------------------------------
// Recording flow
// ---------------------------------------------------------------------------

async function startRecording() {
  // Guards against a rapid double-tap starting a second recording while the
  // first getUserMedia() request is still pending.
  if (state.recorder.isRecording || state.startInFlight) return;

  if (!isRecordingSupported()) {
    showToast('Recording is not supported in this browser.', { isError: true });
    return;
  }

  state.startInFlight = true;
  try {
    const stream = await state.recorder.start();
    enterRecordingView();
    state.visualizer = state.visualizer || new WaveformVisualizer(els.waveformCanvas);
    state.visualizer.start(stream);
    state.recordingStartedAt = Date.now();
    tickTimer();
    state.timerInterval = setInterval(tickTimer, 250);
  } catch (err) {
    console.error(err);
    showToast(describeMediaError(err), { isError: true });
  } finally {
    state.startInFlight = false;
  }
}

function tickTimer() {
  const elapsed = (Date.now() - state.recordingStartedAt) / 1000;
  els.timer.textContent = formatDuration(elapsed);
}

async function stopRecording() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;

  let result;
  try {
    result = await state.recorder.stop();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Recording could not be saved.', { isError: true });
    teardownRecordingView();
    return;
  }

  teardownRecordingView();

  // Naming is optional — leaving it blank (or cancelling) keeps the default
  // placeholder behavior of showing the date/time instead of a custom title.
  const createdAt = Date.now();
  const name = await promptForName({
    heading: 'Save recording',
    placeholder: formatTimestamp(createdAt),
    confirmLabel: 'Save',
  });

  try {
    await db.saveRecording({
      blob: result.blob,
      mimeType: result.mimeType,
      duration: result.duration,
      createdAt,
      title: name || '',
    });
    showToast('Recording saved.');
    await loadRecordings();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not save the recording on this device.', { isError: true });
  }
}

function cancelRecording() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.recorder.cancel();
  teardownRecordingView();
  showToast('Recording discarded.');
}

function enterRecordingView() {
  els.homeView.hidden = true;
  els.recordingView.hidden = false;
  els.timer.textContent = '0:00';
  els.stopBtn.focus();
}

function teardownRecordingView() {
  if (state.visualizer) {
    state.visualizer.stop();
  }
  els.homeView.hidden = false;
  els.recordingView.hidden = true;
  els.recordBtn.focus();
}

// Guard against the user leaving mid-recording: stop cleanly instead of
// leaking an open microphone stream.
window.addEventListener('beforeunload', () => {
  if (state.recorder.isRecording) {
    state.recorder.cancel();
  }
});

// ---------------------------------------------------------------------------
// Recordings list
// ---------------------------------------------------------------------------

function revokeListObjectURLs() {
  for (const li of els.list.children) {
    if (li._els && li._els.objectUrl) {
      URL.revokeObjectURL(li._els.objectUrl);
      li._els.objectUrl = null;
      li._els.audio = null;
    }
  }
}

async function loadRecordings() {
  if (!state.storageReady) return;
  let records = [];
  try {
    records = await db.getRecordings();
  } catch (err) {
    console.error(err);
    showToast('Could not load saved recordings.', { isError: true });
    return;
  }

  stopCurrentPlayback();
  revokeListObjectURLs();
  els.list.innerHTML = '';
  if (records.length === 0) {
    renderEmptyState(els.list);
    return;
  }

  const handlers = {
    canShareFile: isFileShareSupported,
    onTogglePlay: handleTogglePlay,
    onSeek: handleSeek,
    onRename: handleRename,
    onShare: handleShare,
    onDownload: handleDownload,
    onDeleteRequest: handleDeleteRequest,
  };

  for (const record of records) {
    els.list.appendChild(renderRecordingItem(record, handlers));
  }
}

function stopCurrentPlayback() {
  if (state.currentAudioEl) {
    state.currentAudioEl.pause();
  }
  if (state.currentPlayingLi) {
    setPlayButtonState(state.currentPlayingLi, false);
  }
  state.currentAudioEl = null;
  state.currentPlayingLi = null;
}

function effectiveDuration(record, audio) {
  // Prefer the real media duration when known. MediaRecorder webm blobs
  // commonly report Infinity (or NaN before metadata loads), so fall back
  // to the wall-clock duration stored at record time in those cases.
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
    return audio.duration;
  }
  if (Number.isFinite(record.duration) && record.duration > 0) {
    return record.duration;
  }
  return 0;
}

function ensureAudio(record, li) {
  let audio = li._els.audio;
  if (audio) return audio;

  const url = URL.createObjectURL(record.blob);
  audio = new Audio(url);
  audio.preload = 'metadata';
  li._els.audio = audio;
  li._els.objectUrl = url;

  audio.addEventListener('timeupdate', () => {
    updatePlaybackProgress(li, audio.currentTime, effectiveDuration(record, audio));
  });
  audio.addEventListener('loadedmetadata', () => {
    updatePlaybackProgress(li, audio.currentTime, effectiveDuration(record, audio));
  });
  audio.addEventListener('ended', () => {
    setPlayButtonState(li, false);
    updatePlaybackProgress(li, 0, effectiveDuration(record, audio));
    try { audio.currentTime = 0; } catch { /* ignore seek errors on teardown */ }
  });
  audio.addEventListener('error', () => {
    showToast('This recording could not be played back. It may be corrupted.', { isError: true });
    setPlayButtonState(li, false);
  });
  return audio;
}

function handleTogglePlay(record, li) {
  const isThisPlaying = state.currentPlayingLi === li && state.currentAudioEl && !state.currentAudioEl.paused;
  if (isThisPlaying) {
    state.currentAudioEl.pause();
    setPlayButtonState(li, false);
    return;
  }

  // Only one recording plays at a time.
  if (state.currentPlayingLi && state.currentPlayingLi !== li) {
    stopCurrentPlayback();
  }

  const audio = ensureAudio(record, li);

  state.currentAudioEl = audio;
  state.currentPlayingLi = li;

  audio.play().then(() => {
    setPlayButtonState(li, true);
  }).catch((err) => {
    console.error(err);
    showToast('Playback could not start.', { isError: true });
  });
}

function handleSeek(record, li, sliderValue) {
  // Slider uses max=1000 for finer granularity on long recordings.
  const audio = ensureAudio(record, li);
  const max = Number(li._els.progress.max || 1000);
  const duration = effectiveDuration(record, audio);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const fraction = Math.min(1, Math.max(0, Number(sliderValue) / max));
  const target = fraction * duration;
  // Update the time label immediately with the TARGET time. Reading back
  // audio.currentTime here would return the stale pre-seek position because
  // seeking is asynchronous.
  updatePlaybackProgress(li, target, duration);
  try {
    audio.currentTime = target;
  } catch (err) {
    console.warn('Seek failed:', err);
  }
  // If metadata isn't loaded yet (readyState 0, or duration still came from
  // the stored record), re-apply the slider position once it arrives so a
  // pre-playback scrub isn't lost. The live `input` seek above already
  // covers the common during-playback case, including Infinity-duration webm
  // blobs where audio.duration is never finite.
  if (audio.readyState === 0) {
    const reapply = () => {
      const d = effectiveDuration(record, audio);
      if (d > 0) {
        const f = Math.min(1, Math.max(0, Number(li._els.progress.value) / max));
        try { audio.currentTime = f * d; } catch { /* ignore */ }
        updatePlaybackProgress(li, f * d, d);
      }
    };
    audio.addEventListener('loadedmetadata', reapply, { once: true });
  }
}

async function handleRename(record, li) {
  const name = await promptForName({
    heading: 'Rename recording',
    initialValue: record.title || '',
    placeholder: formatTimestamp(record.createdAt),
    confirmLabel: 'Save',
  });
  if (name === null) return; // cancelled — leave the existing name/placeholder as-is

  try {
    await db.saveRecording({ ...record, title: name });
    record.title = name;
    updateRecordingCardMeta(li, record);
    showToast(name ? 'Recording renamed.' : 'Name cleared.');
  } catch (err) {
    console.error(err);
    showToast('Could not rename the recording.', { isError: true });
  }
}

function handleDownload(record) {
  try {
    downloadRecording(record);
    showToast('Recording downloaded.');
  } catch (err) {
    console.error(err);
    showToast('Could not download the recording.', { isError: true });
  }
}

async function handleShare(record) {
  try {
    const result = await shareRecording(record);
    if (result === 'shared') {
      showToast('Recording shared.');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return; // user dismissed the share sheet
    }
    console.warn('Web Share failed, falling back to download:', err);
    try {
      downloadRecording(record);
      showToast('Sharing isn\u2019t available here — downloaded file instead.');
    } catch (downloadErr) {
      console.error(downloadErr);
      showToast('Could not share or download the recording.', { isError: true });
    }
  }
}

async function handleDeleteRequest(record, li) {
  const ok = await confirmDialog('Delete this recording? This cannot be undone.');
  if (!ok) return;

  if (state.currentPlayingLi === li) stopCurrentPlayback();
  if (li._els.objectUrl) URL.revokeObjectURL(li._els.objectUrl);

  try {
    await db.deleteRecording(record.id);
    li.remove();
    if (!els.list.children.length) renderEmptyState(els.list);
    showToast('Recording deleted.');
  } catch (err) {
    console.error(err);
    showToast('Could not delete the recording.', { isError: true });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function wireStaticControls() {
  els.recordBtn.addEventListener('click', startRecording);
  els.stopBtn.addEventListener('click', stopRecording);
  els.cancelBtn.addEventListener('click', cancelRecording);

  // Keyboard: Escape cancels an in-progress recording.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.recorder.isRecording) cancelRecording();
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    // Notify when a new version is ready. We don't auto-reload (that could
    // interrupt a recording) — the user reloads when convenient.
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('A new version is available — reload to update.');
        }
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      showToast('App updated — reload to use the new version.');
    });
  } catch (err) {
    console.warn('Service worker registration failed:', err);
  }
}

async function init() {
  wireStaticControls();

  if (!isRecordingSupported()) {
    els.recordBtn.disabled = true;
    els.recordBtnLabel.textContent = 'Recording unsupported';
    showToast('This browser does not support audio recording.', { isError: true });
  }

  state.storageReady = db.isSupported();
  if (!state.storageReady) {
    showToast('Local storage is unavailable — recordings won\u2019t be saved between visits.', { isError: true });
    renderEmptyState(els.list);
  } else {
    await loadRecordings();
  }

  await registerServiceWorker();
}

init();
