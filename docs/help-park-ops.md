---
feature: park-ops
title: Park Ops — the closing time, from any phone
summary: A web page for the person walking the park — what's on air, today's announcements, and the closing time, editable from the floor. Works from anywhere, on any connection.
where: park.ether-cast.com/<your-station-slug>
since: 4.4.232
audience: operator
tour: true
---

# Park Ops — the closing time, from any phone

## What it is

A web page that answers the three questions the person on the floor actually has at 9pm:

- **What's on air right now?**
- **What is the park about to announce, and when?**
- **What time are we closing tonight — and can I change it from here?**

It opens in an ordinary phone browser. Nothing to install, no login, no app.

## The address

```
park.ether-cast.com/<your-station-slug>
```

For HalloVeen that is **park.ether-cast.com/halloween** — the same slug the public listener page uses
at `listen.ether-cast.com/halloween`.

**The page is hosted, so the address always works.** It does not matter whether the studio machine is
switched on, whether Ether is running, or whether the station is on air. If the station is dark the
page still loads and tells you so. You can bookmark the link, text it to staff, and it will not go
stale.

## Two versions of the link

| Link | Who it's for | Can change the closing time |
|---|---|---|
| `park.ether-cast.com/halloween` | anyone — post it, share it freely | No |
| `park.ether-cast.com/halloween?k=…` | whoever runs the park that night | **Yes** |

The part after `?k=` is an access token. It unlocks the closing time and nothing else — it cannot
touch the music, the log, or any other station. Reading is open on purpose: if someone's phone drops
the query string they should still see the closing time, not an error.

**Where to find your link:** the studio machine prints both versions in its log when Ether starts:

```
[ops] Park Ops (editable): https://park.ether-cast.com/halloween?k=…
[ops] Park Ops (view-only): https://park.ether-cast.com/halloween
```

There is not yet a screen inside Ether that shows this link. That is a known gap, written down in the
backlog — for now, copy it from the log.

## Using it

1. **Open the link on the phone.** The station name is at the top.
2. **Now playing** — what's on air. If the station isn't running it says so rather than showing
   something stale.
3. **Announcements · today** — everything scheduled for today, in order, each with its time. One
   marked **already played** has fired.
4. **Park closes** — tap it, set the time, save.

## The notes beside a row

If something looks wrong the page says so **in a sentence beside the row** — it never refuses your
change. You may know something the rule does not: a ride broke down, the fireworks ran late.

You'll see a note when:

- An announcement is **more than six hours** from the closing time — usually a sign the closing time
  itself is wrong.
- An announcement with **"closing" in its name** is due while the park is open for a good while yet.
- **Two announcements sit within a minute** of each other.

Read it, then do what you were going to do.

## What this version does NOT do yet

Be clear on this, because the page shows times that look live:

- **Times marked "preview" are previews.** Where an announcement is set relative to closing ("20
  minutes before close"), the page shows what it *would* fire at under the closing time you've set.
  **The station still fires the fixed time stored on the announcement.** Changing the closing time
  here does not yet move when those announcements actually air.
- **Changing the closing time sets the station default.** Per-date and per-weekday closing times
  exist in the stored data but aren't editable from this page yet.
- Nothing here starts, stops, or reorders audio. It cannot take the station off air.

## If the closing time is saved while the studio machine is off

It still lands. The change is held and delivered to the station the moment it comes back online. The
page shows the new time immediately either way.

## Troubleshooting

**"No park at this address"**
The slug in the URL doesn't match a published station. Check the link, and check the station has a
public page configured in Ether.

**"This station isn't reporting"**
The page loaded fine, but Ether hasn't sent anything for this park yet — the studio machine hasn't
run since Park Ops shipped, or isn't signed in. It fills in on its own once the machine is running.

**"Can't reach Park Ops"**
Your phone's connection, not the park's. The page keeps showing the last update underneath.

**"View only"**
You're using the link without the `?k=` token. Get the full one from the studio machine's log.

## Related

- Announcements and their schedule: the **Announcements** panel in EtherCast.
- The public listener page for the same station: `listen.ether-cast.com/<slug>`.
