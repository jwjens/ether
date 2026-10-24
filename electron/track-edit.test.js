// Editing one Library field never clears another (the May bug, 486b861): electron/track-edit.js.
import { describe, it, expect, beforeEach } from "vitest";
const { applyTrackEdit } = require("./track-edit");

// An in-memory song/artist/album store behind the same deps the IPC handler passes.
let songs, artists, albums, writes;
function deps() {
  return {
    getSong: (_db, id) => songs.get(id) || null,
    artistsFindOrCreateByName: (_db, name) => {
      let a = [...artists.values()].find(x => x.name === name);
      if (!a) { a = { id: artists.size + 100, name }; artists.set(a.id, a); }
      return a;
    },
    albumsFindOrCreate: (_db, { title, artistId, year }) => {
      let a = [...albums.values()].find(x => x.title === title && x.artist_id === artistId);
      if (!a) { a = { id: albums.size + 200, title, artist_id: artistId, year: year ?? null }; albums.set(a.id, a); }
      else if (year != null) a.year = year;
      return a;
    },
    setAlbumYear: (_db, albumId, year) => { albums.get(albumId).year = year; },
    songsUpdateById: (_db, id, patch) => { writes.push(patch); Object.assign(songs.get(id), patch); },
  };
}

beforeEach(() => {
  artists = new Map([[7, { id: 7, name: "Will Smith" }]]);
  albums = new Map([[3, { id: 3, title: "Big Willie Style", artist_id: 7, year: 1997 }]]);
  songs = new Map([[544, { id: 544, title: "Miami", artist_id: 7, album_id: 3, genre: "Pop", bpm: 106 }]]);
  writes = [];
});

const song = () => songs.get(544);

describe("applyTrackEdit — a field the edit does not carry is left alone", () => {
  it("editing the artist keeps the album (the May bug: album_id went to null)", () => {
    expect(applyTrackEdit(null, { id: 544, artist: "Will S" }, deps()).ok).toBe(true);
    expect(song().album_id).toBe(3);
    expect(song().artist_id).not.toBe(7);
    expect(artists.get(song().artist_id).name).toBe("Will S");
    expect(writes).toEqual([{ artist_id: song().artist_id }]);
  });

  for (const [col, value, expected] of [
    ["genre", "Hip Hop", { genre: "Hip Hop" }],
    ["bpm", 108, { bpm: 108 }],
    ["title", "Miami (Remix)", { title: "Miami (Remix)" }],
  ]) {
    it(`editing ${col} keeps the artist and the album (the May bug: artist_id went to null)`, () => {
      applyTrackEdit(null, { id: 544, [col]: value }, deps());
      expect(song().artist_id).toBe(7);
      expect(song().album_id).toBe(3);
      expect(writes).toEqual([expected]);
    });
  }

  it("editing the album keeps the artist, and files the album under that artist", () => {
    applyTrackEdit(null, { id: 544, album: "Willennium" }, deps());
    expect(song().artist_id).toBe(7);
    expect(albums.get(song().album_id)).toMatchObject({ title: "Willennium", artist_id: 7 });
  });

  it("editing the year sets the year on the song's album and keeps both links", () => {
    expect(applyTrackEdit(null, { id: 544, year: 1998 }, deps()).ok).toBe(true);
    expect(albums.get(3).year).toBe(1998);
    expect(song().artist_id).toBe(7);
    expect(song().album_id).toBe(3);
    expect(writes).toEqual([]);   // songs has no year column: nothing on the song row changes
  });

  it("a year for a song with no album is refused with a reason, and changes nothing", () => {
    song().album_id = null;
    const r = applyTrackEdit(null, { id: 544, year: 1998 }, deps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no album/);
    expect(song().artist_id).toBe(7);
  });

  it("an empty artist or album clears only that field — the one explicit way to clear", () => {
    applyTrackEdit(null, { id: 544, artist: "" }, deps());
    expect(song().artist_id).toBeNull();
    expect(song().album_id).toBe(3);
    applyTrackEdit(null, { id: 544, album: "" }, deps());
    expect(song().album_id).toBeNull();
  });

  it("the full edit dialog still saves every field it carries", () => {
    applyTrackEdit(null, { id: 544, title: "Gettin' Jiggy", artist: "Will Smith", album: "Big Willie Style", year: 1997, genre: "Rap", bpm: 108 }, deps());
    expect(song()).toMatchObject({ title: "Gettin' Jiggy", artist_id: 7, album_id: 3, genre: "Rap", bpm: 108 });
  });

  it("an unknown song is an error, not a silent no-op", () => {
    expect(applyTrackEdit(null, { id: 9999, genre: "x" }, deps())).toEqual({ ok: false, error: "song 9999 not found" });
  });

  it("the IPC handler uses applyTrackEdit and no longer builds the always-defined patch", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "main.js"), "utf8");
    const at = src.indexOf('ipcMain.handle("discogs:updateTrack"');
    const body = src.slice(at, src.indexOf("});", at));
    expect(body).toMatch(/require\('\.\/track-edit'\)\.applyTrackEdit\(/);
    expect(body).not.toMatch(/artistId !== undefined/);
  });
});
