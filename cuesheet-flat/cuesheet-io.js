// cuesheet-io.js — serializes/parses a "cue sheet" (one file's timestamps)
// into a portable JSON format that can be exported, shared with someone
// else, and imported into another copy of the app.
//
// Deliberately does NOT include the audio itself: audio files can be
// large, and this keeps the shared file small and easy to send over
// Messages/email/AirDrop. The recipient needs the same audio file
// separately (already has it, or the sender shares it another way); this
// export's `file` section (filename/fileSize/duration) is exactly what
// fingerprint.js uses, so importing this and then loading that audio file
// auto-reconnects them the same way re-picking one of your own files does.
//
// Pure module (no DOM/IndexedDB) so serialize/parse/validate are directly
// unit-testable — see scripts/test-cuesheet-io.mjs.

const FORMAT_VERSION = 1;

/**
 * @param {{ filename: string, fileSize: number, duration: number }} fileInfo
 * @param {import("./db.js").TimestampRecord[]} timestamps
 * @returns {object} plain JS object, ready for JSON.stringify
 */
export function buildCuesheetExport(fileInfo, timestamps) {
  return {
    cuesheetFormat: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    file: {
      filename: fileInfo.filename,
      fileSize: fileInfo.fileSize,
      duration: fileInfo.duration,
    },
    timestamps: timestamps.map((t) => ({
      time: t.time,
      title: t.title,
      comment: t.comment,
      countOffEnabled: t.countOffEnabled ?? false,
      countOffBpm: t.countOffBpm ?? null,
    })),
  };
}

/**
 * Parses and validates an imported cue sheet JSON string. Never throws for
 * individual malformed timestamp entries — those are just dropped — but
 * throws a user-facing Error for structural problems (not JSON, wrong
 * format version, missing file info) so the caller can show why the
 * import failed.
 * @param {string} jsonText
 * @returns {{
 *   file: { filename: string, fileSize: number, duration: number },
 *   timestamps: { time: number, title: string, comment: string, countOffEnabled: boolean, countOffBpm: number | null }[]
 * }}
 */
export function parseCuesheetImport(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("That doesn't look like a valid cue sheet file (not valid JSON).");
  }

  if (!data || typeof data !== "object") {
    throw new Error("That doesn't look like a valid cue sheet file.");
  }
  if (data.cuesheetFormat !== FORMAT_VERSION) {
    throw new Error("This cue sheet file was made with a different app version and can't be imported.");
  }
  if (
    !data.file ||
    typeof data.file.filename !== "string" ||
    !data.file.filename.trim() ||
    !Number.isFinite(data.file.fileSize) ||
    !Number.isFinite(data.file.duration)
  ) {
    throw new Error("This cue sheet file is missing information about its audio file.");
  }
  if (!Array.isArray(data.timestamps)) {
    throw new Error("This cue sheet file doesn't contain any timestamps.");
  }

  const timestamps = data.timestamps
    .filter((t) => t && typeof t === "object" && typeof t.time === "number" && t.time >= 0)
    .map((t) => ({
      time: t.time,
      title: typeof t.title === "string" ? t.title : "Untitled",
      comment: typeof t.comment === "string" ? t.comment : "",
      countOffEnabled: Boolean(t.countOffEnabled),
      countOffBpm: Number.isFinite(t.countOffBpm) ? t.countOffBpm : null,
    }));

  return {
    file: {
      filename: data.file.filename,
      fileSize: data.file.fileSize,
      duration: data.file.duration,
    },
    timestamps,
  };
}

/**
 * Suggests a filename for the exported cue sheet, derived from the audio
 * file's own name (e.g. "Concert Rehearsal.wav" -> "Concert
 * Rehearsal.cuesheet.json").
 * @param {string} audioFilename
 * @returns {string}
 */
export function suggestExportFilename(audioFilename) {
  const base = audioFilename.replace(/\.[^./]+$/, ""); // strip the audio file's extension
  return `${base}.cuesheet.json`;
}
