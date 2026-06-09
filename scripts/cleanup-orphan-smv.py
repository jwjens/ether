"""
scripts/cleanup-orphan-smv.py — one-shot retroactive orphan cleanup

Soft-deletes song_metadata_values rows whose referenced metadata_vocabulary
row has already been soft-deleted, leaving the SMV active. These were created
before the cascade fix (commit 6b2ca76) when the cascade FK lookup used uuid
instead of the integer id.

Run once: python scripts/cleanup-orphan-smv.py
Safe to re-run — idempotent (second run finds 0 rows).
"""

import sqlite3, json, uuid, time, sys, os

DB_PATH = os.path.join(
    os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming")),
    "com.ether.radio", "openair.db"
)

print(f"Opening: {DB_PATH}\n")

db = sqlite3.connect(DB_PATH)
db.row_factory = sqlite3.Row

# ── Pre-flight reads (outside transaction) ──────────────────────

client_row = db.execute("SELECT client_id FROM client_identity LIMIT 1").fetchone()
if not client_row:
    print("ERROR: client_identity not seeded — cannot log mutations")
    db.close(); sys.exit(1)
CLIENT_ID = client_row["client_id"]

schema_row = db.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
SCHEMA_VERSION = schema_row["v"] if schema_row else 0

hlc_row = db.execute("SELECT value FROM system_state WHERE key='hlc_last'").fetchone()
if not hlc_row:
    print("ERROR: system_state.hlc_last not found")
    db.close(); sys.exit(1)

parts      = hlc_row["value"].split(":")
last_wall  = int(parts[0])
last_logic = int(parts[1])

# ── Find orphans ────────────────────────────────────────────────

orphans = db.execute("""
    SELECT smv.id, smv.uuid, smv.song_id, smv.definition_id,
           smv.value_text, smv.value_vocabulary_id,
           smv.station_id, smv.created_at, smv.updated_at,
           mv.value   AS vocab_value,
           mv.deleted_at AS vocab_deleted_at
    FROM song_metadata_values smv
    JOIN metadata_vocabulary mv ON mv.id = smv.value_vocabulary_id
    WHERE smv.deleted_at IS NULL AND mv.deleted_at IS NOT NULL
    ORDER BY smv.song_id, smv.id
""").fetchall()

if not orphans:
    print("No orphan rows found — already clean (or never broken).")
    db.close(); sys.exit(0)

print(f"Found {len(orphans)} orphan SMV row(s):\n")
for r in orphans:
    print(f"  smv.id={r['id']}  song_id={r['song_id']}  "
          f"value_text='{r['value_text']}'  vocab='{r['vocab_value']}'  "
          f"vocab_deleted_at={r['vocab_deleted_at']}")

print(f"\nSoft-deleting {len(orphans)} row(s) with mutation log entries...\n")

# ── Cleanup inside a single transaction ─────────────────────────

now = __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.") + \
      f"{__import__('datetime').datetime.utcnow().microsecond // 1000:03d}Z"
wall_ms = int(time.time() * 1000)
logical = 0  # incremented per mutation within this wall_ms tick

try:
    with db:  # auto-commits or rolls back
        for row in orphans:
            # Advance HLC monotonically
            new_wall = max(last_wall, wall_ms)
            if new_wall > last_wall:
                logical = 0
            else:
                logical += 1
            last_wall = new_wall
            hlc = f"{new_wall}:{logical}:{CLIENT_ID}"

            mutation_id = str(uuid.uuid4())

            # Build payload_before from the full SMV row
            payload_before = json.dumps({
                "uuid":                row["uuid"],
                "station_id":          row["station_id"],
                "song_id":             row["song_id"],
                "definition_id":       row["definition_id"],
                "value_text":          row["value_text"],
                "value_vocabulary_id": row["value_vocabulary_id"],
                "created_at":          row["created_at"],
                "updated_at":          row["updated_at"],
                "deleted_at":          None,
            })

            # Soft-delete the SMV row
            db.execute(
                "UPDATE song_metadata_values SET deleted_at = ?, updated_at = ? WHERE uuid = ?",
                (now, now, row["uuid"])
            )

            # Log the mutation
            db.execute("""
                INSERT INTO mutations (
                    id, client_id, station_id, actor_id,
                    table_name, row_id, op,
                    payload_before, payload_after,
                    created_at, applied_at, hlc,
                    parent_mutation_id, schema_version,
                    origin, sync_status, conflict_resolution
                ) VALUES (
                    ?, ?, ?, NULL,
                    'song_metadata_values', ?, 'delete',
                    ?, NULL,
                    ?, ?, ?,
                    NULL, ?,
                    'local', 'pending', NULL
                )
            """, (
                mutation_id, CLIENT_ID, str(row["station_id"]),
                row["uuid"],
                payload_before,
                now, now, hlc,
                SCHEMA_VERSION,
            ))

        # Update hlc_last to the final value used
        db.execute(
            "UPDATE system_state SET value = ?, updated_at = ? WHERE key = 'hlc_last'",
            (hlc, now)
        )

    print(f"  Cleaned {len(orphans)} row(s) successfully.")

except Exception as e:
    print(f"ERROR during cleanup: {e}")
    db.close(); sys.exit(1)

# ── Verify idempotency ──────────────────────────────────────────

remaining = db.execute("""
    SELECT COUNT(*) AS n
    FROM song_metadata_values smv
    JOIN metadata_vocabulary mv ON mv.id = smv.value_vocabulary_id
    WHERE smv.deleted_at IS NULL AND mv.deleted_at IS NOT NULL
""").fetchone()["n"]

print(f"  Orphans remaining after cleanup: {remaining}  (expected 0)")

db.close()
print("\nDone.")
