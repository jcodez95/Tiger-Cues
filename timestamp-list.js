// timestamp-list.js — renders the list of saved timestamps for the
// currently loaded file. Pure rendering module: it owns no state and makes
// no db.js calls — the caller (player-view.js) passes in the current array
// of timestamps and gets notified via callbacks when the user taps a row.

/**
 * @param {{
 *   container: HTMLElement,
 *   timestamps: import("./db.js").TimestampRecord[],
 *   formatTime: (seconds: number) => string,
 *   onSelect: (id: string) => void,   // tap the row body: seek + play
 *   onEdit: (id: string) => void,     // tap the edit icon: open the editor
 * }} opts
 */
export function renderTimestampList({ container, timestamps, formatTime, onSelect, onEdit }) {
  container.innerHTML = "";

  if (timestamps.length === 0) {
    const li = document.createElement("li");
    li.className = "timestamp-empty text-muted";
    li.textContent = 'No timestamps yet — tap "+ Add Timestamp" while listening.';
    container.appendChild(li);
    return;
  }

  for (const ts of timestamps) {
    container.appendChild(renderRow(ts, { formatTime, onSelect, onEdit }));
  }
}

/** @param {import("./db.js").TimestampRecord} ts */
function renderRow(ts, { formatTime, onSelect, onEdit }) {
  const li = document.createElement("li");
  li.className = "timestamp-item";

  const mainBtn = document.createElement("button");
  mainBtn.type = "button";
  mainBtn.className = "timestamp-item-main";
  mainBtn.addEventListener("click", () => onSelect(ts.id));

  const time = document.createElement("span");
  time.className = "timestamp-item-time mono";
  time.textContent = formatTime(ts.time);

  const text = document.createElement("span");
  text.className = "timestamp-item-text";

  const title = document.createElement("span");
  title.className = "timestamp-item-title";
  title.textContent = ts.title || "Untitled";
  text.appendChild(title);

  if (ts.comment) {
    const comment = document.createElement("span");
    comment.className = "timestamp-item-comment text-muted";
    comment.textContent = ts.comment;
    text.appendChild(comment);
  }

  mainBtn.appendChild(time);
  mainBtn.appendChild(text);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-icon timestamp-item-edit no-select";
  editBtn.setAttribute("aria-label", `Edit "${ts.title || "Untitled"}"`);
  editBtn.innerHTML = "<span aria-hidden=\"true\">✎</span>";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onEdit(ts.id);
  });

  li.appendChild(mainBtn);
  li.appendChild(editBtn);
  return li;
}
