// outwatch.rs — OUTPUT-CALLBACK LIVENESS, on the dispatch thread (URGENT: OV dead air on 4.6.51, onboard Realtek).
//
// What happened on OV, twice after a restart: the cpal output callback STOPPED BEING CALLED (frames +0, cpal-stale
// 19.5 min, drain total 0). The stream object was still alive, so nothing in Rust noticed; the dispatch thread kept
// re-publishing the last meter frame, so the level meter re-reported the last value and main's wedge detector read
// "fresh levels" and suppressed. Dead air with every sense green.
//
// THE RULE NOW: the dispatch thread watches this station's callback counter (cb_seq, bumped once per callback). A
// stream that is OPEN and has not been called for STALL_AFTER is a STALL: logged with the time and the device,
// counted, and the stream is REOPENED through the existing device-switch path (same device, decks restored). cpal's
// error callback is the same event, sooner. If the chosen device stalls (or fails to open) FALLBACK_AFTER times in
// a row, the next open goes to the SYSTEM DEFAULT — and says so — rather than leaving the station silent.
//
// Pure: no cpal, no clock of its own (the caller passes `now`), so a fake stream can drive it in a test.
use std::time::{Duration, Instant};

/// A stream open this long with no callback is stalled. A WASAPI shared-mode period is ~10 ms: 1 s is ~100 missed
/// periods, far past any scheduling hiccup, and far short of the 19.5 minutes OV sat silent.
pub(crate) const STALL_AFTER: Duration = Duration::from_millis(1000);
/// Callbacks flowing this long after an open = the device is healthy again (the run of consecutive stalls resets).
pub(crate) const HEALTHY_AFTER: Duration = Duration::from_secs(5);
/// Consecutive stalls / failed opens on the CHOSEN device before the next open tries the system default.
pub(crate) const FALLBACK_AFTER: u32 = 2;
/// From this many consecutive failures on, wait BACKOFF between attempts (no tight reopen loop on a dead card).
pub(crate) const BACKOFF_AFTER: u32 = 4;
pub(crate) const BACKOFF: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Stall {
    /// The callback counter did not move for this long while the stream was open.
    NoCallbacks { ms: u64 },
    /// cpal reported an error on the stream.
    DeviceError(String),
}

pub(crate) struct StallWatch {
    stall_after: Duration,
    healthy_after: Duration,
    open: bool,
    opened_at: Instant,
    last_seq: u64,
    last_change: Instant,
    /// Stalls + failed opens in a row, on whatever was opened. Reset once callbacks flow for `healthy_after`.
    pub consecutive: u32,
}

impl StallWatch {
    pub(crate) fn new(now: Instant) -> StallWatch { StallWatch::with(now, STALL_AFTER, HEALTHY_AFTER) }
    pub(crate) fn with(now: Instant, stall_after: Duration, healthy_after: Duration) -> StallWatch {
        StallWatch { stall_after, healthy_after, open: false, opened_at: now, last_seq: 0, last_change: now, consecutive: 0 }
    }
    /// A stream just started playing. `seq` = the callback counter now (it does not reset across opens).
    pub(crate) fn stream_opened(&mut self, now: Instant, seq: u64) {
        self.open = true;
        self.opened_at = now;
        self.last_seq = seq;
        self.last_change = now;
    }
    /// The stream is gone (dropped for a switch/reopen, or it failed to open).
    pub(crate) fn stream_closed(&mut self) { self.open = false; }
    /// An open or a play() failed.
    pub(crate) fn open_failed(&mut self) { self.open = false; self.consecutive = self.consecutive.saturating_add(1); }
    /// Every dispatch tick. Returns the stall, once, when there is one (the caller then drops the stream).
    pub(crate) fn observe(&mut self, now: Instant, seq: u64, device_error: Option<String>) -> Option<Stall> {
        if !self.open { return None; }
        if let Some(e) = device_error {
            self.open = false;
            self.consecutive = self.consecutive.saturating_add(1);
            return Some(Stall::DeviceError(e));
        }
        if seq != self.last_seq {
            self.last_seq = seq;
            self.last_change = now;
            if self.consecutive > 0 && now.duration_since(self.opened_at) >= self.healthy_after { self.consecutive = 0; }
            return None;
        }
        let quiet = now.duration_since(self.last_change);
        if quiet > self.stall_after {
            self.open = false;
            self.consecutive = self.consecutive.saturating_add(1);
            return Some(Stall::NoCallbacks { ms: quiet.as_millis() as u64 });
        }
        None
    }
    /// Should the next open go to the system default instead of the chosen device?
    pub(crate) fn use_default_next(&self) -> bool { self.consecutive >= FALLBACK_AFTER }
    /// How long to wait before the next attempt (zero until the failures pile up).
    pub(crate) fn backoff(&self) -> Duration { if self.consecutive >= BACKOFF_AFTER { BACKOFF } else { Duration::ZERO } }
}

