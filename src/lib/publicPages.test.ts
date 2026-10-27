// Preferences → Links lists every route each public site has (Jeff, 2026-10-27: "The test fails if any route in the site
// is missing from the menu."). src/lib/publicPages.ts.
//
// THE SITES' OWN ROUTING CODE is read from their repos beside this one (ETHER_SITES_ROOT, default: this repo's parent —
// C:\ether-listener, C:\ether-park, C:\ether-signup). Every route found there must be in ROUTES. A site whose repo is
// not on this computer is reported as skipped (CI has only this repo), never passed silently.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ROUTES, PAGE_TYPES, SITES, pageLinks, type Site } from "./publicPages";

const SITES_ROOT = process.env.ETHER_SITES_ROOT || path.join(__dirname, "..", "..", "..");
const repo = (name: string) => path.join(SITES_ROOT, name);
const has = (name: string) => fs.existsSync(path.join(repo(name), "src"));
const read = (name: string, rel: string) => { try { return fs.readFileSync(path.join(repo(name), rel), "utf8"); } catch { return ""; } };
/** A route's shape: every parameter becomes ":" ("/jukebox/:jukebox/lobby" → "/jukebox/:/lobby"). */
const shape = (p: string) => p.replace(/:[a-z]+/g, ":");
const routesOf = (site: Site) => new Set(ROUTES.filter(r => r.site === site).map(r => shape(r.path)));

/** Routes in a listener/park-style api.ts: each `xFromPath()` reads path parts; literals checked at fixed positions. */
function pathFunctionRoutes(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/export function (\w+)FromPath\(\)[^{]*\{([\s\S]*?)\n\}/g)) {
    const body = m[2];
    if (/startsWith\("@"\)/.test(body)) {                    // /@handle and /@handle/<channel>
      out.push("/@:");
      if (/segs\[1\]/.test(body)) out.push("/@:/:");
      continue;
    }
    const lits: Record<number, string> = {};
    for (const x of body.matchAll(/parts\[(\d)\] !== "([a-z0-9-]+)"/g)) lits[Number(x[1])] = x[2];
    let max = -1;
    for (const x of body.matchAll(/parts\[(\d)\]/g)) max = Math.max(max, Number(x[1]));
    if (max < 0 && /split\("\/"\)\[0\]/.test(body)) max = 0;   // slugFromPath: the first segment is the slug
    if (max < 0) continue;
    out.push("/" + Array.from({ length: max + 1 }, (_, i) => lits[i] ?? ":").join("/"));
  }
  return out;
}

describe("every route in each site's routing code is in Links", () => {
  it.skipIf(!has("ether-listener"))("ether-listener (listen.ether-cast.com)", () => {
    const found = pathFunctionRoutes(read("ether-listener", "src/api.ts"));
    if (/RootLanding/.test(read("ether-listener", "src/App.tsx"))) found.push("/");
    expect(found).toEqual(expect.arrayContaining(["/:", "/embed/:", "/jukebox/:", "/jukebox/:/lobby", "/@:", "/@:/:"]));   // the walk sees them
    const missing = found.filter(r => !routesOf("listener").has(r));
    expect(missing, `routes in ether-listener missing from Links: ${missing.join(", ")}`).toEqual([]);
  });
  it.skipIf(!has("ether-park"))("ether-park (park.ether-cast.com)", () => {
    const found = pathFunctionRoutes(read("ether-park", "src/api.ts"));
    expect(found).toContain("/:");
    const missing = found.filter(r => !routesOf("park").has(r));
    expect(missing, `routes in ether-park missing from Links: ${missing.join(", ")}`).toEqual([]);
  });
  it.skipIf(!has("ether-signup"))("ether-signup (signup.ether-cast.com)", () => {
    const found = [...read("ether-signup", "src/App.tsx").matchAll(/p === "(\/[a-z0-9-]*)"/g)].map(m => m[1]);
    expect(found.length).toBeGreaterThan(5);
    found.push("/");                                                         // the sign-up form is the root
    const missing = found.filter(r => !routesOf("signup").has(r));
    expect(missing, `routes in ether-signup missing from Links: ${missing.join(", ")}`).toEqual([]);
  });
  it("the parser itself: a route added to a site is caught", () => {
    const src = `export function fooFromPath(): string {\n  const parts = x;\n  if (parts[0] !== "foo" || !parts[1]) return "";\n}\n`;
    expect(pathFunctionRoutes(src)).toEqual(["/foo/:"]);
    expect(routesOf("listener").has("/foo/:")).toBe(false);                  // → that site's test would fail
  });
});

