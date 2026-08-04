---
feature: spot-artwork
title: Spot Artwork
summary: Pick your own image for a spot, so a commercial stops borrowing album art that has nothing to do with it.
where: Bottom bar → SPOTS → Edit (on a spot row) → Artwork
since: 4.4.134
audience: operator
tour: true
---

# Spot Artwork

## What it is

Every spot can carry **your own image** — the client's logo, a campaign graphic, a park photo. You choose it
once per spot and it stays with that spot.

Without one, a spot has no picture of its own, and anywhere artwork is shown the app falls back to whatever it
can find automatically. For music that works fine. For a commercial it often doesn't — an automatic lookup goes
by the spot's **title**, so a spot called "Zombie Nights" can come back wearing a rock band's album cover.
Setting artwork yourself is how you stop that for good.

## When to use it

- A spot is showing a picture that has nothing to do with it.
- You want a sponsor's logo on screen when their spot plays.
- A campaign has its own graphic and you want it used consistently.

You don't have to set artwork on every spot. Set it on the ones that matter.

## Where your image goes — read this once

**The image stays on this computer.** When you choose a picture, EtherCast reads it and stores a copy **inside
the spot itself**, in the station's local database. It is **not uploaded to the internet**, not sent to
Cloudflare, and not published anywhere. Choosing an image makes no network connection at all.

This is the same thing the **station logo** in Preferences already does.

Two practical consequences:

- **Your original file is not needed afterward.** The copy lives in the spot. You can move, rename or delete
  the file you picked and the artwork stays. (It also means editing the original later won't update the
  spot — choose the image again to refresh it.)
- **It's saved on this machine.** If your station syncs to other computers, spot artwork travels with your
  other spot data the same way. Anything not covered by that sync stays here.

## Set it up (bottom bar → SPOTS)

1. Open **SPOTS** from the bottom bar.
2. Find the spot in the list and click **Edit**. The **Edit Spot** form opens.
3. Look to the right of the **Notes** box — that's the **Artwork** panel. A spot with no image shows an empty
   square reading **"No artwork."**
4. Click **Choose image…** and pick your picture. PNG, JPG, WEBP and SVG all work.
5. The thumbnail updates immediately so you can see what you picked.
6. Click **Save**. Nothing is stored until you save.

## Changing or removing artwork

- **Swap it:** click **Choose image…** again and pick a different file. Save.
- **Remove it:** click **Clear**, then **Save**. The spot goes back to having no image of its own.
- **Changed your mind mid-edit:** click **Cancel** instead of Save and nothing changes.

**Clear** is greyed out when there's no artwork to remove — that's normal, not a fault.

## Tips

- **Square images look best.** The thumbnail is square, so a square picture won't get cropped oddly.
- **Sensible file sizes.** A logo at roughly 500×500 is plenty. Very large photos make your database bigger
  for no visible gain.
- **A recognisable image beats a pretty one.** At small sizes a clean logo reads better than a detailed photo.

## Troubleshooting

**I clicked Choose image… and nothing happened.**
The file picker may have opened behind the main window — check your taskbar. If you cancelled the dialog,
nothing changes, which is expected.

**The picker window is titled "Choose Station Logo."**
Known cosmetic wording — it's the same picker the station logo uses. It selects your spot artwork correctly.

**I picked an image but it's gone.**
It isn't saved until you press **Save** on the Edit Spot form. Re-pick and save.

**The thumbnail is there but the spot still shows the wrong picture elsewhere.**
Artwork you set here is stored on the spot. If somewhere else in the app is still showing an automatic
picture, report it — that's a display problem, not a problem with what you saved.

## Related

- **Spots & Promos** — creating spots, categories, and timed breaks.
- **Preferences → Station logo** — the station-wide image, stored the same local way.
