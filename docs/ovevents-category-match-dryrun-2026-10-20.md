# Dry run — make OVEVENTS' song categories match OV (by UUID)

> **Read this first (added after the run, read-only checks):**
> - **All 73 changes are songs DELETED on both computers.** 0 live songs would change.
> - **Every live song already matches OV**, category by category, by uuid — Kids (halloVeen) 28 = 28 (the same 28 songs), HV Adult 17 = 17, Upbeat-less "none" 145 = 145, every other category equal. The 14:25 one-time repair put the live songs right; it skips deleted songs, which is why these 73 still differ.
> - "Kids holds only Thunder" was the state before 14:25 (not reproduced from the data afterwards).
> - Applying the 73 changes changes nothing anyone can see; it makes the deleted rows match too ("exactly"). Waiting for Jeff's OK.
> - OV export: `P:\ov-song-categories-2026-10-20.csv`, 681 rows, sha256 `7c9195a83653d46d8ff398c79e0cf1b6bda90d60c4b74ed1cccf15a844b7c3d7`. OVEVENTS read live (read-only) at the time of the run.

- Export: `C:/Users/jensj/AppData/Local/Temp/claude/C--openair/0a99cd01-c69f-4d79-bfd4-a7fd150ca704/scratchpad/ov-song-categories.csv` (681 rows) · this database: `C:\Users\jensj\AppData\Local/Ether/profiles/ETH-STN-BAA8-E056-6FC8/openair.db` (682 songs) · made 2026-10-20T21:45:13.546Z
- **Would change: 73** · already the same: 608 · only on OV (not touched): 0 · only on OVEVENTS (not touched): 1 · OV's category is not on OVEVENTS (not touched): 0

## Summary by move

| From (here now) | To (OV) | Songs |
|---|---|---|
| Kids (halloVeen) | Upbeat (halloVeen) | 65 |
| HV Adult (halloVeen) | Kids (halloVeen) | 6 |
| Movie & TV Instrumentals (halloVeen) | HV Adult (halloVeen) | 2 |

## Every song that would change (73)

| Song | From (here now) | To (OV) | Note |
|---|---|---|---|
| Monster - Album Version (Edited) | Movie & TV Instrumentals (halloVeen) | HV Adult (halloVeen) | deleted here, deleted on OV |
| Tales from the crypt_mixdown | Movie & TV Instrumentals (halloVeen) | HV Adult (halloVeen) | deleted here, deleted on OV |
| Bad Blood | HV Adult (halloVeen) | Kids (halloVeen) | deleted here, deleted on OV |
| Ghost | HV Adult (halloVeen) | Kids (halloVeen) | deleted here, deleted on OV |
| Goosebumps | HV Adult (halloVeen) | Kids (halloVeen) | deleted here, deleted on OV |
| HandClap | HV Adult (halloVeen) | Kids (halloVeen) | deleted here, deleted on OV |
| I Want Candy | HV Adult (halloVeen) | Kids (halloVeen) | deleted here, deleted on OV |
| Thunder | HV Adult (halloVeen) | Kids (halloVeen) | deleted here, deleted on OV |
| Anxiety | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Aperture | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| APT. | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Astronaut In The Ocean | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| back to friends | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Beautiful Things | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Blinding Lights | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Bones | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Cake By The Ocean | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Can't Stop The Feeling! | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Candy Girl | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Castle On The Hill | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Certified BOP | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Choosin' Texas | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Criminals | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Cruel Summer | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| DAISIES | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Dance Monkey | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Dance The Night | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Die On This Hill | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Die With A Smile | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Disturbia | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| drop dead | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Forever Young | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Gabriela | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Golden | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| High Hopes | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| HOT TO GO! | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Houdini | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| I Ain't Worried | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| I Don't Care | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| I Just Might | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| I'm Good (Blue) | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| JUMP | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Levitating | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Lil Boo Thang | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Little Shop Of Horrors | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Love Me Not | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Manchild | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| me & ur ghost - US Version | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Messy | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Midnight Sun | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| MUTT | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Mystical Magical | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Nice To Meet You | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| NOKIA | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Old Town Road | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Opalite | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Ordinary | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Pink Pony Club | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Purple People Eater | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Recuérdame | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Shut Up And Dance - Original Version | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| So Easy (To Fall In Love) | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Spooky | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Spooky Halloween Sounds | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Stateside | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Summer Starts Now | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Tears | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| The Addams Family | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| The Bones | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| The Munsters Theme | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Try Everything | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| Vampire | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |
| YUKON | Kids (halloVeen) | Upbeat (halloVeen) | deleted here, deleted on OV |

## Only on OVEVENTS — not touched (1)

- dragon-studio-spooky-wolf-howl-410547 (156069ed-41f4-4156-83a3-eb7db6c88f57) — deleted here — here: (no category)
