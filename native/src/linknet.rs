// linknet.rs — THE REMOTE LINK's sockets and threads (docs/remote-link-design-2026-09-28.md).
// The rules live in link.rs (sans-IO, tested offline); this file moves bytes and publishes what it saw.
//
// SENDER (the remote box), one thread per station while SEND TO is on:
//   the callback pushes the clean programme (post-master, PRE-processor — ruling D3) into a tap ring (LinkTap);
//   this thread pops it, resamples 44.1 → 48 kHz, encodes 20 ms Opus frames, seals each with the target
//   station's link key and sends it over UDP. PING every 250 ms; the receiver's PONG carries the clock sample
//   and what it actually received — the sender's status line is built from that, never assumed.
//
// RECEIVER (OV), ONE thread and ONE UDP port per machine, serving every station patched to "Link":
//   packets are demuxed by the station tag, refused silently unless their tag verifies, placed in that station's
//   jitter buffer, and decoded ON DEMAND into the station's stereo live ring — the mic's ring type, read by the
//   mixer through LiveIn — only as fast as the mixer consumes it. The link thread never runs ahead of the mixer:
//   what is buffered is buffered in the jitter buffer, where it is counted.
//
// SENSES: every counter below is published every 250 ms to a per-station board that audio_link_state reads.
// Nothing here runs on the audio thread except LinkTap::push (no allocation, no lock).

use std::collections::HashMap;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::link::*;
use crate::micin::MicShared;

const PROGRAM_RATE: u32 = 44_100;
/// Tap ring: 0.5 s of 44.1 kHz stereo. The sender drains it every ~5 ms.
const TAP_RING: usize = PROGRAM_RATE as usize;
/// The receiver's live ring: 0.25 s of 48 kHz stereo. It is kept near LiveIn's target (≈ 22 ms), never full.
const RX_RING: usize = LINK_RATE as usize / 2;
/// Decoded audio is pushed into the live ring in blocks of this many frames (10 ms): LiveIn's target is sized
/// from the largest block (MicShared::in_block_max), so a smaller block = a shallower ring = less latency.
const PUSH_BLOCK: usize = 480;
const PING_EVERY: Duration = Duration::from_millis(250);
const PUBLISH_EVERY: Duration = Duration::from_millis(250);
/// No packet from the locked sender for this long: the link is LOST (the jitter buffer has long starved).
const LOST_AFTER: Duration = Duration::from_millis(1000);
/// ...and for this long: the sender is released; any sender with the key may take the link.
const RELEASE_AFTER: Duration = Duration::from_secs(5);
/// A sender with no PONG for this long re-resolves the target address.
const RERESOLVE_AFTER: Duration = Duration::from_secs(10);
/// What the packet clocks cannot see, ms: Opus look-ahead (312 samples at 48 kHz, measured in link.rs) and the two
/// resamplers' half-windows (24 samples at 44.1 kHz on the sender, 24 at 48 kHz in LiveIn). The 20 ms of frame
/// accumulation IS seen: a frame's tap time is its FIRST sample, so the one-way figure already includes it.
const CODEC_DELAY_MS: f64 = 312.0 / 48.0 + 24.0 / 44.1 + 24.0 / 48.0;

fn epoch() -> Instant { static E: OnceLock<Instant> = OnceLock::new(); *E.get_or_init(Instant::now) }
/// This process's monotonic clock, µs. Each machine has its own; the link's clock estimate relates them.
pub(crate) fn now_us() -> u64 { epoch().elapsed().as_micros() as u64 }
fn f64_bits(v: f64) -> u64 { v.to_bits() }
fn machine_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Ether".into())
}
fn random_session() -> u64 {
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    u64::from_le_bytes(b) & !(1u64 << 63)
}

// ══ THE TAP (audio thread) ═══════════════════════════════════════════════════════════════════════════════
pub(crate) struct TxShared {
    /// Blocks the tap could not take (the sender thread fell behind by 0.5 s) — dropped whole, counted.
    pub tap_overruns: AtomicU64,
    pub tap_frames: AtomicU64,
}
/// The callback's end of the sender's tap: a ring producer. Installed and removed only by RtCmd::LinkTap.
pub(crate) struct LinkTap { prod: HeapProd<f32>, pub shared: Arc<TxShared> }
impl LinkTap {
    /// One buffer of the programme, interleaved into the ring. Whole buffer or nothing (a partial buffer would
    /// be a discontinuity the receiver cannot see). No allocation, no lock.
    #[inline]
    pub(crate) fn push(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        if self.prod.vacant_len() < n * 2 {
            self.shared.tap_overruns.fetch_add(1, Ordering::Relaxed);
            return;
        }
        for f in 0..n { let _ = self.prod.try_push(l[f]); let _ = self.prod.try_push(r[f]); }
        self.shared.tap_frames.fetch_add(n as u64, Ordering::Relaxed);
    }
}
/// A tap and the consumer the sender thread drains.
pub(crate) fn tap() -> (LinkTap, HeapCons<f32>, Arc<TxShared>) {
    let (p, c) = HeapRb::<f32>::new(TAP_RING * 2).split();
    let sh = Arc::new(TxShared { tap_overruns: AtomicU64::new(0), tap_frames: AtomicU64::new(0) });
    (LinkTap { prod: p, shared: sh.clone() }, c, sh)
}

