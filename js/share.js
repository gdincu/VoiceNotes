// share.js — sharing/export logic, isolated from UI and storage.
// Uses navigator.share()/navigator.canShare() when available for real file
// sharing, and always offers a plain download fallback.

export function getCleanMimeType(record = {}) {
  const raw = record.mimeType || (record.blob && record.blob.type) || 'audio/webm';
  // Strip codec parameters (e.g. "audio/webm;codecs=opus" -> "audio/webm")
  // because OS share targets and MIME validators require clean media types.
  const clean = String(raw).split(';')[0].trim().toLowerCase();
  return clean || 'audio/webm';
}

export function extensionForMime(mimeType) {
  if (!mimeType) return 'webm';
  const clean = String(mimeType).split(';')[0].trim().toLowerCase();
  if (clean.includes('mp4') || clean.includes('m4a')) return 'm4a';
  if (clean.includes('aac')) return 'aac';
  if (clean.includes('mpeg') || clean.includes('mp3')) return 'mp3';
  if (clean.includes('ogg')) return 'ogg';
  if (clean.includes('wav')) return 'wav';
  if (clean.includes('flac')) return 'flac';
  return 'webm';
}

export function fileNameFor(record = {}) {
  let stamp;
  try {
    const createdAt = record.createdAt;
    const date = createdAt ? new Date(createdAt) : new Date();
    stamp = Number.isNaN(date.getTime())
      ? String(Date.now())
      : date.toISOString().replace(/[:.]/g, '-');
  } catch {
    stamp = String(Date.now());
  }

  // Preserve unicode characters while sanitizing characters invalid in filenames,
  // stripping control chars, leading dots (hidden files), and capping length.
  const rawTitle = record.title ? String(record.title) : '';
  const title = rawTitle
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 100);
  const base = title || `voicenote-${stamp}`;
  const ext = extensionForMime(getCleanMimeType(record));
  return `${base}.${ext}`;
}

export function createShareableFile(record) {
  if (!record || !record.blob) {
    throw new Error('Invalid recording: missing blob data.');
  }
  const cleanMime = getCleanMimeType(record);
  const name = fileNameFor(record);
  const lastModified = Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
  return new File([record.blob], name, { type: cleanMime, lastModified });
}

/**
 * @returns {boolean} whether this browser can attempt file sharing at all.
 * We never claim support the platform doesn't have.
 */
export function isFileShareSupported(record) {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return false;
  try {
    const file = record && record.blob
      ? createShareableFile(record)
      : new File([''], 'test.webm', { type: 'audio/webm' });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Attempts to share a recording as a real audio file via the Web Share API.
 * @param {{blob:Blob, mimeType:string, createdAt:number, title?:string}} record
 * @returns {Promise<'shared'|'cancelled'>}
 */
export async function shareRecording(record) {
  if (!record || !record.blob) {
    throw new Error('No recording data available to share.');
  }

  const file = createShareableFile(record);

  if (!isFileShareSupported(record)) {
    throw Object.assign(new Error('Sharing files is not supported on this device.'), {
      name: 'NotSupportedError',
    });
  }

  try {
    await navigator.share({
      files: [file],
      title: record.title || 'VoiceNotes recording',
    });
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled'; // user dismissed the sheet
    throw err;
  }
}

/**
 * Downloads a recording to disk — the universal fallback when Web Share
 * (or file sharing specifically) isn't available.
 * @param {{blob:Blob, mimeType:string, createdAt:number, title?:string}} record
 */
export function downloadRecording(record) {
  if (!record || !record.blob) {
    throw new Error('Cannot download empty recording.');
  }
  const url = URL.createObjectURL(record.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(record);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
