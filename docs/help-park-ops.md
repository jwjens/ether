---
feature: park-ops
title: Park Ops — the closing time, from your phone
summary: A phone page on the park's wi-fi showing what's on air, tonight's announcements, and the closing time — with the closing time editable from the floor.
where: Any phone on the park wi-fi → http://<station-ip>:3400/ops/
since: 4.4.231
audience: operator
tour: true
---

# Park Ops — the closing time, from your phone

## What it is

A single web page, served by the studio machine itself, that answers the three questions the person
on the floor actually has at 9pm:

- **What's on air right now?**
- **What is the park about to announce, and when?**
- **What time are we closing tonight — and can I change it from here?**

It runs in an ordinary phone browser. There is nothing to install and no login. You need to be on
**the same wi-fi as the studio machine**, and that is the only requirement.

## Why it is served by the studio machine, not from the web

Because on the night it matters, the park's internet is down. The page is served straight off the
studio machine over the local network, so it keeps working when nothing else does. The trade-off is
the one above: same wi-fi, or no page.

## Getting the link (read this — there is no button yet)

**The URL is the whole access method — there is nothing to scan and nothing to install.** Today that
URL appears only in the studio machine's startup log; there is no screen in EtherCast that shows it.
That is a real gap, not a secret — it is written down in the backlog.

On the studio machine, when Ether starts, the log prints one line per network the machine is on:

```
[ops] Park Ops (editable): http://192.168.1.40:3400/ops/?k=a1b2c3d4e5f6...
```

- Send that whole line to whoever needs to change the closing time. That is the **editable** link.
- Drop the `?k=...` part and it becomes the **view-only** link — fine to share with anyone.

If the machine is on wi-fi *and* ethernet you will see two lines. Use the one on the same network as
the phone; the other will simply not load.

## Using it

1. **Open the link on the phone.** The page loads with the station name at the top.
2. **Now playing** — the song currently on air, with how far through it is. If the audio engine is
   not running, it honestly says nothing is playing rather than showing stale information.
3. **Tonight's announcements** — every announcement scheduled for *today's date*, in the order they
   are due, each with its time. One marked **already played** has fired today.
4. **Closing time** — the big one. Tap it, set the time, save.

## The sanity notes beside a row

If something looks wrong, the page says so **in a sentence beside the row** — it never refuses your
change. You may know something the rule does not: a ride broke down, the fireworks ran late.

You will see a note when:

- An announcement is **more than six hours** from the closing time — usually the sign the closing
  time itself is wrong.
- An announcement with **"closing" in its name** is due while the park is open for a good while yet.
- **Two announcements sit within a minute** of each other.

Read it, then do what you were going to do. The note is information, not a gate.

## What is view-only, and why

**Reading is open to anyone on the wi-fi. Changing the closing time needs the `?k=` link.**

That split is deliberate. If someone's phone loses the query string they should still see the
closing time — not an error. But a change to what the park announces should not be one wrong tap
from any phone on the guest network.

If you try to save without the token, the page tells you it is view-only.

## What this version does NOT do yet

Be clear on this, because the page shows times that look live:

- **Announcement times shown as a preview are a preview.** Where an announcement is set to fire
  relative to closing ("20 minutes before close"), the page shows you what it *would* fire at under
  the closing time you have set. **The playout engine is not yet driven by that offset** — it still
  fires the fixed time stored on the announcement. Changing the closing time here does not yet move
  when those announcements actually air.
- **Changing the closing time sets the station default.** Per-date and per-weekday closing times
  exist in the stored shape but are not editable from this page yet.
- Nothing on this page starts, stops, or reorders audio. It cannot take the station off air.

## Troubleshooting

**"This site can't be reached" / connection refused**
Ether is not running on the studio machine, or the phone is on a different network (guest wi-fi is a
common culprit). Check Ether is open, then re-read the `[ops]` line — the machine's IP may have
changed.

**The page loads but says no station is active**
The studio machine has no active station. Open Ether and select one.

**"This copy is view-only"**
You are using the link without the `?k=` token. Get the full line from the startup log.

**No `[ops]` line in the log at all**
The line is only printed when a station is active at startup. Select a station and restart Ether.
The page still serves read-only in the meantime.

## Related

- Announcements and their schedule: **Announcements** panel in EtherCast.
- Design and open rulings: `docs/operator-closing-screen-and-source-routing-2026-08-31.md`
