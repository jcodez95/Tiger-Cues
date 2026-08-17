// db.js — IndexedDB persistence layer.
//
// Three object stores:
//
//   files: { fingerprintId, filename, fileSize, duration, lastOpened, hasStoredAudio }
//     - keyPath: fingerprintId (see fingerprint.js for how this is derived)
//     - one record per distinct audio file the user has ever loaded
//     - lightweight metadata only — the actual audio binary lives in the
//       separate audioBlobs store below, so listing the library doesn't
//       require loading every file's audio data into memory
//
//   audioBlobs: { fingerprintId, blob }
//     - keyPath: fingerprintId
//     - holds the actual audio file data, so a library entry can be
//       reopened without re-picking the file. Kept in its own store (not
//       merged into `files`) so getAllFiles() stays cheap even with many
//       large files saved. Saving here is best-effort: on devices with
//       tight storage this can fail (quota exceeded), in which case the
//       file record's `hasStoredAudio` stays false and the app falls back
//       to prompting the user to re-select that file next time. See
//       README for the iOS storage-eviction caveats this is subject to.
//
//   timestamps: { id, fingerprintId, time, title, comment, createdAt }
//     - keyPath: id (uuid)
//     - indexed by fingerprintId so all timestamps for one file can be
//       fetched without scanning the whole store
//
// This module has no knowledge of the DOM or any UI — it's a plain data
// layer so it can be unit-tested independently (see scripts/test-db.mjs).

const DB_NAME = "cuesheet-db";
const DB_VERSION = 2;

const FILES_STORE = "files";
const AUDIO_STORE = "audioBlobs";
const TIMESTAMPS_STORE = "timestamps";
const FINGERPRINT_INDEX = "byFingerprint";

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/**
 * Opens (and if needed, creates/upgrades) the database. Cached so repeated
 * calls reuse the same connection.
 * @returns {Promise<IDBDatabase>}
 */
