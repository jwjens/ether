# Remote Link — a remote Ether box feeds OV directly (proposal, 2026-09-28)

**Status: PROPOSAL. Nothing is built. Dev only. Build on GO.**

**Jeff's ruling (verbatim):** a remote broadcast keeps OV on air; the remote Ether box sends its audio TO OV. Not via
Icecast (8 s). A direct low-latency link: the remote box's engine encodes its program bus to Opus (48 kHz, 20 ms
frames) and sends it over the network (SRT preferred, plain UDP fallback) to OV; OV's engine receives on a source
channel through the same live ring the mic uses, with a visible jitter buffer (default 120 ms), reconnect, counters,
NOT FED. Auth: a shared link key per station. Reachability: OV listens on a port (router forward) or, if the park's
network won't allow it, both sides connect out to a relay on the Ether server. Propose both and the cost of each.
The remote box gets a "SEND TO <station>" control; OV's source strip gets a "Link" patch type. Target latency and
how it's measured. Verification with OVEVENTS as the remote.

---

## 0 · What is there today (receipts — the tree, not the product)

| Seam | Where | What it means for the link |
|---|---|---|
| The mic live ring | `native/src/micin.rs` — `LiveIn` (consumer in the mixer callback), `input_block` (producer), `mic_ring`, `MicShared` atomics, `MicInputs` dispatch manager | The receive side plugs in here: a `DeckFeed::live(LiveIn)` on a source slot. It already resamples 48 k → 44.1 k (`audio.rs:4910`, `:5039` build `LiveIn::new(c, 48_000, …)`) and absorbs clock drift with a ±0.3 % ratio nudge. |
| **Mono** ring | `micin.rs` header + `docs/dsp-mic-in-engine.md` §1 ("Mono ring … A stereo pair is a later option") | The link carries a **stereo** programme. `LiveIn` needs a stereo mode. Not a copy — the same type, generalised. |
| Stale-flush rule | `micin.rs` `STALE_MS = 100` ("A mic never comes back late") | Correct for a mic, wrong for a link that deliberately holds 120 ms. The link sets its own stale bound (above the jitter target). |
| Engine rate | `audio.rs:2404` `PROGRAM_RATE = 44100` | Opus runs only at 8/12/16/24/48 k. **Sender resamples 44.1 → 48 k** (the same `SincTable`), receiver decodes 48 k and `LiveIn` brings it back to 44.1 k. |
| Program-bus tap | `audio.rs` `drain_program_bus` — one ring, **one consumer** (the TCP f32le client = the Icecast ffmpeg in `audiod/stream.js`) | The link needs a **second tap ring** pushed in the same output callback (the aux bus already does this: `AUX_BUS_BUF`). The broadcast delay lives inside `drain_program_bus` (stream path only), so the link tap is never delayed. |
| Source patch types | `src/components/DeckConfigurator.tsx` `SOURCE_KINDS` | Already has a placeholder **`network` — "Network (IP / Zephyr / AoIP)" — "Needs the engine capture path — Phase 2."** See Decision D1. |
| NOT FED | `ConsoleStrip` `meterNotFed` (mic build) | Reused as is. |
| Bundled ffmpeg | `node_modules/ffmpeg-static/ffmpeg.exe` 6.1.1 (gyan essentials) — configuration contains **`--enable-libsrt` and `--enable-libopus`**; `-protocols` lists `srt`, `udp` | Receipt for Windows only. The macOS `ffmpeg-static` build is **UNVERIFIED** for libsrt. Used below only as a pre-build path probe, not as the product (§3). |
| This machine | `hostname` = **OVEVENTS** | The remote in verification is this box. |
| Lightsail RTT | `curl time_connect` to `stream.ether-technologies.com:8443` from OVEVENTS, 6 samples: **50.5–74.4 ms, median ≈ 54 ms**. ICMP ping is blocked (100 % loss), so TCP connect is the RTT proxy. | Each relay leg costs ≈ 27 ms one way from here. OV's leg is **UNVERIFIED** — run the same `curl` on the OV box. |

---

## 1 · The pipeline

