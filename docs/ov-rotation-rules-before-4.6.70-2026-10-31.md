# Rotation rule settings before 4.6.70 goes on OV (2026-10-31)

Jeff: "Before 4.6.70 goes on OV, list OV's current rotation rule settings for me."

**Source:** Settings → Programming → Music Scheduling Rules, as they are in this computer's (OVEVENTS) database, read
through Ether at 2026-10-31. The rules table syncs between the account's computers (`separation_rules` is a synced
table), so this is the account's copy. **One check settles OV itself:** open Settings → Programming on OV and compare —
a change made on OV that never synced would show there and not here.

Until 4.6.70, only the three separations (artist / song / title) were used, and every one was treated as STRICT.
From 4.6.70, STRICT/SOFT and "Max songs in a row" take effect (Jeff's 5b/6c). The gender rule is retired and ignored.

| Station | Rule | Setting | Mode | On | What 4.6.70 changes |
|---|---|---|---|---|---|
| Open Format (1) | Same artist after | 60 min | STRICT | on | nothing |
| | Same song after | 120 min | STRICT | on | nothing |
| | Same title after | 60 min | STRICT | on | nothing |
| | Max in a row, same category | 3 | **STRICT** | on | **new:** a 4th song from one category moves to the clock's next different category |
| halloVeen (2) | Same artist after | 60 min | STRICT | on | nothing |
| | Same song after | 60 min | STRICT | on | nothing |
| | Same title after | 60 min | STRICT | on | nothing |
| | Max in a row, same category | 3 | SOFT | on | **new:** the category is kept; the row is marked "broken" (26 rows in a 1-day test on a copy) |
| Magical Forest (3) | Same song after | 60 min | **SOFT** | on | **new:** when no song passes, this rule is relaxed first (before least-recently-played) |
| | Same artist / same title | 60 / 60 min | SOFT | off | nothing (off) |
| | Max in a row | 3 | SOFT | off | nothing (off) |
| Christmas in Jully (4) | Same artist after | 60 min | STRICT | on | nothing |
| | Same song after | 180 min | STRICT | on | nothing |
| | Same title after | 120 min | STRICT | on | nothing |
| | Max in a row, same category | 3 | SOFT | on | **new:** kept and marked broken |

Retired `max_same_gender` rows still exist (on: halloVeen, Christmas in Jully; off: Open Format, Magical Forest).
Nothing reads them and 4.6.70 no longer shows them.
