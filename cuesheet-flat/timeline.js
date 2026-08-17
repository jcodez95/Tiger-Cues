// timeline.js — a custom, touch-friendly progress bar. Deliberately not a
// native <input type="range">: we need to draw timestamp markers on top of
// it and native range styling/hit-testing is inconsistent enough across
// iOS/Android/desktop that a custom track is more reliable.
//
// This module knows nothing about the <audio> element or AudioEngine — it
// only reports "the user wants to be at time X" via onSeek, and exposes
// setCurrentTime()/setDuration() for the caller to push playback state in.
// That keeps it independently reusable and testable.
//
// Uses the Pointer Events API (pointerdown/move/up) so touch and mouse
// dragging share one code path instead of separate touch/mouse listeners.
//
// VARIABLE-SPEED SCRUBBING: the initial touch-down always seeks directly
// to the tapped position (fast, intuitive). Once dragging, moving the
// finger straight across continues to map 1:1 to time — but dragging
// *upward*, away from the track, progressively reduces how much time
// moves per pixel of horizontal movement (see scrub-rate.js).
//
// ZOOM: rather than making the track DOM element wider and scrollable
// (which would fight with our single-pointer drag-to-scrub gesture — a
// horizontal swipe would be ambiguous between "scrub" and "pan the zoomed
// view"), zooming narrows the TIME RANGE the fixed-width track represents,
// centered on wherever the playhead currently is. At 4x zoom on a 3-minute
// file, the track represents a 45-second window instead of the full 3
// minutes — the same pixel-width now maps to far less time, giving much
// finer positioning with the exact same drag interaction, no new gesture
// types, and no scroll-vs-drag ambiguity. During normal playback at a
// zoom level above 1x, the window automatically re-centers if playback
// runs past its edge, so it keeps following along.