```
REMOTE (OVEVENTS)                                                        OV
mics/carts → program bus ─tap ring─→ link-out thread                     link-in thread ─→ jitter buffer ─→ Opus decode
   (44.1 k stereo)                   · resample 44.1→48 k                  · auth + replay check    (by seq, 120 ms)   + PLC / FEC
                                     · Opus 20 ms, stereo                  · reorder / dup / late                        │
                                     · seal (AEAD, link key)               · clock-offset estimate                       ▼
                                     · SRT  or  UDP  ─────── network ───→  SRT or UDP                           stereo live ring
                                                                                                                 │ LiveIn (48→44.1 k,
                                                                                                                 │  drift nudge)
                                                                                                                 ▼
                                                                                     source slot (D–F / S1–S5): meter, rack, fader,
                                                                                     cut, duck, aux — like any other channel
```

**Sender (new `native/src/linkout.rs`).**
- A second program-bus tap ring, pushed by the output callback (RT-safe push, overrun counted, never blocks).
- **Tap point: PRE the program processor** (recommended, Decision D3) so OV's own processing is the only
  processing on air — no double limiting. Where the processor sits relative to the existing tap is the first read of
  slice 1; this doc does not claim it.
- A link thread (not the audio callback): resample → Opus encode (`OPUS_APPLICATION_AUDIO`, 20 ms, stereo,
  **128 kb/s default**, in-band FEC on, `packet_loss_perc` fed back from the receiver's loss report) → seal → send.
- Encoding happens in the engine, as ruled. Codec: `libopus` through the `opus`/`audiopus_sys` crate (builds libopus
  from source; CI runners need CMake — **UNVERIFIED** on the mac runner).

**Receiver (new `native/src/linkin.rs`, alongside `micin.rs`).**
- A link thread owns the socket: authenticate, drop replays, place each packet by sequence number.
- **The jitter buffer is packet-level, before decode.** Target **120 ms** (setting, per station, shown — no hidden
  default). Decode happens on demand as the ring drains; a packet missing at its playout deadline is recovered
  from the next packet's FEC if present, else concealed by Opus PLC. Every one of those is counted.
- Decoded 48 k stereo goes into the **same live ring / `LiveIn`** the mic uses, generalised to stereo; `LiveIn`'s
  drift controller reads the **jitter-buffer depth**, not just the small ring fill, so a remote clock that runs
  fast or slow is absorbed by the same ±0.3 % nudge instead of by drops.
- `eof` is never set: silence is an underrun, drawn as a fade, counted, never an end — exactly the mic rule.

**Packet header (our framing, identical on SRT and UDP):** version · station-uuid hash (so one OV port serves every
station on the box) · key id · sender session id · sequence · sender sample clock (48 k frames) · sender wall-time ·
flags (FEC, keepalive, ping/pong) · Opus payload · 16-byte AEAD tag. Keepalive/ping every 250 ms both ways gives
RTT, one-way estimate and holds NAT pinholes open.

---

## 2 · Transport: SRT preferred, plain UDP fallback

| | SRT | Plain UDP |
|---|---|---|
| Loss recovery | ARQ retransmission **plus** Opus FEC/PLC | Opus FEC/PLC only |
| When ARQ actually helps | Only when the buffer covers a retransmit round trip. SRT's guidance is latency ≥ ~4 × RTT. At 120 ms that is RTT ≤ ~30 ms: **direct in-metro, yes; via the relay (≈ 54 ms RTT per leg from here), marginal.** | n/a |
| Jitter buffer | SRT's TSBPD **is** a receive buffer (its `latency` = our 120 ms). We still hold our own packet buffer so the numbers are ours and visible. SRT latency is set small on top, or the two are combined — slice 0 decides with a measurement. | Ours, 120 ms |
| Encryption | Built-in AES (passphrase) — but per connection; **through a relay it terminates at the relay** (the relay holds the key) | Our AEAD end to end; the relay only forwards ciphertext |
| Rust | `srt-tokio` (pure Rust) — maturity and libsrt interop **UNVERIFIED** → slice 0 spike. Fallback: libsrt via FFI (heavier build: needs a crypto library). | `std::net::UdpSocket` + `chacha20poly1305` (pure Rust) |

**Recommendation.** Build the link protocol and the whole receive path (jitter buffer, decode, senses) on plain UDP
first, because both transports share it; add SRT as the preferred transport in the next slice, behind the spike.
The operator picks nothing: the sender tries SRT, falls back to UDP after N seconds, and the strip says which one
is live. (If Jeff wants SRT in the first shippable slice, the order swaps; the scope does not change.)

**Auth — a shared link key per station.** 256-bit random key per station, minted by the backend, stored beside the
station, fetched by any signed-in machine on the account (the account is the root — no keys typed or pasted). Every
packet is AEAD-sealed (ChaCha20-Poly1305, key derived from the link key + session id); a packet that fails the tag
is dropped silently and counted — **the receiver never replies to an unauthenticated packet** (no amplification, no
port-scan response). Replays are rejected by a sequence window. Key rotation: a button in the Remote Link panel
(backend mints a new key; old key id accepted for 60 s).

---

## 3 · Reachability — both options and their cost

### Option A — OV listens on a port (router forward)

- OV's daemon binds **one UDP port** (default proposed `9760`, a per-machine setting). Station demux is by header.
- **What it takes:** OV's IT forwards UDP 9760 → the OV box; a static public IP or DDNS name; a Windows Firewall
  inbound rule (the installer can add it); McAfee's firewall on the managed box may override Windows Firewall —
  **UNVERIFIED**, IT must confirm.
- The remote (the park) only needs **outbound** UDP.
- **Money:** $0. **Time/people:** an IT ticket at OV, and it breaks silently if OV's public IP changes (DDNS needed).
- **Latency:** the best possible — remote → OV straight, likely 5–20 ms one way in-metro (**UNVERIFIED**; slice 0
  measures).
- **Exposure:** an open UDP port that drops everything without a valid tag. Low, but it is an open port on a
  managed corporate network — OV IT's call.

### Option B — both sides connect out to a relay on the Ether server

- **Railway can't host it**: Railway is TCP/HTTP only; inbound UDP is not offered (**UNVERIFIED as of today** —
  check the Railway docs before relying on it). The relay goes on the **Lightsail box** that already runs Icecast
  (`stream.ether-technologies.com`), as a small standalone process (Rust or Node, ~300 lines).
