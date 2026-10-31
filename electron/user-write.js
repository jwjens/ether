// Writes a file the operator asked for — only inside a folder they picked in a Save / folder dialog this run
// (dead-controls items 1 and 2; electron/main.js fs:writeFile). A window can't write anywhere it names on its own.
const path = require("path");

function insideAllowed(filePath, allowedDirs) {
  const full = path.resolve(String(filePath || ""));
  for (const d of allowedDirs) {
    const rel = path.relative(d, full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** → { ok: true, path, bytes } or { ok: false, error } */
function writeUserFile(filePath, data, { allowedDirs, fs = require("fs") }) {
  if (!filePath) return { ok: false, error: "no file name" };
  if (!insideAllowed(filePath, allowedDirs)) return { ok: false, error: "Ether only saves into a folder you picked in the Save window" };
  const buf = typeof data === "string" ? Buffer.from(data, "utf8")
    : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data))
    : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : data && typeof data === "object" ? Buffer.from(Object.values(data))   // a Uint8Array that crossed IPC as a plain object
    : null;
  if (!buf) return { ok: false, error: "nothing to write" };
  const full = path.resolve(filePath);
  fs.writeFileSync(full, buf);
  return { ok: true, path: full, bytes: buf.length };
}

module.exports = { writeUserFile, insideAllowed };
