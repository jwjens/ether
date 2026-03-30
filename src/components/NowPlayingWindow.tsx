// WebviewWindow replaced by Electron IPC

export async function openNowPlayingWindow() {
  // Close existing window if present
  const existing = await WebviewWindow.getByLabel("nowplaying");
  if (existing) {
    const visible = await existing.isVisible().catch(() => false);
    if (visible) {
      await existing.setFocus();
      return;
    }
    // Window exists but not visible - close and recreate
    await existing.close().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }

  new WebviewWindow("nowplaying", {
    url: "/#nowplaying",
    title: "Ether — Now Playing",
    width: 1280,
    height: 720,
    minWidth: 1280,
    minHeight: 720,
    resizable: false,
    decorations: true,
    alwaysOnTop: false,
    focus: true,
    center: true,
  });
}