- Both boxes send a signed hello (a relay token the backend issues to a signed-in machine) and keepalives; the relay
  pairs sender and receiver by station and forwards ciphertext. It never holds the link key on UDP (it would on SRT —
  see §2).
- **Money:** bandwidth ≈ 128 kb/s Opus + ~27 kb/s packet overhead ≈ **155 kb/s each way ≈ 70 MB per hour in + 70 MB
  out** per active link. A 6-hour remote ≈ 0.85 GB through the relay. That fits in any Lightsail bundle's monthly
  transfer allowance; beyond it AWS bills about $0.09/GB → cents per event. CPU: negligible. **≈ $0/month.**
- **Latency:** + two legs through Lightsail. From OVEVENTS the leg is ≈ 27 ms one way (measured RTT ≈ 54 ms); if OV
  is similar, the relay adds **≈ 40–50 ms** over direct. SRT ARQ becomes marginal at 120 ms (§2).
- **Operational cost:** one more service to deploy and watch; the Icecast box becomes the single point of failure for
  both the stream and the link (if it is down, listeners are already off air — same failure domain).
- **Works through almost anything with outbound UDP.** If the park's network blocks outbound UDP entirely (guest
  Wi-Fi, captive portal), neither option works — a TCP/443 last resort is possible but adds head-of-line blocking
  stalls; **not proposed for v1**, named here so it is not a surprise at a venue.

**Recommendation:** build both, sender-selected automatically: try OV direct if OV advertises a reachable endpoint,
else the relay. For the first OVEVENTS test, the **relay is the faster path** (no OV IT ticket).

---

## 4 · The operator doors

**Remote box — "SEND TO <station>".**
- Door: hamburger menu → **Remote Link** (panel), and a **SEND TO** button on the master section.
- Target list: the account's stations (from `/account/connect`). **Refused** for a station this machine is the
  designated air machine for (it would feed itself). Refused with a sentence, not greyed without a reason.
- State line: `SENDING → OV · UDP via relay · 212 ms · loss 0.4 % (FEC 0.3 %) · OV receiving`.
  "OV receiving" comes from the receiver's reports — observed, never assumed.
- The remote operator's headphones stay local (Ruling 3 of the mic build: talent use hardware direct monitor).

