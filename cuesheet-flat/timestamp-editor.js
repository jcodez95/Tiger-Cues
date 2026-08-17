// timestamp-editor.js — the bottom-sheet editor opened when a timestamp is
// created or when the user taps a list row's edit icon. Deliberately does
// NOT pause playback when it opens: per the project's speed requirement,
// the user should be able to keep listening while typing a title/comment.
//
// This module owns the sheet's DOM lifecycle (open/close/transition) and
// input handling; it has no direct db.js dependency — edits are reported
// via onSave/onDelete callbacks so player-view.js stays the single place
// that talks to storage. Tempo detection similarly goes through an
// onDetectTempo callback — this module doesn't know anything about Web
// Audio decoding, it just asks for a number and displays the result.

import { formatTimePrecise, parseTimeString } from "./utils.js";

const SAVE_DEBOUNCE_MS = 250;

/**
 * @param {{
 *   onSave: (record: import("./db.js").TimestampRecord) => void,
 *   onDelete: (id: string) => void,
 *   onDetectTempo: (atTime: number) => Promise<{ bpm: number, onsetCount: number } | null>,
 * }} opts
 */
export function initTimestampEditor({ onSave, onDelete, onDetectTempo }) {
  const backdrop = document.getElementById("sheet-backdrop");
  const sheet = document.getElementById("timestamp-editor");
  const timeInput = document.getElementById("editor-time-input");
  const timeErrorEl = document.getElementById("editor-time-error");
  const titleInput = document.getElementById("editor-title-input");
  const commentInput = document.getElementById("editor-comment-input");
  const doneBtn = document.getElementById("btn-editor-done");
  const deleteBtn = document.getElementById("btn-editor-delete");
  const nudgeButtons = sheet.querySelectorAll(".nudge-btn");
  const countOffToggle = document.getElementById("editor-countoff-toggle");
  const countOffDetails = document.getElementById("countoff-details");
  const bpmInput = document.getElementById("editor-bpm-input");
  const detectBtn = document.getElementById("btn-detect-tempo");
  const countOffStatusEl = document.getElementById("countoff-status");

  /** @type {import("./db.js").TimestampRecord | null} */
  let current = null;
  let saveTimer = null;
  let maxDuration = Infinity;

  function isOpen() {
    return current !== null;
  }

  /** @param {number} duration - the currently loaded file's duration, for clamping typed times */
  function setMaxDuration(duration) {
    maxDuration = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  }

  /** @param {import("./db.js").TimestampRecord} record */
  function open(record) {
    current = {
      ...record,
      countOffEnabled: record.countOffEnabled ?? false,
      countOffBpm: record.countOffBpm ?? null,
    };

    timeInput.value = formatTimePrecise(current.time);
    clearTimeError();
    titleInput.value = current.title;
    commentInput.value = current.comment;

    countOffToggle.setAttribute("aria-checked", String(current.countOffEnabled));
    countOffDetails.hidden = !current.countOffEnabled;
    bpmInput.value = current.countOffBpm ?? "";
    setCountOffStatus(current.countOffBpm ? `Tempo: ${current.countOffBpm} BPM` : "");

    backdrop.hidden = false;
    sheet.hidden = false;
    // Next frame, so the hidden->visible change doesn't skip the transition.
    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
      sheet.classList.add("is-open");
    });

    titleInput.focus();
    titleInput.select();
  }

  function close() {
    if (!isOpen()) return;
    flushSave();
    current = null;

    backdrop.classList.remove("is-open");
    sheet.classList.remove("is-open");
    // Match the CSS transition duration before actually hiding.
    setTimeout(() => {
      backdrop.hidden = true;
      sheet.hidden = true;
    }, 200);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (current) onSave({ ...current });
  }

  function clearTimeError() {
    timeErrorEl.textContent = "";
  }

  function showTimeError(message) {
    timeErrorEl.textContent = message;
  }

  function setCountOffStatus(message, isError = false) {
    countOffStatusEl.textContent = message;
    countOffStatusEl.classList.toggle("status-error", isError);
  }

  // ---------- Title / comment ----------

  titleInput.addEventListener("input", () => {
    if (!current) return;
    current.title = titleInput.value;
    scheduleSave();
  });

  commentInput.addEventListener("input", () => {
    if (!current) return;
    current.comment = commentInput.value;
    scheduleSave();
  });

  // ---------- Precise time entry ----------

  timeInput.addEventListener("change", () => {
    if (!current) return;
    const parsed = parseTimeString(timeInput.value);
    if (parsed === null || parsed < 0 || parsed > maxDuration) {
      timeInput.value = formatTimePrecise(current.time); // revert to last known-good value
      showTimeError("Enter a time like 1:10.05, within the file's length.");
      return;
    }
    current.time = parsed;
    timeInput.value = formatTimePrecise(current.time);
    clearTimeError();
    flushSave();
  });

  // ---------- Nudge buttons ----------

  for (const btn of nudgeButtons) {
    btn.addEventListener("click", () => {
      if (!current) return;
      const delta = parseFloat(btn.dataset.nudge);
      current.time = Math.min(maxDuration, Math.max(0, current.time + delta));
      timeInput.value = formatTimePrecise(current.time);
      clearTimeError();
      flushSave(); // discrete action — persist immediately, not debounced
    });
  }

  // ---------- Metronome count-off ----------

  countOffToggle.addEventListener("click", () => {
    if (!current) return;
    current.countOffEnabled = !current.countOffEnabled;
    countOffToggle.setAttribute("aria-checked", String(current.countOffEnabled));
    countOffDetails.hidden = !current.countOffEnabled;
    flushSave();

    if (current.countOffEnabled && !current.countOffBpm) {
      runDetection();
    }
  });

  bpmInput.addEventListener("input", () => {
    if (!current) return;
    const value = parseFloat(bpmInput.value);
    current.countOffBpm = Number.isFinite(value) && value > 0 ? value : null;
    scheduleSave();
  });

  detectBtn.addEventListener("click", () => {
    runDetection();
  });

  async function runDetection() {
    if (!current) return;
    const atTime = current.time;
    setCountOffStatus("Detecting tempo…");
    detectBtn.disabled = true;
    try {
      const result = await onDetectTempo(atTime);
      if (!current) return; // editor was closed mid-detection — abandon quietly
      if (result) {
        current.countOffBpm = Math.round(result.bpm);
        bpmInput.value = current.countOffBpm;
        setCountOffStatus(
          `Detected ${current.countOffBpm} BPM from ${result.onsetCount} clicks — adjust below if needed.`
        );
        flushSave();
      } else {
        setCountOffStatus("Couldn't auto-detect a tempo here — enter it manually below.", true);
      }
    } catch (err) {
      console.warn("Tempo detection failed:", err);
      setCountOffStatus("Tempo detection failed — enter the BPM manually below.", true);
    } finally {
      if (current) detectBtn.disabled = false;
    }
  }

  // ---------- Delete ----------

  deleteBtn.addEventListener("click", () => {
    if (!current) return;
    const label = current.title || "this timestamp";
    if (window.confirm(`Delete "${label}"? This can't be undone.`)) {
      const id = current.id;
      current = null; // prevent close() from re-saving a deleted record
      onDelete(id);
      backdrop.classList.remove("is-open");
      sheet.classList.remove("is-open");
      setTimeout(() => {
        backdrop.hidden = true;
        sheet.hidden = true;
      }, 200);
    }
  });

  doneBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  return { open, close, isOpen, setMaxDuration };
}
