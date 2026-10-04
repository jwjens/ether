// THE SOURCE KINDS AND WHERE THEY MAY GO — pure data and rules, no React, no window.
//
// Lifted out of DeckConfigurator.tsx (2026-10-04) so the offering rule can be tested: that file pulls in MasterOutput,
// which touches `window` at import, so nothing in it can be imported by a vitest test. DeckConfigurator re-exports
// every name here, so no import site changed.
//
// Operator requirement (2026-10-04), verbatim: "carts announcements jukebox sweepers link they all are just input
// sources and need to work interchangeably on all faders." sourceKindOptions() is the one place a strip's source
// dropdown gets its entries; src/lib/sourceKinds.test.ts pins every kind as offered on every source slot.

export type SourceKind = "jukebox" | "announcement" | "jingle" | "cart" | "mic" | "link" | "network";

export interface SourceKindMeta {
  kind: SourceKind;
  label: string;
  /** "file" works today; "stream" needs the Phase 2 capture path. */
  family: "file" | "stream";
  /** What the operator is told on the strip — honest about what does and does not play yet. */
  state: string;
}

export const SOURCE_KINDS: SourceKindMeta[] = [
  { kind: "jukebox",      label: "Jukebox",              family: "file",
    state: "Public request wall — patched and playing" },
  { kind: "announcement", label: "Announcement",         family: "file",
    state: "Patched. Announcement playout arrives in a later slice — nothing fires yet." },
  { kind: "jingle",       label: "Sweeper",              family: "file",
    // The `kind` VALUE stays "jingle": it is a persisted deck-config key, not a label. Changing a
    // stored key for cosmetics is how a config silently stops matching, and the daemon's channel
    // resolver accepts both 'jingle' and 'sweeper' so an existing install needs no re-dial.
    //
    // NO LONGER "(hand-fired)". Until 2026-09-03 the automated seam sweeper was hardcoded to the
    // literal "CART" slot and never read deck_configs, so this entry genuinely could not carry the
    // log's sweepers — and the state line said so. The fire path now resolves the dialled
    // channel(s) on every fire, so the qualifier and that sentence would both be false.
    state: "Sweepers air on this channel — the log's seam sweepers and hand-fired imaging alike." },
  // CARTS ARE NOT SWEEPERS, and this entry is what finally separates them (Jeff, 2026-09-01).
  //
  //   A SWEEPER is programmed to play DURING ROTATION — armed and fired automatically at a song
  //   seam by the daemon's _jingleTick, bridging the crossfade. It is part of the log.
  //   A CART is a SOUND-EFFECTS RACK — hand-fired, punch-through, never scheduled, never in
  //   rotation.
  //
  // Both used to drive the one native "CART" channel, so a cart fired while a sweeper was bridging
  // a seam clobbered it — the daemon _stop()s and _load()s that channel as part of its bridge
  // lifecycle, and neither side knew about the other. Patching carts onto an ordinary aux deck is
  // what ends that: the sweeper keeps the overlay bus it is built around, and carts move off it.
  { kind: "cart",         label: "Cart / SFX rack",      family: "file",
    state: "Hand-fired sound effects, on this channel instead of the sweeper's overlay bus." },
  // Mic is an ENGINE input since 2026-09-26 (docs/dsp-mic-in-engine.md): the audio engine captures the device and
  // the channel goes on air like any other. Only Network below is still gated on a capture path.
  { kind: "mic",          label: "Mic (device…)",        family: "stream",
    state: "Live microphone on this channel, on air — pick the input on the strip or in Preferences → Audio." },
  // THE REMOTE LINK (docs/remote-link-design-2026-09-28.md, ruling D1): Ether-to-Ether, its own patch type. Network below
  // stays the placeholder for third-party codecs (Zephyr, AoIP), which are a different protocol.
  { kind: "link",         label: "Link (network feed)",  family: "stream",
    state: "A feed over the network from another Ether computer, into this fader — paste that computer's link key on the strip; buffer and port in Preferences → Broadcast → Remote Link." },
  { kind: "network",      label: "Network (IP / Zephyr / AoIP)", family: "stream",
    state: "Needs the engine capture path — Phase 2." },
];

/** Is this channel dialled to sweepers?
 *
 *  Both stored values: 'jingle' is the key the Sweeper entry has always persisted and predates
 *  'sweeper', so an existing install matches with no re-dial and no migration. Renaming a stored key
 *  for cosmetics is how a config silently stops matching.
 *
 *  A sweeper channel is the ONE source kind that joins the programme bus rather than the aux bus —
 *  it sums with the music, is ducked with it, and is heard on the station monitor, exactly as slot 6
 *  always was. Carts are NOT sweepers and never take this path: a cart is a hand-fired rack on an
 *  aux channel. */
export const isSweeperKind = (k?: string | null) => k === "sweeper" || k === "jingle";

export const sourceKindMeta = (k?: string | null) =>
  SOURCE_KINDS.find(s => s.kind === k) || null;

/** Slots a SOURCE channel may occupy: the existing aux decks first, then the new engine slots. */
export const SOURCE_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"] as const;

/** Slots the jukebox source may be assigned to: EVERY source slot (2026-10-04). It was D/E/F only because those were
 *  the only source slots when the jukebox was built; S1..S5 are the same SlotKind::Source in the engine, and the
 *  jukebox IPC (audiod/jukebox-decks.js) now accepts them. A/B/C stay excluded structurally — automation owns them. */
export const JUKEBOX_SLOTS = SOURCE_SLOTS;
export const canHostJukebox = (slot: string) => (JUKEBOX_SLOTS as readonly string[]).includes(String(slot).toUpperCase());


export interface SourceKindOption extends SourceKindMeta { disabled: boolean; why: string; }

/** The entries a source strip's SOURCE dropdown offers on `slot`. Disabled entries are shown with their reason, never
 *  hidden: a door that says "not yet" beats a door that is not there. */
export function sourceKindOptions(slot: string): SourceKindOption[] {
  return SOURCE_KINDS.map(k => {
    if (k.kind === "jukebox" && !canHostJukebox(slot)) {
      return { ...k, disabled: true, why: `Jukebox routes on source faders only — not ${slot}` };
    }
    // MIC is an ENGINE input since 2026-09-26 (docs/dsp-mic-in-engine.md), the LINK since 2026-09-28. Network stays
    // disabled — it genuinely has no path yet.
    if (k.family === "stream" && k.kind !== "mic" && k.kind !== "link") {
      return { ...k, disabled: true, why: "Phase 2 — needs the engine capture path" };
    }
    return { ...k, disabled: false, why: "" };
  });
}
