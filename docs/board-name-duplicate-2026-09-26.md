# The rack tab row read "G H I J J": one fader name used twice (2026-09-26)

**Jeff's report (verbatim):** "The rack tab row reads G H I J J — a duplicate fader name from the one-name helper."

**Status:** fixed; the test now fails on the old code with this machine's rows. What's on screen is UNVERIFIED until
Jeff's check.

## Reproduced with this station's deck_configs

Read-only, from this machine's profile database (`halloVeen`, the active station):

```
A B C D E F S1 S2 S3        (no CART, S4 or S5 row; F and S2/S3 disabled)
```

**The helper at 2b9f1cf:** `boardName(slot, order)` named a slot the rows don't list by appending it to the rows and
naming it "as if it came last" — **on its own**, once per slot. So:
- S4 = the next letter after S3 → **J**;
- S5 = the next letter after S3 → **J** as well.

The tab row asks for all five, S1–S5, and got **G H I J J**.

**A second flaw of the same kind:** a board with no E or F row named S1 as **E**, which collides the day E is
added. My earlier test encoded that as correct (`S1 → E`).

## The fix (`src/lib/boardName.ts`)

- **Completed once:** the board's order (its deck_configs rows, every row, enabled or not) is completed **once**
  with every engine slot it doesn't list, in engine order.
- **One pass:** everything is named from that one list, so no two slots can share a name.
- **A–F are reserved:** each is its own letter whether or not the board has a row for it, so S1 is always after F
  (G on every board with the default order). The rows still decide the order among the S slots.

## The test that would have caught it (`src/lib/boardName.test.ts`)

**Real shapes from this machine:**
- `halloVeen` (gaps at CART, S4, S5; disabled rows);
- `Open Format`;
- the legacy boards with no S rows;
- an empty board.

For each: **all 12 engine slots get 12 different names, and none is an engine id.**

**The named regression:** `halloVeen`'s S1–S5 read **G H I J K**.

**The two old expectations that encoded the flaw are corrected:**
- S1 → E on a board with no E row is now G;
- "named as if it came last, on its own" is gone.

**Receipt:** on the old helper the 4 new tests failed (`expected 11 to be 12`, `10`, `8`, and G H I J J); on the
fix, 9/9 pass.