describe("filled in for this account", () => {
  const data = {
    handle: "opportunity-viilage",
    stations: [{ uuid: "u1", name: "halloVeen", slug: "halloween" }, { uuid: "u2", name: "Fall VIbes", slug: null }],
    jukeboxSlugs: { u1: "magicalforest" },
  };
  const links = pageLinks(data);
  const url = (name: string, station: string | null) => links.find(l => l.name === name && l.station === station)?.url;
  it("real public addresses, per station", () => {
    expect(url("Station player", "halloVeen")).toBe("https://listen.ether-cast.com/halloween");
    expect(url("Embed player", "halloVeen")).toBe("https://listen.ether-cast.com/embed/halloween");
    expect(url("Park page", "halloVeen")).toBe("https://park.ether-cast.com/halloween");
    expect(url("Station on the account page", "halloVeen")).toBe("https://listen.ether-cast.com/@opportunity-viilage/halloween");
    expect(url("Account page", null)).toBe("https://listen.ether-cast.com/@opportunity-viilage");
    expect(url("Jukebox request page", "halloVeen")).toBe("https://listen.ether-cast.com/jukebox/magicalforest");
    expect(url("Lobby screen", "halloVeen")).toBe("https://listen.ether-cast.com/jukebox/magicalforest/lobby");
    expect(url("Log in", null)).toBe("https://signup.ether-cast.com/login");
    expect(url("Dashboard", null)).toBe("https://app.ether-cast.com/");
  });
  it("never a local address", () => {
    for (const l of links) if (l.url) expect(l.url).toMatch(/^https:\/\/([a-z0-9-]+\.)*(ether-cast\.com|ether-technologies\.com|up\.railway\.app)\//);
    expect(Object.values(SITES).join(" ")).not.toMatch(/localhost|127\.0\.0\.1|:3400|192\.168\./);
  });
  it("a missing value is said, not turned into a broken link", () => {
    expect(links.find(l => l.name === "Station player" && l.station === "Fall VIbes")).toMatchObject({ url: null, missing: "this station has no public page address yet" });
    expect(links.find(l => l.name === "Lobby screen" && l.station === "Fall VIbes")?.missing).toMatch(/no jukebox set up on this station/);
    expect(pageLinks({ ...data, handle: null }).find(l => l.name === "Account page")?.missing).toMatch(/no account handle/);
  });
  it("only this account's stations — nothing per-station is typed into Ether", () => {
    expect(new Set(links.filter(l => l.station).map(l => l.station))).toEqual(new Set(["halloVeen", "Fall VIbes"]));
    const src = fs.readFileSync(path.join(__dirname, "publicPages.ts"), "utf8");
    expect(src).not.toMatch(/halloween|magical-forest|christmas|opportunity|radio-playout|cero/i);
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.js"), "utf8");
    const h = main.slice(main.indexOf('ipcMain.handle("links:account"'), main.indexOf("\n});", main.indexOf('ipcMain.handle("links:account"')));
    expect(h).toMatch(/get\("\/api\/account\/stations"\)/);                  // the signed-in account's stations only
    expect(h).not.toMatch(/\/public\/stations/);                              // never every account's
  });
});

describe("Preferences → Links", () => {
  const sp = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");
  it("has its own title in the left sidebar", () => {
    expect(sp).toMatch(/\{ id: "links",\s+label: "Links",/);
  });
  it("and a section for each type, every route's type among them", () => {
    expect(sp).toMatch(/PAGE_TYPES\.map\(t => \(\s*\n\s*<Section key=\{t\.type\} category="links"/);
    const types = new Set(PAGE_TYPES.map(t => t.type));
    for (const r of ROUTES) expect(types.has(r.type), `${r.name}'s type ${r.type} has no section`).toBe(true);
  });
  it("each line has Open and Copy", () => {
    const c = fs.readFileSync(path.join(__dirname, "..", "components", "PublicLinks.tsx"), "utf8");
    expect(c).toMatch(/ether\?\.system\?\.openUrl\?\.\(l\.url\)/);
    expect(c).toMatch(/navigator\.clipboard\.writeText\(l\.url\)/);
  });
});
