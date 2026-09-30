// link.rs — THE REMOTE LINK, the part with no sockets and no threads (docs/remote-link-design-2026-09-28.md).
//
// A remote Ether box sends its programme bus to another station's source channel: Opus, 48 kHz, 20 ms frames,
// over UDP, every packet sealed with the SENDING machine's link key, paired "<receiving machine>|<sending machine>". This file is the sans-IO core — everything
// that decides what a packet means, so all of it is testable offline with a simulated network:
//
//   · the WIRE: a 32-byte cleartext header (it is the AEAD's associated data, so it cannot be altered), then the
//     sealed payload and its 16-byte tag. The receiver demuxes by the station tag BEFORE it trusts anything, and
//     never answers a packet whose tag does not verify;
//   · the REPLAY window: a sliding 64-packet bitmap per sender session;
//   · the JITTER BUFFER: packets placed by frame number, played out on demand once `target` frames are held.
//     A frame missing at its turn is recovered from the NEXT packet's in-band FEC when that packet is here, else
//     concealed (Opus PLC). Nothing buffered at all = STARVED: the channel goes silent and the buffer re-primes;
//   · the CLOCK estimate: NTP's four timestamps over PING/PONG; the offset of the lowest-RTT sample in a window;
//   · the 44.1 → 48 kHz resampler the sender needs (Opus has no 44.1 kHz mode), built on the mic's sinc table.
//
// SENSES: every outcome above is a counter (JbStats) the engine publishes; nothing is silently dropped.

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce, Tag};

use crate::micin::{SincTable, TAPS};

/// The link's audio rate (Opus's own; the engine's programme rate is 44.1 kHz).
pub(crate) const LINK_RATE: u32 = 48_000;
/// One Opus frame: 20 ms at 48 kHz (Jeff's ruling).
pub(crate) const FRAME: usize = 960;
/// Frame duration, microseconds.
pub(crate) const FRAME_US: u64 = 20_000;
/// Stereo: the link carries the programme bus.
pub(crate) const CHANNELS: usize = 2;
/// D5 defaults — every one of them is shown in Preferences.
pub(crate) const DEFAULT_BITRATE: u32 = 128_000;
pub(crate) const DEFAULT_PORT: u16 = 9760;
pub(crate) const DEFAULT_JITTER_MS: u32 = 120;
/// Bitrate range the engine accepts (Opus's useful stereo range).
pub(crate) const BITRATE_RANGE: (u32, u32) = (32_000, 256_000);
/// Jitter-buffer range the engine accepts, ms.
pub(crate) const JITTER_RANGE_MS: (u32, u32) = (20, 1000);
/// The largest Opus packet (RFC 6716 §3.4: 1275 bytes per frame).
pub(crate) const MAX_OPUS: usize = 1275;

// ── the wire ────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) const MAGIC: [u8; 2] = *b"EL";
pub(crate) const VERSION: u8 = 1;
pub(crate) const HEADER: usize = 32;
pub(crate) const TAG_LEN: usize = 16;
/// Header + the largest payload (audio: 16 bytes of clocks + one Opus frame) + tag. Well under a 1500 MTU.
pub(crate) const MAX_PACKET: usize = HEADER + 16 + MAX_OPUS + TAG_LEN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Kind {
    /// sender → receiver: one Opus frame.
    Audio = 1,
    /// sender → receiver, every 250 ms: clock sample + who is sending.
    Ping = 2,
    /// receiver → sender: the clock sample answered, and the receiver's own report (what it actually got).
    Pong = 3,
    /// receiver → sender: this link is already carrying another sender.
    Busy = 4,
}
impl Kind {
    fn from_u8(v: u8) -> Option<Kind> {
        match v { 1 => Some(Kind::Audio), 2 => Some(Kind::Ping), 3 => Some(Kind::Pong), 4 => Some(Kind::Busy), _ => None }
    }
    /// Receiver-originated packets use the other half of the nonce space, so the two directions of one session
    /// can never produce the same nonce under the same key.
    fn from_receiver(self) -> bool { matches!(self, Kind::Pong | Kind::Busy) }
}

/// The cleartext header. It is authenticated (AEAD associated data): a changed byte fails the tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Header {
    pub kind: Kind,
    /// Which station this is for: the first 8 bytes of its UUID. Lets one port serve every station on a box.
    pub station: [u8; 8],
    /// Which of the station's keys sealed it (rotation keeps the previous key for a short overlap).
    pub key_id: u32,
    /// Chosen at random by the SENDER for each connection; the receiver's replies carry the same session.
    pub session: u64,
    /// Per direction, per session, strictly increasing. The replay window runs on it.
    pub seq: u32,
    pub flags: u32,
}
impl Header {
    pub(crate) fn write(&self, out: &mut [u8]) {
        out[0..2].copy_from_slice(&MAGIC);
        out[2] = VERSION;
        out[3] = self.kind as u8;
        out[4..12].copy_from_slice(&self.station);
        out[12..16].copy_from_slice(&self.key_id.to_le_bytes());
        out[16..24].copy_from_slice(&self.session.to_le_bytes());
        out[24..28].copy_from_slice(&self.seq.to_le_bytes());
        out[28..32].copy_from_slice(&self.flags.to_le_bytes());
    }
    /// Parse the cleartext header only. Nothing here is trusted until `open` verifies the tag.
    pub(crate) fn peek(p: &[u8]) -> Option<Header> {
        if p.len() < HEADER + TAG_LEN || p[0..2] != MAGIC || p[2] != VERSION { return None; }
        let kind = Kind::from_u8(p[3])?;
        let mut station = [0u8; 8];
        station.copy_from_slice(&p[4..12]);
        Some(Header {
            kind, station,
            key_id: u32::from_le_bytes(p[12..16].try_into().ok()?),
            session: u64::from_le_bytes(p[16..24].try_into().ok()?),
            seq: u32::from_le_bytes(p[24..28].try_into().ok()?),
            flags: u32::from_le_bytes(p[28..32].try_into().ok()?),
        })
    }
    fn nonce(&self) -> [u8; 12] {
        let dir = if self.kind.from_receiver() { 1u64 << 63 } else { 0 };
        let mut n = [0u8; 12];
        n[0..8].copy_from_slice(&(self.session ^ dir).to_le_bytes());
        n[8..12].copy_from_slice(&self.seq.to_le_bytes());
        n
    }
}

