const fs = require('fs');
fs.writeFileSync('src/components/NowPlayingWindow.tsx', `import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

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
    minWidth: 1280,
    minHeight: 720,
    resizable: false,
    decorations: true,
    alwaysOnTop: false,
    focus: true,
    center: true,
  });
}
`);
console.log('Done');