function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Each block is guarded so this same upgrade path works both for a
      // brand-new database (jumping straight to the latest version) and
      // for an existing v1 database being upgraded to v2 (files/timestamps
      // already exist and are left untouched; only audioBlobs is new).
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE, { keyPath: "fingerprintId" });
      }

      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "fingerprintId" });
      }

      if (!db.objectStoreNames.contains(TIMESTAMPS_STORE)) {
        const store = db.createObjectStore(TIMESTAMPS_STORE, { keyPath: "id" });
        store.createIndex(FINGERPRINT_INDEX, "fingerprintId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

/**
 * Wraps an IDBRequest in a Promise.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- Files ----------

/**
 * @typedef {Object} FileRecord
 * @property {string} fingerprintId
 * @property {string} filename
 * @property {number} fileSize
 * @property {number} duration - seconds
 * @property {number} lastOpened - epoch ms
 * @property {boolean} [hasStoredAudio] - whether the audioBlobs store has this file's data
 */

/**
 * Creates or updates a file's library entry (e.g. on load, or to bump
 * lastOpened when reconnected).
 * @param {FileRecord} fileRecord
 * @returns {Promise<void>}
 */
export async function upsertFile(fileRecord) {
  const db = await getDB();
  const tx = db.transaction(FILES_STORE, "readwrite");
  tx.objectStore(FILES_STORE).put(fileRecord);
  await promisifyRequest(tx.objectStore(FILES_STORE).get(fileRecord.fingerprintId));
}

/**
 * @param {string} fingerprintId
 * @returns {Promise<FileRecord | undefined>}
 */
export async function getFile(fingerprintId) {
  const db = await getDB();
  const tx = db.transaction(FILES_STORE, "readonly");
  return promisifyRequest(tx.objectStore(FILES_STORE).get(fingerprintId));
}

/**
 * Returns all library entries, most recently opened first.
 * @returns {Promise<FileRecord[]>}
 */
export async function getAllFiles() {
  const db = await getDB();
  const tx = db.transaction(FILES_STORE, "readonly");
  const all = await promisifyRequest(tx.objectStore(FILES_STORE).getAll());
  return all.sort((a, b) => b.lastOpened - a.lastOpened);
}

/**
 * Deletes a file's library entry AND all of its timestamps AND its saved
 * audio blob, if any (full cascade).
 * @param {string} fingerprintId
 * @returns {Promise<void>}
 */
export async function deleteFile(fingerprintId) {
  const db = await getDB();

  const timestamps = await getTimestampsForFile(fingerprintId);

  const tx = db.transaction([FILES_STORE, AUDIO_STORE, TIMESTAMPS_STORE], "readwrite");
  tx.objectStore(FILES_STORE).delete(fingerprintId);
  tx.objectStore(AUDIO_STORE).delete(fingerprintId);
  const tsStore = tx.objectStore(TIMESTAMPS_STORE);
  for (const ts of timestamps) {
    tsStore.delete(ts.id);
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Audio blobs ----------
//
// Saving/loading here is separate from the `files` metadata store (see
// module docs above) so that listing the library never has to touch large
// binary data, and so a blob-save failure (e.g. quota exceeded on a huge
// WAV) can be handled independently of saving the file's metadata.

/**
 * Saves a file's raw audio data for later reopening without re-picking it.
 * Can throw (e.g. QuotaExceededError) — callers should catch this and fall
 * back gracefully rather than losing the rest of the file/timestamp save.
 * @param {string} fingerprintId
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
export async function saveAudioBlob(fingerprintId, blob) {
  const db = await getDB();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).put({ fingerprintId, blob });
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * @param {string} fingerprintId
 * @returns {Promise<Blob | undefined>}
 */
export async function getAudioBlob(fingerprintId) {
  const db = await getDB();
  const tx = db.transaction(AUDIO_STORE, "readonly");
  const record = await promisifyRequest(tx.objectStore(AUDIO_STORE).get(fingerprintId));
  return record?.blob;
}

/**
 * @param {string} fingerprintId
 * @returns {Promise<void>}
 */
export async function deleteAudioBlob(fingerprintId) {
  const db = await getDB();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).delete(fingerprintId);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Timestamps ----------

/**
 * @typedef {Object} TimestampRecord
 * @property {string} id
 * @property {string} fingerprintId
 * @property {number} time - seconds into the audio
 * @property {string} title
 * @property {string} comment
 * @property {number} createdAt - epoch ms
 * @property {boolean} [countOffEnabled] - play an 8-click metronome count-off before jumping here
 * @property {number} [countOffBpm] - tempo for the count-off (auto-detected from the click track, or manually entered)
 */

/**
 * Adds a new timestamp. Generates an id if one isn't provided.
 * @param {Omit<TimestampRecord, "id"> & { id?: string }} timestamp
 * @returns {Promise<TimestampRecord>}
 */
export async function addTimestamp(timestamp) {
  const record = {
    id: timestamp.id ?? crypto.randomUUID(),
    ...timestamp,
  };
  const db = await getDB();
  const tx = db.transaction(TIMESTAMPS_STORE, "readwrite");
  tx.objectStore(TIMESTAMPS_STORE).add(record);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return record;
}

/**
 * Updates an existing timestamp (title/comment edits, time nudges).
 * @param {TimestampRecord} timestamp
 * @returns {Promise<void>}
 */
export async function updateTimestamp(timestamp) {
  const db = await getDB();
  const tx = db.transaction(TIMESTAMPS_STORE, "readwrite");
  tx.objectStore(TIMESTAMPS_STORE).put(timestamp);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteTimestamp(id) {
  const db = await getDB();
  const tx = db.transaction(TIMESTAMPS_STORE, "readwrite");
  tx.objectStore(TIMESTAMPS_STORE).delete(id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Returns all timestamps for a given file, sorted earliest-to-latest.
 * @param {string} fingerprintId
 * @returns {Promise<TimestampRecord[]>}
 */
export async function getTimestampsForFile(fingerprintId) {
  const db = await getDB();
  const tx = db.transaction(TIMESTAMPS_STORE, "readonly");
  const index = tx.objectStore(TIMESTAMPS_STORE).index(FINGERPRINT_INDEX);
  const all = await promisifyRequest(index.getAll(fingerprintId));
  return all.sort((a, b) => a.time - b.time);
}
