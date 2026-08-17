// library-view.js — controls the "Library" screen: the file-load button
// and the list of previously used audio files.
//
// STATUS: files are now saved (best-effort) so library entries can be
// reopened directly, without re-picking. Tapping a library entry first
// tries to load its cached audio blob straight from IndexedDB; only if
// that's unavailable (never saved, quota-evicted, etc.) does it fall back
// to prompting the user to re-select the file, same as before.
//
// This is a deliberate change from the app's original design (see git
// history / README): storing the audio binary in IndexedDB can be evicted
// by the browser under storage pressure, and older iOS Safari has had
// bugs with large Blobs in IndexedDB. We request persistent storage in
// app.js to reduce (not eliminate) that risk, and every save is wrapped
// so a failure degrades to "you'll need to re-select this file" instead
// of breaking anything.

import { formatTime, formatRelativeDate } from "./utils.js";
import { computeFingerprint } from "./fingerprint.js";
import { parseCuesheetImport } from "./cuesheet-io.js";
import {
  upsertFile,
  getFile,
  getAllFiles,
  deleteFile,
  saveAudioBlob,
  getAudioBlob,
  addTimestamp,
  getTimestampsForFile,
} from "./db.js";

/**
 * @param {{
 *   showView: (name: "library" | "player") => void,
 *   engine: import("./audio-engine.js").AudioEngine,
 *   onFileOpened: (info: { filename: string, duration: number, fingerprintId: string, note?: string }) => void
 * }} deps
 */
