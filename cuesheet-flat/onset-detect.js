// onset-detect.js — pure signal-processing helpers for estimating a click
// track's tempo from raw PCM samples. No Web Audio / DOM dependency, so
// this can be unit-tested directly with synthetic sample data (see
// scripts/test-onset-detect.mjs) — the browser-only wrapper that actually
// decodes an audio file and calls into this lives in tempo-detect.js.
//
// APPROACH: click tracks have sharp, well-separated percussive transients
// (unlike general music), so a simple energy-envelope peak-picker is
// enough here — no need for a full beat-tracking / autocorrelation
// algorithm. Steps:
//   1. Compute short-window RMS energy across the analysis region.
//   2. Find local peaks above a threshold, enforcing a minimum spacing so
//      a single click's decay tail doesn't get counted as several onsets.
//   3. Take the MEDIAN interval between consecutive onsets — median
//      (not mean) so one missed or spurious detection doesn't skew the
//      result the way an outlier would skew an average.
//
// HONESTY NOTE: this is a simple heuristic, not a robust general-purpose
// beat tracker. It works well on genuinely sharp, consistent click tracks
// (which is the stated use case) and can fail on noisy, quiet, or
// non-percussive material — hence the UI always allows manually entering
// or correcting the detected BPM rather than trusting it blindly.

const HOP_SECONDS = 0.002; // 2ms — finer than a whole-number-of-ms hop keeps
// quantization error low even at fast click tempos (a coarser hop was
// measured to introduce 1+ BPM of error at 180+ BPM; see test-onset-detect.mjs)
const WINDOW_SECONDS = 0.005; // 5ms
const MIN_ONSET_GAP_SECONDS = 0.15; // onsets closer than this are almost
// certainly the same click's decay, not a distinct new click (400bpm cap)
const THRESHOLD_RATIO = 0.3; // a peak must reach this fraction of the loudest moment
const MIN_BPM = 20;
const MAX_BPM = 300;
const MIN_ONSETS_FOR_ESTIMATE = 4;

/**
 * @param {Float32Array} samples - mono PCM samples for the full buffer being searched
 * @param {number} sampleRate
 * @param {number} startSample - inclusive
 * @param {number} endSample - exclusive
 * @returns {number[]} sample indices (into `samples`) of detected onsets
 */
export function detectOnsets(samples, sampleRate, startSample, endSample) {
  const hopSize = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const windowSize = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  const minGapHops = Math.max(1, Math.round(MIN_ONSET_GAP_SECONDS / HOP_SECONDS));

  const envelope = [];
  for (let i = startSample; i < endSample; i += hopSize) {
    const winEnd = Math.min(i + windowSize, endSample);
    let sum = 0;
    for (let j = i; j < winEnd; j++) {
      sum += samples[j] * samples[j];
    }
    envelope.push(Math.sqrt(sum / Math.max(1, winEnd - i)));
  }

  let maxEnv = 0;
  for (const v of envelope) {
    if (v > maxEnv) maxEnv = v;
  }
  if (maxEnv <= 0) return [];
  const threshold = maxEnv * THRESHOLD_RATIO;

  const onsets = [];
  let lastOnsetHop = -Infinity;
  for (let h = 1; h < envelope.length - 1; h++) {
    if (
      envelope[h] >= threshold &&
      envelope[h] >= envelope[h - 1] &&
      envelope[h] >= envelope[h + 1] &&
      h - lastOnsetHop >= minGapHops
    ) {
      onsets.push(startSample + h * hopSize);
      lastOnsetHop = h;
    }
  }
  return onsets;
}

/**
 * @param {number[]} onsetSamples
 * @param {number} sampleRate
 * @returns {number | null} median inter-onset interval, in seconds
 */
function medianInterval(onsetSamples, sampleRate) {
  if (onsetSamples.length < 2) return null;
  const intervals = [];
  for (let i = 1; i < onsetSamples.length; i++) {
    intervals.push((onsetSamples[i] - onsetSamples[i - 1]) / sampleRate);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Estimates BPM from a window of mono PCM samples.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} startSample
 * @param {number} endSample
 * @returns {{ bpm: number, onsetCount: number } | null} null if not
 *   confident (too few onsets detected, or the result falls outside a
 *   plausible click-track tempo range)
 */
export function estimateTempo(samples, sampleRate, startSample, endSample) {
  const onsets = detectOnsets(samples, sampleRate, startSample, endSample);
  if (onsets.length < MIN_ONSETS_FOR_ESTIMATE) return null;

  const interval = medianInterval(onsets, sampleRate);
  if (!interval || interval <= 0) return null;

  const bpm = 60 / interval;
  if (bpm < MIN_BPM || bpm > MAX_BPM) return null;

  return { bpm, onsetCount: onsets.length };
}
