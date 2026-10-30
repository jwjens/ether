// UPDATE WINDOW → DETAILS (Jeff, 2026-10-30): "a popup listing what was added and fixed in that update, taken from that
// release's release notes. If someone is skipping versions (for example 4.6.65 to 4.6.69), show the notes for every
// version in between, newest first. If the notes can't be loaded, say so in the popup; never block or delay the update."
//
// The notes are the published GitHub releases of jwjens/ether — the same releases electron-updater installs from
// (electron-builder.json publish → github, releaseType "release"). They are fetched only when Details is clicked, with a
// time limit, and nothing in the update path waits on them.
const semver = require("semver");

const RELEASES_URL = "https://api.github.com/repos/jwjens/ether/releases";
const MAX_PAGES = 5;          // 100 releases a page; stops early once a page reaches back past the running version
const TIME_LIMIT_MS = 8000;

/** The releases strictly newer than `from` and no newer than `to`, newest first. Drafts and pre-releases are skipped. */
function notesBetween(releases, from, to) {
  const out = [];
  for (const r of releases || []) {
    if (!r || r.draft || r.prerelease) continue;
    const v = semver.valid(semver.clean(String(r.tag_name || "")));
    if (!v || !semver.gt(v, from) || semver.gt(v, to)) continue;
    out.push({ version: v, name: r.name || `Ether ${v}`, date: r.published_at || null, body: String(r.body || "").trim() });
  }
  return out.sort((a, b) => semver.rcompare(a.version, b.version));
}

/** True once a page holds a release at or below `from` — the pages are newest first, so no later page is needed. */
function reachedBack(page, from) {
  return (page || []).some(r => { const v = semver.valid(semver.clean(String(r && r.tag_name || ""))); return v && semver.lte(v, from); });
}

/**
 * @returns { ok: true, from, to, releases, missing } | { ok: false, error }
 *   missing: versions the update offers whose notes were not found (the target itself, when its release has no entry).
 */
async function releaseNotesFor({ from, to, fetchImpl = fetch, timeLimitMs = TIME_LIMIT_MS }) {
  if (!semver.valid(from) || !semver.valid(to)) return { ok: false, error: "the version numbers could not be read" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeLimitMs);
  try {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetchImpl(`${RELEASES_URL}?per_page=100&page=${page}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Ether" }, signal: ctl.signal });
      if (!r.ok) return { ok: false, error: `GitHub answered ${r.status}` };
      const rows = await r.json();
      if (!Array.isArray(rows)) return { ok: false, error: "GitHub's answer could not be read" };
      all.push(...rows);
      if (rows.length < 100 || reachedBack(rows, from)) break;
    }
    const releases = notesBetween(all, from, to);
    const missing = releases.some(x => x.version === semver.valid(to)) ? [] : [semver.valid(to)];
    return { ok: true, from, to, releases, missing };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "GitHub did not answer in time" : `could not reach GitHub (${e && e.message || e})` };
  } finally { clearTimeout(timer); }
}

module.exports = { notesBetween, reachedBack, releaseNotesFor, RELEASES_URL };