// ══ BOARDS (what audio_link_state reads) ═════════════════════════════════════════════════════════════════
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RxStatus {
    pub slot: String,
    /// off · listening · buffering · receiving · lost · listen_failed · bad_config
    pub state: String,
    pub reason: String,
    pub port: u16,
    pub transport: String,
    pub sender: String,
    pub sender_addr: String,
    pub jitter_target_ms: u32,
    pub packets: u64,
    pub auth_failures: u64,
    pub last_auth_failure_ago_ms: Option<u64>,
    pub replays: u64,
    pub busy_refusals: u64,
    pub busy_sender: String,
    pub reconnects: u64,
    pub received: u64,
    pub lost: u64,
    pub fec: u64,
    pub concealed: u64,
    pub late: u64,
    pub duplicates: u64,
    pub reordered: u64,
    pub too_far: u64,
    pub starved: u64,
    pub stale_flushes: u64,
    pub stale_dropped: u64,
    pub jitter_ms: f64,
    /// Jitter-buffer depth (frames held × 20 ms) and the total the link holds (jitter buffer + ring + staging).
    pub depth_ms: f64,
    pub buffered_ms: f64,
    pub rtt_ms: Option<f64>,
    /// Network one way, sender tap → arrival here (needs the clock estimate: None until the first PONG round).
    pub one_way_ms: Option<f64>,
    /// Sender programme bus → this station's slot: encoder + one way + buffered + resampler.
    pub latency_ms: Option<f64>,
    pub kbps: f64,
    pub last_packet_ago_ms: Option<u64>,
}
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TxStatus {
    pub target: String,
    pub host: String,
    pub port: u16,
    /// off · resolving · unreachable · sending (no answer yet) · receiving (the receiver answers) · busy
    pub state: String,
    pub reason: String,
    pub transport: String,
    pub bitrate: u32,
    pub fec: bool,
    pub loss_hint: i32,
    pub frames_sent: u64,
    pub bytes_sent: u64,
    pub send_errors: u64,
    pub encode_errors: u64,
    pub tap_overruns: u64,
    pub rtt_ms: Option<f64>,
    pub offset_ms: Option<f64>,
    pub reconnects: u64,
    pub last_pong_ago_ms: Option<u64>,
    pub busy_holder: String,
    // the receiver's own report (from its last PONG)
    pub rx_state: String,
    pub rx_received: u64,
    pub rx_lost: u64,
    pub rx_fec: u64,
    pub rx_concealed: u64,
    pub rx_late: u64,
    pub rx_depth_ms: u32,
    pub rx_jitter_ms: u32,
}

struct Boards { rx: HashMap<u32, Arc<Mutex<RxStatus>>>, tx: HashMap<u32, Arc<Mutex<TxStatus>>>, live: HashMap<u32, Arc<MicShared>> }
fn boards() -> &'static Mutex<Boards> {
    static B: OnceLock<Mutex<Boards>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(Boards { rx: HashMap::new(), tx: HashMap::new(), live: HashMap::new() }))
}
fn rx_board(station_id: u32) -> Arc<Mutex<RxStatus>> {
    let mut b = boards().lock().unwrap_or_else(|e| e.into_inner());
    b.rx.entry(station_id).or_insert_with(|| Arc::new(Mutex::new(RxStatus { state: "off".into(), ..Default::default() }))).clone()
}
fn tx_board(station_id: u32) -> Arc<Mutex<TxStatus>> {
    let mut b = boards().lock().unwrap_or_else(|e| e.into_inner());
    b.tx.entry(station_id).or_insert_with(|| Arc::new(Mutex::new(TxStatus { state: "off".into(), ..Default::default() }))).clone()
}

/// The station's link state as JSON (audio_link_state): the receive side (with its live ring's own counters —
/// fill, drift, underruns: the same numbers a mic reports) and the send side.
pub(crate) fn state_json(station_id: u32) -> serde_json::Value {
    let (rx, tx, live) = {
        let b = boards().lock().unwrap_or_else(|e| e.into_inner());
        (b.rx.get(&station_id).cloned(), b.tx.get(&station_id).cloned(), b.live.get(&station_id).cloned())
    };
    let rx = rx.map(|r| {
        let s = r.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut v = serde_json::to_value(&s).unwrap_or_default();
        if let (Some(o), Some(sh)) = (v.as_object_mut(), live) {
            let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
            let rate = LINK_RATE as f64;
            o.insert("ringMs".into(), (f64::from_bits(ld(&sh.fill_bits)) / rate * 1000.0).into());
            o.insert("ringTargetMs".into(), (f64::from_bits(ld(&sh.target_bits)) / rate * 1000.0).into());
            o.insert("driftPpm".into(), (f64::from_bits(ld(&sh.nudge_bits)) * 1e6).into());
            o.insert("primed".into(), sh.primed.load(Ordering::Relaxed).into());
            o.insert("underruns".into(), ld(&sh.underruns).into());
            o.insert("starvedMs".into(), (ld(&sh.starved_frames) as f64 / PROGRAM_RATE as f64 * 1000.0).into());
        }
        v
    });
    let tx = tx.map(|t| serde_json::to_value(&*t.lock().unwrap_or_else(|e| e.into_inner())).unwrap_or_default());
    serde_json::json!({ "v": 1, "port": LISTEN_PORT.load(Ordering::Relaxed), "rx": rx, "tx": tx })
}

// ══ SENDER ═══════════════════════════════════════════════════════════════════════════════════════════════
#[derive(Clone, Debug)]
pub(crate) struct SendCfg {
    pub target_uuid: String,
    /// "<receiving machine id>|<this machine id>" — the key's pairing (link.rs `LinkKey`).
    pub pairing: String,
    pub key_hex: String,
    pub key_id: u32,
    pub host: String,
    pub port: u16,
    pub bitrate: u32,
    pub fec: bool,
}

/// SEND TO could not start (bad UUID, no key, no thread): the status line says why.
pub(crate) fn refuse_send(station_id: u32, why: &str) {
    *tx_board(station_id).lock().unwrap_or_else(|e| e.into_inner()) = TxStatus { state: "refused".into(), reason: why.into(), ..Default::default() };
}

/// A running sender. Dropping it stops the thread (the thread publishes "off" as it exits).
pub(crate) struct Sender { stop: Arc<AtomicBool> }
impl Drop for Sender { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); } }

pub(crate) fn start_sender(station_id: u32, cfg: SendCfg, cons: HeapCons<f32>, tsh: Arc<TxShared>) -> Result<Sender, String> {
    let tag = station_tag(&cfg.target_uuid).ok_or_else(|| format!("`{}` is not a station UUID", cfg.target_uuid))?;
    let key = LinkKey::from_hex(&cfg.key_hex, cfg.key_id, &cfg.pairing).ok_or("this computer's link key (or the pairing) is missing or malformed")?;
    let board = tx_board(station_id);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    std::thread::Builder::new().name(format!("link-send-{}", station_id)).spawn(move || {
        let mut s = SenderRun::new(station_id, cfg, tag, key, cons, tsh, board.clone());
        s.run(&stop_t);
        let mut b = board.lock().unwrap_or_else(|e| e.into_inner());
        *b = TxStatus { state: "off".into(), ..Default::default() };
        eprintln!("[LINK] Station {} send stopped", station_id);
    }).map_err(|e| format!("could not start the link thread: {}", e))?;
    Ok(Sender { stop })
}

