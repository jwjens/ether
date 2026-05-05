import sqlite3

DB = r'C:\Users\jensj\AppData\Roaming\com.ether.radio\openair.db'
con = sqlite3.connect(DB)
cur = con.cursor()

print("=== mutation log counts ===")
cur.execute(
    "SELECT table_name, COUNT(*) as cnt FROM mutations "
    "WHERE table_name IN ('shows','clocks','clock_slots','format_clocks') "
    "GROUP BY table_name"
)
for r in cur.fetchall():
    print(f"  {r[0]}: {r[1]}")

print("\n=== shows table (all rows incl soft-deleted) ===")
cur.execute("SELECT id, name, deleted_at FROM shows ORDER BY id DESC LIMIT 10")
for r in cur.fetchall():
    print(f"  id={r[0]}  name={r[1]!r}  deleted_at={r[2]!r}")

con.close()