**OV — source strip patch type "Link".**
- New `SOURCE_KINDS` entry `link`, family `stream`, on any source slot (D–F, S1–S5). Label: **Link (remote Ether)**.
- State line under the dropdown: `LINK · waiting for sender` / `LINK · OVEVENTS · SRT · 118 ms buffer · 205 ms` /
  `LINK · lost 4 s ago — retrying` / `LINK · key rejected`. Click → the Remote Link panel.
- No sender → the meter draws **NOT FED**.
- One sender per link channel. A second sender is refused and shown by name.

**Health Monitor:** a **Remote Link** row per patched link (state, latency, loss/concealment rates, underruns).
**Ledger events:** link up / down / key rejected / loss burst / buffer re-primed.
**Help:** `docs/help-remote-link.md` (template of `docs/help-sweepers.md`) — including the park checklist
(outbound UDP, power, headphones on direct monitor).

---

## 5 · Senses (every counter an atomic, like `MicShared`)

Receiver: state · transport (SRT/UDP, direct/relay) · sender machine · packets received · lost · recovered by FEC ·
concealed (PLC) · late (after deadline) · duplicates · reordered · auth failures · replays · jitter (RFC 3550
estimate) · **jitter-buffer depth ms / target ms** · underruns · starved ms · stale flushes · drift ppm · RTT ·
**one-way link latency** · kb/s · reconnects.
Sender: state · packets sent · tap overruns · encoder ms per frame · RTT · receiver-reported loss · reconnects.

---

## 6 · Latency — target and how it is measured

**Budget (ESTIMATES; slice 0/1 replace them with numbers):**

| Stage | Direct (A) | Relay (B) |
|---|---|---|
| Remote mic input + mixer buffer | ~20 ms | ~20 ms |
| Tap → 20 ms Opus frame + 6.5 ms look-ahead + resample | ~27 ms | ~27 ms |
| Network one way | ~5–20 ms (UNVERIFIED) | ~50–55 ms (≈ 27 ms/leg measured from here) |
| Jitter buffer | 120 ms | 120 ms |
| Decode + `LiveIn` target + OV output buffer | ~25 ms | ~25 ms |
| **Remote mic → OV output (air)** | **≈ 200 ms** | **≈ 245 ms** |

**Target: ≤ 250 ms remote mic → OV programme output, on either path, with loss ≤ 0.5 % concealed per hour.**
Icecast today is ~8 s. 250 ms is conversational-to-cue for a host taking a hand-off; it is not IFB-grade, and the
jitter buffer is the knob (the strip shows it; lowering it trades dropouts for latency).

**How it is measured — three layers:**
1. **Always on (the sense):** each packet carries the sender's clock; ping/pong gives RTT and a clock offset
   (NTP-style, accurate to ± half the path asymmetry, a few ms). The strip shows **link latency** = sender tap →
   OV slot, live. Device buffers either side are added from the cpal buffer sizes the engine already knows.
2. **Link Test button:** the sender injects a 50 ms 1 kHz marker into the link (not into its own air); OV detects it at
   the slot's pre-fader tap and reports **tap-to-tap latency** measured on audio, not headers. Cross-checks layer 1.
3. **Ground truth (hardware, once per path):** both machines' audio into one recorder — a click at the remote mic and
   OV's programme output on the two channels of one stereo recording; cross-correlate. This is the only number that
   includes both sound cards; it is the one that goes in the build report.

---

## 7 · Verification — OVEVENTS as the remote

0. **Slice 0 (before building):** measure the real paths with the bundled ffmpeg — which has libsrt + libopus on
   Windows — to get RTT, loss and jitter OVEVENTS → OV direct and via a test relay. Also `curl` to Lightsail from the
   OV box. Spike `srt-tokio` ↔ libsrt interop. Report numbers, then build.
1. **Offline (CI):** jitter-buffer tests (reorder, duplicate, late, burst loss, clock drift ±200 ppm), Opus
   round-trip level/THD at 48 k, the 44.1 ↔ 48 k resampler, AEAD rejects tampered/replayed packets, a loss/jitter
   simulator whose injected numbers must match the counters exactly.