/// The station tag: the first 8 bytes of the station UUID (hex, dashes ignored). None if it is not a UUID.
pub(crate) fn station_tag(uuid: &str) -> Option<[u8; 8]> {
    let hex: Vec<u8> = uuid.bytes().filter(|b| *b != b'-').collect();
    if hex.len() != 32 { return None; }
    let mut t = [0u8; 8];
    for i in 0..8 {
        let s = std::str::from_utf8(&hex[2 * i..2 * i + 2]).ok()?;
        t[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(t)
}

/// The longest pairing: "<receiving machine id>|<sending machine id>" (two UUIDs: 73 bytes).
pub(crate) const MAX_PAIR: usize = 96;

/// A link key (32 bytes, carried as 64 hex characters). The SENDING machine makes it; the receiving fader's Link
/// input holds a copy (pasted), like a codec told which caller to accept. The station UUID stays the routing tag
/// on the wire. The PAIRING — "<receiving machine id>|<sending machine id>" — is authenticated with every packet
/// (it follows the header in the associated data, never sent): a packet opens only on the machine it was sealed
/// for, and only from the machine that fader's key names — even under the same key.
#[derive(Clone)]
pub(crate) struct LinkKey { cipher: ChaCha20Poly1305, pub id: u32, raw: [u8; 32], pair: [u8; MAX_PAIR], pair_len: usize }
impl LinkKey {
    /// `pairing` = "<receiving machine id>|<sending machine id>", the same string on both ends. Trimmed and
    /// lower-cased, so a UUID typed in either case pairs. None if the key is not 64 hex, or the pairing is empty/too long.
    pub(crate) fn from_hex(hex: &str, id: u32, pairing: &str) -> Option<LinkKey> {
        let h = hex.trim();
        if h.len() != 64 { return None; }
        let mut k = [0u8; 32];
        for i in 0..32 { k[i] = u8::from_str_radix(h.get(2 * i..2 * i + 2)?, 16).ok()?; }
        let m = pairing.trim().to_ascii_lowercase();
        if m.is_empty() || m.len() > MAX_PAIR { return None; }
        let mut pair = [0u8; MAX_PAIR];
        pair[..m.len()].copy_from_slice(m.as_bytes());
        Some(LinkKey { cipher: ChaCha20Poly1305::new(Key::from_slice(&k)), id, raw: k, pair, pair_len: m.len() })
    }
    /// The same key: the same 32 bytes, the same key id, the same pairing. A fader whose key is replaced by one that
    /// is not `same_as` it can no longer vouch for the session it was carrying (linknet.rs drops that session).
    pub(crate) fn same_as(&self, o: &LinkKey) -> bool {
        self.id == o.id && self.raw == o.raw && self.pair[..self.pair_len] == o.pair[..o.pair_len]
    }
    /// The associated data: the 32-byte header, then the pairing. On the stack — no allocation.
    fn aad<'a>(&self, header: &[u8], buf: &'a mut [u8; HEADER + MAX_PAIR]) -> &'a [u8] {
        buf[..HEADER].copy_from_slice(&header[..HEADER]);
        buf[HEADER..HEADER + self.pair_len].copy_from_slice(&self.pair[..self.pair_len]);
        &buf[..HEADER + self.pair_len]
    }
    /// A fresh random key, as hex. OS randomness; None only if the OS refuses.
    pub(crate) fn mint_hex() -> Option<String> {
        let mut k = [0u8; 32];
        getrandom::getrandom(&mut k).ok()?;
        Some(k.iter().map(|b| format!("{:02x}", b)).collect())
    }
    /// Seal: write the header, copy the payload in, encrypt it in place, append the tag. Returns the length.
    pub(crate) fn seal(&self, h: &Header, payload: &[u8], out: &mut [u8]) -> Option<usize> {
        let n = HEADER + payload.len() + TAG_LEN;
        if out.len() < n { return None; }
        h.write(&mut out[..HEADER]);
        out[HEADER..HEADER + payload.len()].copy_from_slice(payload);
        let (hdr, rest) = out.split_at_mut(HEADER);
        let mut ab = [0u8; HEADER + MAX_PAIR];
        let aad = self.aad(hdr, &mut ab);
        let tag = self.cipher.encrypt_in_place_detached(Nonce::from_slice(&h.nonce()), aad, &mut rest[..payload.len()]).ok()?;
        rest[payload.len()..payload.len() + TAG_LEN].copy_from_slice(&tag);
        Some(n)
    }
    /// Open in place: verify the tag over header + payload and decrypt. On success the plaintext payload is
    /// `pkt[HEADER..HEADER + len]`. Any failure — wrong key, altered byte, truncated — is None and nothing else.
    pub(crate) fn open(&self, pkt: &mut [u8]) -> Option<(Header, usize)> {
        let h = Header::peek(pkt)?;
        if h.key_id != self.id { return None; }
        let len = pkt.len() - HEADER - TAG_LEN;
        let (hdr, rest) = pkt.split_at_mut(HEADER);
        let mut ab = [0u8; HEADER + MAX_PAIR];
        let aad = self.aad(hdr, &mut ab);
        let (body, tag) = rest.split_at_mut(len);
        self.cipher.decrypt_in_place_detached(Nonce::from_slice(&h.nonce()), aad, body, Tag::from_slice(tag)).ok()?;
        Some((h, len))
    }
}

// ── the replay window ───────────────────────────────────────────────────────────────────────────────────
/// A 64-packet sliding window (RFC 4303 §3.4.3 style). Call `check` BEFORE acting on a packet and `accept`
/// only after its tag verified, so a forged packet can never move the window.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ReplayWindow { top: Option<u32>, bits: u64 }
impl ReplayWindow {
    pub(crate) fn check(&self, seq: u32) -> bool {
        match self.top {
            None => true,
            Some(t) if seq > t => true,
            Some(t) => { let d = t - seq; d < 64 && self.bits & (1u64 << d) == 0 }
        }
    }
    pub(crate) fn accept(&mut self, seq: u32) {
        match self.top {
            None => { self.top = Some(seq); self.bits = 1; }
            Some(t) if seq > t => {
                let d = seq - t;
                self.bits = if d >= 64 { 0 } else { self.bits << d };
                self.bits |= 1;
                self.top = Some(seq);
            }
            Some(t) => { let d = t - seq; if d < 64 { self.bits |= 1u64 << d; } }
        }
    }
}

// ── payloads ────────────────────────────────────────────────────────────────────────────────────────────
/// AUDIO: frame number (the sender's 48 kHz frame clock / FRAME), when its first sample left the programme bus
/// (sender clock, µs), then the Opus packet.
pub(crate) fn audio_payload(frame_no: u64, tap_us: u64, opus: &[u8], out: &mut [u8]) -> usize {
    out[0..8].copy_from_slice(&frame_no.to_le_bytes());
    out[8..16].copy_from_slice(&tap_us.to_le_bytes());
    out[16..16 + opus.len()].copy_from_slice(opus);
    16 + opus.len()
}
pub(crate) fn parse_audio(p: &[u8]) -> Option<(u64, u64, &[u8])> {
    if p.len() < 17 { return None; }
    Some((u64::from_le_bytes(p[0..8].try_into().ok()?), u64::from_le_bytes(p[8..16].try_into().ok()?), &p[16..]))
}

