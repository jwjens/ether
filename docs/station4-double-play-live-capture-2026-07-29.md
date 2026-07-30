# Station 4 live capture — double-play + dead animation (READ-ONLY)

**Captured:** 2026-07-29 22:07-22:36 UTC, live, while the fault was on air. **Nothing changed. Nothing touched.**
Station 4 = Christmas In July.

---

## The single hard anomaly

At the same instant, the Rust mixer reports station 4's decks in a state **no other station shows**:

```
s4:  A src=1 a=0 p=1 | B src=1 a=1 p=0 | C src=1 a=1 p=1     ← C is ACTIVE *and* PAUSED
s2:  A src=1 a=1 p=0 | B src=1 a=0 p=1 | C src=1 a=0 p=1     ← healthy: idle decks are a=0 p=1
s3:  A src=1 a=1 p=0 | B src=1 a=0 p=1 | C src=1 a=0 p=1     ← healthy
```

`a=1 p=1` is contradictory — the deck is in the active mix **and** flagged paused. Stations 2 and 3 never show it;
station 4 held it for the whole capture window (22:07:48 → 22:36:17, every sample).

**Deck C is the deck that was left behind.** From the rotation chain:

```
22:03:41.271  segue: deck C LIVE — Kana Kaloka
22:03:44.777  advance → stop:B
22:06:13.927  segue: deck B LIVE — Funky New Year
22:06:17.423  advance → stop:A  — outgoing still playing past grace (same source) → FORCE stop (Bug-A guard)
22:10:12.460  segue: deck A LIVE — Tricky Dicky Dong
```

**Deck C went LIVE at 22:03:41 and was never stopped.** Rotation moved C → B → A over the next seven minutes and
issued `stop:B` and `stop:A`, but **no `stop:C` has fired since 21:48:52** — before that C even started. Meanwhile
the chain kept advancing normally, so nothing upstream noticed.

Your screenshot is the same fact from the other side: decks 1 and 3 metering, deck 2 flat, and **deck 3 reading
`0:18 / 0:18`** — Kana Kaloka, an 18-second track, sitting at exactly its own duration. Position clamped at
duration, still lit, still in the mix.

## Is there a second engine driving station 4? **No.**

- **One daemon client**, connected 17:51:41, no reconnect in the log since.
- **One DaemonEngine per station**, keyed by integer id (`ether-audiod.js:56,87`), and s4's advance lines are a
  single serialized chain — every `advance →` is followed by its own `advance done Nms` with no interleaving or
  duplicate rotate for the same deck.
- **No in-process engine competing.** If main's native engine were also playing station 4, drain would exceed the
  target. It does not:

```
[RUST] Station 4 drain: real=355050 B/s   (target 352800)   ← identical to stations 1, 2, 3
```

All four stations drain within 0.6% of target. **The audio pipeline is healthy and single-sourced.** This is not
the two-engine hazard from the HOP-4 teardown report, and I am not going to claim it is.

## Rotation mode for station 4

**Still unknown, and the reason is the one already documented.** The `[ROT] daemon-driven …` / `[ROT] in-process …`
line is written by `rotLog` → `log:rotation` → `main.js:3299`, which resolves to
`__dirname/../tmp-userdata/rotation.log` — a directory that does not exist in a packaged install, inside a
`try/catch`. Every one of those lines has been discarded. That is the repair you authorised and I had started when
this came in; it is not built.

What can be said without it: the daemon **is** emitting for station 4 (segues at 22:06:13 and 22:10:12, deck-ended
lines, jingle fire/clear), so the producer side is alive exactly as before.

## Same root as the frozen animation? — **Almost certainly yes, and the deck C evidence is why**

Both symptoms are the same disagreement, seen twice:

| | Daemon / Rust says | UI shows |
|---|---|---|
| Deck C | `a=1 p=1`, never stopped, position clamped at 18.13 s | Deck 3 lit, metering, frozen at `0:18 / 0:18` |
| Deck B | `a=1 p=0` — the live deck since 22:06:13 | Deck 2 **flat**, no meter |
| Live track | Funky New Year, then Tricky Dicky Dong at 22:10 | NOW PLAYING: *Please Come Home For Christmas* |

The UI is showing a deck the daemon stopped tracking, is not showing the deck the daemon says is live, and NOW
PLAYING names a third thing. **That is not an animation bug — the renderer's deck state and the daemon's deck state
have diverged**, which is precisely the frozen-countdown fault described in
`docs/deck-freeze-live-evidence-2026-07-29.md`, now visible as wrong *content* rather than merely a stopped clock.

**But the deck-C-never-stopped fact is daemon-side, not renderer-side**, and that matters: a stuck `a=1 p=1` deck is
in the Rust mix, which no renderer bug can cause. So the honest reading is **two faults that look like one**:

1. **Daemon/Rust:** deck C left active after its segue-out — `stop:C` never issued. Audible double-play. There is
   already a guard for exactly this shape on the outgoing deck (`stop:A — outgoing still playing past grace (same
   source) → FORCE stop (Bug-A guard)`, fired at 22:06:17) — **deck C's exit did not go through it.**
2. **Renderer:** deck state diverged from the daemon, as previously established.

Fault 1 explains what you can hear. Fault 2 explains what you can see. Fixing the renderer would not silence the
second song.

## What I checked and ruled out

- **Two engines / double advance** — ruled out: single serialized advance chain, one daemon client, drain at target.
- **A starved or degraded mixer** — ruled out: `frames=+227702` for s4 in the same tick as s2's `+227702`; drain
  identical across all four stations.
- **D/E/F involvement** — none; every line is A/B/C, consistent with your statement that only A/B/C are used.

## The one number I could not reconcile

Your Health Monitor shows **Christmas In July 13k/s pk .89** while the other three read 48k/s. The daemon's own
mixer log shows station 4 producing the *same* frame count per tick as the others (`+227702` vs `+227702`) and the
same drain. So the 13k/s is a **reported** value that disagrees with the daemon's own measurement — another
instance of station 4's numbers reaching the UI wrong, not of station 4 actually running slow. Flagged, not chased.

## Scope note

Read-only. Daemon log read, nothing modified, nothing committed, nothing built, no daemon command issued. The
station is still on air with the fault present; I have not touched it.
