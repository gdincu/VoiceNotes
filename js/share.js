// share.js — sharing/export logic, isolated from UI and storage.
// Uses navigator.share()/navigator.canShare() when available for real file
// sharing, and always offers a plain download fallback.

function extensionForMime(mimeType) {
  if (!mimeType) return 'webm';
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

function fileNameFor(record) {
  const date = new Date(record.createdAt);
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  const title = record.title ? record.title.replace(/[^a-z0-9-_ ]/gi, '').trim() : '';
  const base = title || `voicenote-${stamp}`;
  return `${base}.${extensionForMime(record.mimeType)}`;
}

/**
 * @returns {boolean} whether this browser can attempt file sharing at all.
 * We never claim support the platform doesn't have.
 */
export function isFileShareSupported(record) {
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return false;
  try {
    const file = new File([record.blob], fileNameFor(record), { type: record.mimeType });
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
  const file = new File([record.blob], fileNameFor(record), { type: record.mimeType });

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