/// PING (sender → receiver): the NTP t1, the sender's current clock estimate (so the receiver can place audio
/// in its own time), the encoder settings, and the sending machine's name.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Ping {
    pub t1_us: u64,
    /// The sender's estimate of (receiver clock − sender clock), µs; `offset_ok` = it has one.
    pub offset_us: i64,
    pub offset_ok: bool,
    pub rtt_us: u32,
    pub bitrate: u32,
    pub name: String,
}
impl Ping {
    pub(crate) fn write(&self, out: &mut [u8]) -> usize {
        out[0..8].copy_from_slice(&self.t1_us.to_le_bytes());
        out[8..16].copy_from_slice(&self.offset_us.to_le_bytes());
        out[16] = self.offset_ok as u8;
        out[17..21].copy_from_slice(&self.rtt_us.to_le_bytes());
        out[21..25].copy_from_slice(&self.bitrate.to_le_bytes());
        let name = self.name.as_bytes();
        let n = name.len().min(48);
        out[25] = n as u8;
        out[26..26 + n].copy_from_slice(&name[..n]);
        26 + n
    }
    pub(crate) fn parse(p: &[u8]) -> Option<Ping> {
        if p.len() < 26 { return None; }
        let n = p[25] as usize;
        if p.len() < 26 + n { return None; }
        Some(Ping {
            t1_us: u64::from_le_bytes(p[0..8].try_into().ok()?),
            offset_us: i64::from_le_bytes(p[8..16].try_into().ok()?),
            offset_ok: p[16] != 0,
            rtt_us: u32::from_le_bytes(p[17..21].try_into().ok()?),
            bitrate: u32::from_le_bytes(p[21..25].try_into().ok()?),
            name: String::from_utf8_lossy(&p[26..26 + n]).into_owned(),
        })
    }
}

/// PONG (receiver → sender): the clock sample answered, and what the receiver has actually received — the
/// sender's "OV receiving" line is built from THIS, never assumed.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Pong {
    pub t1_us: u64,
    pub t2_us: u64,
    pub t3_us: u64,
    pub frames_received: u64,
    pub frames_lost: u64,
    pub frames_fec: u64,
    pub frames_concealed: u64,
    pub frames_late: u64,
    pub jitter_ms: u16,
    pub depth_ms: u16,
    /// 0 priming · 1 playing · 2 starved
    pub state: u8,
}
impl Pong {
    pub(crate) fn write(&self, out: &mut [u8]) -> usize {
        let mut o = 0;
        for v in [self.t1_us, self.t2_us, self.t3_us, self.frames_received, self.frames_lost, self.frames_fec,
                  self.frames_concealed, self.frames_late] {
            out[o..o + 8].copy_from_slice(&v.to_le_bytes());
            o += 8;
        }
        out[o..o + 2].copy_from_slice(&self.jitter_ms.to_le_bytes());
        out[o + 2..o + 4].copy_from_slice(&self.depth_ms.to_le_bytes());
        out[o + 4] = self.state;
        o + 5
    }
    pub(crate) fn parse(p: &[u8]) -> Option<Pong> {
        if p.len() < 69 { return None; }
        let u = |i: usize| u64::from_le_bytes(p[i * 8..i * 8 + 8].try_into().unwrap());
        Some(Pong {
            t1_us: u(0), t2_us: u(1), t3_us: u(2), frames_received: u(3), frames_lost: u(4), frames_fec: u(5),
            frames_concealed: u(6), frames_late: u(7),
            jitter_ms: u16::from_le_bytes([p[64], p[65]]),
            depth_ms: u16::from_le_bytes([p[66], p[67]]),
            state: p[68],
        })
    }
}

// ── the clock estimate ──────────────────────────────────────────────────────────────────────────────────
/// NTP's on-wire arithmetic over PING/PONG. The offset (receiver − sender) is taken from the lowest-RTT sample
/// of the last `WINDOW` — the sample least disturbed by queueing — and is exact to ± half the path asymmetry.
pub(crate) struct ClockEstimate { samples: [(u32, i64); ClockEstimate::WINDOW], n: usize, next: usize }
impl Default for ClockEstimate { fn default() -> Self { ClockEstimate { samples: [(0, 0); Self::WINDOW], n: 0, next: 0 } } }
impl ClockEstimate {
    /// 32 samples at 4 Hz = the last 8 s.
    pub(crate) const WINDOW: usize = 32;
    /// t1 sender send, t2 receiver receive, t3 receiver send, t4 sender receive (each on its own clock, µs).
    pub(crate) fn add(&mut self, t1: u64, t2: u64, t3: u64, t4: u64) {
        let (t1, t2, t3, t4) = (t1 as i128, t2 as i128, t3 as i128, t4 as i128);
        let rtt = ((t4 - t1) - (t3 - t2)).max(0);
        let off = ((t2 - t1) + (t3 - t4)) / 2;
        self.samples[self.next] = (rtt.min(u32::MAX as i128) as u32, off as i64);
        self.next = (self.next + 1) % Self::WINDOW;
        self.n = (self.n + 1).min(Self::WINDOW);
    }
    /// (rtt µs, offset µs) of the best sample, or None before the first.
    pub(crate) fn best(&self) -> Option<(u32, i64)> {
        self.samples[..self.n].iter().copied().min_by_key(|s| s.0)
    }
    /// The latest RTT (for display: what the path is doing now, not its best moment).
    pub(crate) fn last_rtt(&self) -> Option<u32> {
        if self.n == 0 { None } else { Some(self.samples[(self.next + Self::WINDOW - 1) % Self::WINDOW].0) }
    }
}

// ── the jitter buffer ───────────────────────────────────────────────────────────────────────────────────
/// Frames held: 256 × 20 ms = 5.12 s — far past any sane target; a packet further ahead than that is refused.
pub(crate) const JB_SLOTS: usize = 256;
/// Beyond target + this many frames the buffer is STALE (a backlog arrived at once, or the output stopped
/// pulling): the oldest frames are dropped down to the target, and it is counted.
pub(crate) const JB_STALE_FRAMES: u64 = 10;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct JbStats {
    /// Audio packets placed in the buffer.
    pub received: u64,
    /// Frames that were not here at their turn: fec + concealed.
    pub lost: u64,
    /// ...of which recovered from the next packet's in-band FEC.
    pub fec: u64,
    /// ...of which concealed by Opus PLC.
    pub concealed: u64,
    /// Arrived after their turn had passed (dropped).
    pub late: u64,
    pub duplicates: u64,
    /// Arrived out of order but in time (played normally).
    pub reordered: u64,
    /// Further ahead than the buffer holds (dropped).
    pub too_far: u64,
    /// Nothing buffered at a turn: the channel went silent and the buffer re-primed.
    pub starved: u64,
    /// Received frames dropped (never played) because the buffer was past target + JB_STALE_FRAMES.
    pub stale_dropped: u64,
    pub stale_flushes: u64,
}

