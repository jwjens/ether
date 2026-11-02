// Help → Documentation opens the user manual that ships with Ether (Jeff, 2026-11-02) — the PDF on this computer, no
// web page. The installer puts it at resources/Ether-User-Manual.pdf (electron-builder extraResources; engine-pack.js
// afterPack fails a build without it). A dev run opens build-resources/Ether-User-Manual.pdf. If the file is missing or
// no PDF viewer opens it, Ether says so in a message — it never opens something else instead.
const path = require("path");
const fs = require("fs");

const MANUAL_FILE = "Ether-User-Manual.pdf";

/** Where the manual is: inside the installed app's resources, or the source tree on a dev run. */
function manualPath({ isPackaged, resourcesPath, appDir }) {
  return isPackaged ? path.join(resourcesPath, MANUAL_FILE) : path.join(appDir, "..", "build-resources", MANUAL_FILE);
}

/** Open the manual with this computer's PDF viewer. Returns { ok, path, error? } and shows the error to the user. */
async function openUserManual({ electron, isPackaged, resourcesPath, appDir, exists = fs.existsSync }) {
  const p = manualPath({ isPackaged, resourcesPath, appDir });
  let error = null;
  if (!exists(p)) error = `The user manual is missing from this installation:\n${p}\n\nReinstall Ether to restore it.`;
  else {
    const r = await electron.shell.openPath(p);            // "" on success, otherwise the reason
    if (r) error = `The user manual could not be opened: ${r}\n${p}\n\nA PDF viewer is needed to read it.`;
  }
  if (error) {
    try { await electron.dialog.showMessageBox({ type: "warning", title: "Documentation", message: "Ether User Manual", detail: error, buttons: ["OK"] }); } catch { /* no window yet */ }
    return { ok: false, path: p, error };
  }
  return { ok: true, path: p };
}

module.exports = { MANUAL_FILE, manualPath, openUserManual };
