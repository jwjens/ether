---
feature: audio-engine-version
title: "Warning: the audio engine is running an older build"
summary: What the amber bar at the top of the screen means, why closing the window is not enough, and why some readings may say UNKNOWN until you restart.
where: Appears by itself at the top of the screen when it applies
since: 4.4.178
audience: operator
tour: true
---

# "The audio engine is running an older build"

## What you are seeing

An amber bar across the top of the screen:

> ⚠ The audio engine is running an older build — **fully close and reopen Ether**. Until then some
> readings may be missing or out of date.

## Why this happens

Ether is two programs. The **app** is the window you are looking at. The **audio engine** is a
separate program that keeps playing whether or not the window is open — that is deliberate, and it is
why closing the window never takes you off the air.

When Ether updates itself, the window gets the new version. **The audio engine does not** — it is
busy playing, and swapping it mid-song would put dead air to air. So it keeps running the old build
until it is stopped and started again.

Most of the time the two builds agree and you never see this bar. When they do not, you get told.

## What to do

1. Finish or hand off what is on air — this restarts the audio.
2. **Fully close Ether.** Not just the window: quit it from the tray icon as well, so the audio
   engine stops too.
3. Open Ether again.

The bar disappears on its own once the engine matches. There is nothing to dismiss and nothing to
click — it is a statement about your system, not a notification.

> **Closing only the window is not enough.** The window and the engine are separate programs; the
> engine survives the window closing. That is the entire reason this bar exists.

## Is anything wrong with what is on air?

**Probably not.** A mismatched engine usually plays exactly as it should. The risk is not silence —
it is that the *screen* may not be able to tell you the whole truth, because a newer app can ask the
older engine for things it does not know how to answer.

That is why the bar says *some readings may be missing or out of date*.

## Why a reading says UNKNOWN

Where the app needs something the running engine cannot supply, it says **UNKNOWN** rather than
showing a number.

That is on purpose, and it is the safer of the two options. A confident-looking figure that is
actually a stand-in cannot be questioned — it looks like fact. UNKNOWN can be questioned, and it
points at this bar. If a reading you rely on says UNKNOWN, restart as above and it will come back.

The bar itself follows the same rule: if the engine is old enough that it cannot even report its own
version, it says **version unknown** instead of printing a number nobody can stand behind.

## What it does NOT mean

- **It is not a crash**, and it is not dead air. Your station is playing.
- **It is not an update prompt.** Updating again will not clear it — only stopping and starting the
  engine will.
- **It is not permanent.** One full close and reopen resolves it.

## Related

**Health Monitor** — the same event is written to the health ledger as `daemon-version`, once when
it starts and once when it clears, so a support look-back can see exactly when the mismatch began.
