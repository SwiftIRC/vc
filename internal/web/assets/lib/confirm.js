// A reusable modal confirmation built on the native <dialog> element, which provides the
// backdrop, focus trapping, and Escape-to-cancel for free. Promise-based: resolves true
// if the user confirms, false on cancel / Escape / backdrop click. Developer-authored
// text only (set via textContent, never innerHTML).
//
//   if (await confirmDialog({ title: "Ban alice?", message: "…", confirmLabel: "Ban", tone: "danger" })) { … }
export function confirmDialog({ title, message = "", confirmLabel = "Confirm", tone } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";

    const h = document.createElement("h2");
    h.className = "confirm-title";
    h.textContent = title || "";
    dialog.appendChild(h);

    if (message) {
      const p = document.createElement("p");
      p.className = "confirm-message";
      p.textContent = message;
      dialog.appendChild(p);
    }

    const row = document.createElement("div");
    row.className = "confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "confirm-cancel";
    cancel.textContent = "Cancel";
    cancel.autofocus = true; // safe default: Enter/Escape cancel a destructive prompt

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "confirm-ok" + (tone === "danger" ? " danger" : "");
    ok.textContent = confirmLabel;

    row.append(cancel, ok);
    dialog.appendChild(row);
    document.body.appendChild(dialog);

    let done = false;
    const settle = (result) => {
      if (done) return;
      done = true;
      resolve(result);
      dialog.close(); // fires "close"; DOM cleanup happens there
    };

    cancel.addEventListener("click", () => settle(false));
    ok.addEventListener("click", () => settle(true));
    // Escape: <dialog> fires "cancel" (then "close"). Treat as a negative answer.
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); settle(false); });
    // Backdrop click: the click's target is the <dialog> element itself, not a child.
    dialog.addEventListener("click", (e) => { if (e.target === dialog) settle(false); });
    // However it closed, resolve (no-op if already settled) and remove it.
    dialog.addEventListener("close", () => { settle(false); dialog.remove(); });

    dialog.showModal();
  });
}
