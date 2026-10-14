---
feature: sync-cleanup
title: Sync cleanup and the health log
summary: Remove the sync entries this machine will never send, safely while on air, and set how big the health log may grow.
where: ☰ → Preferences → Multi-Machine Sync → "Stuck sync entries" and "Health log"
since: 4.6.59
audience: operator
tour: true
---

# Sync cleanup and the health log

## What it is

Older builds put every change to the **generated log** into this machine's sync queue, but the generated log is
never sent to other machines. Those entries stay in the queue forever. On a busy air machine there can be hundreds
of thousands of them, and they slow the app down.

**Run sync cleanup now** removes exactly those entries. Nothing else in the queue is touched, and no station data
is changed.

The **health log** is the file where Ether records health events, such as an output that was reopened, a slow
startup step or a fire that failed. It is now one file, written in the background, and it starts a new file when it
reaches the size you set.

## When to use it

- The **Stuck sync entries** row shows a number above zero, especially on a machine that is on air all day.
- Ether stutters for a moment every few seconds, or takes a long time to start.

## Run the cleanup (☰ → Preferences → Multi-Machine Sync)

1. Find **Stuck sync entries**. It says how many entries this machine will never send. For example: "241,064
   entries this machine will never send (241,064 for the generated log)".
2. Press **RUN SYNC CLEANUP NOW**. This is safe while you are on air.
3. Watch the progress: "Backing up 120,000 of 241,064…", then "Removing …".
4. When it finishes, the row shows the result in plain words:
   - how many entries were removed;
   - how many were waiting before and after;
   - where the backup is;
   - how long it took.
5. Press **COUNT AGAIN** any time to see the number now.

## Set the health log size (same page, "Health log")

- **Rotate at (MB):** when the log reaches this size, it becomes `health-events.1.jsonl` and a new log starts.
  The starting value is 50 MB.
- **Keep (old files):** how many old logs are kept. The oldest one beyond this is deleted. The starting value is 5.
- **Delete archives after (days):** the two big logs from before this build were renamed to
  `health-events.archive-<date>.jsonl`, not deleted. They are deleted after this many days. The starting value is 30.

Type a number and press **Save**. It takes effect on the next line written. "now:" shows the value in use.

## How it behaves on air

- **The cleanup runs on its own thread with its own database connection.**
- **Backup first:** every entry it will remove is copied to `backups\sync-queue-removed-<date-time>.db` in this
  station's folder. The copy is counted. If the copy is short, nothing is removed.
- **Small steps:** entries are removed a few at a time, each step about 30 ms, with a pause between steps. The app
  and the audio engine never wait long behind it.
- **The automatic cleanup still runs by itself.** It starts about a minute after Ether opens, once nothing has
  played for 15 seconds. If it is still waiting for silence when you press the button, the button replaces it.
  Only one cleanup runs at a time.
- **If Ether closes mid-way,** nothing is lost. The backup keeps what was copied, and running it again finishes the
  job.

## If something looks wrong

- **"Could not count":** the database was busy for over a minute. Press **COUNT AGAIN**.
- **"Sync cleanup stopped…":** the message says why. Entries already removed are in the backup. Press the button
  again to finish.
- **The button is greyed out:** a cleanup is already running.

## Not this

- **CLEAR PENDING…** (under Manual override) is a different tool. It empties the **whole** sync queue in one step
  and sets a new baseline. Don't use it on an air machine. The cleanup button is the safe one.

## Related

- `docs/air-machine-stalls-plan-2026-10-13.md`: why this exists and what was measured.
- `docs/sync-queue-excluded-leak-2026-10-12.md`: how the stuck entries got there.