struct SenderRun {
    station_id: u32,
    cfg: SendCfg,
    tag: [u8; 8],
    key: LinkKey,
    cons: HeapCons<f32>,
    tsh: Arc<TxShared>,
    board: Arc<Mutex<TxStatus>>,
    st: TxStatus,
    sock: Option<UdpSocket>,
    dest: Option<SocketAddr>,
    session: u64,
    seq: u32,
    frame_no: u64,
    clock: ClockEstimate,
    last_pong: Option<Instant>,
    last_resolve: Option<Instant>,
    pong_hist: std::collections::VecDeque<(Instant, u64, u64)>,
}

impl SenderRun {
    fn new(station_id: u32, cfg: SendCfg, tag: [u8; 8], key: LinkKey, cons: HeapCons<f32>, tsh: Arc<TxShared>, board: Arc<Mutex<TxStatus>>) -> SenderRun {
        let st = TxStatus {
            target: cfg.target_uuid.clone(), host: cfg.host.clone(), port: cfg.port, state: "resolving".into(),
            transport: "UDP".into(), bitrate: cfg.bitrate, fec: cfg.fec, ..Default::default()
        };
        SenderRun { station_id, cfg, tag, key, cons, tsh, board, st, sock: None, dest: None, session: random_session(), seq: 0,
                    frame_no: 0, clock: ClockEstimate::default(), last_pong: None, last_resolve: None,
                    pong_hist: std::collections::VecDeque::new() }
    }

    fn header(&mut self, kind: Kind) -> Header {
        self.seq = self.seq.wrapping_add(1);
        Header { kind, station: self.tag, key_id: self.key.id, session: self.session, seq: self.seq, flags: 0 }
    }

    fn resolve(&mut self, now: Instant) {
        self.last_resolve = Some(now);
        let target = format!("{}:{}", self.cfg.host, self.cfg.port);
        let addrs: Vec<SocketAddr> = target.to_socket_addrs().map(|it| it.collect()).unwrap_or_default();
        match addrs.iter().find(|a| a.is_ipv4()).or(addrs.first()).copied() {
            Some(a) => {
                if self.dest != Some(a) { eprintln!("[LINK] Station {} sending to {} ({})", self.station_id, target, a); }
                self.dest = Some(a);
                if self.sock.is_none() {
                    match UdpSocket::bind("0.0.0.0:0").and_then(|s| { s.set_nonblocking(true)?; Ok(s) }) {
                        Ok(s) => self.sock = Some(s),
                        Err(e) => { self.st.state = "unreachable".into(); self.st.reason = format!("could not open a UDP socket: {}", e); return; }
                    }
                }
                if self.st.state == "resolving" || self.st.state == "unreachable" {
                    self.st.state = "sending".into();
                    self.st.reason = format!("no answer yet from {}", target);
                }
            }
            None => {
                self.st.state = "unreachable".into();
                self.st.reason = format!("cannot find {} — check the address", self.cfg.host);
            }
        }
    }

    fn send(&mut self, pkt_len: usize, buf: &[u8]) {
        let (Some(sock), Some(dest)) = (self.sock.as_ref(), self.dest) else { return };
        match sock.send_to(&buf[..pkt_len], dest) {
            Ok(n) => self.st.bytes_sent += n as u64,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => self.st.send_errors += 1,
            Err(_) => self.st.send_errors += 1,
        }
    }

    fn run(&mut self, stop: &AtomicBool) {
        use opus::{Application, Bitrate, Channels, Encoder};
        let mut enc = match Encoder::new(LINK_RATE, Channels::Stereo, Application::Audio) {
            Ok(e) => e,
            Err(e) => { self.st.state = "unreachable".into(); self.st.reason = format!("Opus encoder: {}", e); self.publish(); return; }
        };
        let _ = enc.set_bitrate(Bitrate::Bits(self.cfg.bitrate as i32));
        let _ = enc.set_inband_fec(self.cfg.fec);
        let _ = enc.set_packet_loss_perc(0);
        let mut rs = Resampler48::new(PROGRAM_RATE);
        let mut pop = vec![0f32; TAP_RING * 2];
        let mut staging: Vec<f32> = Vec::with_capacity(LINK_RATE as usize);
        let mut opus_buf = [0u8; MAX_OPUS];
        let mut payload = [0u8; MAX_PACKET];
        let mut pkt = [0u8; MAX_PACKET];
        let mut rbuf = [0u8; MAX_PACKET];
        let mut last_ping = Instant::now() - PING_EVERY;
        let mut last_pub = Instant::now();
        let name = machine_name();
        let now = Instant::now();
        self.resolve(now);
        self.publish();
        eprintln!("[LINK] Station {} SEND TO {} → {}:{} · UDP · Opus {} kb/s · FEC {}",
                  self.station_id, self.cfg.target_uuid, self.cfg.host, self.cfg.port, self.cfg.bitrate / 1000, if self.cfg.fec { "on" } else { "off" });
        while !stop.load(Ordering::Relaxed) {
            let now = Instant::now();
            // 1 · the programme: pop, resample, encode every whole 20 ms frame, send
            let n = self.cons.pop_slice(&mut pop);
            let t_pop = now_us();
            if n > 0 { rs.process(&pop[..n - n % 2], &mut staging); }
            let mut consumed = 0usize;
            while staging.len() - consumed >= FRAME * CHANNELS {
                let frame = &staging[consumed..consumed + FRAME * CHANNELS];
                // When this frame's first sample left the programme bus: the newest staged sample left at ≈ t_pop.
                let behind = ((staging.len() - consumed) / CHANNELS) as u64;
                let tap_us = t_pop.saturating_sub(behind * 1_000_000 / LINK_RATE as u64);
                match enc.encode_float(frame, &mut opus_buf) {
                    Ok(len) => {
                        let pl = audio_payload(self.frame_no, tap_us, &opus_buf[..len], &mut payload);
                        let h = self.header(Kind::Audio);
                        if let Some(pn) = self.key.seal(&h, &payload[..pl], &mut pkt) { self.send(pn, &pkt); }
                        self.st.frames_sent += 1;
                    }
                    Err(_) => self.st.encode_errors += 1,
                }
                self.frame_no += 1;
                consumed += FRAME * CHANNELS;
            }
            staging.drain(..consumed);
            // 2 · PING
            if now.duration_since(last_ping) >= PING_EVERY {
                last_ping = now;
                let best = self.clock.best();
                let ping = Ping { t1_us: now_us(), offset_us: best.map(|b| b.1).unwrap_or(0), offset_ok: best.is_some(),
                                  rtt_us: self.clock.last_rtt().unwrap_or(0), bitrate: self.cfg.bitrate, name: name.clone() };
                let pl = ping.write(&mut payload);
                let h = self.header(Kind::Ping);
                if let Some(pn) = self.key.seal(&h, &payload[..pl], &mut pkt) { self.send(pn, &pkt); }
                // no answer for a while: the address may have changed (DDNS, a re-dialled relay)
                let silent = self.last_pong.map_or(true, |t| now.duration_since(t) > RERESOLVE_AFTER);
                if silent && self.last_resolve.map_or(true, |t| now.duration_since(t) > RERESOLVE_AFTER) { self.resolve(now); }
                if let Some(t) = self.last_pong {
                    if now.duration_since(t) > LOST_AFTER * 3 && self.st.state == "receiving" {
                        self.st.state = "sending".into();
                        self.st.reason = "the receiver stopped answering".into();
                        eprintln!("[LINK] Station {} send: the receiver stopped answering", self.station_id);
                    }
                }
            }
            // 3 · PONG / BUSY — and the loop's 5 ms rest is spent polling for them every millisecond, so a reply is
            // time-stamped (NTP t4) within ~1 ms of its arrival, not up to 5 ms late (which skews RTT and offset).
            self.poll_replies(&mut rbuf, &mut enc);
            if now.duration_since(last_pub) >= PUBLISH_EVERY { last_pub = now; self.publish(); }
            let rest_until = now + Duration::from_millis(5);
            while Instant::now() < rest_until {
                if !self.poll_replies(&mut rbuf, &mut enc) { std::thread::sleep(Duration::from_millis(1)); }
            }
        }
    }