2. **One box:** OVEVENTS sends station X → station Y on itself over 127.0.0.1 — the pipeline with no network.
3. **OVEVENTS → OV via the relay**, then **direct** once OV IT forwards the port. On each path:
   - a 1-hour soak with programme audio; screenshots of the strip + Health row at 0, 30, 60 min;
   - pull the remote's network cable for 10 s → OV strip shows *lost*, NOT FED, the programme continues; plug back
     in → reconnect time logged;
   - Link Test result + one hardware ground-truth recording;
   - log lines `[LINK] …` from both daemons.
4. **Receipts are runtime:** a latency or "it works" claim is only made with a log line, a screenshot, or Jeff's word.

---

## Decisions for Jeff

- **D1 — "Link" vs the existing "Network (IP / Zephyr / AoIP)" placeholder.** Proposed: add **Link** as its own
  kind (Ether-to-Ether); leave **Network** as the placeholder for third-party codecs (Zephyr/AoIP/AES67), which is a
  different protocol. Alternative: Link replaces Network.
- **D2 — Transport order:** UDP-first then SRT (recommended; shared receive path, lower risk), or SRT in slice 1.
- **D3 — Tap point:** pre the program processor (recommended: OV processes once) or post.
- **D4 — Link loss behaviour on OV:** the channel goes silent and it is shown/ledgered. Should OV do anything more
  (e.g. restart automation after N seconds of link silence)? Proposed: a per-station setting, **default off**,
  visible — no hidden default.
- **D5 — Defaults to confirm:** 120 ms buffer (ruled), 128 kb/s stereo, UDP port 9760.
- **D6 — Reachability order:** both built, relay first for the OVEVENTS test (no OV IT ticket).

## What this deliberately does NOT build

- **A return feed / mix-minus (IFB) to the remote talent.** They will need to hear OV to take cues; listening to
  Icecast is 8 s behind. A return link is the same machinery in reverse, but it is a separate ask.
- A TCP/443 fallback for venues with no outbound UDP.
- Third-party codec interop (Zephyr, Comrex, AES67).
- Multiple simultaneous senders mixed on one channel.
- Video.

## Architecture compliance (receipts)

- **Faders are generic / the mic model** (`docs/dsp-mic-in-engine.md` ruling 1): the link is a patch on a source
  channel, not a dedicated deck; it gets meter, rack, fader, cut, duck and aux for free through the same
  `DeckFeed::live` / `LiveIn`.
- **Account is the root** (CLAUDE.md): the link key is account-scoped and fetched after sign-in; never typed.
- **Station identity by UUID** (peer-sync UUID defect memory): the header and the target list use the station
  UUID, never the local integer id.
- **Designation:** SEND TO is refused toward a station this machine airs.
- **Build the sense, not the scaffold:** §5 counters, Health row and ledger events are v1 scope.
- **Doors before rooms:** hamburger → Remote Link, SEND TO on the master section, the Link patch on the strip, a
  help entry, and empty states that explain themselves.
- **Broadcast delay** stays on the stream path only (`drain_program_bus`); the link tap is never delayed.

---

## Rulings (Jeff, GO 2026-09-28)

- **D1:** Link is its own patch type; Network stays as the placeholder for third-party codecs.
- **D2:** UDP first, SRT added after a short library test; the Link tries SRT then falls back to UDP.
- **D3:** before the remote's processing. OV processes once.
- **D4:** on loss, the channel goes silent and NOT FED, counted, the ducker releases naturally; the per-station
  auto-cut setting ships off by default and visible.
- **D5:** 128 kb/s, UDP 9760, 120 ms buffer, all visible in Preferences.
- **D6:** both routes; test through the relay first so OV needs no IT ticket.
- Order: measure both paths → offline tests → engine → daemon/main → UI → relay on Lightsail. Commit per step.
  All existing goldens stay bit-exact with no Link patched; allocation trap 0. **This run stops after the UI commit
  with the OVEVENTS-to-itself test. No Lightsail in this run** (Jeff, 2026-09-28). Local commits only.
- The SRT → UDP fallback timeout is proposed as a visible setting in Preferences; Jeff sets the value.

## Build — step 1: the paths, measured

