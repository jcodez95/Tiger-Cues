// fingerprint.js — derives a stable identifier for an audio file so that
// re-picking the same file in a later session (see README: iOS doesn't
// reliably persist large audio blobs) — or loading the audio file a
// cue sheet was exported for, on a DIFFERENT device — can be matched
// back to its saved library entry and timestamps, without reading/hashing
// the whole file.
//
// This is a heuristic, not a cryptographic hash: filename + exact file
// size. Good enough to distinguish "Concert Rehearsal.wav" from "Tuba
// Warmup.mp3" reliably, cheap to compute, and fast even for large WAV
// files. Trade-off (accepted per project plan): renaming a file, or
// re-exporting/re-encoding it (which changes its byte size), will
// register as a "new" file rather than reconnecting — a fresh library
// entry with no timestamps, rather than data loss or a wrong match.
//
// DELIBERATELY does NOT include duration, even though it's tempting as a
// third disambiguating field: duration is measured by actually decoding
// the audio, and different browsers/platforms can report slightly
// different durations for the exact same bytes — this is especially
// common for MP3, where duration is often estimated by scanning frame
// headers rather than read from a reliable field, and different decoders
// (e.g. Safari/WebKit's AVFoundation vs. Chrome's FFmpeg-based decoder)
// can disagree by more than the rounding tolerance absorbs. This was
// observed breaking cross-device cue sheet import specifically: export a
// cue sheet on one device, load the identical audio file on an iPhone,
// and a large-enough duration discrepancy made the fingerprints not
// match, leaving the file stuck on "Needs re-select" even though it WAS
// the right file. Filename + exact byte size alone is already
// astronomically unlikely to collide for two genuinely different
// recordings, so dropping duration trades away negligible collision
// protection for real cross-platform reliability.

/**
 * @param {{ filename: string, fileSize: number }} info
 * @returns {string}
 */
export function computeFingerprint({ filename, fileSize }) {
  const normalizedName = filename.trim().toLowerCase();
  return `${normalizedName}::${fileSize}`;
}