export function initLibraryView({ showView, engine, onFileOpened }) {
  const loadButton = document.getElementById("btn-load-file");
  const fileInput = document.getElementById("file-input");
  const listEl = document.getElementById("library-list");

  // Set just before opening the file picker from a tapped library entry
  // (only reached when that entry has no usable cached audio), so the
  // "change" handler knows what the user was expecting to re-select.
  // Cleared as soon as a selection is resolved (matched, mismatched, or
  // the picker is cancelled).
  /** @type {{ fingerprintId: string, filename: string } | null} */
  let reconnectTarget = null;

  loadButton.addEventListener("click", () => {
    reconnectTarget = null; // general "load a file" — no specific expectation
    setLibraryStatus("");
    fileInput.click();
  });

  // Supported in evergreen browsers (not universally on older Safari) —
  // harmless no-op where unsupported, just means a stale expectation
  // lingers until the next pick resolves it one way or another.
  fileInput.addEventListener("cancel", () => {
    reconnectTarget = null;
  });

  // ---------- Cue sheet import ----------

  const importButton = document.getElementById("btn-import-cuesheet");
  const importInput = document.getElementById("cuesheet-import-input");
  const statusEl = document.getElementById("library-status");

  importButton.addEventListener("click", () => {
    setLibraryStatus("");
    importInput.click();
  });

  importInput.addEventListener("change", async () => {
    if (!importInput.files || importInput.files.length === 0) return;
    const file = importInput.files[0];

    try {
      const text = await file.text();
     const { file: fileInfo, timestamps } = parseCuesheetImport(text);
const cuesheetFingerprintId = computeFingerprint(fileInfo);

// Mobile browsers can report MP3 duration slightly differently.
// Match the cue sheet to an existing audio file by filename/size first.
let existingFile = await getFile(cuesheetFingerprintId);

if (!existingFile) {
  const allFiles = await getAllFiles();
  const cueName = String(fileInfo.filename || "").trim().toLowerCase();

  existingFile =
    allFiles.find(
      (f) =>
        String(f.filename || "").trim().toLowerCase() === cueName &&
        Number(f.fileSize) === Number(fileInfo.fileSize)
    ) ||
    allFiles.find(
      (f) => String(f.filename || "").trim().toLowerCase() === cueName
    ) ||
    null;
}

// Use the actual audio file's fingerprint when we found it.
const fingerprintId =
  existingFile?.fingerprintId || cuesheetFingerprintId;
      if (!existingFile) {
        // No local entry for this file yet — create a metadata-only one
        // (no cached audio). It'll show "Needs re-select" until the user
        // loads that actual audio file, at which point it reconnects
        // automatically via the same fingerprint, same as any other file.
        await upsertFile({
          fingerprintId,
          filename: fileInfo.filename,
          fileSize: fileInfo.fileSize,
          duration: fileInfo.duration,
          lastOpened: Date.now(),
          hasStoredAudio: false,
        });
      }

      // Skip anything that looks like a duplicate of a timestamp already
      // present for this file (same time to within 10ms, same title) —
      // makes re-importing the same cue sheet twice harmless rather than
      // creating a pile of duplicates.
      const existingTimestamps = await getTimestampsForFile(fingerprintId);
      let importedCount = 0;
      for (const ts of timestamps) {
        const isDuplicate = existingTimestamps.some(
          (e) => Math.abs(e.time - ts.time) < 0.01 && e.title === ts.title
        );
        if (isDuplicate) continue;
        await addTimestamp({
          fingerprintId,
          time: ts.time,
          title: ts.title,
          comment: ts.comment,
          countOffEnabled: ts.countOffEnabled,
          countOffBpm: ts.countOffBpm,
          createdAt: Date.now(),
        });
        importedCount++;
      }

      await renderLibraryList();

      const skipped = timestamps.length - importedCount;
      let message = `Imported ${importedCount} timestamp${importedCount === 1 ? "" : "s"} for "${fileInfo.filename}."`;
      if (skipped > 0) {
        message += ` (${skipped} already present, skipped.)`;
      }
      if (!existingFile || !existingFile.hasStoredAudio) {
        message += ` Load that audio file to use them.`;
      }
      setLibraryStatus(message);
    } catch (err) {
      setLibraryStatus(err.message, true);
    } finally {
      importInput.value = "";
    }
  });

  function setLibraryStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle("status-error", isError);
  }

  fileInput.addEventListener("change", async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    const file = fileInput.files[0];

    const expected = reconnectTarget;
    reconnectTarget = null;

    setLoadingState(true);

    try {
      const duration = await engine.load(file);
      const fingerprintId = computeFingerprint({
        filename: file.name,
        fileSize: file.size,
        duration,
      });

      const existing = await getFile(fingerprintId);

      // Best-effort: save the actual audio data so this file can be
      // reopened directly next time, without picking it again. This can
      // fail (storage quota, especially on large WAVs) — that's fine, we
      // just fall back to "you'll need to re-select it" for that file.
      let hasStoredAudio = false;
      let storageNote;
      try {
        await saveAudioBlob(fingerprintId, file);
        hasStoredAudio = true;
      } catch (err) {
        console.warn("Could not cache audio for offline reuse:", err);
        storageNote =
          "This file couldn't be saved for next time (storage limit) — you'll need to re-select it in a future session.";
      }

      await upsertFile({
        fingerprintId,
        filename: file.name,
        fileSize: file.size,
        duration,
        lastOpened: Date.now(),
        hasStoredAudio,
      });

      // If the user tapped a specific library entry but picked a file that
      // fingerprints differently, don't fail the load — just let them know
      // it's being treated as its own (separate) file rather than silently
      // pretending it reconnected. Takes priority over the storage note
      // since it's the more surprising/important thing to flag.
      let note = storageNote;
      if (expected && expected.fingerprintId !== fingerprintId) {
        note = `That doesn't match "${expected.filename}" — loaded "${file.name}" as its own file instead.`;
      }

      onFileOpened({ filename: file.name, fileSize: file.size, duration, fingerprintId, note });
      showView("player");

      if (!existing) {
        console.log("New library entry created:", fingerprintId);
      } else {
        console.log("Reconnected to existing library entry:", fingerprintId);
      }

      await renderLibraryList();
    } catch (err) {
      // Loading failed (corrupt/unsupported file) — stay on the library
      // screen and surface the reason inline rather than losing context.
      renderLoadError(err.message);
    } finally {
      setLoadingState(false);
      // Reset so picking the same file again still fires a "change" event.
      fileInput.value = "";
    }
  });

  /**
   * Tapping a library entry. Tries to open it directly from its cached
   * audio blob; falls back to prompting re-selection if that's not
   * available (never saved successfully, or evicted since).
   * @param {import("./db.js").FileRecord} fileRecord
   */
  async function openFileRecord(fileRecord) {
    try {
      const blob = await getAudioBlob(fileRecord.fingerprintId);
      if (blob) {
        const duration = await engine.load(blob);
        await upsertFile({ ...fileRecord, lastOpened: Date.now() });
        onFileOpened({
          filename: fileRecord.filename,
          fileSize: fileRecord.fileSize,
          duration,
          fingerprintId: fileRecord.fingerprintId,
        });
        showView("player");
        await renderLibraryList();
        return;
      }
    } catch (err) {
      console.warn("Could not load cached audio, falling back to file picker:", err);
    }

    // No cached blob (or loading it failed) — fall back to the original
    // "please re-select this file" flow.
    reconnectTarget = {
      fingerprintId: fileRecord.fingerprintId,
      filename: fileRecord.filename,
    };
    fileInput.click();
  }

  function setLoadingState(isLoading) {
    loadButton.disabled = isLoading;
    loadButton.textContent = isLoading ? "Loading…" : "+ Load Audio File";
  }

  function renderLoadError(message) {
    listEl.innerHTML = "";
    const li = document.createElement("li");
    li.className = "library-empty";
    li.style.borderColor = "var(--color-danger)";
    li.style.color = "var(--color-danger)";
    li.textContent = message;
    listEl.appendChild(li);
  }

  async function renderLibraryList() {
    const files = await getAllFiles();
    listEl.innerHTML = "";

    if (files.length === 0) {
      const li = document.createElement("li");
      li.className = "library-empty text-muted";
      li.textContent = "No files yet — load an audio file to get started.";
      listEl.appendChild(li);
      return;
    }

    for (const fileRecord of files) {
      listEl.appendChild(renderLibraryItem(fileRecord));
    }
  }

  /** @param {import("./db.js").FileRecord} fileRecord */
  function renderLibraryItem(fileRecord) {
    const li = document.createElement("li");
    li.className = "library-item";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "library-item-main";
    btn.setAttribute(
      "aria-label",
      fileRecord.hasStoredAudio
        ? `Open ${fileRecord.filename}`
        : `Reopen ${fileRecord.filename} — you'll need to re-select the file`
    );
    btn.addEventListener("click", () => openFileRecord(fileRecord));

    const textWrap = document.createElement("span");
    textWrap.className = "library-item-text";

    const name = document.createElement("span");
    name.className = "library-item-name";
    name.textContent = fileRecord.filename;

    const meta = document.createElement("span");
    meta.className = "library-item-meta";
    const durationSpan = document.createElement("span");
    durationSpan.className = "mono";
    durationSpan.textContent = formatTime(fileRecord.duration);
    meta.appendChild(durationSpan);
    meta.appendChild(document.createTextNode(` · ${formatRelativeDate(fileRecord.lastOpened)}`));
    if (!fileRecord.hasStoredAudio) {
      meta.appendChild(document.createTextNode(" · Needs re-select"));
    }

    textWrap.appendChild(name);
    textWrap.appendChild(meta);

    const chevron = document.createElement("span");
    chevron.className = "library-item-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";

    btn.appendChild(textWrap);
    btn.appendChild(chevron);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-icon library-item-delete no-select";
    deleteBtn.setAttribute("aria-label", `Remove ${fileRecord.filename} from library`);
    deleteBtn.innerHTML = '<span aria-hidden="true">🗑</span>';
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (window.confirm(`Remove "${fileRecord.filename}" and all its timestamps from your library? This can't be undone.`)) {
        await deleteFile(fileRecord.fingerprintId);
        await renderLibraryList();
      }
    });

    li.appendChild(btn);
    li.appendChild(deleteBtn);
    return li;
  }

  // Initial render on app start.
  renderLibraryList();
}