    /// Everything waiting on the socket. True if anything arrived.
    fn poll_replies(&mut self, rbuf: &mut [u8; MAX_PACKET], enc: &mut opus::Encoder) -> bool {
        let mut any = false;
        loop {
            let Some(sock) = self.sock.as_ref() else { break };
            let (len, _from) = match sock.recv_from(rbuf) { Ok(x) => x, Err(_) => break };
            let t4 = now_us();
            let now = Instant::now();
            any = true;
            let Some((h, pl)) = self.key.open(&mut rbuf[..len]) else { continue };
            if h.session != self.session || h.station != self.tag { continue; }
            let body = &rbuf[HEADER..HEADER + pl];
            match h.kind {
                Kind::Pong => if let Some(p) = Pong::parse(body) { self.on_pong(p, t4, now, enc); },
                Kind::Busy => {
                    let holder = String::from_utf8_lossy(body).into_owned();
                    if self.st.state != "busy" { eprintln!("[LINK] Station {} send refused: the link is carrying {}", self.station_id, holder); }
                    self.st.state = "busy".into();
                    self.st.reason = format!("the link is already carrying {}", holder);
                    self.st.busy_holder = holder;
                    self.last_pong = Some(now);
                }
                _ => {}
            }
        }
        any
    }

    fn on_pong(&mut self, p: Pong, t4: u64, now: Instant, enc: &mut opus::Encoder) {
        self.clock.add(p.t1_us, p.t2_us, p.t3_us, t4);
        if self.st.state != "receiving" {
            eprintln!("[LINK] Station {} send: the receiver answers", self.station_id);
            if self.last_pong.is_some() { self.st.reconnects += 1; }
        }
        self.last_pong = Some(now);
        self.st.state = "receiving".into();
        self.st.reason.clear();
        self.st.busy_holder.clear();
        self.st.rx_state = match p.state { 0 => "buffering", 1 => "receiving", _ => "starved" }.into();
        self.st.rx_received = p.frames_received;
        self.st.rx_lost = p.frames_lost;
        self.st.rx_fec = p.frames_fec;
        self.st.rx_concealed = p.frames_concealed;
        self.st.rx_late = p.frames_late;
        self.st.rx_depth_ms = p.depth_ms as u32;
        self.st.rx_jitter_ms = p.jitter_ms as u32;
        // The loss hint (only with FEC on): the receiver's measured loss over the last 10 s, rounded UP. A clean
        // path stays 0 % = full-band CELT (link.rs: a hint > 0 moves frames to hybrid to carry the FEC copy).
        self.pong_hist.push_back((now, p.frames_received, p.frames_lost));
        while self.pong_hist.front().map_or(false, |f| now.duration_since(f.0) > Duration::from_secs(10)) { self.pong_hist.pop_front(); }
        if self.cfg.fec {
            if let (Some(a), Some(b)) = (self.pong_hist.front(), self.pong_hist.back()) {
                let (dr, dl) = (b.1.saturating_sub(a.1), b.2.saturating_sub(a.2));
                let hint = if dr + dl == 0 { 0 } else { ((dl as f64 * 100.0 / (dr + dl) as f64).ceil() as i32).min(30) };
                if hint != self.st.loss_hint {
                    let _ = enc.set_packet_loss_perc(hint);
                    self.st.loss_hint = hint;
                }
            }
        }
    }

    fn publish(&mut self) {
        self.st.tap_overruns = self.tsh.tap_overruns.load(Ordering::Relaxed);
        self.st.rtt_ms = self.clock.last_rtt().map(|r| r as f64 / 1000.0);
        self.st.offset_ms = self.clock.best().map(|b| b.1 as f64 / 1000.0);
        self.st.last_pong_ago_ms = self.last_pong.map(|t| t.elapsed().as_millis() as u64);
        *self.board.lock().unwrap_or_else(|e| e.into_inner()) = self.st.clone();
    }
}

// ══ RECEIVER ═════════════════════════════════════════════════════════════════════════════════════════════
#[derive(Clone, Debug)]
pub(crate) struct RxCfg {
    pub uuid: String,
    pub key_hex: String,
    pub key_id: u32,
    pub jitter_ms: u32,
    /// "<this machine id>|<sending machine id>" — the pasted key's pairing (link.rs `LinkKey`).
    pub pairing: String,
}

enum RxReg {
    Add { station_id: u32, slot: String, tag: [u8; 8], key: LinkKey, jitter_ms: u32, prod: HeapProd<f32>, live: Arc<MicShared> },
    Update { station_id: u32, key: LinkKey, jitter_ms: u32 },
    Remove { station_id: u32 },
}

/// The UDP port this machine listens on (D5: 9760 by default, a machine setting shown in Preferences).
static LISTEN_PORT: AtomicU16 = AtomicU16::new(DEFAULT_PORT);
fn listener() -> &'static Mutex<mpsc::Sender<RxReg>> {
    static L: OnceLock<Mutex<mpsc::Sender<RxReg>>> = OnceLock::new();
    L.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<RxReg>();
        let _ = std::thread::Builder::new().name("link-listen".into()).spawn(move || Listener::new(rx).run());
        Mutex::new(tx)
    })
}
fn register(r: RxReg) { let _ = listener().lock().unwrap_or_else(|e| e.into_inner()).send(r); }

