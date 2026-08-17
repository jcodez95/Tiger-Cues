// tempo-detect.js — browser-only wrapper around onset-detect.js. Decodes
// an audio Blob into raw PCM via the Web Audio API's decodeAudioData, then
// hands a window of samples to the pure detection logic.
//
// Decoding a whole file is the only way decodeAudioData works (there's no
// way to decode just a slice without manually parsing the container), so
// for a very large file this can take a moment and use real memory —
// acceptable here because it's triggered lazily (only when the user
// actually turns on count-off for a timestamp) and cached per fingerprint
// for the rest of the session, not run automatically on every file load.

import { estimateTempo } from "./onset-detect.js";

const WINDOW_SECONDS = 10; // analyze up to this many seconds starting at the timestamp

/** @type {Map<string, Promise<AudioBuffer>>} fingerprintId -> decoded buffer */
const decodedCache = new Map();

function getDecodedBuffer(fingerprintId, blob) {
  if (!decodedCache.has(fingerprintId)) {
    decodedCache.set(fingerprintId, decode(blob));
  }
  return decodedCache.get(fingerprintId);
}

async function decode(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    // Some browsers only support the older callback form; the promise form
    // covers current Safari/Chrome/Firefox, which is our target set.
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close().catch(() => {});
  }
}

/**
 * Estimates the click track's tempo starting at a given point in the file.
 * @param {{ fingerprintId: string, blob: Blob, atTime: number }} opts
 * @returns {Promise<{ bpm: number, onsetCount: number } | null>}
 */
export async function detectTempoAt({ fingerprintId, blob, atTime }) {
  if (!blob) return null;

  const buffer = await getDecodedBuffer(fingerprintId, blob);
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0); // mono analysis is sufficient for click detection

  const startSample = Math.max(0, Math.floor(atTime * sampleRate));
  const endSample = Math.min(channelData.length, startSample + Math.floor(WINDOW_SECONDS * sampleRate));
  if (endSample - startSample < sampleRate * 1) return null; // not enough audio left to analyze

  return estimateTempo(channelData, sampleRate, startSample, endSample);
}

/**
 * Drops any decoded buffer cached for a fingerprint (e.g. if a file is
 * removed from the library, or to free memory). Not required for correct
 * behavior — decoded buffers are already scoped to a single session (an
 * in-memory Map, never persisted) — but available for cleanliness.
 * @param {string} fingerprintId
 */
export function clearDecodedCache(fingerprintId) {
  decodedCache.delete(fingerprintId);
}
