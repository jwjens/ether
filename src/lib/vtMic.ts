// THE VOICE-TRACKING MICROPHONE (Jeff, 2026-10-30, build D): the mic picked in Settings → Audio is saved on this
// computer (like the phone hybrid and cue pickers beside it) and Voice Tracker records from it — in the main window and
// in its pop-out. If that mic is gone, Voice Tracker records from the default mic and says so on its screen.
export const VT_MIC_KEY = "ether_vt_input";

export function getVtMic(): string {
  try { return localStorage.getItem(VT_MIC_KEY) || ""; } catch { return ""; }
}
export function setVtMic(deviceId: string): void {
  try { localStorage.setItem(VT_MIC_KEY, deviceId); } catch { /* ignore */ }
}

/** Open the picked mic; if it can't be opened (unplugged / renamed), open the default mic and say which happened. */
export async function openVtMic(deviceId: string, gum: (c: MediaStreamConstraints) => Promise<MediaStream>):
  Promise<{ stream: MediaStream; fellBack: boolean }> {
  if (!deviceId) return { stream: await gum({ audio: true }), fellBack: false };
  try { return { stream: await gum({ audio: { deviceId: { exact: deviceId } } }), fellBack: false }; }
  catch (e: any) {
    // Only "that device isn't here" falls back; a refused permission is the operator's answer and stays an error.
    if (e?.name !== "OverconstrainedError" && e?.name !== "NotFoundError") throw e;
    return { stream: await gum({ audio: true }), fellBack: true };
  }
}
