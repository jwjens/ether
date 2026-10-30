---
feature: update-details
title: Update details (what's new)
summary: The Details button on every update window shows what was added and fixed — every version since yours, newest first.
where: The update window (bottom right) → Details
since: 4.6.69
audience: operator
tour: false
---

# Update details (what's new)

## What it is

When Ether finds a new version it shows an update window in the bottom-right corner. Every stage of that
window has a **Details** button: when the update is offered, while it downloads, when it's ready to restart,
and if it failed. Details opens a popup listing what was added and fixed, taken from the release notes
published with that version.

If you are skipping versions (for example going from 4.6.65 straight to 4.6.69), the popup shows the notes
for **every version in between**, newest first, so nothing you missed is hidden.

## When to use it

Before you click **Update Now** or **Restart & Update**, when you want to know what will change.

## Use it

1. When the update window appears, click **Details**.
2. Read the list. The newest version is at the top; scroll down for the older ones.
3. Close the popup with **×** or by clicking outside it. The update window is still there; carry on with
   **Update Now**, **Later** or **Restart & Update** as usual.

## How it behaves

- The notes are loaded only when you click Details. They never slow down or hold up the update.
- If the notes can't be loaded (no internet, or GitHub doesn't answer within 8 seconds), the popup says so.
  The update itself still works.
- If the version you are updating to has no published notes, the popup says that too.

## Related

- Help → Check for Updates looks for a new version right away.
