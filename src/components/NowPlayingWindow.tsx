import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function openNowPlayingWindow() {
  const existing = await WebviewWindow.getByLabel("nowplaying");
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow("nowplaying", {
    url: "/#nowplaying",
    title: "Ether — Now Playing",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    decorations: true,
    alwaysOnTop: false,
    focus: true,
  });
}
