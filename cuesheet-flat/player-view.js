// player-view.js — controls the "Player" screen: transport controls, the
// timeline/scrub bar, and timestamp creation/list/editing. This is the
// orchestrator for the screen — actual rendering/DOM-lifecycle work for
// the list and editor lives in timestamp-list.js and timestamp-editor.js;
// storage lives in db.js. This file wires them together and owns the
// in-memory copy of "timestamps for the currently open file".

import { formatTime, formatTimePrecise } from "./utils.js";
import { Timeline } from "./timeline.js";
import { renderTimestampList } from "./timestamp-list.js";
import { initTimestampEditor } from "./timestamp-editor.js";
import { Metronome } from "./metronome.js";
import { detectTempoAt } from "./tempo-detect.js";
import { buildCuesheetExport, suggestExportFilename } from "./cuesheet-io.js";
import { addTimestamp, updateTimestamp, deleteTimestamp, getTimestampsForFile } from "./db.js";

/**
 * @param {{ showView: (name: "library" | "player") => void, engine: import("./audio-engine.js").AudioEngine }} deps
 * @returns {{
 *   onFileOpened: (info: { filename: string, duration: number, fingerprintId: string }) => void,
 *   closeEditor: () => void,
 *   stopCountOff: () => void,
 * }}
 */
