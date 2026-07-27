// READ-ONLY: prove the spot's REAL duration via the same native probe the app uses (getFileDuration → sec).
const path = require("path");
const A = require(path.join(process.cwd(), "native", "ether-audio.node"));
const fp = process.argv[2] || "C:\Users\jensj\Downloads\idoberg-creepy-halloween-bell-trap-melody-247720.mp3";
try {
  const sec = A.getFileDuration(fp);
  console.log(`file: ${fp}`);
  console.log(`getFileDuration → ${sec}s  (rounded length_sec = ${Math.round(sec)})`);
  console.log(`stored default was 30s → ${Math.round(sec) === 30 ? "matches default (suspicious)" : "REAL duration differs from the fake 30s default ✓"}`);
} catch (e) { console.error("probe error:", e.message); process.exit(1); }