struct JbSlot { frame_no: u64, present: bool, len: u16, data: [u8; MAX_OPUS] }

/// What to feed the decoder for the next frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Playout<'a> {
    /// The frame itself.
    Packet(&'a [u8]),
    /// The frame is missing but the next one is here: decode THIS with fec = true (it carries the lost frame's
    /// LBRR copy). The next frame stays in the buffer for its own turn.
    Fec(&'a [u8]),
    /// Missing and no FEC available: decode an empty packet (Opus PLC).
    Conceal,
    /// Not primed yet (or re-priming): produce nothing.
    Waiting,
    /// Nothing buffered at this turn — the stream stopped. The buffer re-primes; the channel goes silent.
    Starved,
}

pub(crate) struct JitterBuffer {
    slots: Box<[JbSlot]>,
    next_play: u64,
    highest: Option<u64>,
    primed: bool,
    /// After a starve, the next packet re-anchors the playout point (the sender kept counting frames while
    /// nothing arrived; waiting for the old frame numbers would never end).
    reanchor: bool,
    target: u64,
    pub stats: JbStats,
}
impl JitterBuffer {
    pub(crate) fn new(target_ms: u32) -> JitterBuffer {
        let slots: Vec<JbSlot> = (0..JB_SLOTS).map(|_| JbSlot { frame_no: 0, present: false, len: 0, data: [0; MAX_OPUS] }).collect();
        JitterBuffer { slots: slots.into_boxed_slice(), next_play: 0, highest: None, primed: false, reanchor: true,
                       target: Self::frames_for(target_ms), stats: JbStats::default() }
    }
    /// A target in ms → whole frames, at least 1 (120 ms = 6 frames).
    pub(crate) fn frames_for(ms: u32) -> u64 { ((ms as u64 * 1000 + FRAME_US - 1) / FRAME_US).max(1) }
    pub(crate) fn set_target_ms(&mut self, ms: u32) { self.target = Self::frames_for(ms); }
    pub(crate) fn target_frames(&self) -> u64 { self.target }
    pub(crate) fn primed(&self) -> bool { self.primed }
    /// Frames between the playout point and the newest frame received, inclusive — the buffer's depth in time.
    pub(crate) fn depth_frames(&self) -> u64 {
        match self.highest { Some(h) if h >= self.next_play && !self.reanchor => h - self.next_play + 1, _ => 0 }
    }
    /// Forget everything (a new sender session).
    pub(crate) fn reset(&mut self) {
        for s in self.slots.iter_mut() { s.present = false; }
        self.highest = None; self.primed = false; self.reanchor = true; self.next_play = 0;
    }

    /// Place one frame. Never blocks, never allocates.
    pub(crate) fn insert(&mut self, frame_no: u64, opus: &[u8]) {
        if opus.is_empty() || opus.len() > MAX_OPUS { return; }
        if self.reanchor {
            // First packet (or the first after a starve): the playout point starts here.
            for s in self.slots.iter_mut() { s.present = false; }
            self.next_play = frame_no;
            self.highest = None;
            self.reanchor = false;
            self.primed = false;
        }
        if frame_no < self.next_play { self.stats.late += 1; return; }
        if frame_no >= self.next_play + JB_SLOTS as u64 { self.stats.too_far += 1; return; }
        let s = &mut self.slots[(frame_no % JB_SLOTS as u64) as usize];
        if s.present && s.frame_no == frame_no { self.stats.duplicates += 1; return; }
        s.frame_no = frame_no;
        s.present = true;
        s.len = opus.len() as u16;
        s.data[..opus.len()].copy_from_slice(opus);
        self.stats.received += 1;
        match self.highest {
            Some(h) if frame_no < h => self.stats.reordered += 1,
            Some(h) if frame_no == h => {}
            _ => self.highest = Some(frame_no),
        }
        if !self.primed && self.depth_frames() >= self.target { self.primed = true; }
        // STALE — more than target + JB_STALE_FRAMES held: drop the oldest down to the target.
        if self.primed {
            let d = self.depth_frames();
            if d > self.target + JB_STALE_FRAMES {
                let drop = d - self.target;
                for f in self.next_play..self.next_play + drop {
                    let s = &mut self.slots[(f % JB_SLOTS as u64) as usize];
                    if s.present && s.frame_no == f { s.present = false; self.stats.stale_dropped += 1; }
                }
                self.next_play += drop;
                self.stats.stale_flushes += 1;
            }
        }
    }

    fn slot(&self, f: u64) -> Option<&JbSlot> {
        let s = &self.slots[(f % JB_SLOTS as u64) as usize];
        if s.present && s.frame_no == f { Some(s) } else { None }
    }

    /// The next frame's turn. Consumes the turn (the playout point advances) for Packet / Fec / Conceal.
    pub(crate) fn pop(&mut self) -> Playout<'_> {
        if !self.primed { return Playout::Waiting; }
        let f = self.next_play;
        match self.highest {
            Some(h) if h >= f => {}
            _ => {
                // Nothing at or after the playout point: the sender stopped (or the network did).
                self.stats.starved += 1;
                self.primed = false;
                self.reanchor = true;
                return Playout::Starved;
            }
        }
        self.next_play += 1;
        let idx = (f % JB_SLOTS as u64) as usize;
        if self.slots[idx].present && self.slots[idx].frame_no == f {
            self.slots[idx].present = false;
            let len = self.slots[idx].len as usize;
            return Playout::Packet(&self.slots[idx].data[..len]);
        }
        self.stats.lost += 1;
        if self.slot(f + 1).is_some() {
            self.stats.fec += 1;
            let nidx = ((f + 1) % JB_SLOTS as u64) as usize;
            let len = self.slots[nidx].len as usize;
            return Playout::Fec(&self.slots[nidx].data[..len]);
        }
        self.stats.concealed += 1;
        Playout::Conceal
    }
}

/// RFC 3550 §6.4.1 interarrival jitter, in µs: J += (|D| − J) / 16, where D is the change in transit time.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Jitter { last_transit: Option<i64>, pub j_us: f64 }
impl Jitter {
    /// `sent_us` on the sender's clock, `arrived_us` on ours: only differences matter, so no offset is needed.
    pub(crate) fn add(&mut self, sent_us: u64, arrived_us: u64) {
        let transit = arrived_us as i64 - sent_us as i64;
        if let Some(l) = self.last_transit {
            let d = (transit - l).abs() as f64;
            self.j_us += (d - self.j_us) / 16.0;
        }
        self.last_transit = Some(transit);
    }
}