/// D5 — the numbers Preferences shows before the operator changes them, and the ranges the engine accepts.
/// ONE source: the UI reads these rather than repeating them.
pub(crate) fn defaults_json() -> serde_json::Value {
    serde_json::json!({
        "bitrate": DEFAULT_BITRATE, "bitrateRange": [BITRATE_RANGE.0, BITRATE_RANGE.1],
        "jitterMs": DEFAULT_JITTER_MS, "jitterRangeMs": [JITTER_RANGE_MS.0, JITTER_RANGE_MS.1],
        "port": DEFAULT_PORT, "frameMs": FRAME_US / 1000, "rate": LINK_RATE, "transport": "UDP",
    })
}

/// Set this machine's listening port (the listener rebinds within one tick). 0 = keep the current one.
pub(crate) fn set_listen_port(port: u16) { if port != 0 { LISTEN_PORT.store(port, Ordering::Relaxed); } }

/// The receive side of one station, on the DISPATCH thread: owns which slot carries the link.
pub(crate) struct LinkInputs { station_id: u32, slot: Option<usize>, cfg: Option<RxCfg> }
impl LinkInputs {
    pub(crate) fn new(station_id: u32) -> LinkInputs { LinkInputs { station_id, slot: None, cfg: None } }
    pub(crate) fn is_live(&self, idx: usize) -> bool { self.slot == Some(idx) }
    pub(crate) fn refused(&self, idx: usize, what: &str) {
        if self.is_live(idx) {
            eprintln!("[LINK] Station {} slot {}: `{}` ignored — this channel carries the Remote Link. Unpatch it to load it.", self.station_id, idx, what);
        }
    }
    /// Patch (Some) or unpatch (None) `idx`. A second patch on another slot moves the link there.
    pub(crate) fn set(&mut self, idx: usize, slot_name: &str, cfg: Option<RxCfg>, out: &mut Vec<crate::micin::MicAction>) {
        let board = rx_board(self.station_id);
        let Some(cfg) = cfg else {
            if self.slot == Some(idx) {
                self.slot = None;
                self.cfg = None;
                out.push(crate::micin::MicAction::Release(idx));
                register(RxReg::Remove { station_id: self.station_id });
                *board.lock().unwrap_or_else(|e| e.into_inner()) = RxStatus { state: "off".into(), ..Default::default() };
                eprintln!("[LINK] Station {} {}: Link unpatched", self.station_id, slot_name);
            }
            return;
        };
        let bad = |why: String| {
            eprintln!("[LINK] Station {} {}: Link NOT patched — {}", self.station_id, slot_name, why);
            *board.lock().unwrap_or_else(|e| e.into_inner()) = RxStatus { slot: slot_name.into(), state: "bad_config".into(), reason: why, ..Default::default() };
        };
        let Some(tag) = station_tag(&cfg.uuid) else { return bad(format!("`{}` is not a station UUID", cfg.uuid)); };
        let Some(key) = LinkKey::from_hex(&cfg.key_hex, cfg.key_id, &cfg.pairing) else { return bad("this fader has no valid link key from the sending computer".into()); };
        let jitter_ms = cfg.jitter_ms.clamp(JITTER_RANGE_MS.0, JITTER_RANGE_MS.1);
        if self.slot == Some(idx) {
            // Same slot: a new key or buffer size only — the ring and the slot's feed stay.
            register(RxReg::Update { station_id: self.station_id, key, jitter_ms });
            self.cfg = Some(cfg);
            return;
        }
        if let Some(old) = self.slot.take() {
            out.push(crate::micin::MicAction::Release(old));
            register(RxReg::Remove { station_id: self.station_id });
        }
        let (prod, cons) = HeapRb::<f32>::new(RX_RING * 2).split();
        let live = Arc::new(MicShared::default());
        live.in_block_max.store(PUSH_BLOCK as u64, Ordering::Relaxed);
        let li = crate::micin::LiveIn::new_link(cons, LINK_RATE, live.clone());
        out.push(crate::micin::MicAction::Install(idx, crate::rt::DeckFeed::live(Box::new(li))));
        boards().lock().unwrap_or_else(|e| e.into_inner()).live.insert(self.station_id, live.clone());
        register(RxReg::Add { station_id: self.station_id, slot: slot_name.into(), tag, key, jitter_ms, prod, live });
        self.slot = Some(idx);
        self.cfg = Some(cfg);
        eprintln!("[LINK] Station {} {}: Link patched · jitter buffer {} ms · listening on UDP {}", self.station_id, slot_name, jitter_ms,
                  LISTEN_PORT.load(Ordering::Relaxed));
    }
}

struct RxStation {
    station_id: u32,
    tag: [u8; 8],
    key: LinkKey,
    prod: HeapProd<f32>,
    live: Arc<MicShared>,
    board: Arc<Mutex<RxStatus>>,
    st: RxStatus,
    jb: JitterBuffer,
    dec: opus::Decoder,
    staging: Vec<f32>,
    staged_from: usize,
    session: Option<u64>,
    replay: ReplayWindow,
    sender_addr: Option<SocketAddr>,
    sender_name: String,
    last_packet: Option<Instant>,
    last_auth_fail: Option<Instant>,
    last_busy_reply: Option<Instant>,
    offset_us: Option<i64>,
    jitter: Jitter,
    one_way: std::collections::VecDeque<f64>,
    bytes_window: std::collections::VecDeque<(Instant, usize)>,
    seq_out: u32,
}

impl RxStation {
    fn reset_session(&mut self, session: u64, addr: SocketAddr, now: Instant) {
        if self.session.is_some() { self.st.reconnects += 1; }
        self.session = Some(session);
        self.replay = ReplayWindow::default();
        self.jb.reset();
        let _ = self.dec.reset_state();
        self.staging.clear();
        self.staged_from = 0;
        self.sender_addr = Some(addr);
        self.offset_us = None;
        self.jitter = Jitter::default();
        self.one_way.clear();
        self.last_packet = Some(now);
        eprintln!("[LINK] Station {}: sender connected from {} (session {:016x})", self.station_id, addr, session);
    }