| Path | Result | Receipt |
|---|---|---|
| OVEVENTS → Lightsail (`stream.ether-technologies.com`, 6.6.0.186) | **RTT n=30: min 47.0 · p50 57.2 · p90 70.5 · max 105.5 ms** → one relay leg ≈ 29 ms one way at p50 | `curl -w %{time_connect}` to :8443, 30 samples, 2026-09-28T22:56:44Z. ICMP is blocked (ping 100 % loss), so TCP connect is the RTT proxy. |
| OV box → Lightsail (the relay's second leg) | **NOT MEASURED** — needs the OV box | On the OV box, in Git Bash: `for i in $(seq 1 30); do curl -s -o /dev/null -w "%{time_connect}\n" https://stream.ether-technologies.com:8443/; done` |
| OVEVENTS → OV direct | **NOT MEASURED** — needs OV's public address and an open UDP port (the IT ticket D6 defers) | Once the Link is built: patch Link on OV, send from OVEVENTS with the route forced to direct, read the strip's RTT/latency. Before that, with the port forwarded: `ffmpeg -f lavfi -i sine -c:a libopus -f mpegts "srt://<OV public IP>:9760?mode=caller&latency=120000"` against `ffmpeg -i "srt://:9760?mode=listener" -f null -` on OV reports the path. |
| Relay path end to end | **NOT MEASURED** — the relay is not deployed in this run | After the relay slice: the strip's latency with route = relay. |

What the one measured leg says: at p50 the relay path costs ≈ 57 ms of network one way (two ≈ 29 ms legs, if OV's leg
is similar) against the §6 budget; the p90 → max spread (70 → 105 ms RTT) is the jitter the 120 ms buffer has to
absorb, and it fits. SRT ARQ through the relay (≈ 57 ms RTT per leg) has ≈ 2 retransmit round trips inside 120 ms —
marginal, as §2 said.

**Build environment finding:** every libopus binding (`opus` → `opusic-sys`, `opus-head-sys`, `audiopus_sys`)
compiles libopus with CMake. This machine has no CMake on PATH, but Visual Studio Build Tools ships one
(`…\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`, 3.31). Local builds set
`CMAKE` to it (nothing installed); GitHub's Windows and macOS runners have CMake on PATH. A deep target directory
trips MSBuild's path-length limit; `native/target` is short enough (probe build: libopus compiled in 45 s).

## Ruling 2026-09-29 — a FEED into a FADER; the SENDING machine makes the key ("B")

Jeff, verbatim: *"its just a source feed thats being sent to an aux deck fader input should be in the dropdown just
like the knob setting at the top of a wheatstone board its not station to station its feed over network"* — and
*"B. The sending machine makes the key (Preferences → Broadcast → Remote Link, one copyable line with its machine
name); the receiving side pastes it into the fader's Link input next to the source dropdown. Override my earlier
'key belongs to the receiver.'"* — *"just like telling a codec which caller to accept. Each fader can be cut off on
its own."* This supersedes the per-station receive key of steps 3–5 and the earlier same-day ruling that the key
belongs to the receiving machine.