// ── the sender's resampler: 44.1 kHz stereo → 48 kHz stereo, fixed ratio ────────────────────────────────
/// The mic's polyphase windowed-sinc (micin::SincTable, 48 taps, Kaiser β 8) run at a FIXED ratio: the sender
/// has one clock (its own output device), and the receiver absorbs the drift between the two machines.
pub(crate) struct Resampler48 {
    table: SincTable,
    hist: [[f32; 2 * TAPS]; CHANNELS],
    hpos: usize,
    phase: f64,
    step: f64,
}
impl Resampler48 {
    pub(crate) fn new(in_rate: u32) -> Resampler48 {
        Resampler48 { table: SincTable::new(in_rate, LINK_RATE), hist: [[0.0; 2 * TAPS]; CHANNELS], hpos: 0, phase: 0.0,
                      step: in_rate as f64 / LINK_RATE as f64 }
    }
    /// Feed interleaved stereo input; append interleaved stereo 48 kHz output to `out` (up to its capacity;
    /// returns frames written). Every input frame is consumed.
    pub(crate) fn process(&mut self, input: &[f32], out: &mut Vec<f32>) -> usize {
        let mut written = 0;
        for fr in input.chunks_exact(2) {
            // one input sample enters: emit every output instant that falls before the next one
            self.hist[0][self.hpos] = fr[0]; self.hist[0][self.hpos + TAPS] = fr[0];
            self.hist[1][self.hpos] = fr[1]; self.hist[1][self.hpos + TAPS] = fr[1];
            self.hpos += 1;
            if self.hpos == TAPS { self.hpos = 0; }
            while self.phase < 1.0 {
                let l = self.table.interp(&self.hist[0][self.hpos..self.hpos + TAPS], self.phase);
                let r = self.table.interp(&self.hist[1][self.hpos..self.hpos + TAPS], self.phase);
                out.push(l);
                out.push(r);
                written += 1;
                self.phase += self.step;
            }
            self.phase -= 1.0;
        }
        written
    }
}

