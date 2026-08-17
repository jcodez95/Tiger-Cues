// app.js — bootstraps the app: service worker registration + view routing.
// Each screen's own logic lives in its own module (library-view.js, player-view.js, etc.)
// and is wired up here. Keep this file thin — it should orchestrate, not implement.

import { AudioEngine } from "./audio-engine.js";
import { initLibraryView } from "./library-view.js";
import { initPlayerView } from "./player-view.js";

const views = {
  library: document.getElementById("view-library"),
  player: document.getElementById("view-player"),
};

/**
 * Switches the visible top-level screen. Only one .view is ever active at a time.
 * @param {"library" | "player"} name
 */
function showView(name) {
  for (const key of Object.keys(views)) {
    views[key].classList.toggle("is-active", key === name);
  }
}

// One AudioEngine wraps the single shared <audio> element for the whole app —
// the library screen loads files into it, the player screen controls it.
const engine = new AudioEngine(document.getElementById("audio-el"));

const player = initPlayerView({ showView, engine });
initLibraryView({ showView, engine, onFileOpened: player.onFileOpened });

// Leaving the player screen pauses playback, stops any in-progress
// metronome count-off, and closes any open timestamp editor, so nothing
// keeps running or floats over the library screen.
document.getElementById("btn-back-to-library").addEventListener("click", () => {
  engine.pause();
  player.stopCountOff();
  player.closeEditor();
  showView("library");
});

// ---------- Service worker registration ----------
// Registers on load so the app shell (HTML/CSS/JS/icons) becomes available offline.
// Safe to call even if the browser doesn't support service workers.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

// ---------- Persistent storage request ----------
// Best-effort signal to the browser that this app's saved audio files and
// timestamps are important and shouldn't be evicted under storage
// pressure the way "regular" site data can be. Support and behavior vary
// by browser (Safari may auto-grant this for installed/home-screen PWAs;
// Chrome may prompt the user) — this does not guarantee data survives
// indefinitely, just improves the odds. Silently ignored where unsupported.
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}
