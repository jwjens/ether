# Asset types: what is STRUCTURAL and what the OPERATOR controls (2026-08-26)

**Status: PROPOSAL. NOT BUILT. Jeff confirms the split before any code.**

Jeff's correction: the flagged behaviours — does a promo rotate, does a voice track duck a bed, is a
bed scheduled or manual — are **operator decisions, not type identity**. The registry carries
**defaults**; the operator edits them **per station**.

I had baked station policy into the type definition. That was wrong for the same reason the closing-
time work was wrong when it hardcoded suppression: it decides for the operator something that is
theirs to decide.

---

## 1. The split

### STRUCTURAL — fixed in code, identical on every station

These are what the type **is**. Changing one per station would break identity, cross-station
reporting, or the meaning of the as-run record.

| Behaviour | Why it cannot be per-station |
|---|---|
| `code` | The type's identity. Everything keys on it. |
| **`logsAs`** (= `code`) | **The as-run record must mean the same thing everywhere.** If a SPOT logged as SPOT on one station and PROMO on another, no cross-station report, affidavit or fleet view could be trusted. This is the hardest fixed line in the design. |
| `badge` | Derived from `code`. A per-station badge for the same class would make two machines' logs unreadable side by side. |
| `metaTable` | Which side table holds its fields. A code-level fact about storage. |
| **`commercial`** | Whether something is **sold airtime** is not a preference. It is what an advertiser affidavit attests. **If a station sells its promos, those assets are typed SPOT** — the type carries the commerciality, not a per-station flag over it. |

### OPERATOR-CONFIGURABLE — registry default, editable per station

These are **how this station chooses to run**. The registry says "here is how a PROMO behaves by
default"; the operator changes it and it stays changed for that station.

| Behaviour | Default | The question it answers |
|---|---|---|
| `rotationEligible` | per §3 | *Does a promo rotate between songs, or only in breaks?* ← Jeff's example |
| `scheduler` | per §3 | *Is a bed manual, or a schedulable log element?* ← Jeff's example |
| `bus` | per §3 | *Does an SFX play on a source channel or the cart overlay?* |
| `honorsSeparation` | per §3 | *Do voice tracks respect a no-repeat window?* |
| `countsAsMusic` | per §3 | *Do promos count toward music hours?* — **see the caveat in §4** |
| `showAsTab` | per §3 | *Show a tab for a type this station never uses?* |
| `sortOrder` | per §3 | Display order |
| `label` / `labelOne` | per §3 | Station vernacular. Low priority, but free once the mechanism exists. |

---

## 2. Where the settings live, and how they resolve

**No new table.** `station_config_kv` — already per-station, already synced, already has a sanctioned
writer (`stationConfigKvUpsertByKey`), already the home for closing times and flags.

```
key:   asset_type.<CODE>.<behaviour>        e.g.  asset_type.PROMO.rotationEligible
value: '1' | '0' | a string for enums       e.g.  asset_type.BED.scheduler = 'log-element'
```

**ONE resolver, and precedence lives only there** — the same discipline as `closingTimeForDate`:

```ts
resolveTypeBehaviour(stationId, code) →  { ...registryDefault, ...stationOverrides }
```

- A key that is absent means "use the default". Absent ≠ false.
- An unknown value falls back to the default rather than to `false` — a corrupt setting must not
  silently make a type ineligible for everything.
- Cached per station and invalidated on write, because rotation asks this on a hot path.

**The structural fields are not readable from KV at all.** `resolveTypeBehaviour` returns them from
the registry unconditionally, so no setting — and no synced row from a peer — can change what a SPOT
logs as.

---

## 3. The defaults (unchanged from the proposal, now explicitly *defaults*)

| Type | rotationEligible | scheduler | bus | honorsSep | countsAsMusic |
|---|---|---|---|---|---|
| **SONG** | ✅ | rotation | rotation-deck | ✅ | ✅ |
| **SPOT** | ❌ | traffic-break | rotation-deck | plays/day + window | no |
| **PROMO** | ❌ | traffic-break | rotation-deck | plays/day + window | no |
| **SWEEPER** | ❌ | cadence | cart-overlay | own cadence | no |
| **ANNOUNCEMENT** | ❌ | date-list | source-channel | none | no |
| **VOICE_TRACK** | ❌ | log-element | rotation-deck | none | no |
| **BED** | ❌ | manual | source-channel | none | no |
| **SFX** | ❌ | manual | source-channel | none | no |