// ── tests (offline: no sockets, no threads, no device) ──────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "8e8f6181-b68a-433f-a93d-8005787b641b";
    const MACHINE: &str = "8e8f6181-b68a-433f-a93d-8005787b641b|041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e";
    fn key() -> LinkKey { LinkKey::from_hex(&"ab".repeat(32), 7, MACHINE).unwrap() }
    fn hdr(kind: Kind, seq: u32) -> Header {
        Header { kind, station: station_tag(UUID).unwrap(), key_id: 7, session: 0x1234_5678_9abc_def0, seq, flags: 0 }
    }

    /// A small deterministic PRNG (xorshift64*), so every simulated network is reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 { self.0 ^= self.0 >> 12; self.0 ^= self.0 << 25; self.0 ^= self.0 >> 27; self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) }
        fn unit(&mut self) -> f64 { (self.next() >> 11) as f64 / (1u64 << 53) as f64 }
    }

    // 1 · the wire
    #[test]
    fn seal_open_roundtrip_and_every_tamper_is_refused() {
        let k = key();
        let mut buf = [0u8; MAX_PACKET];
        let n = k.seal(&hdr(Kind::Audio, 5), b"programme audio", &mut buf).unwrap();
        let mut p = buf[..n].to_vec();
        let (h, len) = k.open(&mut p).expect("a sealed packet opens");
        assert_eq!(h, hdr(Kind::Audio, 5));
        assert_eq!(&p[HEADER..HEADER + len], b"programme audio");
        // every single byte, flipped, fails the tag (header bytes are associated data, so they count too)
        let mut refused = 0;
        for i in 0..n {
            let mut q = buf[..n].to_vec();
            q[i] ^= 0x01;
            if k.open(&mut q).is_none() { refused += 1; }
        }
        println!("[link-wire] {} of {} single-byte tampers refused", refused, n);
        assert_eq!(refused, n);
        // the wrong key, and a truncated packet
        let other = LinkKey::from_hex(&"cd".repeat(32), 7, MACHINE).unwrap();
        assert!(other.open(&mut buf[..n].to_vec()).is_none());
        assert!(k.open(&mut buf[..n - 1].to_vec()).is_none());
        // a different key id is refused before any decryption
        let rotated = LinkKey::from_hex(&"ab".repeat(32), 8, MACHINE).unwrap();
        assert!(rotated.open(&mut buf[..n].to_vec()).is_none());
    }

    #[test]
    fn the_pairing_binds_a_packet_to_both_machines() {
        // Same key, same header: sealed for receiver A from sender S, it opens on A-from-S (any case/whitespace),
        // never on another receiver, never as if from another sender.
        let a = key();
        let mut buf = [0u8; MAX_PACKET];
        let n = a.seal(&hdr(Kind::Audio, 1), b"feed", &mut buf).unwrap();
        let a_upper = LinkKey::from_hex(&"ab".repeat(32), 7, &format!("  {}  ", MACHINE.to_uppercase())).unwrap();
        assert!(a_upper.open(&mut buf[..n].to_vec()).is_some());
        let other_rx = LinkKey::from_hex(&"ab".repeat(32), 7, "0f1e2d3c-0000-4000-8000-000000000000|041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e").unwrap();
        assert!(other_rx.open(&mut buf[..n].to_vec()).is_none(), "sealed for receiver A: must not open on receiver B");
        let other_tx = LinkKey::from_hex(&"ab".repeat(32), 7, "8e8f6181-b68a-433f-a93d-8005787b641b|0f1e2d3c-0000-4000-8000-000000000000").unwrap();
        assert!(other_tx.open(&mut buf[..n].to_vec()).is_none(), "the fader's key names sender S: a packet claiming another sender must not open");
        // No machine id = no key: an unpaired key cannot exist.
        assert!(LinkKey::from_hex(&"ab".repeat(32), 7, "").is_none());
        assert!(LinkKey::from_hex(&"ab".repeat(32), 7, "   ").is_none());
        assert!(LinkKey::from_hex(&"ab".repeat(32), 7, &"x".repeat(MAX_PAIR + 1)).is_none());
    }

    #[test]
    fn same_as_is_bytes_and_id_and_pairing() {
        let a = key();
        assert!(a.same_as(&LinkKey::from_hex(&"AB".repeat(32), 7, &MACHINE.to_uppercase()).unwrap()), "case of hex and pairing does not matter");
        assert!(!a.same_as(&LinkKey::from_hex(&"cd".repeat(32), 7, MACHINE).unwrap()), "other bytes");
        assert!(!a.same_as(&LinkKey::from_hex(&"ab".repeat(32), 8, MACHINE).unwrap()), "other key id");
        assert!(!a.same_as(&LinkKey::from_hex(&"ab".repeat(32), 7, "x|y").unwrap()), "other pairing");
    }

    #[test]
    fn the_two_directions_never_share_a_nonce() {
        let a = hdr(Kind::Ping, 9);
        let b = Header { kind: Kind::Pong, ..a };
        assert_ne!(a.nonce(), b.nonce());
    }

    #[test]
    fn garbage_never_panics_and_never_opens() {
        let k = key();
        let mut r = Rng(0x9e37_79b9_7f4a_7c15);
        for len in 0..400usize {
            let mut p: Vec<u8> = (0..len).map(|_| r.next() as u8).collect();
            if len >= 3 { p[0] = b'E'; p[1] = b'L'; p[2] = VERSION; }
            assert!(k.open(&mut p).is_none());
        }
    }

    #[test]
    fn station_tag_from_uuid() {
        assert_eq!(station_tag(UUID), Some([0x8e, 0x8f, 0x61, 0x81, 0xb6, 0x8a, 0x43, 0x3f]));
        assert_eq!(station_tag("not-a-uuid"), None);
        assert_eq!(station_tag("12"), None);
    }

    #[test]
    fn minted_keys_are_64_hex_and_distinct() {
        let a = LinkKey::mint_hex().unwrap();
        let b = LinkKey::mint_hex().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(LinkKey::from_hex(&a, 1, MACHINE).is_some());
        assert!(LinkKey::from_hex("zz", 1, MACHINE).is_none());
    }

    #[test]
    fn payloads_roundtrip() {
        let mut b = [0u8; 256];
        let n = audio_payload(42, 99, &[1, 2, 3], &mut b);
        assert_eq!(parse_audio(&b[..n]), Some((42, 99, &[1u8, 2, 3][..])));
        let ping = Ping { t1_us: 1, offset_us: -5, offset_ok: true, rtt_us: 7, bitrate: 128_000, name: "OVEVENTS".into() };
        let n = ping.write(&mut b);
        assert_eq!(Ping::parse(&b[..n]), Some(ping));
        let pong = Pong { t1_us: 1, t2_us: 2, t3_us: 3, frames_received: 4, frames_lost: 5, frames_fec: 6,
                          frames_concealed: 7, frames_late: 8, jitter_ms: 9, depth_ms: 120, state: 1 };
        let n = pong.write(&mut b);
        assert_eq!(Pong::parse(&b[..n]), Some(pong));
    }

    // 2 · replay
    #[test]
    fn replay_window() {
        let mut w = ReplayWindow::default();
        for s in [10u32, 12, 11, 15] { assert!(w.check(s)); w.accept(s); }
        assert!(!w.check(12), "a duplicate is refused");
        assert!(w.check(13) && w.check(14), "a gap inside the window is still open");
        w.accept(100);
        assert!(!w.check(36), "older than the 64-packet window");
        assert!(w.check(37));
        assert!(!w.check(100));
    }

    // 3 · the jitter buffer, case by case
    fn pk(f: u64) -> Vec<u8> { vec![(f & 0xff) as u8 + 1; 3] }
    fn play(jb: &mut JitterBuffer) -> String {
        match jb.pop() {
            Playout::Packet(p) => format!("P{}", p[0] - 1),
            Playout::Fec(p) => format!("F{}", p[0] - 1),
            Playout::Conceal => "C".into(),
            Playout::Waiting => "W".into(),
            Playout::Starved => "S".into(),
        }
    }

    #[test]
    fn jb_primes_at_target_then_plays_in_order() {
        let mut jb = JitterBuffer::new(60); // 3 frames
        assert_eq!(jb.target_frames(), 3);
        jb.insert(100, &pk(100));
        assert_eq!(play(&mut jb), "W");
        jb.insert(101, &pk(101));
        assert!(!jb.primed());
        jb.insert(102, &pk(102));
        assert!(jb.primed());
        assert_eq!(jb.depth_frames(), 3);
        assert_eq!(play(&mut jb), "P100");
        assert_eq!(play(&mut jb), "P101");
        assert_eq!(play(&mut jb), "P102");
        assert_eq!(play(&mut jb), "S");
        assert_eq!(jb.stats.starved, 1);
    }

    #[test]
    fn jb_reorder_duplicate_late_fec_conceal() {
        let mut jb = JitterBuffer::new(60);
        for f in [0u64, 2, 1] { jb.insert(f, &pk(f)); }
        assert_eq!(jb.stats.reordered, 1);
        jb.insert(2, &pk(2));
        assert_eq!(jb.stats.duplicates, 1);
        assert_eq!(play(&mut jb), "P0");
        jb.insert(0, &pk(0));
        assert_eq!(jb.stats.late, 1);
        // 3 lost, 4 here → FEC from 4; then 4 itself; 5 and 6 lost, 7 here → 5 concealed, 6 from 7's FEC
        jb.insert(4, &pk(4));
        jb.insert(7, &pk(7));
        let seq: Vec<String> = (0..7).map(|_| play(&mut jb)).collect();
        assert_eq!(seq, ["P1", "P2", "F4", "P4", "C", "F7", "P7"]);
        assert_eq!((jb.stats.lost, jb.stats.fec, jb.stats.concealed), (3, 2, 1));
    }

    #[test]
    fn jb_starve_then_reanchor_on_the_new_frame_numbers() {
        let mut jb = JitterBuffer::new(40);
        jb.insert(0, &pk(0)); jb.insert(1, &pk(1));
        assert_eq!(play(&mut jb), "P0");
        assert_eq!(play(&mut jb), "P1");
        assert_eq!(play(&mut jb), "S");
        // the sender kept counting through the outage: it comes back at frame 200
        jb.insert(200, &pk(200));
        assert_eq!(play(&mut jb), "W");
        jb.insert(201, &pk(201));
        assert_eq!(play(&mut jb), "P200");
        assert_eq!(jb.stats.late, 0);
    }

    #[test]
    fn jb_stale_backlog_drops_to_target() {
        let mut jb = JitterBuffer::new(60); // target 3
        for f in 0..20u64 { jb.insert(f, &pk(f)); }
        assert!(jb.depth_frames() <= 3 + JB_STALE_FRAMES);
        assert!(jb.stats.stale_flushes >= 1);
        // what is left plays in order from where the flush put the playout point
        let first = play(&mut jb);
        assert!(first.starts_with('P'));
    }

    #[test]
    fn jb_refuses_a_frame_further_ahead_than_it_holds() {
        let mut jb = JitterBuffer::new(20);
        jb.insert(0, &pk(0));
        jb.insert(JB_SLOTS as u64 + 5, &pk(1));
        assert_eq!(jb.stats.too_far, 1);
    }

    // 4 · the clock estimate
    #[test]
    fn clock_offset_from_the_lowest_rtt_sample() {
        let mut r = Rng(7);
        let mut c = ClockEstimate::default();
        let true_off: i64 = 3_700_000_123; // receiver clock is 3700 s ahead
        let base_owd = 25_000u64;          // 25 ms each way
        let mut t = 1_000_000u64;
        for _ in 0..40 {
            let q1 = (r.unit() * 30_000.0) as u64;   // queueing, 0–30 ms, independent per direction
            let q2 = (r.unit() * 30_000.0) as u64;
            let t1 = t;
            let t2 = (t1 + base_owd + q1) as i64 + true_off;
            let t3 = t2 + 300;
            let t4 = ((t3 - true_off) as u64) + base_owd + q2;
            c.add(t1, t2 as u64, t3 as u64, t4);
            t += 250_000;
        }
        let (rtt, off) = c.best().unwrap();
        let err = off - true_off;
        println!("[link-clock] best rtt {:.1} ms · offset error {:+.2} ms (true one-way 25 ms, queueing 0–30 ms each way)", rtt as f64 / 1000.0, err as f64 / 1000.0);
        assert!(rtt >= 50_000 && rtt < 65_000, "the best sample is close to the queue-free RTT");
        assert!(err.abs() < 6_000, "offset within ±6 ms");
    }

    #[test]
    fn rfc3550_jitter_is_zero_for_a_steady_stream_and_rises_with_spread() {
        let mut j = Jitter::default();
        for i in 0..100u64 { j.add(i * 20_000, i * 20_000 + 30_000); }
        assert!(j.j_us < 1.0);
        let mut r = Rng(3);
        let mut j = Jitter::default();
        for i in 0..2000u64 { j.add(i * 20_000, i * 20_000 + 30_000 + (r.unit() * 20_000.0) as u64); }
        println!("[link-jitter] uniform 0–20 ms spread → RFC 3550 jitter {:.2} ms (theory ≈ 6.7 ms)", j.j_us / 1000.0);
        assert!(j.j_us > 4_000.0 && j.j_us < 9_000.0);
    }

    // 5 · THE SIMULATED NETWORK — injected loss/lateness must equal the counters, exactly.
    //
    // The sender emits one frame every 20 ms. Each frame is dropped with probability `loss` (in bursts of
    // `burst` frames when a loss starts) or delayed by base + uniform(0, spread). The receiver pulls one frame
    // every 20 ms, starting when the buffer primes. Every frame's fate is decided by the simulator, and then the
    // buffer's counters must say the same thing.
    struct Profile { name: &'static str, loss: f64, burst: u64, base_ms: f64, spread_ms: f64, target_ms: u32, seed: u64 }

    fn simulate(p: &Profile) -> (JbStats, u64, u64) {
        const N: u64 = 30_000; // 10 minutes of frames
        let mut r = Rng(p.seed);
        // Each frame's fate, decided here: dropped, or its arrival time.
        let mut arrival: Vec<Option<u64>> = vec![None; N as usize];
        let mut burst_left = 0u64;
        for f in 0..N {
            if burst_left > 0 { burst_left -= 1; continue; }
            if r.unit() < p.loss { burst_left = p.burst - 1; continue; }
            let d = p.base_ms + r.unit() * p.spread_ms;
            arrival[f as usize] = Some(f * FRAME_US + (d * 1000.0) as u64);
        }
        let mut order: Vec<(u64, u64)> = arrival.iter().enumerate().filter_map(|(f, a)| a.map(|t| (t, f as u64))).collect();
        order.sort();
        let mut jb = JitterBuffer::new(p.target_ms);
        // The receiver's playout clock: one turn per 20 ms from the moment it first primes. Arrivals in a
        // millisecond are inserted before that millisecond's turn.
        let mut ai = 0usize;
        let mut first_pull: Option<u64> = None;
        let mut turn: Vec<Option<(u64, u8)>> = vec![None; N as usize]; // (turn time, 1 packet · 2 fec · 3 plc)
        let mut t = 0u64;
        while t < N * FRAME_US + 2_000_000 {
            while ai < order.len() && order[ai].0 <= t { let f = order[ai].1; jb.insert(f, &pk(f)); ai += 1; }
            if jb.primed() && first_pull.is_none() { first_pull = Some(t); }
            if let Some(fp) = first_pull {
                if (t - fp) % FRAME_US == 0 {
                    let f = jb.next_play;
                    let how = match jb.pop() { Playout::Packet(_) => 1, Playout::Fec(_) => 2, Playout::Conceal => 3, _ => 0 };
                    if how != 0 { turn[f as usize] = Some((t, how)); }
                }
            }
            t += 1_000;
        }
        // THE TRUTH, frame by frame: a frame with a turn plays from its own packet iff it arrived by that turn;
        // it is recovered by FEC iff it did not and the NEXT frame had arrived by then; otherwise it is concealed.
        let mut mismatches = 0u64;
        let on_time = |f: u64, t: u64| f < N && matches!(arrival[f as usize], Some(a) if a <= t);
        for f in 0..N {
            if let Some((t, how)) = turn[f as usize] {
                let want = if on_time(f, t) { 1 } else if on_time(f + 1, t) { 2 } else { 3 };
                if want != how { mismatches += 1; }
            }
        }
        let dropped = arrival.iter().filter(|a| a.is_none()).count() as u64;
        (jb.stats, dropped, mismatches)
    }

    #[test]
    fn simulated_networks_counters_match_the_injected_truth() {
        let profiles = [
            Profile { name: "clean LAN",                loss: 0.0,   burst: 1, base_ms: 1.0,  spread_ms: 1.0,   target_ms: 120, seed: 1 },
            Profile { name: "1 % random, 30 ms spread", loss: 0.01,  burst: 1, base_ms: 25.0, spread_ms: 30.0,  target_ms: 120, seed: 2 },
            Profile { name: "5 % in bursts of 3",       loss: 0.017, burst: 3, base_ms: 25.0, spread_ms: 20.0,  target_ms: 120, seed: 3 },
            Profile { name: "spread past the buffer",   loss: 0.0,   burst: 1, base_ms: 25.0, spread_ms: 160.0, target_ms: 120, seed: 4 },
        ];
        for p in &profiles {
            let (s, dropped, mismatches) = simulate(p);
            println!("[link-sim] {:<26} injected drop {:>5} · recv {:>5} lost {:>4} (fec {:>4} plc {:>4}) late {:>4} reord {:>5} dup {} far {} starve {} stale {}/{} · per-frame mismatches {}",
                     p.name, dropped, s.received, s.lost, s.fec, s.concealed, s.late, s.reordered, s.duplicates, s.too_far,
                     s.starved, s.stale_flushes, s.stale_dropped, mismatches);
            assert_eq!(mismatches, 0, "{}: every turn's outcome matches the simulator's truth", p.name);
            assert_eq!(s.fec + s.concealed, s.lost, "{}: fec + plc = lost", p.name);
            // every frame is accounted for exactly once at the door: dropped by the network, or placed, late,
            // duplicate or too far
            assert_eq!(dropped + s.received + s.late + s.duplicates + s.too_far, 30_000, "{}: every frame accounted for", p.name);
            // A clean path loses nothing; its one starve is the end of the stream (the sender stopped).
            if p.spread_ms < 20.0 && p.loss == 0.0 { assert_eq!((s.lost, s.late, s.starved), (0, 0, 1), "{}: a clean path loses nothing", p.name); }
        }
    }

    // 6 · the codec and the resampler (measured, not assumed)
    fn sine(freq: f64, amp: f32, rate: u32, frames: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(frames * 2);
        for n in 0..frames {
            let s = amp * (2.0 * std::f64::consts::PI * freq * n as f64 / rate as f64).sin() as f32;
            v.push(s); v.push(s);
        }
        v
    }
    /// Level (dBFS RMS) and residual (dB below the fitted tone) of one channel of a stereo buffer, from `skip`.
    fn tone_fit(buf: &[f32], rate: u32, freq: f64, skip: usize) -> (f64, f64) {
        let x: Vec<f64> = buf.chunks_exact(2).skip(skip).map(|c| c[0] as f64).collect();
        let (mut sc, mut ss) = (0.0, 0.0);
        for (n, v) in x.iter().enumerate() {
            let w = 2.0 * std::f64::consts::PI * freq * n as f64 / rate as f64;
            sc += v * w.cos(); ss += v * w.sin();
        }
        let (a, b) = (2.0 * sc / x.len() as f64, 2.0 * ss / x.len() as f64);
        let (mut e, mut p) = (0.0, 0.0);
        for (n, v) in x.iter().enumerate() {
            let w = 2.0 * std::f64::consts::PI * freq * n as f64 / rate as f64;
            let fit = a * w.cos() + b * w.sin();
            e += (v - fit) * (v - fit); p += v * v;
        }
        (10.0 * (p / x.len() as f64).log10(), 10.0 * (e / p).log10())
    }

    #[test]
    fn resampler_44k1_to_48k_keeps_level_and_is_clean() {
        let input = sine(1000.0, 0.125, 44_100, 44_100); // −18 dBFS peak → −21.03 dBFS RMS
        let mut rs = Resampler48::new(44_100);
        let mut out = Vec::new();
        let n = rs.process(&input, &mut out);
        let (in_lvl, _) = tone_fit(&input, 44_100, 1000.0, 0);
        let (lvl, resid) = tone_fit(&out, 48_000, 1000.0, 200);
        println!("[link-resample] 44.1→48 kHz: {} → {} frames · level {:.3} dB (in {:.3}) · residual {:.1} dB", input.len() / 2, n, lvl, in_lvl, resid);
        assert!((n as i64 - 48_000).abs() <= 1);
        assert!((lvl - in_lvl).abs() < 0.02);
        assert!(resid < -70.0);
    }

    /// Encode → decode 2 s of a −18 dBFS 1 kHz stereo tone at 128 kb/s, 20 ms frames. Returns
    /// (kb/s, level dB, input level dB, residual dB below the fitted tone, frames coded in hybrid mode).
    fn opus_roundtrip(loss_perc: i32) -> (f64, f64, f64, f64, usize) {
        use opus::{Application, Bitrate, Channels, Decoder, Encoder};
        let mut enc = Encoder::new(LINK_RATE, Channels::Stereo, Application::Audio).unwrap();
        enc.set_bitrate(Bitrate::Bits(DEFAULT_BITRATE as i32)).unwrap();
        enc.set_inband_fec(true).unwrap();
        enc.set_packet_loss_perc(loss_perc).unwrap();
        let mut dec = Decoder::new(LINK_RATE, Channels::Stereo).unwrap();
        let input = sine(1000.0, 0.125, LINK_RATE, LINK_RATE as usize * 2);
        let mut out = Vec::new();
        let mut pkt = [0u8; MAX_OPUS];
        let mut pcm = [0f32; FRAME * CHANNELS];
        let (mut bytes, mut hybrid) = (0usize, 0usize);
        for fr in input.chunks_exact(FRAME * CHANNELS) {
            let n = enc.encode_float(fr, &mut pkt).unwrap();
            bytes += n;
            if (12..16).contains(&(pkt[0] >> 3)) { hybrid += 1; }   // RFC 6716 §3.1 TOC config 12–15 = hybrid
            assert_eq!(dec.decode_float(&pkt[..n], &mut pcm, false).unwrap(), FRAME);
            out.extend_from_slice(&pcm);
        }
        // PLC and FEC decode a full frame and never fail
        assert_eq!(dec.decode_float(&[], &mut pcm, false).unwrap(), FRAME);
        let n = enc.encode_float(&input[..FRAME * CHANNELS], &mut pkt).unwrap();
        assert_eq!(dec.decode_float(&pkt[..n], &mut pcm, true).unwrap(), FRAME);
        let (in_lvl, _) = tone_fit(&input, LINK_RATE, 1000.0, 0);
        let (lvl, resid) = tone_fit(&out, LINK_RATE, 1000.0, 4800);
        (bytes as f64 * 8.0 / 2.0 / 1000.0, lvl, in_lvl, resid, hybrid)
    }

    /// MEASURED (2026-09-28, libopus 1.6.1): in-band FEC only exists in SILK. With FEC on and a loss hint of 0 %
    /// the encoder stays full-band CELT (clean); with any loss hint it moves frames to HYBRID to carry the FEC
    /// copy, and the waveform residual on a tone falls from ≈ −45 dB to ≈ −18 dB. The sender feeds the
    /// receiver's measured loss into the hint, so a clean path stays CELT — and the FEC switch is a visible
    /// setting (docs/remote-link-design-2026-09-28.md, "FEC costs quality").
    #[test]
    fn opus_20ms_stereo_128k_roundtrip_measured() {
        let mut enc = opus::Encoder::new(LINK_RATE, opus::Channels::Stereo, opus::Application::Audio).unwrap();
        let lookahead = enc.get_lookahead().unwrap();
        println!("[link-opus] libopus {} · lookahead {} samples ({:.2} ms)", opus::version(), lookahead, lookahead as f64 / 48.0);
        for loss in [0, 1, 5] {
            let (kbps, lvl, in_lvl, resid, hybrid) = opus_roundtrip(loss);
            println!("[link-opus] FEC on, loss hint {} % · {:.1} kb/s · level {:.3} dB (in {:.3}) · residual {:.1} dB · {} of 100 frames hybrid",
                     loss, kbps, lvl, in_lvl, resid, hybrid);
            assert!((lvl - in_lvl).abs() < 0.2);
            assert!(kbps > 64.0 && kbps < 160.0);
            if loss == 0 { assert_eq!(hybrid, 0); assert!(resid < -40.0, "a clean path is full-band CELT"); }
        }
    }
}
