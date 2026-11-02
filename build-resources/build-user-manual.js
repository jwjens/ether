// Build the user manual PDF that ships in the installer (Help → Documentation opens it; Jeff, 2026-11-02).
//
//   npx electron build-resources/build-user-manual.js
//
// docs/user-manual.md (the source; edit that) → build-resources/Ether-User-Manual.pdf (committed; electron-builder
// extraResources copies it to resources/Ether-User-Manual.pdf, and engine-pack.js afterPack fails the build without
// it). Rendered in a hidden window with marked (cdnjs, pinned) and printed to A4 with page numbers. Run it again after
// any change to the manual.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "user-manual.md");
const OUT = path.join(__dirname, "Ether-User-Manual.pdf");
const VERSION = require(path.join(ROOT, "package.json")).version;

const md = fs.readFileSync(SRC, "utf8");
const logo = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "icon-512.png")).toString("base64");
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ether User Manual ${VERSION}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
  body { font: 10.5pt/1.5 "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #1d1b29; }
  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; page-break-after: always; }
  .cover img { width: 120px; height: 120px; margin-bottom: 28px; }
  .cover h1 { font-size: 34pt; margin: 0 0 8px; border: none; padding: 0; color: #3a2a80; page-break-before: avoid; }
  .cover p { font-size: 13pt; color: #5f5b78; margin: 4px 0; }
  .toc { page-break-after: always; } .toc h2 { margin-top: 0; } .toc a { color: #1d1b29; text-decoration: none; }
  .toc div { padding: 3px 0; border-bottom: 1px dotted #d9d6ea; font-size: 11pt; }
  h1 { font-size: 20pt; color: #3a2a80; page-break-before: always; border-bottom: 2px solid #6040c0; padding-bottom: 6px; margin-top: 0; }
  h2 { font-size: 14pt; color: #2b2550; margin: 18px 0 6px; page-break-after: avoid; }
  h3 { font-size: 11.5pt; color: #5f5b78; margin: 14px 0 4px; page-break-after: avoid; }
  p, li { orphans: 3; widows: 3; } ul, ol { padding-left: 20px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 1px solid #d9d6ea; padding: 4px 6px; text-align: left; vertical-align: top; } th { background: #ecebf5; }
  code { font-family: Consolas, monospace; font-size: 9pt; background: #ecebf5; padding: 0 3px; }
  pre { background: #ecebf5; padding: 8px; white-space: pre-wrap; font-size: 9pt; }
  blockquote { border-left: 3px solid #6040c0; margin: 8px 0; padding: 2px 10px; color: #5f5b78; }
  hr { display: none; } a { color: #6040c0; }
</style></head><body>
<div class="cover"><img src="${logo}" alt=""><h1>Ether User Manual</h1><p>Version ${VERSION}</p><p>Ether Technologies</p></div>
<div class="toc" id="toc"><h2>Contents</h2></div>
<div id="doc"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script>
  const doc = document.getElementById("doc");
  doc.innerHTML = marked.parse(${JSON.stringify(md).replace(/<\//g, "<\\/")});
  const first = doc.querySelector("h1"); if (first && !/^\\d+\\./.test(first.textContent)) first.remove();   // the title is on the cover
  const toc = document.getElementById("toc");
  doc.querySelectorAll("h1").forEach((h, i) => { h.id = "ch" + i; const d = document.createElement("div"); d.innerHTML = '<a href="#ch' + i + '">' + h.textContent + "</a>"; toc.appendChild(d); });
  window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  const tmp = path.join(app.getPath("temp"), "ether-user-manual.html");
  fs.writeFileSync(tmp, html);
  const w = new BrowserWindow({ show: false, width: 900, height: 1200 });
  try {
    await w.loadFile(tmp);
    for (let i = 0; i < 100 && !(await w.webContents.executeJavaScript("!!window.__ready")); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await w.webContents.executeJavaScript("!!window.__ready"))) throw new Error("the manual did not render (marked failed to load?)");
    const chapters = await w.webContents.executeJavaScript("document.querySelectorAll('#doc h1').length");
    const pdf = await w.webContents.printToPDF({
      pageSize: "A4", printBackground: true, displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px;width:100%;padding:0 16mm;color:#888;display:flex;justify-content:space-between"><span>Ether User Manual · ${VERSION}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margins: { top: 0.6, bottom: 0.7, left: 0.6, right: 0.6 },
    });
    fs.writeFileSync(OUT, pdf);
    console.log(`Ether-User-Manual.pdf: ${chapters} chapters, ${(pdf.length / 1024).toFixed(0)} KB → ${OUT}`);
  } catch (e) { console.error("FAILED:", e.message); process.exitCode = 1; }
  finally { fs.rmSync(tmp, { force: true }); app.quit(); }
});
