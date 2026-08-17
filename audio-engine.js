// audio-engine.js — wraps the single shared <audio> element with a small,
// promise-based API. Keeps object-URL lifecycle management (create/revoke)
// and iOS-relevant playback quirks in one place, away from view logic.
//
// Important iOS Safari constraint this module is designed around:
// `audio.play()` must be called synchronously within a user-gesture event
// handler (a tap), or the browser silently rejects it. `load()` itself is
// safe to call from a file-input "change" handler; callers just need to make
// sure `play()` is invoked directly inside a click handler, not after an
// intervening `await`. See player-view.js for how the play button does this.

export class AudioEngine {
  /**
   * @param {HTMLAudioElement} audioElement
   */
  constructor(audioElement) {
    this.audio = audioElement;
    /** @type {string | null} */
    this._objectUrl = null;
    /** @type {Blob | null} */
    this._sourceBlob = null;
  }

  /** Whether a file has been loaded into the element. */
  get hasSource() {
    return this._objectUrl !== null;
  }

  /**
   * The raw Blob/File last passed to load() — used by tempo-detect.js to
   * decode the audio for click-track analysis without needing to fetch it
   * again from IndexedDB or re-request it from the user.
   */
  get sourceBlob() {
    return this._sourceBlob;
  }

  get paused() {
    return this.audio.paused;
  }

  get duration() {
    return this.audio.duration;
  }

  get currentTime() {
    return this.audio.currentTime;
  }

  /**
   * Loads a File/Blob into the audio element and resolves once duration
   * metadata is available. Revokes any previously loaded file's object URL
   * first, so switching files doesn't leak memory.
   * @param {File} file
   * @returns {Promise<number>} duration in seconds
   */
  load(file) {
    this._revokeCurrentUrl();
    this._sourceBlob = file;

    const objectUrl = URL.createObjectURL(file);
    this._objectUrl = objectUrl;

    this.audio.pause();
    this.audio.src = objectUrl;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", onLoaded);
        this.audio.removeEventListener("error", onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve(this.audio.duration);
      };
      const onError = () => {
        cleanup();
        reject(
          new Error(
            "This file couldn't be played. It may be corrupted or in a format this browser doesn't support."
          )
        );
      };

      this.audio.addEventListener("loadedmetadata", onLoaded, { once: true });
      this.audio.addEventListener("error", onError, { once: true });
      this.audio.load();
    });
  }

  /**
   * Starts playback. Must be called directly inside a user-gesture handler
   * on iOS — see module-level note above.
   * @returns {Promise<void>}
   */
  play() {
    return this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  /**
   * Seeks to a specific time, clamped to the valid [0, duration] range.
   * @param {number} time - seconds
   */
  seek(time) {
    const max = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    this.audio.currentTime = Math.max(0, Math.min(time, max));
  }

  /**
   * "Unlocks" the audio element for a LATER programmatic play() call that
   * isn't itself triggered by a fresh user gesture — needed for the
   * metronome count-off flow, where playback should start automatically
   * once the count-off finishes (via a setTimeout), which iOS Safari would
   * otherwise block. iOS only allows this once the element has actually
   * been played, synchronously, from within a real gesture at least once
   * per page session — so this briefly (silently, muted) plays and
   * immediately pauses it. Must be called directly inside a user-gesture
   * handler, same as play().
   */
  unlock() {
    if (!this.hasSource) return;
    const wasMuted = this.audio.muted;
    this.audio.muted = true;
    this.audio
      .play()
      .catch(() => {
        // If even the unlock play() is rejected, there's nothing more we
        // can do here — the later programmatic play() may also fail, in
        // which case attemptPlay()'s own error handling surfaces that.
      })
      .finally(() => {
        this.audio.pause();
        this.audio.muted = wasMuted;
      });
  }

  _revokeCurrentUrl() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
  }
}