Structural for all eight: `logsAs = code`, `badge = code`, `commercial` — ✅ for SPOT only.

**These are now starting points, not rulings.** Every one is editable per station, so the six I
flagged for correction no longer need a correction — they need a sensible default and a settings UI,
which is what this becomes.

---

## 4. Three things worth deciding explicitly

**a) `countsAsMusic` changes history.** It is applied at query time, so flipping it changes what *past*
reports show — last month's music-hours total moves because a setting changed today. Options: accept
it (simplest, and it is how the current `content_class` filters already behave), or stamp the decision
at log time. **My read: accept it, and say so in the settings UI** — "changing this affects past
reports as well as future ones."

**b) DUCKING IS NOT A TYPE BEHAVIOUR — RULED (Jeff, 2026-08-26).**

> *"Beds are USER-CONTROLLED — the jock turns his own bed down manually when he talks, like riding a
> fader on a real board. No automatic ducking for beds. Keep ducking as manual/channel control the way
> it works now — the operator rides their own levels."*

So `ducks` and `duckable` are **removed from the registry entirely** — not kept as advisory flags.

Keeping them would have put a control in the type system that does nothing at playout, beside a
ducker that does. This codebase has already paid for that exact shape: slice 4 deleted the fake
per-announcement duck controls with the note *"A dead control beside a working one is worse than no
control: it is how an operator mis-sets the duck and then distrusts the feature that does work."*
A decorative `ducks` column on eight types is the same defect with more surface area.

**DUCK IS A CHANNEL FUNCTION, FULL STOP** (Jeff, clarified 2026-08-26):

> *"The duck is a function of the CHANNEL/DECK, available to ANYTHING on that deck — mic,
> announcement, any source — not tied to content type. A live jock rides his own bed manually, but the
> mic on an aux deck should still have its DUCK button, because duck is a channel function, period."*

So the rule is stronger than "types do not carry duck flags". It is: **the channel's DUCK control is
universal and content-agnostic, and nothing in the type system may override, replace, gate or
pre-empt it.** A deck has a DUCK button because it is a deck — whatever happens to be loaded on it,
including a live mic, including nothing.

That also forbids a tempting future shortcut: "hide the DUCK button for types that do not duck". The
button belongs to the channel, not to the content, so it is always there.

**Ducking stays exactly as built and is untouched by this arc:** per-station depth/hold/release/
attack/threshold in Preferences → Ducker, DUCK ON per source channel, duckable per deck. The operator
rides their own levels — including a bed, which is a fader move, not a rule.

**c) Structural vs configurable is itself a setting surface.** The settings UI must show the
structural ones as **read-only with the reason**, not hide them. An operator who cannot find "what
does a SPOT log as" will assume it is configurable and look for it.

---

## 5. What changes in the build plan

Step 1 (the registry) grows from one module to three small ones, all pure and all tested:

1. `assetTypes.ts` — the eight definitions: structural fields + **defaults** for the configurable ones.
2. `resolveTypeBehaviour.ts` — merge station overrides over defaults; structural fields never
   overridable. This is where the precedence rule lives, and it gets the same treatment as the other
   single-resolver rules in this codebase.
3. The settings surface — Preferences → per station → asset type behaviour, one row per type, showing
   structural fields read-only and configurable ones as controls with "default" clearly marked.

The openness test is unchanged and still the acceptance criterion: **adding a ninth type is one
object**, and it automatically gains a settings row, a filter button, a tab and a badge.

---

## 6. What I need

1. **Confirm the fixed/configurable split in §1.** Anything in the structural list you want editable?
2. ~~Answer §4(b)~~ — **RULED**: ducking stays manual/channel control; the flags are gone.
3. Still outstanding: **install-scope for `library_asset`**, and whether **`songs_all`** lands first.

Then I build step 1.
