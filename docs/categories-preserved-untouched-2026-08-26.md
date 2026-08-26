# Custom categories are UNLIMITED and stay untouched (verified 2026-08-26)

**Status: READ-ONLY VERIFICATION + BINDING CONSTRAINT on the library work. No schema written.**

Jeff:

> *"Categories are UNLIMITED. There is no set number of category rows; I create as many as I want and
> can always add more, per station. The unified library work must NOT cap, fix, or limit this."*

**Confirmed on all counts. Nothing in the library arc touches the `categories` table, its create path,
or its cardinality.**

---

## 1. What is true today, measured

| | |
|---|---|
| Table | `categories` — `station_id NOT NULL DEFAULT 1` |
| Scope | **per station** |
| Live counts | **Open Format 10 · halloVeen 2 · Magical Forest 2 · Christmas in Jully 1** |
| Cap in the schema | **none** — `id INTEGER PRIMARY KEY AUTOINCREMENT`, no `CHECK`, no fixed enum |
| Cap in the create path | **none** — `categoriesCreate` requires `station_id` and imposes no count limit |
| Create entry points | `App.tsx:5178` (library) · `CreateShowWizard.tsx:162` · `GSelectorImport.tsx:177` · `ImportDialog.tsx:44` — all `categories.create({ station_id: stationId, code, name, … })` |
| Searched for caps | no `MAX_CATEGORIES`, no length limit, no `slice()` bound on creation. The only `.length` hits are a 6-row import **preview** and empty-state checks — display, not limits. |

**The differing counts per station are the proof.** 10 / 2 / 2 / 1 is not a seeded fixed set; it is
four stations with as many operator-made categories as each needed.

Categories also carry per-station programming behaviour of their own — `spins_per_hour`, `priority`,
`color`, and the `overlay_*` columns. All station-scoped, all untouched.

---

## 2. The real risk, named: TYPE is not CATEGORY

The failure this arc could plausibly cause is not a hard cap — nobody would write one. It is
**collapsing two orthogonal axes into one**, because both look like "classification":

| | **Type** | **Category** |
|---|---|---|
| What it answers | *what kind of asset is this?* | *which rotation pool did this station put it in?* |
| Examples | SONG, SPOT, SWEEPER, ANNOUNCEMENT | Power Gold, Halloween Drop, Christmas AC — whatever the operator names |
| Who defines it | developers, in the registry | **the operator, at will** |
| How many | 8 today, extensible by adding a definition | **unlimited, per station, created anytime** |
| Scope | install-wide, identical everywhere | **per station** |
| Stored | `library_asset.type` | `categories` row, referenced from the per-station programming overlay |

**An asset has BOTH, independently.** A song is `type = SONG` *and* `category = <whatever this station
called it>`. A spot is `type = SPOT` and may sit in a spot category. The two never substitute for each
other, and the eight types must never become "the eight categories".

---

## 3. Binding constraints on the build

Written as prohibitions, because each is a shortcut this design could invite:

1. **Nothing may cap the number of categories.** No enum, no `CHECK`, no fixed list, no UI that only
   renders N. Creating the 11th, the 50th and the 500th category on any station must work exactly as
   the 2nd does today.
2. **The type registry must never be used as a category list.** A tab per type is not a tab per
   category. Types are developer-defined; categories are operator-defined; a UI that offers "pick a
   type" where the operator expects "pick a category" is the same defect as a fixed list.
3. **`categories` is not migrated, renamed, merged or replaced by this arc.** It keeps its table, its
   `station_id`, its columns, and all four create call sites.
4. **The per-station programming overlay keeps `category_id` as a plain FK to `categories(id)`** —
   an unbounded reference, exactly as `station_programming` already has it. No denormalising a
   category into a type code, and no copying its name onto the asset.
5. **Creating a category stays available from every place it is available now** — the library panel,
   the show wizard, the G-Selector import and the import dialog.

---

## 4. What the arc *does* change near categories — and why it strengthens this

One thing only: **where a song's category assignment lives.**

- **Today:** `songs.category_id` — an install-scoped column, so an asset points at exactly ONE
  station's category. That is why the 510 songs partition as 163/151/76/46 across the four stations.
- **After:** the per-station programming overlay (`station_programming`, generalised) holds
  `category_id` per `(asset, station)` — so the same file can be in Power Gold on Open Format *and*
  a Halloween category on halloVeen, at the same time.

**This does not touch the `categories` table.** It changes which side of the relationship carries the
assignment, and it makes categories *more* useful per station, not less. Categories stay unlimited,
operator-created and station-scoped throughout.

---

## 5. Confirmation

**The create-new-category feature is preserved untouched, and remains open-ended.** No cap exists
today, none is introduced, and the type system is a separate axis that cannot become a fixed category
list. Recorded as binding constraints on the build above.

Still open, unchanged: the 436 categorised songs migrate as **(a)** one programming row each on their
current station, or **(b)** the same plus availability to every station — and the `songs_all`
sequencing question.
