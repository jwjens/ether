export async function openNowPlayingWindow() {
  await (window as any).ether.invoke("open_nowplaying_window");
}
