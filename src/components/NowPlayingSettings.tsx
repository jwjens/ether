import { useState } from "react";
export default function NowPlayingSettings() {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-bold text-zinc-300">Now Playing Metadata</h2>
      <div className="text-xs text-zinc-500">Pushes current track info to files and services when each song starts. Configure in a future update.</div>
      <div className="text-xs text-zinc-400">JSON file, text file, TuneIn, and webhook outputs — coming soon.</div>
    </div>
  );
}