import { formatTime } from "./utils.js";
import { scrubRateForOffset } from "./scrub-rate.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class Timeline {
  /**
   * @param {{
   *   container: HTMLElement,   // the outer .timeline element (larger hit area for touch)
   *   track: HTMLElement,       // the thin visual track — used for x-position math
   *   progressEl: HTMLElement,  // filled portion
   *   playheadEl: HTMLElement,  // the draggable thumb
   *   markersEl: HTMLElement,   // container for timestamp marker dots
   *   scrubLabelEl: HTMLElement,// small pill shown during slow-speed dragging
   *   onSeek: (time: number) => void,
   * }} opts
   */
  constructor({ container, track, progressEl, playheadEl, markersEl, scrubLabelEl, onSeek }) {
    this.container = container;
    this.track = track;
    this.progressEl = progressEl;
    this.playheadEl = playheadEl;
    this.markersEl = markersEl;
    this.scrubLabelEl = scrubLabelEl;
    this.onSeek = onSeek;

    this._duration = 0;
    this._dragging = false;
    /** @type {Map<string, HTMLElement>} */
    this._markerEls = new Map();
    /** @type {{ id: string, time: number, label?: string }[]} */
    this._lastMarkers = [];

    // Zoom / visible-window state. At zoomLevel 1, the window always
    // spans the full [0, duration] range (same as before zoom existed).
    this._zoomLevel = 1;
    this._windowStart = 0;
    this._windowSpan = 0;

    // Drag-in-progress state for variable-speed scrubbing.
    this._trackWidth = 0;
    this._dragStartY = 0;
    this._dragRate = 1;
    this._anchorX = 0;
    this._anchorTime = 0;
    this._liveTime = 0;

    this.container.addEventListener("pointerdown", this._handlePointerDown);
    this.container.addEventListener("pointermove", this._handlePointerMove);
    this.container.addEventListener("pointerup", this._handlePointerUp);
    this.container.addEventListener("pointercancel", this._handlePointerUp);
  }

  get isDragging() {
    return this._dragging;
  }

  get zoomLevel() {
    return this._zoomLevel;
  }

  /**
   * @param {number} duration - seconds
   */
  setDuration(duration) {
    this._duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    // A new file always starts unzoomed, viewing the whole thing.
    this._zoomLevel = 1;
    this._windowStart = 0;
    this._windowSpan = this._duration;
  }

  /**
   * Changes the zoom level, re-centering the visible window on `centerTime`
   * (typically the current playhead position, so zooming "in" narrows the
   * view around wherever you already are).
   * @param {number} level - e.g. 1, 2, 4, 8, 16
   * @param {number} centerTime - seconds
   */
  setZoom(level, centerTime) {
    if (this._duration <= 0) return;
    this._zoomLevel = Math.max(1, level);
    this._windowSpan = this._duration / this._zoomLevel;
    this._recenterWindow(centerTime);
    this._renderPlayhead(this._liveTime || centerTime);
    this._redrawMarkers();
  }

  /**
   * Pushes the current playback position into the visual display. Ignored
   * while the user is actively dragging, so playback updates can't fight
   * the finger/pointer mid-drag. When zoomed in, if playback has moved
   * outside the currently visible window, re-centers the window to follow it.
   * @param {number} time - seconds
   */
  setCurrentTime(time) {
    if (this._dragging) return;
    if (this._zoomLevel > 1 && (time < this._windowStart || time > this._windowStart + this._windowSpan)) {
      this._recenterWindow(time);
      this._redrawMarkers();
    }
    this._renderPlayhead(time);
  }

  /**
   * Replaces the set of timestamp markers drawn on the track. Markers
   * outside the currently visible (zoomed) window are simply not rendered,
   * rather than clamped to the edge, to avoid misleading clustering.
   * @param {{ id: string, time: number, label?: string }[]} markers
   */
  setMarkers(markers) {
    this._lastMarkers = markers;
    this._redrawMarkers();
  }

  _redrawMarkers() {
    this.markersEl.innerHTML = "";
    this._markerEls.clear();

    if (this._duration <= 0) return;

    const windowEnd = this._windowStart + this._windowSpan;

    for (const marker of this._lastMarkers) {
      if (marker.time < this._windowStart || marker.time > windowEnd) continue;

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "timeline-marker";
      dot.style.left = `${this._ratioFor(marker.time) * 100}%`;
      dot.dataset.id = marker.id;
      dot.setAttribute(
        "aria-label",
        `Jump to ${marker.label ?? "timestamp"} at ${formatTime(marker.time)}`
      );

      // Seek to the marker's exact stored time (not the tap's pixel
      // position, which could be a hair off for a small dot) and stop the
      // event from also reaching the container's drag handler.
      dot.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        this._seekTo(marker.time);
      });

      this.markersEl.appendChild(dot);
      this._markerEls.set(marker.id, dot);
    }
  }

  _recenterWindow(centerTime) {
    const maxStart = Math.max(0, this._duration - this._windowSpan);
    this._windowStart = clamp(centerTime - this._windowSpan / 2, 0, maxStart);
  }

  _ratioFor(time) {
    return this._windowSpan > 0 ? clamp((time - this._windowStart) / this._windowSpan, 0, 1) : 0;
  }

  _renderPlayhead(time) {
    const pct = `${this._ratioFor(time) * 100}%`;
    this.progressEl.style.width = pct;
    this.playheadEl.style.left = pct;
  }

  _timeFromAbsolutePointer(event) {
    const rect = this.track.getBoundingClientRect();
    const ratio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
    return this._windowStart + ratio * this._windowSpan;
  }

  _handlePointerDown = (event) => {
    if (this._duration <= 0) return;
    this._dragging = true;
    this.container.classList.add("is-dragging");
    try {
      this.container.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail in rare edge cases (e.g. pointerId already
      // released); dragging still works via move/up on the container.
    }

    // The initial touch-down always seeks directly to the tapped position —
    // fast and predictable — and becomes the anchor for any slow-speed
    // relative dragging that follows.
    const time = this._timeFromAbsolutePointer(event);
    this._trackWidth = this.track.getBoundingClientRect().width;
    this._dragStartY = event.clientY;
    this._dragRate = 1;
    this._anchorX = event.clientX;
    this._anchorTime = time;
    this._liveTime = time;

    this._seekTo(time);
  };

  _handlePointerMove = (event) => {
    if (!this._dragging) return;

    const dy = event.clientY - this._dragStartY;
    const { rate, label } = scrubRateForOffset(dy);

    // Changing speed zones mid-drag resets the anchor to the current live
    // position, so the seek position never jumps when the user's finger
    // crosses a zone boundary — only the sensitivity from that point on changes.
    if (rate !== this._dragRate) {
      this._dragRate = rate;
      this._anchorX = event.clientX;
      this._anchorTime = this._liveTime;
    }

    this._setScrubLabel(label);

    if (this._trackWidth > 0 && this._windowSpan > 0) {
      const dx = event.clientX - this._anchorX;
      // Uses the current ZOOMED window span, not the full duration — this
      // is what makes zoom actually increase precision: the same pixel
      // distance now represents proportionally less time.
      const deltaTime = dx * (this._windowSpan / this._trackWidth) * this._dragRate;
      const time = clamp(this._anchorTime + deltaTime, 0, this._duration);
      this._liveTime = time;
      this._seekTo(time);
    }
  };

  _handlePointerUp = (event) => {
    if (!this._dragging) return;
    this._dragging = false;
    this.container.classList.remove("is-dragging");
    this._setScrubLabel(null);
    try {
      this.container.releasePointerCapture(event.pointerId);
    } catch {
      // Already released or invalid — safe to ignore.
    }
    this._seekTo(this._liveTime);
  };

  _setScrubLabel(label) {
    if (!this.scrubLabelEl) return;
    if (label) {
      this.scrubLabelEl.textContent = label;
      this.scrubLabelEl.classList.add("is-visible");
    } else {
      this.scrubLabelEl.classList.remove("is-visible");
    }
  }

  _seekTo(time) {
    this._renderPlayhead(time);
    this.onSeek?.(time);
  }
}
