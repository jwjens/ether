# halloVeen: new shows and clocks not followed: DIAGNOSIS ONLY (2026-10-15)

Nothing was changed, regenerated or written on any machine. Read-only:
- OVEVENTS' own database, opened read-only;
- the cloud mirror the air machine pushes (`station_cc_data`), the air machine's play reports (`station_play_history`)
  and its now-playing report, all read in READ ONLY transactions.

The scripts are in the session scratchpad: `diag-clocks*.mjs/js`.

## Jeff (verbatim)

> Clocks: diagnose only, change nothing (HalloVeen is on air). I added new clocks and new categories and assigned them to shows. The new shows generate, but the generated schedule isn't using the right clocks/categories.
> 1. Which station and machine I made the changes on, and which machine generates that station's schedule. If clocks were made on one machine and the schedule is generated on another (OVEVENTS vs ovowforestmusic), did the new clocks and categories sync over?
> 2. For each new show: the clock it's assigned to vs the clock the generated schedule actually used. Where they differ, why: old schedule not regenerated, show-to-clock link not saved, clock slots pointing at old categories, categories with no songs, or a default clock used.
> 3. One hour side by side: the clock as I built it vs what was generated.
> Plain words, propose the fix. Don't regenerate or edit anything on the air machine until I approve.

## 1. Station, machines, sync

- **Station:** halloVeen (`43889edc…`).
- **The machine that generates and plays it:** ovowforestmusic, machine `041ceb96…`. It is the one reporting
  now-playing, and the web app shows "sourced from ovowforestmusic".
- **New categories and clocks are on BOTH machines** (made 2026-10-13, 10:22–10:32 AM PDT):
  - categories **Kids**, **HV Adult**;
  - clocks **HalloVeen Hour One / Two / Three / Four**.
  - They have the same creation times on both, so they synced. The data can't tell which machine they were made on.
  - Each machine numbers them its own way, which is normal; the link between machines is the row's uuid:

    | | Upbeat | Kids | HV Adult |
    |---|---|---|---|
    | OVEVENTS | 18 | 19 | 20 |
    | ovowforestmusic | 19 | 20 | 21 |
- **The new shows exist ONLY on ovowforestmusic.** They were made there **today, 4:43–4:49 PM PDT**, and "HalloVeen" was
  changed from all day to 0–17 at 4:45 PM.
  - OVEVENTS has none of them. Ether isn't running on OVEVENTS, so it cannot receive them.
  - Today's slot edit on Hour Three (4:47 PM) is also only on ovowforestmusic: Hour Three has 23 slots there, 21 on
    OVEVENTS.
  - OVEVENTS doesn't generate halloVeen, so this doesn't change what airs.

## 2. Each new show: assigned clock vs what aired

On ovowforestmusic the setup itself is right:

| Show | Hours | Clock | Clock asks for |
|---|---|---|---|
| HalloVeen | 0–17 | HalloVeen | 25 × HV |
| HalloVeen Hour One | 17–18 | Hour One | 7 Kids, 12 HV |
| HalloVeen Hour Two | 18–19 | Hour Two | 26 HV |
| HalloVeen Hour Three | 19–20 | Hour Three | 4 HV Adult, 19 HV |
| HalloVeen Hour Four | 20–22 | Hour Four | 7 HV Adult, 17 HV |

- The show-to-clock links are saved.
- Every slot points at the new categories (not old or deleted ones).
- No hour falls back to a default clock: the generator has none; a show without a clock is skipped
  (`electron/generate-core.js:231-232`).

**Why the schedule doesn't follow them: the schedule was made before the shows existed and hasn't been remade.**
- **Before 4:45 PM today there were no Hour shows.** Every hour ran "HalloVeen" on the all-HV clock. So every day before
  today aired exactly what was set up then.
- **Generated days are not remade when a show changes.**
  - Auto-generate only tops up when fewer than 4 days remain, then fills the next 10 days
    (`electron/main.js:11473-11475`, `_autoExtendTick` `:12203`).
  - Pressing Generate also remakes days.
  - Nothing else does. So today's 5 PM onward, and the days already generated after it, still hold the old picks.
