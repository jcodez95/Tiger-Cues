// scrub-rate.js — maps how far the user has dragged vertically away from
// the timeline track to a scrub-speed multiplier, mimicking the
// "drag up to slow down" gesture from iOS's native Music/Podcasts scrubber.
// Near the track, dragging maps directly to time (rate 1 = full speed).
// The further up the user drags, the smaller a given horizontal finger
// movement's effect on playback time becomes — letting them park a
// timestamp to the exact frame instead of being limited by how many
// pixels wide the track is.
//
// Pulled out as a pure function (no DOM) so the zone thresholds can be
// unit-tested directly — see scripts/test-scrub-rate.mjs.

const ZONES = [
  { maxDy: 40, rate: 1, label: null },
  { maxDy: 90, rate: 0.3, label: "Fine Scrub" },
  { maxDy: 140, rate: 0.08, label: "Finer Scrub" },
  { maxDy: Infinity, rate: 0.02, label: "Finest Scrub" },
];

/**
 * @param {number} dy - absolute vertical pixel distance from the drag's start point
 * @returns {{ rate: number, label: string | null }} rate: multiplier applied to
 *   horizontal drag distance when converting to a time delta. label: text to
 *   show the user for this zone, or null when at full (normal) speed.
 */
export function scrubRateForOffset(dy) {
  const absDy = Math.abs(dy);
  for (const zone of ZONES) {
    if (absDy < zone.maxDy) return { rate: zone.rate, label: zone.label };
  }
  // Unreachable (last zone's maxDy is Infinity) but keeps the function total.
  return { rate: ZONES[ZONES.length - 1].rate, label: ZONES[ZONES.length - 1].label };
}
