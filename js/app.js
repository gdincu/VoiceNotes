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
  recordingError: document.getElementById('recording-error'),
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

  els.recordingError.hidden = true;
  els.recordingError.textContent = '';

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
  document.body.classList.add('is-recording');
  els.timer.textContent = '0:00';
}

function teardownRecordingView() {
  if (state.visualizer) {
    state.visualizer.stop();
  }
  els.homeView.hidden = false;
  els.recordingView.hidden = true;
  document.body.classList.remove('is-recording');
}

// Guard against the user leaving mid-recording: stop cleanly instead of
// leaking an open microphone stream.
window.addEventListener('beforeunload', () => {
  if (state.recorder.isRecording) {
    state.recorder.cancel();
  }
});
document.addEventListener('visibilitychange', () => {
  // Recording continues in the background on most platforms; we only need
  // to make sure the waveform loop doesn't burn cycles when hidden. The
  // rAF loop already throttles itself in background tabs by default.
});

// ---------------------------------------------------------------------------
// Recordings list
// ---------------------------------------------------------------------------

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

  let audio = li._els.audio;
  if (!audio) {
    const url = URL.createObjectURL(record.blob);
    audio = new Audio(url);
    audio.preload = 'metadata';
    li._els.audio = audio;
    li._els.objectUrl = url;

    audio.addEventListener('timeupdate', () => {
      updatePlaybackProgress(li, audio.currentTime, record.duration || audio.duration || 0);
    });
    audio.addEventListener('ended', () => {
      setPlayButtonState(li, false);
      updatePlaybackProgress(li, 0, record.duration || audio.duration || 0);
      audio.currentTime = 0;
    });
    audio.addEventListener('error', () => {
      showToast('This recording could not be played back. It may be corrupted.', { isError: true });
      setPlayButtonState(li, false);
    });
  }

  state.currentAudioEl = audio;
  state.currentPlayingLi = li;

  audio.play().then(() => {
    setPlayButtonState(li, true);
  }).catch((err) => {
    console.error(err);
    showToast('Playback could not start.', { isError: true });
  });
}

function handleSeek(record, li, percent) {
  const audio = li._els.audio;
  const duration = record.duration || (audio && audio.duration) || 0;
  if (!audio || !duration) return;
  audio.currentTime = (percent / 100) * duration;
  updatePlaybackProgress(li, audio.currentTime, duration);
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
    await navigator.serviceWorker.register('./sw.js');
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