export function initPlayerView({ showView, engine }) {
  const filenameEl = document.getElementById("player-filename");
  const playPauseBtn = document.getElementById("btn-play-pause");
  const currentTimeEl = document.getElementById("time-current");
  const durationEl = document.getElementById("time-duration");
  const statusEl = document.getElementById("player-status");
  const addTimestampBtn = document.getElementById("btn-add-timestamp");
  const timestampListEl = document.getElementById("timestamp-list");
  const zoomInBtn = document.getElementById("btn-zoom-in");
  const zoomOutBtn = document.getElementById("btn-zoom-out");
  const zoomLevelLabel = document.getElementById("zoom-level-label");
  const exportBtn = document.getElementById("btn-export-cuesheet");

  const ZOOM_LEVELS = [1, 2, 4, 8, 16];
  let zoomIndex = 0;

  /** @type {string | null} fingerprintId of the currently open file */
  let currentFingerprintId = null;
  /** @type {{ filename: string, fileSize: number, duration: number } | null} */
  let currentFileInfo = null;
  /** @type {import("./db.js").TimestampRecord[]} in-memory mirror, kept sorted by time */
  let currentTimestamps = [];

  const timeline = new Timeline({
    container: document.getElementById("timeline"),
    track: document.querySelector("#timeline .timeline-track"),
    progressEl: document.querySelector("#timeline .timeline-progress"),
    playheadEl: document.querySelector("#timeline .timeline-playhead"),
    markersEl: document.querySelector("#timeline .timeline-markers"),
    scrubLabelEl: document.getElementById("timeline-scrub-label"),
    onSeek: (time) => {
      engine.seek(time);
      currentTimeEl.textContent = formatTimePrecise(time);
    },
  });

  const metronome = new Metronome();

  /** @param {number} atTime */
  function detectTempoForCurrentFile(atTime) {
    const blob = engine.sourceBlob;
    if (!blob || !currentFingerprintId) return Promise.resolve(null);
    return detectTempoAt({ fingerprintId: currentFingerprintId, blob, atTime });
  }

  const editor = initTimestampEditor({
    onSave: handleEditorSave,
    onDelete: handleEditorDelete,
    onDetectTempo: detectTempoForCurrentFile,
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && editor.isOpen()) {
      editor.close();
    }
  });

  function setPlayingUI(isPlaying) {
    playPauseBtn.querySelector("span").textContent = isPlaying ? "❚❚" : "▶";
    playPauseBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  }

  function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle("status-error", isError);
  }

  function attemptPlay() {
    engine.play().catch((err) => {
      setStatus(`Couldn't start playback: ${err.message}`, true);
    });
  }

  playPauseBtn.addEventListener("click", () => {
    if (!engine.hasSource) return;

    if (metronome.isCountingOff) {
      metronome.cancel();
      setStatus("");
      setPlayingUI(false);
      return;
    }

    // NOTE: engine.play() must be invoked synchronously within this click
    // handler (no `await` before it) — iOS Safari requires playback to
    // start directly inside a user-gesture callback. See audio-engine.js.
    if (engine.paused) {
      attemptPlay();
    } else {
      engine.pause();
    }
  });

  function updateZoomUI() {
    zoomLevelLabel.textContent = `${ZOOM_LEVELS[zoomIndex]}×`;
    zoomOutBtn.disabled = zoomIndex === 0;
    zoomInBtn.disabled = zoomIndex === ZOOM_LEVELS.length - 1;
  }

  zoomInBtn.addEventListener("click", () => {
    if (zoomIndex >= ZOOM_LEVELS.length - 1) return;
    zoomIndex++;
    timeline.setZoom(ZOOM_LEVELS[zoomIndex], engine.currentTime);
    updateZoomUI();
  });

  zoomOutBtn.addEventListener("click", () => {
    if (zoomIndex <= 0) return;
    zoomIndex--;
    timeline.setZoom(ZOOM_LEVELS[zoomIndex], engine.currentTime);
    updateZoomUI();
  });

  exportBtn.addEventListener("click", async () => {
    if (!currentFileInfo) return;

    const exportData = buildCuesheetExport(currentFileInfo, currentTimestamps);
    const json = JSON.stringify(exportData, null, 2);
    const filename = suggestExportFilename(currentFileInfo.filename);
    const blob = new Blob([json], { type: "application/json" });

    // Prefer the native share sheet where available (e.g. iOS Safari) —
    // lets the user AirDrop/Message/email the file directly, rather than
    // downloading it and then having to go find it to share separately.
    if (navigator.canShare) {
      const shareFile = new File([blob], filename, { type: "application/json" });
      if (navigator.canShare({ files: [shareFile] })) {
        try {
          await navigator.share({ files: [shareFile], title: `${currentFileInfo.filename} — Cue Sheet` });
          return;
        } catch (err) {
          if (err.name === "AbortError") return; // user cancelled the share sheet — not an error
          console.warn("Share failed, falling back to direct download:", err);
        }
      }
    }

    // Fallback: trigger a direct file download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  engine.audio.addEventListener("play", () => setPlayingUI(true));
  engine.audio.addEventListener("pause", () => setPlayingUI(false));
  engine.audio.addEventListener("ended", () => setPlayingUI(false));
  engine.audio.addEventListener("timeupdate", () => {
    // While the user is actively dragging the timeline, the drag's own
    // onSeek callback already owns the current-time display — letting
    // natural playback updates through here too would fight the drag.
    if (timeline.isDragging) return;
    currentTimeEl.textContent = formatTime(engine.currentTime);
    timeline.setCurrentTime(engine.currentTime);
  });

  // ---------- Timestamp creation ----------

  addTimestampBtn.addEventListener("click", async () => {
    if (!engine.hasSource || !currentFingerprintId) return;

    // Capture the time FIRST, synchronously, before any async work — speed
    // matters here (per project requirements), and we don't want an await
    // to introduce drift between "the button was pressed" and "the time we
    // actually save".
    const time = engine.currentTime;

    const record = await addTimestamp({
      fingerprintId: currentFingerprintId,
      time,
      title: `Timestamp ${formatTime(time)}`,
      comment: "",
      createdAt: Date.now(),
    });

    currentTimestamps.push(record);
    sortTimestamps();
    refreshTimestampUI();

    // Auto-open the editor for immediate labeling. Playback is NOT paused —
    // the user can keep listening while typing the title/comment.
    editor.open(record);
  });

  // ---------- Timestamp list interactions ----------

  function handleSelectTimestamp(id) {
    const ts = currentTimestamps.find((t) => t.id === id);
    if (!ts) return;

    metronome.cancel(); // in case a previous count-off is still pending

    if (ts.countOffEnabled && ts.countOffBpm) {
      // "Unlock" the <audio> element now, synchronously within this tap,
      // so the play() call after the count-off (fired from a setTimeout,
      // NOT a fresh user gesture) is allowed to actually start audio on
      // iOS Safari. See audio-engine.js's unlock() for details.
      engine.unlock();

      engine.seek(ts.time);
      currentTimeEl.textContent = formatTime(ts.time);
      timeline.setCurrentTime(ts.time);

      setPlayingUI(true); // show "counting off" as if already playing
      setStatus(`Counting off at ${Math.round(ts.countOffBpm)} BPM…`);

      metronome.playCountOff({
        bpm: ts.countOffBpm,
        count: 8,
        onComplete: () => {
          setStatus("");
          engine.seek(ts.time); // guard against any drift during the count-off
          attemptPlay();
        },
      });
    } else {
      engine.seek(ts.time);
      currentTimeEl.textContent = formatTime(ts.time);
      timeline.setCurrentTime(ts.time);
      attemptPlay();
    }
  }

  function handleEditTimestamp(id) {
    const ts = currentTimestamps.find((t) => t.id === id);
    if (ts) editor.open(ts);
  }

  // ---------- Editor callbacks (persistence) ----------

  /** @param {import("./db.js").TimestampRecord} record */
  async function handleEditorSave(record) {
    await updateTimestamp(record);
    const idx = currentTimestamps.findIndex((t) => t.id === record.id);
    if (idx !== -1) currentTimestamps[idx] = record;
    sortTimestamps();
    refreshTimestampUI();
  }

  /** @param {string} id */
  async function handleEditorDelete(id) {
    await deleteTimestamp(id);
    currentTimestamps = currentTimestamps.filter((t) => t.id !== id);
    refreshTimestampUI();
  }

  // ---------- Shared helpers ----------

  function sortTimestamps() {
    currentTimestamps.sort((a, b) => a.time - b.time);
  }

  function refreshTimestampUI() {
    renderTimestampList({
      container: timestampListEl,
      timestamps: currentTimestamps,
      formatTime,
      onSelect: handleSelectTimestamp,
      onEdit: handleEditTimestamp,
    });
    timeline.setMarkers(
      currentTimestamps.map((t) => ({ id: t.id, time: t.time, label: t.title }))
    );
  }

  /**
   * Called when a file has just been loaded (from the library screen).
   * Resets the transport/timeline and loads that file's saved timestamps.
   * @param {{ filename: string, fileSize: number, duration: number, fingerprintId: string, note?: string }} info
   */
  async function onFileOpened({ filename, fileSize, duration, fingerprintId, note }) {
    currentFingerprintId = fingerprintId;
    currentFileInfo = { filename, fileSize, duration };

    filenameEl.textContent = filename;
    durationEl.textContent = formatTime(duration);
    currentTimeEl.textContent = formatTime(0);
    setPlayingUI(false);
    setStatus(note ?? "");
    addTimestampBtn.disabled = false;
    exportBtn.disabled = false;
    metronome.cancel();
    editor.setMaxDuration(duration);

    zoomIndex = 0;
    zoomInBtn.disabled = false;
    zoomOutBtn.disabled = true; // starts at the lowest zoom level (1x)
    zoomLevelLabel.textContent = "1×";

    timeline.setDuration(duration);
    timeline.setCurrentTime(0);

    currentTimestamps = await getTimestampsForFile(fingerprintId);
    sortTimestamps();
    refreshTimestampUI();
  }

  return { onFileOpened, closeEditor: editor.close, stopCountOff: () => metronome.cancel() };
}
