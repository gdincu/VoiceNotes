// recorder.js — wraps getUserMedia + MediaRecorder.
// Emits lifecycle callbacks so the UI/state layer never touches raw browser
// recording APIs directly.

// Ordered by preference; the first supported type wins.
const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

/**
 * @returns {string} the best supported MIME type, or '' if MediaRecorder
 * cannot report support (caller should let the browser pick a default).
 */
export function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  return CANDIDATE_MIME_TYPES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) || '';
}

export function isRecordingSupported() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

/**
 * Maps getUserMedia/MediaRecorder failures to short, user-facing messages.
 * Keeping this here means the UI layer never has to know DOMException names.
 */
export function describeMediaError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access was denied. Allow microphone access in your browser settings to record.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is already in use by another app.';
    case 'OverconstrainedError':
      return 'No microphone matches the required settings.';
    case 'SecurityError':
      return 'Microphone access requires a secure (HTTPS) connection.';
    default:
      return 'Could not access the microphone. Please try again.';
  }
}

export class Recorder {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {MediaRecorder|null} */
    this.mediaRecorder = null;
    /** @type {Blob[]} */
    this.chunks = [];
    this.mimeType = '';
    this.startedAt = 0;
  }

  get isRecording() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  }

  /**
   * Requests microphone access and starts recording.
   * @returns {Promise<MediaStream>} the live stream (caller may use it for
   * waveform visualization).
   */
  async start() {
    if (!isRecordingSupported()) {
      throw Object.assign(new Error('MediaRecorder is not supported in this browser.'), {
        name: 'NotSupportedError',
      });
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mimeType = pickSupportedMimeType();
    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;

    try {
      this.mediaRecorder = options
        ? new MediaRecorder(this.stream, options)
        : new MediaRecorder(this.stream);
    } catch (err) {
      this._releaseStream();
      throw err;
    }

    this.chunks = [];
    this.mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });

    this.mediaRecorder.start(250); // periodic chunks so nothing is lost if it crashes
    this.startedAt = Date.now();
    return this.stream;
  }

  /**
   * Stops recording and releases the microphone.
   * @returns {Promise<{blob:Blob, mimeType:string, duration:number}>}
   */
  stop() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
      return Promise.reject(new Error('No active recording to stop.'));
    }

    const duration = (Date.now() - this.startedAt) / 1000;
    const mimeType = this.mimeType || this.mediaRecorder.mimeType || 'audio/webm';

    return new Promise((resolve, reject) => {
      this.mediaRecorder.addEventListener('stop', () => {
        this._releaseStream();
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        if (blob.size === 0) {
          reject(new Error('The recording came out empty. Please try again.'));
          return;
        }
        resolve({ blob, mimeType, duration });
      }, { once: true });

      this.mediaRecorder.addEventListener('error', (e) => {
        this._releaseStream();
        reject(e.error || new Error('Recording failed unexpectedly.'));
      }, { once: true });

      try {
        this.mediaRecorder.stop();
      } catch (err) {
        this._releaseStream();
        reject(err);
      }
    });
  }

  /** Aborts recording without producing a blob (e.g. page unload, cancel). */
  cancel() {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    } catch {
      // Ignore — we're tearing down anyway.
    }
    this._releaseStream();
    this.chunks = [];
  }

  _releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    this.stream = null;
  }
}