| | Before (steps 3–5) | Now |
|---|---|---|
| Destination | a station | **computer · station · the fader set to Link** (the computer per station from `designated_generator`, synced) |
| Key made by | the receiving station | **the sending machine** — `EtherMachine/link-key` beside `machine-id` (survives wipes) |
| Key shown as | fingerprint only | **one copyable line** `ether-link:1:<machine id>:<key id>:<64 hex>:<machine name>` (Preferences → Broadcast → Remote Link → Copy link key) |
| Receiving side | station key in `link_key` | the pasted line lives on the fader: `link_input.from {machine, name, keyId, key}`; **✕ / Forget key** cuts that sender off, that fader only |
| Wire | station tag + AEAD(header) | station tag unchanged (routing); AEAD associated data = header ‖ **"<receiving machine id>\|<sending machine id>"** — a packet opens only on the machine it was sealed for, only from the machine the fader's key names |
| Refusals | to itself; a station this machine airs; a two-way loop | **one**: a feed to THIS SAME machine (a loop), refused on both ends (send list greyed; a fader refuses its own computer's key). A station this machine also airs is the normal case. |
| Self-test | — | `ETHER_LINK_SELF_TEST=1` (env; never set by the UI) lifts the same-machine refusal; a station still never feeds its own board |

Where: `native/src/link.rs` (`LinkKey::from_hex(hex, id, pairing)`, `MAX_PAIR` 96, AAD on the stack), `linknet.rs`
(`RxCfg.pairing`, `SendCfg.pairing`), `lib.rs` (`audio_set_link_input` / `audio_set_link_send` take `pairing` last),
`audiod/link.js` (token, machine key file, pairing, refusals), `audiod/ether-audiod.js` (plans), `electron/main.js`
(`link:get` targets, `link:key-line`, `link:mint-key` = the machine's key, `link:set-input` takes `keyLine` /
`clearKey`), `SourceChannelStrip.tsx` (paste box under the dropdown, ✕), `RemoteLinkSettings.tsx`, the Health row,
the master section's SEND FEED, `docs/help-remote-link.md`. Dropdown label: **Link (network feed)**.

Tests: `cargo test --release --lib link` 23 passed (new: `the_pairing_binds_a_packet_to_both_machines` — other
receiver refused, other sender refused, empty/oversized pairing refused); the real-UDP loopback (`--ignored`) with
the pairing: key accepted, 0 auth failures, 0 lost, tone −21.10 dBFS (sent −21.07); 3 runs — Δ(shown − audio)
−17.2 ms (**FAILED** the 15 ms bound, on a loaded box: dev app + release build running), then −4.1 and +2.8 ms
(passed). `node audiod/smoke-link.js` all passed. `npx tsc --noEmit` 0 errors.

### Self-test on OVEVENTS (design §7 step 2) — 2026-09-30T03:36–03:38Z, dev app at `87f3302`, `ETHER_LINK_SELF_TEST=1`

Driven through the app's own IPC (`window.ether.audio.link*`, the calls Preferences and the strip make) over a
DevTools port on the dev launch. Magical Forest (s3) → OVEVENTS · halloVeen (s2), fader S5, 127.0.0.1:9760.

| Check | Result (runtime) |
|---|---|
| Targets | 7 rows; halloVeen on **ovowforestmusic** (designation) and on **OVEVENTS (this)** (override); only Magical Forest → its own board refused |
| Copy link key | `ether-link:1:8e8f6181-…:1:<hex>:OVEVENTS`, fingerprint 2B76-918E |
| Pick Link, no key | `{ok:true, needsKey:true}` — stored, not in the engine |
| Paste garbage | refused: "that is not a link key — copy the whole line…" |
| Paste the real line (padded + line break) | taken: fader ← OVEVENTS · 2B76-918E, engine `listening` UDP 9760 |
| Feed to its own board | refused: "self-test: a station cannot feed its own board — the programme would loop" |
| Feed Magical Forest → OVEVENTS · halloVeen | 10 s, ~500 frames: **receiving both ends, 0 lost, 0 late, 0 key refused, 0 dropouts**, latency 120–142 ms (net ≈ 28 + buffer ≈ 104–126), RTT 1.4–2.3 ms, 143–156 kb/s |
| Replace key (fader still holds key #1) | fader refused it: **key refused 229**, state `lost` |
| Paste the new line | **not recovered within 4 s** — the new sender session was answered BUSY: `[LINK] Station 3 send refused: the link is carrying OVEVENTS`. OPEN — cause UNVERIFIED (see below) |
| ✕ / Forget key | `{ok:true, needsKey:true}`, fader `off` |
| Teardown | feed stopped, fader unpatched, nothing stored on s1–s4, s9 |

**Jeff's report during the test, verbatim:** *"its link ovevents and it has a feed but im on ovevents and im not
playing anything"* — that was this self-test's feed (Magical Forest's idle programme = silence) arriving on his
halloVeen Link fader. At 03:38:13Z the stored fader moved from **S5 to S1** (`[link s2] input S1 · key from
OVEVENTS`), which this script did not do — consistent with Link being picked on halloVeen's S1 strip in the UI at
that moment (the patch follows the pick and keeps the pasted key). UNVERIFIED which.

**OPEN — BUSY after a re-key.** The one-venue rule holds a fader for its sender session until 5 s of silence
(`linknet.rs` `RELEASE_AFTER`). After Replace key + re-paste, the same machine's new session was refused as a second
sender. The fader was also re-patched S5 → S1 during this window, so the cause is not isolated. Check: with nobody
touching the board, feed → Replace key → wait 6 s → paste → does `receiving` return, and does the log say `busy`?