    fn reply(&mut self, sock: &UdpSocket, kind: Kind, payload: &[u8], to: SocketAddr) {
        let Some(session) = self.session else { return };
        self.seq_out = self.seq_out.wrapping_add(1);
        let h = Header { kind, station: self.tag, key_id: self.key.id, session, seq: self.seq_out, flags: 0 };
        let mut pkt = [0u8; MAX_PACKET];
        if let Some(n) = self.key.seal(&h, payload, &mut pkt) { let _ = sock.send_to(&pkt[..n], to); }
    }

    fn on_packet(&mut self, sock: &UdpSocket, pkt: &mut [u8], from: SocketAddr, now: Instant, t_arr: u64) {
        let Some((h, pl)) = self.key.open(pkt) else {
            // Wrong key, altered or forged: refused SILENTLY (never answered), counted.
            self.st.auth_failures += 1;
            self.last_auth_fail = Some(now);
            return;
        };
        if matches!(h.kind, Kind::Pong | Kind::Busy) { return; }
        match self.session {
            Some(s) if s == h.session => {}
            Some(_) if self.last_packet.map_or(false, |t| now.duration_since(t) < RELEASE_AFTER) => {
                // One sender per link. The second is told, at most once a second, and counted.
                self.st.busy_refusals += 1;
                let name = if h.kind == Kind::Ping { Ping::parse(&pkt[HEADER..HEADER + pl]).map(|p| p.name).unwrap_or_default() } else { String::new() };
                if !name.is_empty() { self.st.busy_sender = name; }
                if self.last_busy_reply.map_or(true, |t| now.duration_since(t) > Duration::from_secs(1)) {
                    self.last_busy_reply = Some(now);
                    // Reply sealed under the REFUSED sender's session, so it can open it.
                    let holder = self.sender_name.clone();
                    let saved = self.session;
                    self.session = Some(h.session);
                    self.reply(sock, Kind::Busy, holder.as_bytes(), from);
                    self.session = saved;
                }
                return;
            }
            _ => self.reset_session(h.session, from, now),
        }
        if !self.replay.check(h.seq) { self.st.replays += 1; return; }
        self.replay.accept(h.seq);
        self.st.packets += 1;
        self.last_packet = Some(now);
        if self.sender_addr != Some(from) { self.sender_addr = Some(from); }   // NAT re-binding: follow the sender
        let body = &pkt[HEADER..HEADER + pl];
        match h.kind {
            Kind::Audio => {
                if let Some((frame_no, tap_us, opus)) = parse_audio(body) {
                    self.jb.insert(frame_no, opus);
                    self.jitter.add(tap_us, t_arr);
                    self.bytes_window.push_back((now, pkt.len()));
                    if let Some(off) = self.offset_us {
                        let ow = (t_arr as i128 - (tap_us as i128 + off as i128)) as f64 / 1000.0;
                        self.one_way.push_back(ow);
                        if self.one_way.len() > 250 { self.one_way.pop_front(); }
                    }
                }
            }
            Kind::Ping => {
                if let Some(p) = Ping::parse(body) {
                    // The sender's estimate of (our clock − its clock): places its tap times on our clock.
                    if p.offset_ok { self.offset_us = Some(p.offset_us); }
                    self.st.rtt_ms = if p.rtt_us > 0 { Some(p.rtt_us as f64 / 1000.0) } else { self.st.rtt_ms };
                    if self.sender_name != p.name { self.sender_name = p.name.clone(); }
                    let s = &self.jb.stats;
                    let pong = Pong {
                        t1_us: p.t1_us, t2_us: t_arr, t3_us: now_us(),
                        frames_received: s.received, frames_lost: s.lost, frames_fec: s.fec, frames_concealed: s.concealed,
                        frames_late: s.late, jitter_ms: (self.jitter.j_us / 1000.0).round().min(u16::MAX as f64) as u16,
                        depth_ms: (self.jb.depth_frames() * 20).min(u16::MAX as u64) as u16,
                        state: if self.jb.primed() { 1 } else if s.starved > 0 && self.jb.depth_frames() == 0 { 2 } else { 0 },
                    };
                    let mut b = [0u8; 128];
                    let n = pong.write(&mut b);
                    self.reply(sock, Kind::Pong, &b[..n], from);
                }
            }
            _ => {}
        }
    }

    /// Top the live ring up to LiveIn's target (one pull + one push block + 2 ms) — decoding frames from the jitter
    /// buffer only on demand. Serviced every ~1 ms, so the ring never needs more headroom than that.
    fn service(&mut self, now: Instant) {
        let target = f64::from_bits(self.live.target_bits.load(Ordering::Relaxed));
        loop {
            let ring = (self.prod.occupied_len() / 2) as f64;
            if ring >= target || target <= 0.0 { break; }
            let avail = (self.staging.len() - self.staged_from) / CHANNELS;
            if avail >= PUSH_BLOCK {
                let a = self.staged_from;
                let b = a + PUSH_BLOCK * CHANNELS;
                if self.prod.vacant_len() < PUSH_BLOCK * CHANNELS { break; }
                self.prod.push_slice(&self.staging[a..b]);
                self.staged_from = b;
                continue;
            }
            // compact, then decode the next frame
            if self.staged_from > 0 { self.staging.drain(..self.staged_from); self.staged_from = 0; }
            let mut pcm = [0f32; FRAME * CHANNELS];
            let got = match self.jb.pop() {
                Playout::Packet(p) => self.dec.decode_float(p, &mut pcm, false),
                Playout::Fec(p) => self.dec.decode_float(p, &mut pcm, true),
                Playout::Conceal => self.dec.decode_float(&[], &mut pcm, false),
                Playout::Waiting | Playout::Starved => break,
            };
            if let Ok(n) = got { self.staging.extend_from_slice(&pcm[..n.min(FRAME) * CHANNELS]); }
        }
        // What the link holds upstream of the ring (for the drift controller), and the total it is to hold.
        let staged = ((self.staging.len() - self.staged_from) / CHANNELS) as f64;
        let upstream = self.jb.depth_frames() as f64 * FRAME as f64 + staged;
        let total_target = self.jb.target_frames() as f64 * FRAME as f64;
        self.live.extra_fill_bits.store(f64_bits(upstream), Ordering::Relaxed);
        self.live.extra_target_bits.store(f64_bits(total_target), Ordering::Relaxed);
        // State
        let prev = self.st.state.clone();
        let since = self.last_packet.map(|t| now.duration_since(t));
        self.st.state = match (self.session, since) {
            (None, _) => "listening",
            (Some(_), Some(d)) if d > RELEASE_AFTER => "listening",
            (Some(_), Some(d)) if d > LOST_AFTER => "lost",
            (Some(_), _) if self.jb.primed() => "receiving",
            _ => "buffering",
        }.into();
        if self.session.is_some() && since.map_or(false, |d| d > RELEASE_AFTER) {
            eprintln!("[LINK] Station {}: sender {} released after {} s of silence", self.station_id, self.sender_name, RELEASE_AFTER.as_secs());
            self.session = None;
            self.jb.reset();
        }
        if prev != self.st.state {
            match self.st.state.as_str() {
                "lost" => eprintln!("[LINK] Station {}: LOST — no packets from {} for {} ms (the channel is silent, NOT FED; the programme continues)",
                                    self.station_id, self.sender_name, LOST_AFTER.as_millis()),
                "receiving" => eprintln!("[LINK] Station {}: receiving {} · buffer {} ms", self.station_id, self.sender_name, self.jb.target_frames() * 20),
                _ => {}
            }
        }
    }