- **Evidence it's the old picks:** in today's 5 PM hour three **HV Adult** songs aired, and Hour One's clock has no Adult
  slots. Those songs were picked while they were still HalloVeen songs, before the 2026-10-13 recategorization.
- **UNVERIFIED** (one read-only check on ovowforestmusic settles it): its `generated_schedule` rows for tonight 5–10 PM
  should show the old clock (HalloVeen) and a `generated_at` from before 4:43 PM today.
  - In Ether: Calendar → today. If Hour One shows the old 25-HV pattern, this is confirmed.

## 3. One hour side by side: Hour One, 5 PM today

| # | Clock as built | Aired (PDT, category on the air machine) |
|---|---|---|
| 1 | Kids | 5:02 creepy-halloween-bell-trap-melody (HV) |
| 2 | HV | 5:02 Love Ain't It (HV) |
| 3 | HV | 5:06 UNLV Health spot |
| 4 | Kids | 5:06 Sweet but Psycho (**HV Adult**) |
| 5 | HV | 5:09 monster-growl (none) |
| 6 | Kids | 5:09 KANYE WEST - MONSTER (**HV Adult**) |
| 7 | HV | 5:12 Halloween-scary-transition (HV) |
| 8 | HV | 5:12 Witch Doctor (none) |
| 9 | Kids | 5:14 La Llorona (HV) |
| 10 | HV | 5:17 halloween-impact-3 (HV) |
| 11 | Kids | 5:17 KANYE WEST - MONSTER (**HV Adult**, again) |
| 12 | HV | 5:19 halloween-impact-2 (HV) |
| 13 | HV | 5:19 Dancing In the Dark (Kids) |
| … | … | 5:23 Dancing In the Dark (Kids, again), 5:30 I Walked with a Zombie (Kids), the rest HV |

The clock asks for 7 Kids songs. 3 Kids plays aired, 2 of them the same song, and 3 HV Adult plays aired.
Up next at 5:40 PM: 10 HV and 2 Kids.

## Also found

- **10 PM–midnight has no show now.** "HalloVeen" ends at 17 and Hour Four at 22.
  - An hour with no show gets **no songs at all** when generated (`generate-core.js:231`; Generate reports "2 hour(s)
    have no show scheduled").
  - The park closes at 9, but the stream would have nothing scheduled 10–12 PM once those days are generated.
- **Kids and HV Adult are small on ovowforestmusic:** 8 Kids songs and 14 HV Adult songs in its library mirror.
  - Hour Three plus two Hour Fours ask for 18 Adult plays a day, so Adult songs will repeat and some picks will be
    "relaxed".
  - **UNVERIFIED:** OVEVENTS' own songs table counts 65 Kids and 9 Adult, so the two machines may not agree on which
    songs are Kids. Check: Library on ovowforestmusic, filter by Kids.
- **Two songs aired twice within minutes:** KANYE WEST - MONSTER at 5:09 and 5:17, Dancing In the Dark at 5:19 and
  5:23.
  - That breaks song separation. It may be a double report or a real double play. **UNVERIFIED**, noted only.

## Proposed fix (nothing done; each step needs Jeff's OK)

1. **Cover 10 PM–midnight:** either make Hour Four 20–0, or set "HalloVeen" back to cover 22–0 as a second show. This is
   Jeff's call: which clock should play 10 PM–midnight?
2. **Regenerate on ovowforestmusic.** Calendar → Generate, from the next hour forward, for today and the generated days
   after it.
   - The generator never touches an hour that has started (`generate-core.js:225`), so what is on air now is safe.
   - It's best done right after an hour starts or after close, so the new picks land cleanly.
3. **Check the Kids / HV Adult song counts** on ovowforestmusic. Add songs if 8 and 14 are really all there is.
4. **OVEVENTS** catches up the next time Ether opens on it. It doesn't affect what airs.
