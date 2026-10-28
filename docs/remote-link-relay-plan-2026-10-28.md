# Remote Link relay: plan (option A, Lightsail) — 2026-10-28

**Jeff (verbatim):** "Relay: A. Show me the plan before building; don't change anything on Lightsail until I approve the
plan." Option A, as offered: a small UDP relay on the Lightsail server that already runs Icecast; the backend (Railway)
introduces the two machines. Railway carries no UDP, so the relay cannot live in the backend.

Goal (plan step 3, `docs/ether-audio-patch-bay-plan.md`): machines find each other with **no IP addresses and no ports**,
through any router, and the audio stays UDP and end-to-end encrypted. Nothing here is built. Nothing on Lightsail is
touched until Jeff approves this plan.

## What exists (receipts)

- **Engine** (`native/src/link.rs`, `linknet.rs`): 20 ms Opus frames sealed with ChaCha20-Poly1305 bound to both machine
  ids; the receiver demuxes by station tag on ONE UDP port per machine (9760) and **replies to whatever address the
  packets came from, following it** (`linknet.rs`: "NAT re-binding: follow the sender"). A relay in the middle is
  therefore invisible to the receive side's audio path.
- **Today the sender types the receiver's public address and a router-forwarded port** (`RemoteLinkSettings.tsx`); the
  receiver must forward UDP 9760 on its router. Both are what the relay removes.
- **Pairing** (who may feed whom): the backend's account list (closed to the account since `0d072b1`) or a one-use guest
  code. The relay never decides who may feed whom; the key does.

## How it would work

```
 sender (venue)                    relay (Lightsail, UDP 9790)                   receiver (OV)
   │  ── "start a feed to OV·halloVeen" ─→ backend (Railway, HTTPS) ──┐
   │  ←── relay host, port, session ticket ──────────────────────────┤
   │                                                                  └→ receiver learns the same ticket
   │                                                                     (its 60 s Link poll)
   │                                       ←── REGISTER(ticket) every 15 s ── receiver (outbound: opens its NAT)
   │ ── [ticket | sealed audio] ─────────→ relay forwards by ticket ─────────→ receiver (on its existing socket)
   │ ←─ [ticket | PONG]  ←───────────────── relay forwards back ←──────────── receiver replies to the relay
```

1. **The sender asks the backend for a session** (`POST /api/link/relay/session`, signed in): target machine + station.
   The backend checks the target is in the sender's account (or was paired by a guest code), and returns the relay's
   host and port and a **ticket**: an HMAC of {session id, both machine ids, expiry 12 h} signed with a secret the relay
   and backend share. No database lookup is needed on the relay.
2. **The receiver learns the ticket** on its existing once-a-minute Link poll (`GET /api/link/relay/sessions`), and
   from its existing UDP socket sends `REGISTER(ticket)` to the relay every 15 s. That outbound packet opens its router's
   NAT for the relay's replies: **no port forwarding**.
3. **The sender sends `[ticket | sealed packet]` to the relay.** The relay checks the ticket's signature and expiry once
   per session, then forwards each datagram to the registered receiver, and the receiver's PONGs back to the sender.
   It never sees audio (sealed end to end) and never stores anything.
4. **Expiry and teardown:** a session with no packets for 60 s is dropped from the relay's memory; a ticket expires after
   12 h and the sender asks for a new one (the backend renews it on the sender's poll, so a running link never notices).

## The pieces

| Piece | Where | Size |
|---|---|---|
| Relay: `ether-relay`, one small program (Node `dgram`, ~300 lines), tickets checked by HMAC, per-session counters | New, on Lightsail as its own systemd service and user, UDP 9790 | new |
| Backend: `relay/session` (create, renew) and `relay/sessions` (the receiver's list), the shared secret as a Railway variable | `src/lib/link-relay.js` + tests | new module |
| Engine: an optional relay "via" on send (prefix the ticket, send to the relay) and a `REGISTER` keepalive on the receive socket; the 16-byte prefix stripped on arrival | `linknet.rs` | small; direct UDP unchanged |
| Desktop: no address field; SEND FEED TO picks a computer and station from the account list; the relay is used automatically | `RemoteLinkSettings.tsx`, `audiod/link.js`, `main.js` | moderate |
| Health: the relay's own `/health` (sessions, packets, drops, per-session loss) read by the backend's platform health; the desktop's Link row says "via relay" | relay + backend + `RemoteLinkHealth.tsx` | small |

## Lightsail, exactly what would change (only after approval)

- A new Linux user `ether-relay`, a directory `/opt/ether-relay`, one systemd unit `ether-relay.service`
  (`Restart=always`, memory and CPU limits so it can never starve Icecast).
- One firewall rule in the Lightsail console: **UDP 9790 inbound**.
- The shared secret in `/etc/ether-relay.env` (root-readable only).
- **Icecast is not touched**: no change to its config, its user, its ports or its service.
- Rollback: `systemctl disable --now ether-relay` and remove the firewall rule; Links fall back to direct UDP (today's
  behaviour).

## Cost and limits (to measure, not assumed)

- Bandwidth: each stream ≈ 128 kb/s in + 128 kb/s out ≈ 115 MB/hour through the relay. One 4-hour remote ≈ 0.5 GB.
  Lightsail plans include a monthly transfer allowance; the current plan's figure is to be read from the console before
  building.
- Latency: the Lightsail region (the stream host's address is in AWS us-west-2, Oregon, to be confirmed) adds the
  sender→Oregon→receiver path. To measure on the two real machines.
- **OV is a managed corporate network: whether it allows outbound UDP to 9790 is UNVERIFIED.** The first test is a
  one-packet echo from OVEVENTS and, on Jeff's go only, from ovowforestmusic. If outbound UDP is blocked there, the
  fallback is a TCP leg to the relay (a later step, not in this plan).

## How it is tested

1. Relay unit tests: a valid ticket forwards both ways; a forged, expired or other-session ticket is dropped and
   counted; a silent session is dropped after 60 s; one session cannot flood another.
2. Backend tests: a session only to a machine in the caller's account or paired by code (the stranger test refused);
   renewal; the receiver sees only its own sessions.
3. Engine: the prefix and REGISTER framing (offline, like `link.rs`'s tests); direct UDP unchanged (existing tests).
4. One machine, two engines (`ETHER_LINK_SELF_TEST`), through a relay running locally.
5. OVEVENTS ↔ a second machine on another network, through the Lightsail relay: latency, loss, recovery after
   unplugging the network. **OV only on Jeff's go.**

## Build order (each its own commit with tests; each stop shown before the next)

1. Relay program + its tests (runs locally only).
2. Backend `link-relay` + tests; deployed on its own after Jeff's go.
3. Engine relay path + tests; desktop UI without the address field; help (`docs/help-remote-link.md` rewritten).
4. **Lightsail install (only after this plan is approved).**
5. The two-machine test, then OV on Jeff's go.

## Questions for Jeff

1. UDP port for the relay: 9790 proposed.
2. Keep the direct path (typed address) as an advanced fallback, or remove it once the relay works?
3. The sending operator's consent: anyone on the same account may start a feed to a receiver that is patched to Link
   (today's rule), or should the receiver approve each new sender?