    fn publish(&mut self, now: Instant) {
        let s = self.jb.stats;
        let st = &mut self.st;
        st.transport = "UDP".into();
        st.port = LISTEN_PORT.load(Ordering::Relaxed);
        st.jitter_target_ms = (self.jb.target_frames() * 20) as u32;
        st.sender = self.sender_name.clone();
        st.sender_addr = self.sender_addr.map(|a| a.to_string()).unwrap_or_default();
        st.received = s.received; st.lost = s.lost; st.fec = s.fec; st.concealed = s.concealed; st.late = s.late;
        st.duplicates = s.duplicates; st.reordered = s.reordered; st.too_far = s.too_far; st.starved = s.starved;
        st.stale_flushes = s.stale_flushes; st.stale_dropped = s.stale_dropped;
        st.jitter_ms = self.jitter.j_us / 1000.0;
        st.depth_ms = self.jb.depth_frames() as f64 * 20.0;
        let ring = f64::from_bits(self.live.fill_bits.load(Ordering::Relaxed));
        let staged = ((self.staging.len() - self.staged_from) / CHANNELS) as f64;
        st.buffered_ms = (self.jb.depth_frames() as f64 * FRAME as f64 + staged + ring) / LINK_RATE as f64 * 1000.0;
        st.one_way_ms = if self.one_way.is_empty() { None } else {
            let mut v: Vec<f64> = self.one_way.iter().copied().collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            Some(v[v.len() / 2])
        };
        // Sender programme bus → this slot. A frame that arrives now (its FIRST sample tapped `one way` ago) plays
        // after the frames ahead of it in the jitter buffer (depth − 1), the staged audio and the ring — the newest
        // frame's own 20 ms is already in the one-way figure. The network term is the median of the last 250 frames.
        let ahead = (self.jb.depth_frames().saturating_sub(1)) as f64 * FRAME as f64 + staged + ring;
        st.latency_ms = st.one_way_ms.map(|ow| ow + ahead / LINK_RATE as f64 * 1000.0 + CODEC_DELAY_MS);
        while self.bytes_window.front().map_or(false, |b| now.duration_since(b.0) > Duration::from_secs(2)) { self.bytes_window.pop_front(); }
        st.kbps = self.bytes_window.iter().map(|b| b.1).sum::<usize>() as f64 * 8.0 / 2.0 / 1000.0;
        st.last_packet_ago_ms = self.last_packet.map(|t| now.duration_since(t).as_millis() as u64);
        st.last_auth_failure_ago_ms = self.last_auth_fail.map(|t| now.duration_since(t).as_millis() as u64);
        *self.board.lock().unwrap_or_else(|e| e.into_inner()) = st.clone();
    }
}

