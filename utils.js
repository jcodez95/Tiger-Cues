// utils.js — small formatting helpers shared across view modules.

/**
 * Formats a duration in seconds as "m:ss" (e.g. 77.8 -> "1:17").
 * Returns "0:00" for invalid/negative input so UI never shows "NaN:NaN"
 * before metadata has loaded.
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Formats a duration in seconds with hundredths-of-a-second precision
 * (e.g. 70.05 -> "1:10.05"). Used anywhere the user is actively fine-tuning
 * a position (dragging the timeline, editing a timestamp's exact time) —
 * everyday playback display sticks with the whole-second formatTime()
 * above to stay uncluttered.
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimePrecise(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.00";
  const totalHundredths = Math.round(seconds * 100);
  const mins = Math.floor(totalHundredths / 6000);
  const secs = Math.floor((totalHundredths % 6000) / 100);
  const hundredths = totalHundredths % 100;
  return `${mins}:${String(secs).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

/**
 * Parses a typed time string back into seconds. Accepts:
 *   "70"        -> 70 (bare seconds, decimals allowed: "70.5")
 *   "1:10"      -> 70 (minutes:seconds)
 *   "1:10.05"   -> 70.05 (minutes:seconds.hundredths — matches formatTimePrecise's output)
 *   "1:10:05"   -> 70.05 (same as above; colon accepted in place of the
 *                  period before the final segment, since that's how some
 *                  people naturally type a third time-like segment)
 * Does NOT support an hours component — deliberately: supporting it would
 * make "M:SS:ff" ambiguous with "H:M:SS", and rehearsal recordings are
 * essentially always under an hour. Returns null for anything that doesn't
 * cleanly match one of the above (never guesses).
 * @param {string} input
 * @returns {number | null}
 */
export function parseTimeString(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":");

  if (parts.length === 1) {
    const value = Number(parts[0]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (parts.length === 2 || parts.length === 3) {
    const minutes = Number(parts[0]);
    // The seconds segment may itself carry a decimal fraction ("1:10.05"),
    // in which case there's no separate third part.
    const secondsPart = parts[1];
    const seconds = Number(secondsPart);
    if (!Number.isFinite(minutes) || minutes < 0) return null;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 60) return null;

    let fraction = 0;
    if (parts.length === 3) {
      const fracDigits = parts[2].trim();
      if (!/^\d{1,3}$/.test(fracDigits)) return null;
      fraction = Number(fracDigits) / Math.pow(10, fracDigits.length);
    }

    return minutes * 60 + seconds + fraction;
  }

  return null;
}

/**
 * Formats a past epoch-ms timestamp as a short relative label for the
 * library list (e.g. "Today", "Yesterday", "3 days ago", "Jun 12").
 * @param {number} epochMs
 * @returns {string}
 */
export function formatRelativeDate(epochMs) {
  const diffDays = Math.floor((Date.now() - epochMs) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
