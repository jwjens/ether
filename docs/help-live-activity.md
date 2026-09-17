---
feature: live-activity
title: Live Activity
summary: A running terminal in the Health Monitor showing what Ether is doing right now — every rotation, segue, stop, spot and warning, as it happens, per station.
where: Footer → NOMINAL (Health Monitor) → right-hand column
since: 4.4.107
audience: operator
tour: true
---

# Live Activity

## What it is

**Live Activity** is a terminal that sits beside the health sections and shows you, line by line, what Ether's
automation is doing **right now** — which deck just went live, which song ended, when a stop was issued, when
a sweeper fired, when a spot went to air. It is the answer to "is it actually doing anything, and what?"

It reads the log the audio engine already writes. It is a **window, not a control** — nothing you do here
changes what is on air.

## When to use it

- Something sounds wrong and you want to see what the engine just did.
- You want to confirm a station is rotating normally without staring at the decks.
- You're checking whether a spot or sweeper actually fired.
- You're on the phone with support and need to describe what's happening.

## How to use it

1. Open the **Health Monitor** — click **NOMINAL** in the bottom-right footer.
2. The terminal is the **right-hand column**. On a narrow window it moves **below** the health sections
   instead.
3. Watch it. Newest lines appear at the bottom and it scrolls itself.

### Choosing what you see

Three buttons across the middle:

- **Decisions** *(the default)* — only the moments something changed: a deck went live, a song ended, a stop
  was issued, a sweeper or spot fired, automation started or stopped. This is what you want almost always.
- **All activity** — everything, including the engine's four-times-a-second heartbeat. Useful for deep
  troubleshooting, very noisy otherwise.
- **Warnings** — only things worth a second look: a stall, a forced stop, a safety guard firing, a station
  running behind its schedule.

### Watching one station

The row of buttons above — **All**, **s1**, **s2**, **s3**, **s4** — filters to a single station. Each station
also has its own colour, so you can pick one out at a glance without filtering.

### Reading without it jumping

Click **Pause** to freeze the view. **Scrolling up also pauses it automatically** — so you can read a line
without the feed yanking you back down. The green dot goes grey while paused.

Click **Resume** to jump back to live. **Nothing is lost while paused** — activity keeps being collected in
the background and appears when you resume.

## What the lines mean

Each line is: **time · station · what happened**.

| You'll see | It means |
|---|---|
| `segue: deck B LIVE — <song>` | That song just started on deck B — it is what's on air. |
| `deck A ended` | The song on deck A finished. |
| `advance → stop:A` | Deck A was stopped and cleared after handing over. |
| `segue overlap: A→B` | The next song started early over the tail of the last one — a normal segue. |
| `clean spot edge` | A commercial is playing on its own, with no overlap. That's deliberate. |
| `sweeper FIRING` | A sweeper or sweeper is playing over the seam. |
| `top-of-hour HARD CUT` | The top of the hour arrived and the schedule was re-synced to the clock. |
| `liveDeck OBSERVER — TWO DECKS ON AIR` | **Two songs are playing at once.** Report this. |
| `watchdog: STALL` | Nothing was playing and the engine forced a recovery. |
| `resume-playout: deck B REFUSED by the engine` | The recovery tried deck B but the deck had nothing loaded, so the engine refused to play it. **Nothing went to air from that deck** — the recovery moves on to the next queued song on deck A. Shown in red under **Warnings**; it is also counted in the Health Monitor (see *Library & Rotation* → skipped this hour, and the station's red line). |
| `[RUST] Play deck B: REFUSED — no content loaded` | The audio engine's own line for the same refusal. |
| `LOGREADER-SHADOW: behind` | The station is running later than its scheduled log. |

## Good to know

- The terminal keeps roughly the **last 800 lines**, then drops the oldest. It is not an archive — for the
  permanent record use **Export Play Log CSV** further down the Health Monitor.
- If it says *"Waiting for activity from the audio daemon…"*, the audio engine may not have started yet.
  Give it a moment after launching Ether.
- After an update, **fully close and reopen Ether** — the audio engine does not reload on its own, so its log
  won't restart until you do.
- Empty with a filter on? Switch to **All activity** to confirm the feed is alive.

### Which file it is reading, and how fresh it is

Under the line count the terminal names the **log file it is following** and **when that file was last
written** — for example *following …\Ether\logs\ether-audiod.log · last write 4s ago*.

- The audio engine tells Ether where it is writing, so this is the engine's own answer, not a guess.
- If the file has not been written for **10 minutes** the line turns red and says **STALE**. Old lines
  on screen are then old lines — the engine is not busy, it is quiet (or not running).
- *"path not confirmed by the daemon"* means the running engine is from an older build that does not
  report its file; Ether falls back to the most recently written engine log. After you **fully close and
  reopen Ether** the new engine reports its path and the note goes away.
- If the engine restarts into a different file, the feed says *— now following … —* and continues from
  the new file's tail.