struct Listener {
    rx: mpsc::Receiver<RxReg>,
    sock: Option<UdpSocket>,
    bound: u16,
    stations: HashMap<u32, RxStation>,
    last_bind_try: Option<Instant>,
    bind_error: String,
}
impl Listener {
    fn new(rx: mpsc::Receiver<RxReg>) -> Listener {
        Listener { rx, sock: None, bound: 0, stations: HashMap::new(), last_bind_try: None, bind_error: String::new() }
    }
    fn registrations(&mut self) {
        while let Ok(r) = self.rx.try_recv() {
            match r {
                RxReg::Add { station_id, slot, tag, key, jitter_ms, prod, live } => {
                    let dec = match opus::Decoder::new(LINK_RATE, opus::Channels::Stereo) { Ok(d) => d, Err(e) => { eprintln!("[LINK] Opus decoder: {}", e); continue; } };
                    let board = rx_board(station_id);
                    let st = RxStatus { slot, state: "listening".into(), transport: "UDP".into(), jitter_target_ms: jitter_ms, ..Default::default() };
                    self.stations.insert(station_id, RxStation {
                        station_id, tag, key, prod, live, board, st, jb: JitterBuffer::new(jitter_ms), dec,
                        staging: Vec::with_capacity(FRAME * CHANNELS * 4), staged_from: 0, session: None, replay: ReplayWindow::default(),
                        sender_addr: None, sender_name: String::new(), last_packet: None, last_auth_fail: None, last_busy_reply: None,
                        offset_us: None, jitter: Jitter::default(), one_way: std::collections::VecDeque::new(),
                        bytes_window: std::collections::VecDeque::new(), seq_out: 0,
                    });
                }
                RxReg::Update { station_id, key, jitter_ms } => {
                    if let Some(s) = self.stations.get_mut(&station_id) { s.key = key; s.jb.set_target_ms(jitter_ms); }
                }
                RxReg::Remove { station_id } => {
                    if let Some(s) = self.stations.remove(&station_id) {
                        s.live.extra_fill_bits.store(0, Ordering::Relaxed);
                        s.live.extra_target_bits.store(0, Ordering::Relaxed);
                    }
                    boards().lock().unwrap_or_else(|e| e.into_inner()).live.remove(&station_id);
                }
            }
        }
    }
    fn bind(&mut self, now: Instant) {
        let want = LISTEN_PORT.load(Ordering::Relaxed);
        if self.sock.is_some() && self.bound == want { return; }
        if self.stations.is_empty() { self.sock = None; self.bound = 0; return; }   // nothing patched: no open port
        if self.last_bind_try.map_or(false, |t| now.duration_since(t) < Duration::from_secs(2)) && self.bound != want && self.sock.is_none() { return; }
        self.last_bind_try = Some(now);
        match UdpSocket::bind(("0.0.0.0", want)).and_then(|s| { s.set_nonblocking(true)?; Ok(s) }) {
            Ok(s) => {
                eprintln!("[LINK] listening on UDP {}", want);
                self.sock = Some(s); self.bound = want; self.bind_error.clear();
            }
            Err(e) => {
                let why = format!("cannot listen on UDP {}: {} (another program is using the port, or it is blocked)", want, e);
                if self.bind_error != why { eprintln!("[LINK] {}", why); }
                self.bind_error = why;
                self.sock = None; self.bound = 0;
            }
        }
    }
    fn run(mut self) {
        let mut buf = [0u8; 2048];
        let mut last_pub = Instant::now();
        loop {
            let now = Instant::now();
            self.registrations();
            self.bind(now);
            match self.sock.as_ref() {
                Some(sock) => {
                    // everything queued on the socket, then service and a 1 ms rest
                    loop {
                        let Ok((len, from)) = sock.recv_from(&mut buf) else { break };
                        let t_arr = now_us();
                        let now = Instant::now();
                        let Some(h) = Header::peek(&buf[..len]) else { continue };
                        if let Some(st) = self.stations.values_mut().find(|s| s.tag == h.station) {
                            st.on_packet(sock, &mut buf[..len], from, now, t_arr);
                        }
                    }
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
            if self.sock.is_some() { std::thread::sleep(Duration::from_millis(1)); }
            let now = Instant::now();
            for st in self.stations.values_mut() {
                st.service(now);
                if !self.bind_error.is_empty() { st.st.state = "listen_failed".into(); st.st.reason = self.bind_error.clone(); }
                else if st.st.state == "listen_failed" { st.st.reason.clear(); }
            }
            if now.duration_since(last_pub) >= PUBLISH_EVERY {
                last_pub = now;
                for st in self.stations.values_mut() { st.publish(now); }
            }
        }
    }
}

// ── tests: the real sockets and threads, on loopback ────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// END TO END on one machine: a tap fed at real time → the sender thread → UDP 127.0.0.1 → the listener →
    /// jitter buffer → Opus → the live ring → LiveIn pulled at real time, as the mixer does. Measures, on AUDIO,
    /// how long a click takes from the tap to the slot, and checks the level and the counters.
    #[test]
    #[ignore] // real time (≈ 6 s) and a real UDP port: `cargo test --release --lib linknet -- --ignored --nocapture`
    fn loopback_end_to_end_on_audio() {
        let port = 39_760u16;
        set_listen_port(port);
        let uuid = "11111111-2222-4333-8444-555555555555";
        let pairing = "8e8f6181-b68a-433f-a93d-8005787b641b|041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e";
        let key = LinkKey::mint_hex().unwrap();
        // receiver on station 9001, slot S1
        let mut links = LinkInputs::new(9001);
        let mut acts = Vec::new();
        links.set(7, "S1", Some(RxCfg { uuid: uuid.into(), key_hex: key.clone(), key_id: 1, jitter_ms: 120, pairing: pairing.into() }), &mut acts);
        let mut feed = match acts.pop() { Some(crate::micin::MicAction::Install(_, f)) => f, _ => panic!("no feed installed") };
        // sender on station 9002
        let (mut tap, cons, tsh) = tap();
        let _sender = start_sender(9002, SendCfg { target_uuid: uuid.into(), pairing: pairing.into(), key_hex: key, key_id: 1, host: "127.0.0.1".into(),
                                                  port, bitrate: DEFAULT_BITRATE, fec: true }, cons, tsh).unwrap();
        // run 6 s at real time in 10 ms buffers: tap in, slot out. A click at 3.000 s (sample-accurate at the tap).
        let block = 441usize;
        let (mut l, mut r) = (vec![0f32; block], vec![0f32; block]);
        let mut out = vec![0f32; block * 2];
        let li = feed.live.as_mut().unwrap();
        let t0 = Instant::now();
        let click_at = 3 * 44_100usize;
        let mut click_out: Option<usize> = None;
        let mut tone_sum = 0f64; let mut tone_n = 0usize;
        for b in 0..600usize {
            // pace to real time
            let due = t0 + Duration::from_micros(b as u64 * 10_000);
            while Instant::now() < due { std::thread::sleep(Duration::from_micros(200)); }
            for f in 0..block {
                let n = b * block + f;
                // a −18 dBFS 1 kHz tone, silenced 2.9–3.2 s with a single full-scale click at exactly 3.0 s
                let t = n as f64 / 44_100.0;
                let v = if (2.9..3.2).contains(&t) { if n == 3 * 44_100 { 1.0 } else { 0.0 } } else { 0.125 * (2.0 * std::f64::consts::PI * 1000.0 * t).sin() as f32 as f64 };
                l[f] = v as f32; r[f] = v as f32;
            }
            tap.push(&l, &r);
            li.pull(&mut out, block);
            // Tap and slot run on this one real-time loop: sample k is pushed and sample k is pulled in the same
            // turn, so (index out − index in) IS the delay through the link, measured on the audio.
            for f in 0..block {
                let k = b * block + f;
                if click_out.is_none() && k > click_at && out[2 * f].abs() > 0.2 { click_out = Some(k); }
                if b > 450 { tone_sum += (out[2 * f] as f64).powi(2); tone_n += 1; }
            }
        }
        let st = state_json(9001);
        let tx = state_json(9002);
        let lat = click_out.map(|o| (o - click_at) as f64 / 44.1);
        let lvl = 10.0 * (tone_sum / tone_n as f64).log10();
        println!("[link-e2e] click tap→slot on AUDIO: {:?} ms · tone level {:.2} dBFS RMS (sent −21.07)", lat, lvl);
        println!("[link-e2e] rx: {}", st["rx"]);
        println!("[link-e2e] tx: {}", tx["tx"]);
        assert!(lat.is_some(), "the click came through");
        // THE SENSE AGREES WITH THE AUDIO: the latency the strip shows vs the click measured on the samples.
        let shown = st["rx"]["latencyMs"].as_f64().expect("latency shown");
        println!("[link-e2e] latency shown {:.1} ms vs measured on audio {:.1} ms (Δ {:+.1} ms)", shown, lat.unwrap(), shown - lat.unwrap());
        assert!((shown - lat.unwrap()).abs() < 15.0, "the displayed latency disagrees with the audio by more than 15 ms");
        assert!((lvl + 21.07).abs() < 0.5, "level through the link");
        assert_eq!(st["rx"]["state"], "receiving");
        assert_eq!(st["rx"]["lost"], 0);
        assert_eq!(st["rx"]["authFailures"], 0);
        assert_eq!(tx["tx"]["state"], "receiving");
    }
}