/// Wall-clock time as ISO-8601 UTC with milliseconds — for the [RUST] stall lines (the dispatch thread, never audio).
pub(crate) fn iso_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    iso_utc(ms)
}
pub(crate) fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (H. Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, sod / 3600, sod % 3600 / 60, sod % 60, ms.rem_euclid(1000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn iso_utc_is_right() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_790_640_207_793), "2026-09-29T00:03:27.793Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    /// A FAKE OUTPUT STREAM: a thread that "calls back" every 10 ms (bumping the station's counter, as
    /// mixer_callback's closure does) until it is told to stop — or, for a dead card, never calls at all.
    struct FakeStream { stop: Arc<AtomicBool>, t: Option<std::thread::JoinHandle<()>> }
    impl FakeStream {
        fn open(seq: Arc<AtomicU64>, calls: bool, die_after: Option<Duration>) -> FakeStream {
            let stop = Arc::new(AtomicBool::new(false));
            let s = stop.clone();
            let t = std::thread::spawn(move || {
                let t0 = Instant::now();
                while !s.load(Ordering::Relaxed) {
                    let dead = die_after.map_or(false, |d| t0.elapsed() > d);
                    if calls && !dead { seq.fetch_add(1, Ordering::Relaxed); }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
            FakeStream { stop, t: Some(t) }
        }
    }
    impl Drop for FakeStream { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); if let Some(t) = self.t.take() { let _ = t.join(); } } }

    /// The dispatch loop in miniature, around a fake stream: the same calls in the same order as audio.rs.
    /// `devices` = how each open behaves, by device ("chosen" / "default"): (calls at all, dies after).
    fn run(seconds: f64, behave: impl Fn(&str, usize) -> (bool, Option<Duration>), err_at: Option<Duration>)
        -> (Vec<String>, u64, Vec<String>, u64) {
        let seq = Arc::new(AtomicU64::new(0));
        let err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let t0 = Instant::now();
        let mut w = StallWatch::with(t0, Duration::from_millis(300), Duration::from_millis(800));
        let (mut log, mut opens, mut stalls) = (Vec::new(), Vec::new(), 0u64);
        let mut stream: Option<FakeStream> = None;
        let mut err_fired = false;
        while t0.elapsed().as_secs_f64() < seconds {
            if stream.is_none() {
                let dev = if w.use_default_next() { "default" } else { "chosen" };
                if dev == "default" { log.push(format!("{} falling back to the system default after {} stalls", iso_now(), w.consecutive)); }
                let n = opens.iter().filter(|d| *d == dev).count();
                let (calls, die) = behave(dev, n);
                opens.push(dev.to_string());
                stream = Some(FakeStream::open(seq.clone(), calls, die));
                w.stream_opened(Instant::now(), seq.load(Ordering::Relaxed));
            }
            std::thread::sleep(Duration::from_millis(50));
            if !err_fired && err_at.map_or(false, |a| t0.elapsed() > a) { err_fired = true; *err.lock().unwrap() = Some("The device has been invalidated.".into()); }
            let e = err.lock().unwrap().take();
            if let Some(why) = w.observe(Instant::now(), seq.load(Ordering::Relaxed), e) {
                stalls += 1;
                log.push(format!("{} Station 9 output STALL on '{}': {:?} — reopening", iso_now(), opens.last().unwrap(), why));
                stream = None;   // drop → 'outer reopens
                w.stream_closed();
            }
        }
        let before = seq.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(200));
        let resumed = seq.load(Ordering::Relaxed) - before;
        drop(stream);
        (log, stalls, opens, resumed)
    }

    #[test]
    fn a_callback_that_stops_is_a_stall_the_stream_is_reopened_and_audio_resumes() {
        // The chosen device's FIRST stream dies after 0.6 s (OV's symptom); the reopened one is fine.
        let (log, stalls, opens, resumed) = run(3.0, |dev, n| (true, if dev == "chosen" && n == 0 { Some(Duration::from_millis(600)) } else { None }), None);
        for l in &log { println!("[outwatch] {}", l); }
        println!("[outwatch] opens {:?} · stalls {} · callbacks in the last 200 ms {}", opens, stalls, resumed);
        assert_eq!(stalls, 1, "one stall, counted once");
        assert!(log[0].contains("STALL on 'chosen'") && log[0].contains("NoCallbacks"), "logged with the device and the kind");
        assert!(log[0].starts_with("20"), "logged with the time");
        assert_eq!(opens, ["chosen", "chosen"], "reopened on the SAME device");
        assert!(resumed >= 10, "audio resumed: {} callbacks in 200 ms", resumed);
    }

    #[test]
    fn a_card_that_never_comes_back_falls_back_to_the_system_default_and_says_so() {
        // The chosen device dies, and every reopen of it is silent; the default works.
        let (log, stalls, opens, resumed) = run(4.0, |dev, n| if dev == "chosen" { (n == 0, Some(Duration::from_millis(400))) } else { (true, None) }, None);
        for l in &log { println!("[outwatch] {}", l); }
        println!("[outwatch] opens {:?} · stalls {} · resumed {}", opens, stalls, resumed);
        assert_eq!(&opens[..3], ["chosen", "chosen", "default"], "two stalls on the chosen card, then the default");
        assert!(log.iter().any(|l| l.contains("falling back to the system default")), "the fallback is SAID");
        assert!(resumed >= 10, "audio resumed on the default");
        assert_eq!(stalls, 2);
    }

    #[test]
    fn a_cpal_error_is_a_stall_the_same_reopen_path() {
        let (log, stalls, opens, resumed) = run(2.0, |_, _| (true, None), Some(Duration::from_millis(500)));
        for l in &log { println!("[outwatch] {}", l); }
        assert_eq!(stalls, 1);
        assert!(log[0].contains("DeviceError(\"The device has been invalidated.\")"));
        assert_eq!(opens, ["chosen", "chosen"]);
        assert!(resumed >= 10);
    }

    #[test]
    fn a_healthy_stream_is_never_a_stall_and_a_closed_one_is_never_judged() {
        let t0 = Instant::now();
        let mut w = StallWatch::new(t0);
        assert_eq!(w.observe(t0 + Duration::from_secs(60), 0, None), None, "no stream open → nothing to judge");
        w.stream_opened(t0, 5);
        for i in 1..=600u64 { assert_eq!(w.observe(t0 + Duration::from_millis(i * 50), 5 + i, None), None); }
        w.stream_closed();
        assert_eq!(w.observe(t0 + Duration::from_secs(120), 0, None), None);
    }

    #[test]
    fn backoff_starts_after_repeated_failures() {
        let mut w = StallWatch::new(Instant::now());
        for _ in 0..3 { w.open_failed(); }
        assert_eq!(w.backoff(), Duration::ZERO);
        assert!(w.use_default_next());
        w.open_failed();
        assert_eq!(w.backoff(), BACKOFF);
    }
}
