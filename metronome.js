// metronome.js — schedules a short count-off of synthesized click sounds
// at a given tempo, using the Web Audio API's own clock (AudioContext
// scheduling) rather than setTimeout for the individual clicks, so the
// spacing stays tight even over several seconds — setTimeout drifts
// enough over 8 beats to sound noticeably off.
//
// The AudioContext is created/resumed lazily, and MUST be done so
// synchronously within a user-gesture handler (a tap) — iOS Safari blocks
// audio contexts started outside one, same rule as <audio>.play(). See
// player-view.js for how this is called.

const CLICK_DURATION = 0.05; // seconds — short percussive blip
const LEAD_IN = 0.05; // tiny cushion so the very first click isn't clipped

export class Metronome {
  constructor() {
    /** @type {AudioContext | null} */
    this._ctx = null;
    this._timers = [];
    /** @type {OscillatorNode[]} */
    this._activeOscillators = [];
    this._isCountingOff = false;
  }

  get isCountingOff() {
    return this._isCountingOff;
  }

  _ensureContext() {
    if (!this._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._ctx = new Ctx();
    }
    if (this._ctx.state === "suspended") {
      this._ctx.resume();
    }
    return this._ctx;
  }

  /**
   * Plays `count` short click sounds spaced 60/bpm seconds apart, then
   * calls onComplete. Must be invoked synchronously within a user-gesture
   * handler (a tap) — see module docs above.
   * @param {{ bpm: number, count?: number, accentEvery?: number, onComplete?: () => void }} opts
   */
  playCountOff({ bpm, count = 8, accentEvery = 4, onComplete }) {
    this.cancel(); // clear any previous pending count-off first

    if (!Number.isFinite(bpm) || bpm <= 0) {
      onComplete?.();
      return;
    }

    this._isCountingOff = true;
    const ctx = this._ensureContext();
    const interval = 60 / bpm;
    const startTime = ctx.currentTime + LEAD_IN;

    for (let i = 0; i < count; i++) {
      const t = startTime + i * interval;
      const isAccent = i % accentEvery === 0;
      this._scheduleClick(ctx, t, isAccent);
    }

    const totalMs = (count * interval + LEAD_IN) * 1000;
    const timer = setTimeout(() => {
      this._isCountingOff = false;
      onComplete?.();
    }, totalMs);
    this._timers.push(timer);
  }

  _scheduleClick(ctx, time, isAccent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = isAccent ? 1800 : 1200;

    // Fast attack/decay envelope so it reads as a "click," not a tone.
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.5 : 0.35, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + CLICK_DURATION);

    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + CLICK_DURATION + 0.01);

    this._activeOscillators.push(osc);
    osc.addEventListener("ended", () => {
      const idx = this._activeOscillators.indexOf(osc);
      if (idx !== -1) this._activeOscillators.splice(idx, 1);
    });
  }

  /**
   * Stops any pending/sounding count-off immediately and prevents its
   * onComplete from firing. Safe to call even when nothing is counting off.
   */
  cancel() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];

    for (const osc of this._activeOscillators) {
      try {
        osc.stop();
      } catch {
        // Already stopped — safe to ignore.
      }
    }
    this._activeOscillators = [];
    this._isCountingOff = false;
  }
}
