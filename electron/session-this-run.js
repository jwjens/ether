// A RELOAD NEVER SIGNS ANYONE OUT (Jeff, 2026-10-30: "reloading the window must never sign anyone out while Ether runs").
//
// The renderer's sign-in gate (App.tsx accountSignedIn) is React state, so View → Reload (Ctrl+R), a dev live reload or
// any webContents.reload() starts it at false again, and the only doors back were the on-air marker and the keep-session
// marker a SELF-relaunch writes. A plain reload writes neither, so the operator landed on the sign-in screen mid-session.
// The main process lives for the whole run: it remembers that this run opened the gate, and answers
// account:resume-session with that. A new process starts with nothing remembered, so a cold start or reboot still asks
// for sign-in; Sign Out exits the process, so it forgets too.
function createSessionThisRun({ consumeKeepSession }) {
  let opened = false;
  return {
    /** The gate opened this run (a completed sign-in, a resumed session). */
    markOpened() { opened = true; },
    /** account:resume-session: true when this run already opened the gate, else the self-relaunch marker (consumed). */
    resume() {
      if (opened) return true;
      if (consumeKeepSession()) { opened = true; return true; }
      return false;
    },
    isOpened() { return opened; },
  };
}

module.exports = { createSessionThisRun };
