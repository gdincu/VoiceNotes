// db.js — IndexedDB storage layer for VoiceNotes.
// Isolated so all persistence logic (and its failure modes) lives in one place.
// Public API: saveRecording, getRecordings, deleteRecording.

const DB_NAME = 'voicenotes-db';
const DB_VERSION = 1;
const STORE = 'recordings';

/** @type {Promise<IDBDatabase>|null} cached DB-open promise */
let dbPromise = null;

/**
 * True if IndexedDB exists in this browser at all. Callers should check this
 * before relying on persistence and fall back to in-memory/session-only mode.
 */
export function isSupported() {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openDB() {
  if (!isSupported()) {
    return Promise.reject(new Error('IndexedDB is not supported in this browser.'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // If the connection is closed elsewhere (e.g. version change in another
      // tab), drop the cache so the next call reopens cleanly.
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Failed to open IndexedDB.'));
    };

    req.onblocked = () => {
      reject(new Error('IndexedDB open request is blocked by another tab.'));
    };
  });

  return dbPromise;
}

function tx(mode) {
  return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed.'));
  });
}

/**
 * Persist a recording.
 * @param {{id?:string, blob:Blob, mimeType:string, createdAt?:number, duration:number, title?:string}} record
 * @returns {Promise<string>} the record's id
 */
export async function saveRecording(record) {
  if (!record || !(record.blob instanceof Blob) || record.blob.size === 0) {
    throw new Error('Cannot save an empty or invalid recording.');
  }
  const id = record.id || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    blob: record.blob,
    mimeType: record.mimeType || record.blob.type || 'application/octet-stream',
    createdAt: record.createdAt || Date.now(),
    duration: Number.isFinite(record.duration) ? record.duration : 0,
    title: record.title || '',
  };

  const store = await tx('readwrite');
  try {
    await requestToPromise(store.put(entry));
    return id;
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new Error('Not enough storage space on this device to save the recording.');
    }
    throw err;
  }
}

/**
 * @returns {Promise<Array>} all recordings, newest first.
 * Uses the `createdAt` index so ordering happens in IndexedDB
 * instead of sorting potentially large record sets in JS.
 */
export async function getRecordings() {
  const store = await tx('readonly');
  const all = await requestToPromise(store.index('createdAt').getAll());
  // Index returns ascending; newest-first is what the UI wants.
  return all.reverse();
}

/**
 * @param {string} id
 */
export async function deleteRecording(id) {
  const store = await tx('readwrite');
  return requestToPromise(store.delete(id));
}
