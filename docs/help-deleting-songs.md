---
feature: deleting-songs
title: Deleting a Song
summary: Deleting a song removes it from the library and pulls it out of every future log — it never airs again, even after you regenerate. What it already aired stays on the books.
where: Library → right-click a song → Delete
since: 4.4.151
audience: operator
tour: true
---

# Deleting a Song

## What it is

Deleting a song takes it out of your library **and out of everything scheduled ahead of it**. The song stops
being something the station can play: it won't be picked when you Generate, it won't show up in the queue or
the calendar, and it won't come back the next time you generate a day.

What it *already* played stays exactly where it is. Your airplay history — the record you'd hand an
advertiser to prove their spot ran — is never rewritten by a delete.

## When to use it

- A track you don't want on the air any more: wrong format, bad edit, licensing pulled, a duplicate import.
- A song that's damaged or won't play properly.

If you only want a song to *rest* for a while, don't delete it — that's what rotation status and rest rules
are for. Delete is permanent.

## How to delete a song

1. Open the **Library**.
2. Find the song. (Search matches title, artist, and cart number.)
3. **Right-click** it and choose **Delete**.
4. Confirm.

That's it. There is no second step and nothing to clean up afterwards.

## What happens the moment you delete

**Removed — the song's future:**

- It disappears from the **Library** and from library search.
- Every **upcoming log entry** for it is pulled — today's and every future day already generated.
- It's dropped from the **queue** and the **calendar**.
- It's removed from any **pinned** spot, **programming** entry, and its **category assignment**.
- If it was pinned into a **clock** slot or set as a **category's** imaging, that slot or category stays
  exactly where it is — it simply no longer points at the deleted song. Your clocks are not rearranged.
- **Generate will never pick it again**, no matter how many times you regenerate.

**Kept — the song's past:**

- **Airplay history** (what aired, and when) — your advertiser proof.
- The **log entries for plays that already happened**, marked as played.
- **Anything on the air right now stays on the air.** If you delete a song while it's playing, it finishes
  normally. Deleting never cuts live audio.

## How to check it worked

1. Search the **Library** for the song — no result.
2. Open the **Calendar** and **Generate** the day again.
3. Search the log — the song is not there, and it won't be there after any future Generate either.

## Things worth knowing

- **The audio file itself is not erased from your computer or your cloud storage.** Deleting removes the song
  from the station's library and programming; it doesn't reach onto your disk and delete the file. If you
  want the file gone, remove it yourself.
- **Deleting is not the same as re-importing.** If you delete a song and later import the same file again, it
  comes back as a new library entry — fresh, with none of its old tags or category.
- **On more than one machine?** The delete travels with your account. Other installs signed into the same
  account stop playing the song too, as soon as they sync.
- **Deleting a whole station's library** (Preferences) follows the same rules: the future is cleared, the
  airplay history is kept.

## If something looks wrong

- **The song is still in the queue right after deleting.** The queue on screen may show what was already
  handed to the audio engine. It clears at the next break; nothing new will be loaded from that song.
- **A song you deleted seems to still be playing.** Check **Help → About** for your version — this behavior
  arrived in **4.4.151**. On older builds, deleted songs could be picked up again by Generate. Update, then
  regenerate the day.
- **You deleted the wrong song.** There's no undo. Re-import the file from the **Library → Import** button
  and re-tag it.
