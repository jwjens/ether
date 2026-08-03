---
feature: deck-on
title: Starting a Deck — the ON button
summary: ON is the only start control. It starts a cued deck and takes over from whatever is playing; pressed on a playing deck it turns that channel off. The old XFADE button is gone.
where: Live panel → each deck's ON button
since: 4.4.121
audience: operator
tour: true
---

# Starting a Deck — the ON button

## What it is

**ON is how you put a deck on air, and it is the only button that does it.** It works the way a channel ON
button works on a real broadcast board: press it and that channel goes on. Press it on the channel that is
already on and that channel goes off.

If you used the **XFADE** button before, it is gone — ON does that job now, and does it more safely. You no
longer have to think about which button starts a deck and which one swaps decks. There is one button.

## When to use it

- You want to **skip to the next track right now** — a wrong track, a bad file, something you need off the
  air immediately. Cue the next deck and press its ON.
- You want to **start the station** from silence.
- You want to **kill a channel** — press ON on the deck that's playing.

You do **not** need to leave AUTO to do any of this. Automation keeps rolling around you.

## How to use it

### Start a deck that is cued

1. Make sure the deck has a track loaded on it (the deck shows a title — that's a **cued** deck).
2. Press that deck's **ON**.
3. The deck goes on air. If another deck was playing, it comes **off within about a third of a second**.

That's the whole operation. You don't stop the other deck first — ON does it for you, in the right order.

### Turn a channel off

Press **ON** on the deck that is currently playing. That channel goes silent immediately.

This is a **stop, not a pause.** There is no resume — the deck goes back to idle. If you want that track
back, load it again.

### Start from silence

If nothing is playing at all, press ON on any cued deck. It simply starts. Nothing has to come off first.

## How it behaves on air

- **The handover is a clean cut, not a fade.** When you use ON to take over, the outgoing track is cut
  after about 300 milliseconds. That is deliberate: the reasons you reach for this button in a hurry —
  profanity, the wrong song, a garbled file — are all reasons the current audio needs to be **gone**, not
  fading underneath the new track for another three seconds.
- **Your normal automatic song-to-song segues are unchanged.** Those still use the smooth overlap set by
  your crossfade time in Settings. The quick cut applies only when *you* press ON.
- **Automation absorbs it and keeps going.** In AUTO, after you take over, the next tracks re-cue behind
  you automatically and the program log continues from where you skipped to. You do not have to re-arm
  anything.
- **In MANUAL, nothing auto-cues.** ON works exactly the same, but no track is loaded onto the standby
  decks afterward. In MANUAL you own the hour — cue every deck by hand, as intended.
- **Pressing it twice does nothing bad.** A second press on a deck that is already going live is ignored,
  not doubled. You cannot put two decks on air by hammering the button.

## If it doesn't do anything

- **The deck is empty.** ON will not start a deck with no track on it — that would be dead air. Load a
  track first. The deck shows a title when it is genuinely cued.
- **You pressed the deck that's already live.** That's the "already on air" case — nothing to take over.
- **Check the Health Monitor's Live Activity.** Every start is logged there. You will see
  `operator start: deck B LIVE` or `segue: deck B LIVE` with the track name, so you can confirm what the
  station actually did.

## Not in this version (by design)

- **No fade on the takeover.** It is a hard 300 ms cut. Automation never moves your faders — those are
  your controls, and ON does not touch them.
- **No keyboard shortcut** for ON.
- **No undo.** Channel OFF is immediate and final; reload the track if you need it back.

## Related

- Automatic segues and crossfade time — Settings → Playout
- **MANUAL vs AUTO** — what automation does and does not decide for you
- Health Monitor → Live Activity — the running log of every start, segue and stop
