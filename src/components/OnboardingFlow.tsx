import { useState, useEffect } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { setPlanGlobally, usePlan } from "../hooks/usePlan";
import type { PlanTier } from "../hooks/usePlan";
import type { VenueProfile, VenueType } from "./FirstRunWizard";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";

// Replaces FirstRunWizard at the first_run_complete gate in App.tsx.
// Implements the four screens of docs/onboarding-spec-v1.md with the
// three FirstRunWizard fields (venue_type, experience_mode, station_name +
// station_tagline) bolted on between Screen 3/3b and Screen 4 so the
// downstream readers in OnShiftScreen / SettingsPanel / App.tsx persona
// labels keep working.

type OnboardingState =
  | 'auth'               // Screen 0 — account sign in / sign up (email + password, required)
  | 'welcome'            // Screen 1 — path picker (legacy license-key path; bypassed)
  | 'create'             // Screen 2a — POST /account/create
  | 'connect'            // Screen 2b — POST /account/connect
  | 'pickStation'        // Screen 3  — list from /account/connect
  | 'cloudSync'          // Sign-in on a fresh machine — pull account stations from the cloud
  | 'addStation'         // Screen 3b — POST /account/add-station
  | 'experienceMode'     // bolted, restyled FirstRunWizard step 0
  | 'venueType'          // bolted, restyled FirstRunWizard step 1
  | 'nameStation'        // bolted, restyled FirstRunWizard step 2 (name + tagline)
  | 'pickAudioLocation'  // Screen 3.5 — Milestone B only; skipped in Milestone A
  | 'pulling'            // Screen 4 — initial library sync
  | 'done';              // calls onComplete(); App.tsx routes to main UI

interface Props {
  onComplete: (profile: VenueProfile) => void;
}

// Shape of each station returned by /account/connect. Used by Screen 3
// to render the picker. Per docs/onboarding-spec-v1.md the stations table
// carries id/uuid/name plus optional nickname/frequency/call_letters.
export interface OnboardingStation {
  id:            number;
  uuid:          string;
  name:          string;
  nickname?:     string | null;
  frequency?:    string | null;
  call_letters?: string | null;
}

// ── Bolted-screen option data ──────────────────────────────────────────
// experience_mode is read by OnShiftScreen + SettingsPanel; venue_type is
// read by App.tsx persona labels (~line 1954). The `id` values are the
// canonical KV values those readers expect — do not change them. Taglines
// and descriptions are local to OnboardingFlow's card UI (not shared with
// FirstRunWizard's data shape, which carries 9 extra fields per venue
// that don't display on the new cards).

const EXPERIENCE_OPTIONS = [
  { id: 'solo',       label: 'Solo',       tagline: 'One deck · Simple play/pause',     description: 'Single deck, no crossfades. Best for podcasters and first-time users.' },
  { id: 'standard',   label: 'Standard',   tagline: 'Two decks · Crossfades included',  description: 'Decks A and B always visible. Smooth crossfades between them. For independent broadcasters.' },
  { id: 'live_radio', label: 'Live Radio', tagline: 'All six decks · Full automation',  description: 'All six decks unlocked. Format clock scheduling, hard transitions, full rotation engine.' },
] as const;

const VENUE_OPTIONS = [
  { id: 'radio',   label: 'Radio Station',      tagline: 'AM · FM · Internet · Podcast · College Radio' },
  { id: 'venue',   label: 'Venue / Attraction', tagline: 'Bars · Clubs · Theme Parks · Arenas · Events' },
  { id: 'retail',  label: 'Retail / Business',  tagline: 'Stores · Restaurants · Hotels · Gyms · Offices' },
  { id: 'worship', label: 'House of Worship',   tagline: 'Churches · Mosques · Synagogues · Temples' },
  { id: 'podcast', label: 'Podcast / YouTube',  tagline: 'Podcasts · YouTube · Livestreams · Video Shows' },
] as const;

// ── Shared visual constants ────────────────────────────────────────────
// Pulled from FirstRunWizard so the whole onboarding feels like one product.
// Extracted as module-level consts so each screen body stays readable as the
// flow grows across commits.

const OVERLAY_STYLE: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 9998,
  background: "#080810",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: "'Inter', system-ui, sans-serif",
  padding: 24,
};

const SHELL_STYLE: React.CSSProperties = {
  width: "100%", maxWidth: 640, position: "relative",
};

const GLOW_STYLE: React.CSSProperties = {
  position: "absolute", width: 700, height: 700, borderRadius: "50%",
  background: "radial-gradient(circle, rgb(from var(--accent-cyan) r g b / 0.05) 0%, transparent 70%)",
  pointerEvents: "none",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: "0.2em",
  color: "var(--accent-cyan)", textTransform: "uppercase",
  marginBottom: 12,
};

const HEADING_STYLE: React.CSSProperties = {
  fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800,
  letterSpacing: "-0.04em", color: "#f0f0f8", lineHeight: 1.1, marginBottom: 12,
};

const SUB_STYLE: React.CSSProperties = {
  fontSize: 14, color: "rgba(255,255,255,0.4)", lineHeight: 1.6,
};

const CARD_STYLE: React.CSSProperties = {
  padding: "22px 24px", borderRadius: 0, textAlign: "left",
  background: "rgba(255,255,255,0.03)",
  border: "1.5px solid rgba(255,255,255,0.08)",
  cursor: "pointer", transition: "all 0.2s",
  display: "flex", alignItems: "center", gap: 16,
  color: "#f0f0f8",
};

const ANIMATION_CSS = `
  @keyframes onb-in {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

export default function OnboardingFlow({ onComplete }: Props) {
  const [state, setState] = useState<OnboardingState>('auth');
  const { stationId } = useActiveStation();

  // Banner shown on the welcome screen after /account/create returns
  // account_already_exists — directs the user to the Connect path.
  const [welcomeBanner, setWelcomeBanner] = useState<string | null>(null);

  // ── Form state (shared across Screens 2a/2b/3/3b) ────────────
  const [licenseKey,  setLicenseKey]  = useState('');
  const [accountName, setAccountName] = useState('');
  const [stnName,     setStnName]     = useState('');
  const [nickname,    setNickname]    = useState('');
  const [frequency,   setFrequency]   = useState('');
  const [callLetters, setCallLetters] = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [formError,   setFormError]   = useState<string | null>(null);

  // ── Screen 2b → 3 carryover ──────────────────────────────────
  // /account/connect returns the account name + stations list; both are
  // displayed on Screen 3 ("Welcome back, <account_name>" + radio list).
  const [connectAccountName, setConnectAccountName] = useState('');
  const [connectStations,    setConnectStations]    = useState<OnboardingStation[]>([]);

  // ── Screen 3 selection ───────────────────────────────────────
  // Either a station uuid from connectStations, or the 'ADD_NEW' sentinel
  // for the "Add a new station" card. null = nothing picked yet.
  const [selection, setSelection] = useState<string | null>(null);

  // ── Bolted-screen state ──────────────────────────────────────
  const [chosenExperience, setChosenExperience] = useState<string | null>(null);
  const [chosenVenue,      setChosenVenue]      = useState<string | null>(null);
  const [displayTagline,   setDisplayTagline]   = useState('');

  // ── Cloud-sync step (sign-in on a fresh machine) ─────────────
  // Returning user on a new computer: offer to pull the account's stations
  // (profiles, color theme, shows, calendar, rotation schedules) from the
  // cloud DB backup before forcing a new profile. syncSel = the uuids the
  // operator chose to keep visible; phase drives the install/progress UI.
  const [syncSel,   setSyncSel]   = useState<Set<string>>(new Set());
  const [syncPhase, setSyncPhase] = useState<'choose' | 'installing' | 'error'>('choose');
  const [syncMsg,   setSyncMsg]   = useState('');

  // ── Resumption ───────────────────────────────────────────────
  // True until the on-mount KV read completes. Renders an empty dark
  // overlay (no content) during the few ms it takes to read flags —
  // avoids a flash of the welcome screen before snapping to the
  // resumed state.
  const [resumeChecking, setResumeChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        if (cancelled) return;
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const get = (k: string) => rows.find(r => r.key === k)?.value;

        // Pre-populate any fields that already live in KV. Bolted screens
        // read these from component state, so this ensures their forms
        // render with the user's prior input.
        const lkSaved = get('license_key');
        if (lkSaved) setLicenseKey(lkSaved);
        const snSaved = get('station_name');
        if (snSaved) setStnName(snSaved);
        const tgSaved = get('station_tagline');
        if (tgSaved) setDisplayTagline(tgSaved);
        const expSaved = get('experience_mode');
        if (expSaved) setChosenExperience(expSaved);
        const venSaved = get('venue_type');
        if (venSaved) setChosenVenue(venSaved);

        // ── 1. Library pulled OR first-run already done → done ──
        // BUT only if an account was actually signed in. A carried-over / invite / cloud-restored
        // install can have first_run_complete=1 with nobody ever signed in — that must still show
        // the (required-for-all) sign-in screen, not jump past it to the profile login.
        const accountJoined = get('onboarding_account_joined') === '1';
        if (accountJoined && (get('first_run_complete') === '1' || get('onboarding_library_pulled') === '1')) {
          setState('done');
          setResumeChecking(false);
          return;
        }
        if (!accountJoined) {
          setState('auth');
          setResumeChecking(false);
          return;
        }

        // ── 2. Account joined → land on first unfinished step ──
        // Order: bolted screens → pickAudioLocation → pulling. The audio-source
        // check (B.3) sits between bolted screens and pulling; a customer who
        // crashed before clicking a Screen 3.5 button lands back there. Once
        // the source choice is recorded ('skip' | 'computer' | 'cloud') we
        // trust it and advance to pulling, regardless of whether the action
        // actually completed — see OB9 for the picker-cancel orphan edge.
        if (get('onboarding_account_joined') === '1') {
          if      (!expSaved)                                setState('experienceMode');
          else if (!venSaved)                                setState('venueType');
          else if (!snSaved)                                 setState('nameStation');
          else if (!get('onboarding_library_source'))        setState('pickAudioLocation');
          else if (get('onboarding_library_source') === 'cloud') setState('pulling');
          else                                               setState('done');
          setResumeChecking(false);
          return;
        }

        // ── 3. Connect path mid-pickStation → re-fetch /account/connect ──
        if (get('onboarding_license_entered') === '1' && get('onboarding_path') === 'connect') {
          if (!lkSaved) {
            setState('auth');
            setResumeChecking(false);
            return;
          }
          try {
            const idResp = await (window as any).ether.identity.get();
            if (!idResp?.ok) throw new Error(idResp?.error || 'identity.get() failed');
            const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                license_key:  lkSaved,
                machine_id:   idResp.machine_id,
                machine_name: idResp.machine_name,
              }),
            });
            const data = await res.json().catch(() => ({}));
            if (!cancelled && Array.isArray(data.stations)) {
              setConnectAccountName(data.account_name || '');
              setConnectStations(data.stations as OnboardingStation[]);
              setState('pickStation');
            } else if (!cancelled) {
              // Re-fetch failed (seat_limit_reached, invalid_license_key, network) —
              // fall back to welcome. User retries manually.
              console.warn('[onboarding] resume /account/connect returned no stations; falling back to welcome', data);
              setState('auth');
            }
          } catch (err) {
            console.error('[onboarding] resume /account/connect threw:', err);
            if (!cancelled) setState('auth');
          }
          if (!cancelled) setResumeChecking(false);
          return;
        }

        // ── 4. Anything else (including the Create-path-mid-2a partial-write
        //    edge case where license_entered=1 but account_joined=0 — should
        //    never happen since /account/create writes both atomically — but
        //    be defensive) → restart from welcome. ──
        setState('auth');
        setResumeChecking(false);
      } catch (e) {
        console.error('[onboarding] resume check failed:', e);
        if (!cancelled) {
          setState('auth');
          setResumeChecking(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [stationId]);

  // Wipe per-flow form state when the user picks a path on welcome. Keeps
  // licenseKey (same value either path) but clears station fields and
  // selection so a stale 2a entry can't bleed into 3b's form.
  const resetForWelcomePath = () => {
    setWelcomeBanner(null);
    setFormError(null);
    setStnName(''); setNickname(''); setFrequency(''); setCallLetters('');
    setSelection(null);
  };

  // ── Account auth (Screen 0) — email/password sign in / sign up. Required for everyone
  // (including free Solo). Replaces the license-key welcome as the first screen. ──
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authErr, setAuthErr] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // After auth, ask the backend which stations this account already has, then route into the
  // existing pick-station (has stations) or add-station (none yet) screens. License/plan are
  // already stored by activateAndContinue.
  const routeAfterAuth = async (lk: string) => {
    setLicenseKey(lk);
    try {
      const idResp = await (window as any).ether.identity?.get?.().catch(() => null);
      const machine_id = idResp?.ok ? idResp.machine_id : '';
      const machine_name = idResp?.ok ? idResp.machine_name : '';
      const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: lk, machine_id, machine_name }),
      });
      const data = await res.json().catch(() => ({}));
      const kv = (window as any).ether.stationConfigKv;
      if (data.account_name) await kv.upsertByKey(stationId, 'account_name', data.account_name);
      await kv.upsertByKey(stationId, 'onboarding_license_entered', '1');
      const stations = Array.isArray(data.stations) ? (data.stations as OnboardingStation[]) : [];
      setConnectAccountName(data.account_name || '');
      setConnectStations(stations);
      setState(stations.length > 0 ? 'pickStation' : 'addStation');
    } catch {
      setState('addStation');
    }
  };

  // desktop-activate provisions/returns the license for this account + machine, stores
  // plan/license/email/trial, then routes into station setup.
  const activateAndContinue = async (email: string, password: string) => {
    const idResp = await (window as any).ether.identity?.get?.().catch(() => null);
    const machine_id = idResp?.ok ? idResp.machine_id : '';
    const machine_name = idResp?.ok ? idResp.machine_name : '';
    const res = await fetch(`${ETHER_BACKEND_URL}/api/user/desktop-activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, machine_id, machine_name, os: navigator.platform }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error === 'invalid_credentials' ? 'Email or password is incorrect.' : (data.message || 'Could not activate your account. Please try again.'));
    }
    const kv = (window as any).ether.stationConfigKv;
    await kv.upsertByKey(stationId, 'plan_tier', data.plan);
    if (data.license_key) await kv.upsertByKey(stationId, 'license_key', data.license_key);
    await kv.upsertByKey(stationId, 'license_email', data.email || email);
    if (data.trial && data.trial_ends_at) await kv.upsertByKey(stationId, 'trial_ends_at', data.trial_ends_at);
    setPlanGlobally(data.plan as PlanTier);
    if (!data.license_key) throw new Error('No license returned for this account. Please contact support.');
    return data.license_key as string;
  };

  // Sign in = returning user. On a FRESH machine the account already has stations
  // in the cloud (profiles, theme, shows, calendar, rotations) but nothing locally
  // — so instead of dropping straight to "create a profile", offer to pull them
  // down (the 'cloudSync' step). If the account has no stations there is nothing to
  // sync: mark first-run complete and go straight to the profile PIN login.
  const doSignIn = async () => {
    if (!authEmail.trim() || !authPassword) { setAuthErr('Enter your email and password.'); return; }
    setAuthBusy(true); setAuthErr('');
    try {
      const lk = await activateAndContinue(authEmail.trim(), authPassword);
      setLicenseKey(lk);

      // Ask the backend which stations this account already has (license-key authed).
      let stations: OnboardingStation[] = [];
      try {
        const idResp = await (window as any).ether.identity?.get?.().catch(() => null);
        const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            license_key:  lk,
            machine_id:   idResp?.ok ? idResp.machine_id   : '',
            machine_name: idResp?.ok ? idResp.machine_name : '',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.stations)) {
          stations = data.stations as OnboardingStation[];
          setConnectAccountName(data.account_name || '');
        }
      } catch { /* network/seat error — fall through to a fresh profile setup */ }

      if (stations.length > 0) {
        setConnectStations(stations);
        setSyncSel(new Set(stations.map(s => s.uuid))); // default: everything selected
        setSyncPhase('choose'); setSyncMsg('');
        setAuthBusy(false);
        setState('cloudSync');
        return;
      }

      const kv = (window as any).ether.stationConfigKv;
      await kv.upsertByKey(stationId, 'first_run_complete', '1');
      setState('done');
    }
    catch (e: any) { setAuthErr(e?.message || 'Could not sign in.'); setAuthBusy(false); }
  };

  // ── Cloud-sync handlers ──────────────────────────────────────
  // Pull the account's whole-DB backup (immediate: profiles/theme/shows/calendar/
  // rotations), optionally hide the stations the operator didn't pick, then pull the
  // shared audio library and relaunch into the restored database.
  const runCloudInstall = async (keepUuids: string[] | null) => {
    const ether = (window as any).ether;
    setSyncPhase('installing');
    setSyncMsg('Downloading your station database…');
    try {
      let r = await ether.invoke('station:install-from-cloud', {});
      if (!r?.ok && r?.hasData) r = await ether.invoke('station:install-from-cloud', { force: true });
      if (!r?.ok) {
        setSyncPhase('error');
        setSyncMsg(r?.error || 'Could not install your station from the cloud.');
        return;
      }

      // "Sync selected": soft-hide the stations the operator didn't choose (reuses the
      // ghost-sweep pattern). Non-destructive — their scoped rows stay inert and the
      // active station's profiles are the only ones UserLogin shows. Switch to the
      // first kept station first so it is is_active=1 and never swept.
      if (keepUuids && keepUuids.length > 0) {
        try {
          const keep = new Set(keepUuids);
          const list = await ether.stations.list();
          const rows = Array.isArray(list) ? list : [];
          const firstKeep = rows.find((s: any) => s.uuid === keepUuids[0]);
          if (firstKeep?.id) await ether.stations.switch(firstKeep.id);
          const after = await ether.stations.list();
          for (const s of (Array.isArray(after) ? after : [])) {
            if (s.uuid && !keep.has(s.uuid) && !s.is_active) await ether.stations.delete(s.id);
          }
        } catch (e) { console.error('[cloudSync] prune/switch threw:', e); }
      }

      // Shared audio library (account-wide R2 pull), then relaunch into the restored DB.
      setSyncMsg(`Database installed${r.stationName ? ` — ${r.stationName}` : ''} (${r.songs} songs). Downloading audio…`);
      const offP = ether.libraryR2.onDownloadProgress?.((v: any) =>
        setSyncMsg(`Downloading audio… ${v.done ?? 0}/${v.total ?? 0}`));
      await ether.libraryR2.download();
      offP?.();
      setSyncMsg('Done. Restarting Ether…');
      await ether.invoke('app:relaunch').catch(() => {});
    } catch (e: any) {
      setSyncPhase('error');
      setSyncMsg(String(e?.message || e));
    }
  };

  const syncAllStations = () => runCloudInstall(null);
  const syncSelectedStations = () => { if (syncSel.size > 0) runCloudInstall([...syncSel]); };
  const toggleSyncSel = (uuid: string) => setSyncSel(prev => {
    const next = new Set(prev);
    if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
    return next;
  });

  const doSignUp = async () => {
    if (!authEmail.trim()) { setAuthErr('Enter your email.'); return; }
    if (authPassword.length < 8) { setAuthErr('Password must be at least 8 characters.'); return; }
    setAuthBusy(true); setAuthErr('');
    try {
      const res = await fetch(`${ETHER_BACKEND_URL}/api/user/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail.trim(), password: authPassword, name: authName.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        throw new Error(
          data.error === 'email_taken' ? 'That email already has an account — switch to Sign in.'
          : data.error === 'weak_password' ? 'Password must be at least 8 characters.'
          : data.error === 'invalid_email' ? 'Enter a valid email address.'
          : 'Could not create your account. Please try again.'
        );
      }
      const lk = await activateAndContinue(authEmail.trim(), authPassword);
      // Sign up = brand-new account: run the full onboarding (pick/create station →
      // experience → venue → name → audio → pull).
      await routeAfterAuth(lk);
    } catch (e: any) { setAuthErr(e?.message || 'Could not sign up.'); setAuthBusy(false); }
  };

  const submitCreate = async () => {
    if (!licenseKey.trim() || !stnName.trim()) {
      setFormError('License key and station name are required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const idResp = await (window as any).ether.identity.get();
      if (!idResp?.ok) {
        throw new Error(idResp?.error || 'identity.get() failed');
      }
      const { machine_id, machine_name } = idResp;

      const res = await fetch(`${ETHER_BACKEND_URL}/account/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key:  licenseKey.trim(),
          account_name: accountName.trim() || null,
          station: {
            name:         stnName.trim(),
            nickname:     nickname.trim()    || null,
            frequency:    frequency.trim()   || null,
            call_letters: callLetters.trim() || null,
          },
          machine_id,
          machine_name,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (data.error === 'invalid_license_key') {
        setFormError('Invalid license key. Check the key and try again.');
        setSubmitting(false);
        return;
      }
      if (data.error === 'account_already_exists') {
        setWelcomeBanner(
          "This license already has an account. Choose 'Connect to existing account' on this screen instead."
        );
        setState('auth');
        setSubmitting(false);
        return;
      }
      if (!res.ok || !data.station_uuid) {
        setFormError(data.error || data.detail || 'Could not create account. Try again.');
        setSubmitting(false);
        return;
      }

      const kv = (window as any).ether.stationConfigKv;
      await kv.upsertByKey(stationId, 'license_key', licenseKey.trim());
      if (data.account_name) {
        await kv.upsertByKey(stationId, 'account_name', data.account_name);
      }
      await kv.upsertByKey(stationId, 'station_uuid',                data.station_uuid);
      if (data.plan) {
        await kv.upsertByKey(stationId, 'plan_tier', data.plan);
        setPlanGlobally(data.plan as PlanTier);
      }
      await kv.upsertByKey(stationId, 'onboarding_path',             'create');
      await kv.upsertByKey(stationId, 'onboarding_license_entered',  '1');
      await kv.upsertByKey(stationId, 'onboarding_account_joined',   '1');

      setSubmitting(false);
      setState('experienceMode'); // first bolted screen (placeholder until task #7)
    } catch (e: any) {
      setFormError(e?.message || 'Could not reach the license server. Check your internet connection.');
      setSubmitting(false);
    }
  };

  const submitConnect = async () => {
    if (!licenseKey.trim()) {
      setFormError('License key is required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const idResp = await (window as any).ether.identity.get();
      if (!idResp?.ok) {
        throw new Error(idResp?.error || 'identity.get() failed');
      }
      const { machine_id, machine_name } = idResp;

      const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: licenseKey.trim(),
          machine_id,
          machine_name,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (data.error === 'invalid_license_key') {
        setFormError('Invalid license key. Check the key and try again.');
        setSubmitting(false);
        return;
      }
      if (data.error === 'seat_limit_reached') {
        setFormError(
          'This license is using all 5 seats. To add this computer, ' +
          'deauthorize a seat in the Manage Devices panel on another machine.'
        );
        setSubmitting(false);
        return;
      }
      if (!res.ok || !Array.isArray(data.stations)) {
        setFormError(data.error || data.detail || 'Could not connect. Try again.');
        setSubmitting(false);
        return;
      }

      const kv = (window as any).ether.stationConfigKv;
      await kv.upsertByKey(stationId, 'license_key', licenseKey.trim());
      if (data.account_name) {
        await kv.upsertByKey(stationId, 'account_name', data.account_name);
      }
      if (data.plan) {
        await kv.upsertByKey(stationId, 'plan_tier', data.plan);
        setPlanGlobally(data.plan as PlanTier);
      }
      await kv.upsertByKey(stationId, 'onboarding_path',            'connect');
      await kv.upsertByKey(stationId, 'onboarding_license_entered', '1');
      // onboarding_account_joined is set on Screen 3 (bind-seat / add-station),
      // not here — Connect path has not joined a station yet.

      const stations = data.stations as OnboardingStation[];
      setConnectAccountName(data.account_name || '');
      setConnectStations(stations);
      setSubmitting(false);

      if (stations.length === 0) {
        // Account exists but has no stations (all deleted, or never registered
        // server-side — EB16). The returning customer must create one: fall
        // through to the add-station screen.
        setState('addStation');
        return;
      }

      // Pre-select the picker on the station this machine was last bound to
      // (local KV station_uuid is this machine's own prior binding), else the
      // oldest station (connect returns ORDER BY created_at ASC). The customer
      // can still override on Screen 3.
      let lastBound: string | undefined;
      try {
        const kvList = await (window as any).ether.stationConfigKv.list(stationId);
        if (kvList?.ok) lastBound = kvList.rows.find((r: any) => r.key === 'station_uuid')?.value || undefined;
      } catch { /* non-fatal — fall back to oldest */ }
      setSelection(
        lastBound && stations.some(s => s.uuid === lastBound) ? lastBound : stations[0].uuid
      );
      setState('pickStation');
    } catch (e: any) {
      setFormError(e?.message || 'Could not reach the license server. Check your internet connection.');
      setSubmitting(false);
    }
  };

  const submitBindSeat = async (station_uuid: string) => {
    setSubmitting(true);
    setFormError(null);
    try {
      const idResp = await (window as any).ether.identity.get();
      if (!idResp?.ok) {
        throw new Error(idResp?.error || 'identity.get() failed');
      }
      const { machine_id, machine_name } = idResp;

      const res = await fetch(`${ETHER_BACKEND_URL}/account/bind-seat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: licenseKey.trim(),
          machine_id,
          machine_name,
          station_uuid,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        setFormError(data.error || data.detail || 'Could not join the selected station. Try again.');
        setSubmitting(false);
        return;
      }

      const kv = (window as any).ether.stationConfigKv;
      await kv.upsertByKey(stationId, 'station_uuid',              station_uuid);
      await kv.upsertByKey(stationId, 'onboarding_account_joined', '1');

      const picked = connectStations.find(s => s.uuid === station_uuid);

      // Mirror the seat binding locally + sweep the auto-seeded ghost.
      try {
        const list = await (window as any).ether.stations.list();
        let localId: number | undefined = Array.isArray(list)
          ? list.find((s: any) => s.uuid === station_uuid)?.id
          : undefined;
        if (!localId) {
          // Fresh 2nd machine before sync lands: insert from the /account/connect
          // data we already hold, reusing the backend uuid so peer sync stays
          // consistent (OB18).
          const createRes = await (window as any).ether.stations.create({
            uuid:      station_uuid,
            name:      picked?.name         || 'Station',
            callsign:  picked?.call_letters || '',
            frequency: picked?.frequency    || '',
          });
          if (createRes?.ok && createRes.id) localId = createRes.id;
          else console.error('[onboarding] local station insert failed:', createRes?.error);
        }
        if (localId) {
          // Make the picked station active (no 'station-switched' dispatch —
          // badge refreshes when the main UI mounts; same rationale as OB18).
          await (window as any).ether.stations.switch(localId);

          // Sweep the auto-seeded "Station 1" ghost: any local station whose
          // uuid is NOT one of this account's stations was never on the backend
          // (the fresh-install seed in seedFreshInstall is local-only), so it's
          // a ghost. Soft-delete it — the deleted_at filter on stations:list
          // then hides it from the header switcher and Manage Stations. We read
          // the list AFTER the switch so the active picked station is is_active=1
          // and never swept. Pragmatic interim for OB19 (proper fix removes the
          // auto-seed entirely).
          const accountUuids = new Set(connectStations.map(s => s.uuid));
          const afterSwitch = await (window as any).ether.stations.list();
          for (const s of (Array.isArray(afterSwitch) ? afterSwitch : [])) {
            if (!accountUuids.has(s.uuid) && !s.is_active) {
              await (window as any).ether.stations.delete(s.id);
            }
          }
        }
      } catch (mirrorErr) {
        console.error('[onboarding] local bind-seat mirror/sweep threw:', mirrorErr);
      }

      // Connect → pick existing is terminal: skip the bolted config screens
      // (experience/venue/name), the audio-source picker, and the library-pull
      // screen — the returning customer's library arrives via background sync.
      // Carry the picked station's real name into onComplete for the header
      // title, and write first_run_complete now so a crash before the 'done'
      // render can't bounce the resume logic back into the bolted screens.
      if (picked?.name) setStnName(picked.name);
      await kv.upsertByKey(stationId, 'first_run_complete', '1');

      setSubmitting(false);
      setState('done');
    } catch (e: any) {
      setFormError(e?.message || 'Could not reach the license server. Check your internet connection.');
      setSubmitting(false);
    }
  };

  const submitExperience = async () => {
    if (!chosenExperience) return;
    const kv = (window as any).ether.stationConfigKv;
    await kv.upsertByKey(stationId, 'experience_mode', chosenExperience);
    setState('venueType');
  };

  const submitVenue = async () => {
    if (!chosenVenue) return;
    const kv = (window as any).ether.stationConfigKv;
    await kv.upsertByKey(stationId, 'venue_type', chosenVenue);
    setState('nameStation');
  };

  const submitName = async () => {
    if (!stnName.trim()) {
      setFormError('Station name is required.');
      return;
    }
    setFormError(null);
    const kv = (window as any).ether.stationConfigKv;
    await kv.upsertByKey(stationId, 'station_name',    stnName.trim());
    await kv.upsertByKey(stationId, 'station_tagline', displayTagline.trim());
    setState('pickAudioLocation');
  };

  const submitAddStation = async () => {
    if (!stnName.trim()) {
      setFormError('Station name is required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const idResp = await (window as any).ether.identity.get();
      if (!idResp?.ok) {
        throw new Error(idResp?.error || 'identity.get() failed');
      }
      const { machine_id, machine_name } = idResp;

      const res = await fetch(`${ETHER_BACKEND_URL}/account/add-station`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: licenseKey.trim(),
          machine_id,
          machine_name,
          station: {
            name:         stnName.trim(),
            nickname:     nickname.trim()    || null,
            frequency:    frequency.trim()   || null,
            call_letters: callLetters.trim() || null,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.station_uuid) {
        setFormError(data.error || data.detail || 'Could not create station. Try again.');
        setSubmitting(false);
        return;
      }

      const kv = (window as any).ether.stationConfigKv;
      await kv.upsertByKey(stationId, 'station_uuid',              data.station_uuid);
      await kv.upsertByKey(stationId, 'onboarding_account_joined', '1');

      // Mirror the backend create in the local stations table so the new
      // station shows in the header badge and active-station-aware code (OB18).
      // Reuse the backend's station_uuid so peer sync treats the two rows as
      // identical. create() is gated behind multistation_insert_audit_complete,
      // which seedFreshInstall sets to 'true'. Non-fatal: the backend already
      // succeeded, so a local-mirror failure logs and lets onboarding proceed.
      // No 'station-switched' dispatch — the badge picks up the new active
      // station when the main UI mounts after onComplete(); dispatching here
      // would change stationId mid-flow and re-trigger the [stationId] resume
      // effect.
      try {
        const createRes = await (window as any).ether.stations.create({
          uuid:      data.station_uuid,
          name:      stnName.trim(),
          callsign:  callLetters.trim() || '',
          frequency: frequency.trim()   || '',
        });
        if (createRes?.ok && createRes.id) {
          await (window as any).ether.stations.switch(createRes.id);
        } else {
          console.error('[onboarding] local station create failed:', createRes?.error);
        }
      } catch (mirrorErr) {
        console.error('[onboarding] local station create/switch threw:', mirrorErr);
      }

      setSubmitting(false);
      setState('experienceMode'); // first bolted screen (placeholder until task #7)
    } catch (e: any) {
      setFormError(e?.message || 'Could not reach the license server. Check your internet connection.');
      setSubmitting(false);
    }
  };

  // Empty dark overlay while the on-mount KV read decides resume target.
  // Beats flashing welcome then snapping to the resumed state.
  if (resumeChecking) {
    return <div style={OVERLAY_STYLE} />;
  }

  // Done — invoke onComplete with the values the bolted screens collected
  // (or the values restored from KV via the resumption useEffect). Also writes
  // first_run_complete=1 so App.tsx's gate flips on the next render. Task #9
  // will own this branch more fully when Screen 4 lands; for now the resume
  // path can hit this branch and needs accurate values.
  if (state === 'done') {
    (window as any).ether.stationConfigKv
      .upsertByKey(stationId, 'first_run_complete', '1')
      .catch((err: any) => console.error('[onboarding] write first_run_complete failed:', err));
    onComplete({
      venueType: (chosenVenue as VenueType | null) ?? 'radio',
      name:      stnName.trim()      || 'My Station',
      tagline:   displayTagline.trim(),
    });
    return null;
  }

  // ── Screen 0 — account sign in / sign up (email + password) ──────────
  if (state === 'auth') {
    const authInput: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0f0f8", fontSize: 14, outline: "none", fontFamily: "'Inter', system-ui, sans-serif" };
    const tab = (active: boolean): React.CSSProperties => ({ flex: 1, padding: "10px 0", borderRadius: 0, cursor: "pointer", fontSize: 13, fontWeight: 700, border: `1px solid ${active ? "var(--accent-cyan)" : "rgba(255,255,255,0.1)"}`, background: active ? "rgb(from var(--accent-cyan) r g b / 0.1)" : "transparent", color: active ? "var(--accent-cyan)" : "rgba(255,255,255,0.5)" });
    const submit = authMode === 'signin' ? doSignIn : doSignUp;
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={LABEL_STYLE}>Welcome to Ether</div>
              <h1 style={HEADING_STYLE}>{authMode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
              <p style={SUB_STYLE}>
                {authMode === 'signin'
                  ? 'Sign in with your Ether account to get started.'
                  : 'Create a free account — your trial starts right away.'}
              </p>
            </div>
            <div style={{ maxWidth: 420, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <button onClick={() => { setAuthMode('signin'); setAuthErr(''); }} style={tab(authMode === 'signin')}>Sign in</button>
                <button onClick={() => { setAuthMode('signup'); setAuthErr(''); }} style={tab(authMode === 'signup')}>Sign up</button>
              </div>
              {authMode === 'signup' && (
                <input value={authName} onChange={e => setAuthName(e.target.value)} placeholder="Your name (optional)" style={authInput} />
              )}
              <input type="email" autoFocus value={authEmail} onChange={e => { setAuthEmail(e.target.value); setAuthErr(''); }} placeholder="Email address" style={authInput} />
              <input type="password" value={authPassword} onChange={e => { setAuthPassword(e.target.value); setAuthErr(''); }} onKeyDown={e => { if (e.key === 'Enter') submit(); }} placeholder={authMode === 'signup' ? 'Create a password (8+ characters)' : 'Password'} style={authInput} />
              {authErr && <div style={{ fontSize: 12, color: "#f87171" }}>{authErr}</div>}
              <button onClick={submit} disabled={authBusy} style={{ width: "100%", padding: "13px 0", borderRadius: 0, background: "var(--accent-cyan)", color: "#000", border: "none", fontSize: 14, fontWeight: 700, cursor: authBusy ? "default" : "pointer", fontFamily: "'Syne', sans-serif", letterSpacing: "0.02em", opacity: authBusy ? 0.7 : 1, marginTop: 4 }}>
                {authBusy ? (authMode === 'signin' ? 'Signing in…' : 'Creating account…') : (authMode === 'signin' ? 'Sign in' : 'Create account & continue')}
              </button>
              {authMode === 'signin' && (
                <button
                  onClick={() => (window as any).ether?.system?.openUrl?.('https://signup.ether-technologies.com/forgot')}
                  style={{ background: "none", border: "none", color: "var(--accent-cyan)", fontSize: 12, cursor: "pointer", padding: "4px 0", textAlign: "center" }}
                >
                  Forgot password?
                </button>
              )}
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Screen 1 — Welcome / choose path ─────────────────────────────────
  if (state === 'welcome') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 40 }}>
              <div style={LABEL_STYLE}>Welcome to Ether</div>
              <h1 style={HEADING_STYLE}>Set up your<br />Ether station</h1>
              <p style={SUB_STYLE}>
                Are you setting up Ether for the first time,<br />
                or adding this computer to an existing account?
              </p>
            </div>

            {welcomeBanner && (
              <div style={{
                maxWidth: 520, margin: "0 auto 16px",
                padding: "12px 16px", borderRadius: 0,
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.4)",
                color: "#fbbf24", fontSize: 12, lineHeight: 1.5,
              }}>
                {welcomeBanner}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520, margin: "0 auto" }}>
              <PathButton
                title="Create new account"
                subtitle="First install — set up a new station under your license"
                onClick={() => { resetForWelcomePath(); setState('create'); }}
              />
              <PathButton
                title="Connect to existing account"
                subtitle="Adding this computer to a station you already use"
                onClick={() => { resetForWelcomePath(); setState('connect'); }}
              />
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Screen 2a — Create new account ───────────────────────────────────
  if (state === 'create') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>Step 1 of 2</div>
              <h1 style={HEADING_STYLE}>Create your<br />Ether account</h1>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto" }}>
              <InputField
                label="License key"
                required
                autoFocus
                value={licenseKey}
                onChange={setLicenseKey}
                placeholder="ETHER-PRO-XXXX-XXXX"
              />
              <InputField
                label="Account name"
                hint="A label for your company or organization. Change later in Settings."
                value={accountName}
                onChange={setAccountName}
                placeholder="WXYZ Broadcasting"
              />

              <div style={{ marginTop: 12, marginBottom: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", color: "rgba(255,255,255,0.5)", textTransform: "uppercase" }}>
                Name your first station
              </div>

              <InputField
                label="Station name"
                required
                value={stnName}
                onChange={setStnName}
                placeholder="98.5 The Wave"
              />
              <InputField
                label="Nickname"
                value={nickname}
                onChange={setNickname}
                placeholder="The Wave"
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <InputField
                  label="Frequency"
                  value={frequency}
                  onChange={setFrequency}
                  placeholder="98.5 FM"
                />
                <InputField
                  label="Call letters"
                  value={callLetters}
                  onChange={setCallLetters}
                  placeholder="WXYZ"
                />
              </div>

              {formError && (
                <div style={{
                  marginTop: 4, padding: "10px 14px", borderRadius: 0,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.4)",
                  color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
                }}>
                  {formError}
                </div>
              )}

              <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => setState('auth')}
                  disabled={submitting}
                  style={{
                    padding: "12px 24px", borderRadius: 0,
                    background: "transparent", color: "rgba(255,255,255,0.4)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                    letterSpacing: "0.04em", cursor: submitting ? "default" : "pointer",
                  }}
                >
                  ← Back
                </button>
                <PrimaryButton
                  label={submitting ? "Creating…" : "Create account"}
                  onClick={submitCreate}
                  disabled={submitting || !licenseKey.trim() || !stnName.trim()}
                />
              </div>
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Screen 3 — Pick or add a station ─────────────────────────────────
  // ── Cloud sync — pull the account's stations onto a fresh machine ────
  if (state === 'cloudSync') {
    // Installing / error: progress card (DB → audio → relaunch).
    if (syncPhase !== 'choose') {
      return (
        <div style={OVERLAY_STYLE}>
          <div style={GLOW_STYLE} />
          <div style={SHELL_STYLE}>
            <div style={{ animation: "onb-in 0.4s ease both", textAlign: "center" }}>
              <div style={LABEL_STYLE}>Syncing from the cloud</div>
              <h1 style={HEADING_STYLE}>{syncPhase === 'error' ? 'Sync failed' : 'Bringing your\nstation down…'}</h1>
              <p style={{ ...SUB_STYLE, maxWidth: 460, margin: "0 auto", color: syncPhase === 'error' ? "#fca5a5" : "rgba(255,255,255,0.55)" }}>
                {syncMsg}
              </p>
              {syncPhase === 'error' && (
                <div style={{ marginTop: 24, display: "flex", justifyContent: "center", gap: 12 }}>
                  <button
                    onClick={() => { setSyncPhase('choose'); setSyncMsg(''); }}
                    style={{ padding: "12px 24px", borderRadius: 0, background: "transparent", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.1)", fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer" }}
                  >
                    ← Back
                  </button>
                  <PrimaryButton label="Retry" onClick={() => runCloudInstall(syncSel.size > 0 && syncSel.size < connectStations.length ? [...syncSel] : null)} />
                </div>
              )}
            </div>
          </div>
          <style>{ANIMATION_CSS}</style>
        </div>
      );
    }

    const allSelected = syncSel.size === connectStations.length;
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={LABEL_STYLE}>Welcome back{connectAccountName ? `, ${connectAccountName}` : ''}</div>
              <h1 style={HEADING_STYLE}>Sync your stations<br />to this computer</h1>
              <p style={SUB_STYLE}>
                Pull your stations — profiles, color theme, shows, calendar and<br />
                rotation schedules — down from the cloud. The music library<br />
                downloads once, shared across them all.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 520, margin: "0 auto" }}>
              {connectStations.length > 1 && (
                <button
                  onClick={() => setSyncSel(allSelected ? new Set() : new Set(connectStations.map(s => s.uuid)))}
                  style={{ alignSelf: "flex-end", background: "transparent", border: "none", color: "var(--accent-cyan)", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "2px 4px" }}
                >
                  {allSelected ? "Clear all" : "Select all"}
                </button>
              )}
              {connectStations.map(s => (
                <StationRadioCard
                  key={s.uuid}
                  selected={syncSel.has(s.uuid)}
                  onClick={() => toggleSyncSel(s.uuid)}
                  title={`${s.frequency ? s.frequency + ' ' : ''}${s.name}`}
                  subtitle={s.call_letters || s.nickname || undefined}
                />
              ))}
            </div>

            <div style={{ maxWidth: 520, margin: "24px auto 0", display: "flex", flexDirection: "column", gap: 12 }}>
              <PrimaryButton
                label={allSelected ? `Sync all ${connectStations.length > 1 ? connectStations.length + ' stations' : 'stations'}` : `Sync ${syncSel.size} selected`}
                onClick={allSelected ? syncAllStations : syncSelectedStations}
                disabled={syncSel.size === 0}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => { resetForWelcomePath(); setState('addStation'); }}
                  style={{ padding: "11px 20px", borderRadius: 0, background: "transparent", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.12)", fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer", flex: 1 }}
                >
                  + Create new station
                </button>
                <button
                  onClick={async () => {
                    const kv = (window as any).ether.stationConfigKv;
                    await kv.upsertByKey(stationId, 'first_run_complete', '1');
                    setState('done');
                  }}
                  style={{ padding: "11px 20px", borderRadius: 0, background: "transparent", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.08)", fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer" }}
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  if (state === 'pickStation') {
    const onContinue = () => {
      if (!selection) return;
      if (selection === 'ADD_NEW') {
        setFormError(null);
        setState('addStation');
        return;
      }
      submitBindSeat(selection);
    };

    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>Step 2 of 2</div>
              <h1 style={HEADING_STYLE}>
                Welcome back,<br />{connectAccountName || 'your account'}
              </h1>
              <p style={SUB_STYLE}>Which station is this computer for?</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 520, margin: "0 auto" }}>
              {connectStations.map(s => (
                <StationRadioCard
                  key={s.uuid}
                  selected={selection === s.uuid}
                  onClick={() => setSelection(s.uuid)}
                  title={`${s.frequency ? s.frequency + ' ' : ''}${s.name}`}
                  subtitle={s.call_letters || s.nickname || undefined}
                />
              ))}
              <StationRadioCard
                key="__add_new__"
                selected={selection === 'ADD_NEW'}
                onClick={() => setSelection('ADD_NEW')}
                title="Add a new station"
                subtitle="Create a new station under this account"
                isAddNew
              />
            </div>

            {formError && (
              <div style={{
                maxWidth: 520, margin: "16px auto 0",
                padding: "10px 14px", borderRadius: 0,
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.4)",
                color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
              }}>
                {formError}
              </div>
            )}

            <div style={{ maxWidth: 520, margin: "24px auto 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <button
                onClick={() => setState('auth')}
                disabled={submitting}
                style={{
                  padding: "12px 24px", borderRadius: 0,
                  background: "transparent", color: "rgba(255,255,255,0.4)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                  letterSpacing: "0.04em", cursor: submitting ? "default" : "pointer",
                }}
              >
                ← Back
              </button>
              <PrimaryButton
                label={submitting ? "Joining…" : "Continue"}
                onClick={onContinue}
                disabled={!selection || submitting}
              />
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Screen 3b — Add a new station ────────────────────────────────────
  if (state === 'addStation') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>New station</div>
              <h1 style={HEADING_STYLE}>Name your<br />new station</h1>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto" }}>
              <InputField
                label="Station name"
                required
                autoFocus
                value={stnName}
                onChange={setStnName}
                placeholder="98.5 The Wave"
              />
              <InputField
                label="Nickname"
                value={nickname}
                onChange={setNickname}
                placeholder="The Wave"
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <InputField
                  label="Frequency"
                  value={frequency}
                  onChange={setFrequency}
                  placeholder="98.5 FM"
                />
                <InputField
                  label="Call letters"
                  value={callLetters}
                  onChange={setCallLetters}
                  placeholder="WXYZ"
                />
              </div>

              {formError && (
                <div style={{
                  marginTop: 4, padding: "10px 14px", borderRadius: 0,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.4)",
                  color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
                }}>
                  {formError}
                </div>
              )}

              <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => { setFormError(null); setState('pickStation'); }}
                  disabled={submitting}
                  style={{
                    padding: "12px 24px", borderRadius: 0,
                    background: "transparent", color: "rgba(255,255,255,0.4)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                    letterSpacing: "0.04em", cursor: submitting ? "default" : "pointer",
                  }}
                >
                  ← Back
                </button>
                <PrimaryButton
                  label={submitting ? "Creating…" : "Create station"}
                  onClick={submitAddStation}
                  disabled={submitting || !stnName.trim()}
                />
              </div>
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Bolted: experience mode ──────────────────────────────────────────
  // FirstRunWizard step 0 equivalent, restyled to match OnboardingFlow.
  // No back button — account/seat is already committed to the backend by
  // 2a/3/3b. Going back would let the user edit committed state.
  if (state === 'experienceMode') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>Interface</div>
              <h1 style={HEADING_STYLE}>How do you want<br />to broadcast?</h1>
              <p style={SUB_STYLE}>This sets your default deck layout. You can change it later in Settings.</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 520, margin: "0 auto" }}>
              {EXPERIENCE_OPTIONS.map(opt => (
                <StationRadioCard
                  key={opt.id}
                  selected={chosenExperience === opt.id}
                  onClick={() => setChosenExperience(opt.id)}
                  title={opt.label}
                  subtitle={opt.tagline}
                  description={opt.description}
                />
              ))}
            </div>

            <div style={{ maxWidth: 520, margin: "24px auto 0", display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton
                label="Continue"
                onClick={submitExperience}
                disabled={!chosenExperience}
              />
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Bolted: venue type ───────────────────────────────────────────────
  if (state === 'venueType') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>Persona</div>
              <h1 style={HEADING_STYLE}>What are you using<br />Ether for?</h1>
              <p style={SUB_STYLE}>We'll customize the interface and language to match your setup.</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 520, margin: "0 auto" }}>
              {VENUE_OPTIONS.map(opt => (
                <StationRadioCard
                  key={opt.id}
                  selected={chosenVenue === opt.id}
                  onClick={() => setChosenVenue(opt.id)}
                  title={opt.label}
                  subtitle={opt.tagline}
                />
              ))}
            </div>

            <div style={{ maxWidth: 520, margin: "24px auto 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <button
                onClick={() => setState('experienceMode')}
                style={{
                  padding: "12px 24px", borderRadius: 0,
                  background: "transparent", color: "rgba(255,255,255,0.4)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                  letterSpacing: "0.04em", cursor: "pointer",
                }}
              >
                ← Back
              </button>
              <PrimaryButton
                label="Continue"
                onClick={submitVenue}
                disabled={!chosenVenue}
              />
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Bolted: station name + tagline ───────────────────────────────────
  // station_tagline has no UI reader today — kept as a placeholder field
  // for future UI per design discussion. Pre-populates stnName with
  // whatever's already in component state (typed on 2a/3b, empty on
  // pickStation path).
  if (state === 'nameStation') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>Station details</div>
              <h1 style={HEADING_STYLE}>Name your<br />station</h1>
              <p style={SUB_STYLE}>This shows in the header and on your Now Playing screen.</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto" }}>
              <InputField
                label="Station name"
                required
                autoFocus
                value={stnName}
                onChange={setStnName}
                placeholder="98.5 The Wave"
              />
              <InputField
                label="Tagline"
                hint="A short slogan or descriptor."
                value={displayTagline}
                onChange={setDisplayTagline}
                placeholder="Your city's home for classic rock"
              />

              {formError && (
                <div style={{
                  marginTop: 4, padding: "10px 14px", borderRadius: 0,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.4)",
                  color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
                }}>
                  {formError}
                </div>
              )}

              <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => { setFormError(null); setState('venueType'); }}
                  style={{
                    padding: "12px 24px", borderRadius: 0,
                    background: "transparent", color: "rgba(255,255,255,0.4)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                    letterSpacing: "0.04em", cursor: "pointer",
                  }}
                >
                  ← Back
                </button>
                <PrimaryButton
                  label="Continue"
                  onClick={submitName}
                  disabled={!stnName.trim()}
                />
              </div>
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Screen 3.5 — Audio library source picker (Milestone B / Phase B.3) ─
  // Three buttons: Skip / From this computer / From the cloud. Sub-component
  // so its scan-and-preview sub-state and the basename-match map are scoped
  // to this branch's lifetime. Advances to 'pulling' when any handler resolves.
  if (state === 'pickAudioLocation') {
    return (
      <PickAudioLocationScreen
        stationId={stationId}
        onPull={() => setState('pulling')}
        onDone={() => setState('done')}
      />
    );
  }

  // ── Screen 4 — Pulling library ───────────────────────────────────────
  // Real progress UI consuming the sync:* events shipped in task #8a.
  // Renders a PullingScreen subcomponent so its hooks (subscription +
  // initial-complete handler) are scoped to this branch's lifetime.
  if (state === 'pulling') {
    return (
      <PullingScreen
        stationId={stationId}
        stationName={stnName}
        onContinue={() => setState('done')}
      />
    );
  }

  // ── Screen 2b — Connect to existing account ──────────────────────────
  if (state === 'connect') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={LABEL_STYLE}>Step 1 of 2</div>
              <h1 style={HEADING_STYLE}>Connect to your<br />Ether account</h1>
              <p style={{ ...SUB_STYLE, marginTop: 8 }}>
                Enter the same license key you used on your first computer.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto" }}>
              <InputField
                label="License key"
                required
                autoFocus
                value={licenseKey}
                onChange={setLicenseKey}
                placeholder="ETHER-PRO-XXXX-XXXX"
              />

              {formError && (
                <div style={{
                  marginTop: 4, padding: "10px 14px", borderRadius: 0,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.4)",
                  color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
                }}>
                  {formError}
                </div>
              )}

              <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => setState('auth')}
                  disabled={submitting}
                  style={{
                    padding: "12px 24px", borderRadius: 0,
                    background: "transparent", color: "rgba(255,255,255,0.4)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                    letterSpacing: "0.04em", cursor: submitting ? "default" : "pointer",
                  }}
                >
                  ← Back
                </button>
                <PrimaryButton
                  label={submitting ? "Connecting…" : "Continue"}
                  onClick={submitConnect}
                  disabled={submitting || !licenseKey.trim()}
                />
              </div>
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Placeholder for unbuilt screens ──────────────────────────────────
  // Replaced screen-by-screen by tasks #3-9. Until then, clicking through
  // Screen 1 lands here; "Back to start" returns to the welcome screen so
  // the operator isn't trapped during dev.
  return (
    <div style={OVERLAY_STYLE}>
      <div style={GLOW_STYLE} />
      <div style={SHELL_STYLE}>
        <div style={{ textAlign: "center", animation: "onb-in 0.4s ease both" }}>
          <div style={LABEL_STYLE}>OnboardingFlow — scaffold</div>
          <h1 style={HEADING_STYLE}>{stateLabel(state)}</h1>
          <p style={SUB_STYLE}>Not implemented yet — building in a follow-up commit.</p>
          <button
            onClick={() => setState('auth')}
            style={{
              marginTop: 32, padding: "12px 28px", borderRadius: 0,
              background: "transparent", color: "rgba(255,255,255,0.4)",
              border: "1px solid rgba(255,255,255,0.1)",
              fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
              letterSpacing: "0.04em", cursor: "pointer",
            }}
          >
            ← Back to start
          </button>
        </div>
      </div>
      <style>{ANIMATION_CSS}</style>
    </div>
  );
}

function stateLabel(s: OnboardingState): string {
  switch (s) {
    case 'auth':              return 'Screen 0 — Sign in or sign up';
    case 'create':            return 'Screen 2a — Create new account';
    case 'connect':           return 'Screen 2b — Connect to existing account';
    case 'pickStation':       return 'Screen 3 — Pick or add a station';
    case 'cloudSync':         return 'Sync your stations from the cloud';
    case 'addStation':        return 'Screen 3b — Add a new station';
    case 'experienceMode':    return 'Choose your deck layout';
    case 'venueType':         return 'What are you using Ether for?';
    case 'nameStation':       return 'Name your station';
    case 'pickAudioLocation': return 'Screen 3.5 — Audio library location (Milestone B)';
    case 'pulling':           return 'Connecting to your station…';
    case 'welcome':           return 'Welcome';
    case 'done':              return 'All set';
  }
}

function PathButton({ title, subtitle, onClick }: { title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={CARD_STYLE}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent-cyan)";
        e.currentTarget.style.background  = "rgb(from var(--accent-cyan) r g b / 0.06)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
        e.currentTarget.style.background  = "rgba(255,255,255,0.03)";
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, color: "#f0f0f8", letterSpacing: "-0.02em", marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.5 }}>
          {subtitle}
        </div>
      </div>
      <div style={{ fontSize: 18, color: "rgb(from var(--accent-cyan) r g b / 0.5)" }}>→</div>
    </button>
  );
}

interface InputFieldProps {
  label:        string;
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  required?:    boolean;
  autoFocus?:   boolean;
  hint?:        string;
}

function InputField({ label, value, onChange, placeholder, required, autoFocus, hint }: InputFieldProps) {
  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: "0.14em",
        color: "rgba(255,255,255,0.4)", textTransform: "uppercase",
        marginBottom: 6,
      }}>
        {label}
        {!required && <span style={{ opacity: 0.5, marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>optional</span>}
      </div>
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", padding: "12px 16px",
          borderRadius: 0, fontSize: 15,
          fontFamily: "'Inter', system-ui, sans-serif",
          background: "rgba(255,255,255,0.05)",
          border: "1.5px solid rgba(255,255,255,0.12)",
          color: "#f0f0f8", outline: "none",
          boxSizing: "border-box",
          transition: "border-color 0.2s",
        }}
        onFocus={(e) => (e.target.style.borderColor = "var(--accent-cyan)")}
        onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
      />
      {hint && (
        <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

interface StationRadioCardProps {
  title:        string;
  subtitle?:    string;
  description?: string;
  selected:     boolean;
  onClick:      () => void;
  isAddNew?:    boolean;
}

function StationRadioCard({ title, subtitle, description, selected, onClick, isAddNew }: StationRadioCardProps) {
  const borderColor = selected ? "var(--accent-cyan)" : (isAddNew ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)");
  const background  = selected ? "rgb(from var(--accent-cyan) r g b / 0.08)" : "rgba(255,255,255,0.03)";
  return (
    <button
      onClick={onClick}
      style={{
        padding: "16px 20px", borderRadius: 0, textAlign: "left",
        background,
        border: `1.5px ${isAddNew && !selected ? "dashed" : "solid"} ${borderColor}`,
        cursor: "pointer", transition: "all 0.2s",
        display: "flex", alignItems: "center", gap: 16,
        color: "#f0f0f8",
        boxShadow: selected ? "0 0 24px rgb(from var(--accent-cyan) r g b / 0.12)" : "none",
      }}
    >
      <div style={{
        width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
        border: `2px solid ${selected ? "var(--accent-cyan)" : "rgba(255,255,255,0.2)"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {selected && <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent-cyan)" }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{
          fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700,
          color: selected ? "var(--accent-cyan)" : "#f0f0f8",
          letterSpacing: "-0.02em",
          marginBottom: (subtitle || description) ? 4 : 0,
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.4, marginBottom: description ? 4 : 0 }}>
            {subtitle}
          </div>
        )}
        {description && (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
            {description}
          </div>
        )}
      </div>
    </button>
  );
}

function StatusLine({ done, text }: { done: boolean; text: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      fontSize: 14, lineHeight: 1.4,
      color: done ? "rgb(from var(--accent-cyan) r g b / 0.9)" : "rgba(255,255,255,0.6)",
    }}>
      <span style={{
        fontFamily: "'Inter', system-ui, sans-serif",
        width: 16, display: "inline-block", textAlign: "center",
        color: done ? "var(--accent-cyan)" : "rgba(255,255,255,0.4)",
        fontWeight: 700, fontSize: 14,
      }}>
        {done ? '✓' : '○'}
      </span>
      <span>{text}</span>
    </div>
  );
}

interface PullingScreenProps {
  stationId:   number;
  stationName: string;
  onContinue:  () => void;
}

function PullingScreen({ stationId, stationName, onContinue }: PullingScreenProps) {
  const [appliedTotal,    setAppliedTotal]    = useState(0);
  const [initialComplete, setInitialComplete] = useState(false);

  // Subscribe on mount; catch up via getState in case events already fired
  // before this component mounted (initial-complete is a one-shot — see the
  // three-tier persistence design in sync-scheduler.js).
  useEffect(() => {
    let cancelled = false;

    (window as any).ether.sync.getState()
      .then((s: { initialComplete: boolean; appliedTotal: number; byTable: Record<string, number> }) => {
        if (cancelled) return;
        setAppliedTotal(s.appliedTotal || 0);
        if (s.initialComplete) setInitialComplete(true);
      })
      .catch((err: any) => console.error('[onboarding] sync.getState() failed:', err));

    const unsubP = (window as any).ether.sync.onProgress(
      (event: { applied: number; byTable: Record<string, number> }) => {
        if (cancelled) return;
        setAppliedTotal(prev => prev + event.applied);
      }
    );
    const unsubI = (window as any).ether.sync.onInitialComplete(() => {
      if (cancelled) return;
      setInitialComplete(true);
    });

    return () => { cancelled = true; unsubP(); unsubI(); };
  }, []);

  // When initial-complete fires (or arrives via getState), write the
  // onboarding_library_pulled flag and advance to done.
  useEffect(() => {
    if (!initialComplete) return;
    let cancelled = false;
    (async () => {
      try {
        await (window as any).ether.stationConfigKv
          .upsertByKey(stationId, 'onboarding_library_pulled', '1');
      } catch (e) {
        console.error('[onboarding] write onboarding_library_pulled failed:', e);
      }
      if (!cancelled) onContinue();
    })();
    return () => { cancelled = true; };
  }, [initialComplete, stationId, onContinue]);

  // Escape hatch — only visible while waiting. Writes the same flag as the
  // auto path so the next launch doesn't re-prompt. Used when sync isn't
  // running this session (sync_enabled=false at startup, network down, etc.)
  // and the user doesn't want to be stuck on Screen 4. Library sync resumes
  // on the next launch when sync is running.
  const continueWithoutWaiting = async () => {
    try {
      await (window as any).ether.stationConfigKv
        .upsertByKey(stationId, 'onboarding_library_pulled', '1');
    } catch (e) {
      console.error('[onboarding] write onboarding_library_pulled failed:', e);
    }
    onContinue();
  };

  const countLabel = `${appliedTotal.toLocaleString()} ${appliedTotal === 1 ? 'entry' : 'entries'} received`;

  return (
    <div style={OVERLAY_STYLE}>
      <div style={GLOW_STYLE} />
      <div style={SHELL_STYLE}>
        <div style={{ animation: "onb-in 0.4s ease both" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={LABEL_STYLE}>Setup</div>
            <h1 style={HEADING_STYLE}>
              Connecting to<br />{stationName || 'your station'}…
            </h1>
          </div>

          <div style={{
            maxWidth: 520, margin: "0 auto",
            display: "flex", flexDirection: "column", gap: 14,
          }}>
            <StatusLine done text="License verified" />
            <StatusLine done text="Account joined" />
            <StatusLine
              done={initialComplete}
              text={initialComplete ? "Library downloaded" : `Downloading library… ${countLabel}`}
            />
          </div>

          <p style={{
            fontSize: 13, color: "rgba(255,255,255,0.4)", lineHeight: 1.6,
            maxWidth: 520, margin: "32px auto 0", textAlign: "center",
          }}>
            Your library list arrives now; songs will appear in the Library
            panel immediately. Audio file sync coming in a future update —
            until then, songs are visible but not yet playable on this
            computer.
          </p>

          {!initialComplete && (
            <div style={{ maxWidth: 520, margin: "20px auto 0", textAlign: "center" }}>
              <button
                onClick={continueWithoutWaiting}
                style={{
                  background: "transparent", border: "none",
                  color: "rgba(255,255,255,0.3)", fontSize: 11,
                  textDecoration: "underline", cursor: "pointer",
                  fontFamily: "'Inter', system-ui, sans-serif",
                  letterSpacing: "0.02em",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.6)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.3)")}
              >
                Continue without waiting — library will sync in the background
              </button>
            </div>
          )}
        </div>
      </div>
      <style>{ANIMATION_CSS}</style>
    </div>
  );
}

// ── Screen 3.5 — Audio library source picker (Phase B.3) ─────────────────────
// Three button paths. "From this computer" runs scan → preview → confirm, then
// writes file_path per match via the local-only setLocalFilePath IPC (which
// bypasses the mutation log — file_path resolution is per-machine). "From the
// cloud" is fire-and-forget; the download proceeds in the background with the
// persistent progress bar (B.4) taking over once onboarding completes.

interface PickAudioLocationScreenProps {
  stationId:   number;
  onPull:      () => void;  // cloud download → show the pulling/progress screen
  onDone:      () => void;  // skip / local import → straight into the app, no pulling screen
}

// Inline-shared with ImportDialog.tsx (Q7: do not extract — list is stable).
const PAL_AUDIO_EXTS = [".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac", ".aiff"];

function PickAudioLocationScreen({ stationId, onPull, onDone }: PickAudioLocationScreenProps) {
  const { isStation } = usePlan();
  type Sub = 'idle' | 'scanning' | 'preview' | 'applying';
  const [sub, setSub]                   = useState<Sub>('idle');
  const [scannedCount, setScannedCount] = useState(0);
  const [matchedPairs, setMatchedPairs] = useState<Array<{ id: number; file_path: string }>>([]);
  const [applyDone, setApplyDone]       = useState(0);
  const [error, setError]               = useState<string | null>(null);

  // Write the library source choice BEFORE acting on it. If the app crashes
  // mid-action, next launch knows what the operator picked (resumption routing
  // for this key is deferred — see commit body).
  const writeSourceKv = async (value: 'skip' | 'computer' | 'cloud') => {
    try {
      await (window as any).ether.stationConfigKv
        .upsertByKey(stationId, 'onboarding_library_source', value);
    } catch (e) {
      console.error(`[onboarding] write onboarding_library_source=${value} failed:`, e);
    }
  };

  const handleSkip = async () => {
    await writeSourceKv('skip');
    onDone();
  };

  const handleCloud = async () => {
    if (!isStation) return; // disabled-but-visible — inert click
    await writeSourceKv('cloud');
    // Fire-and-forget. Downloads continue post-onboarding via the persistent
    // progress bar (B.4). Network+ paid for cloud sync; don't ask twice.
    (window as any).ether.libraryR2.download().catch((err: any) =>
      console.error('[onboarding] libraryR2.download() invoke failed:', err)
    );
    onPull();
  };

  const handleComputer = async () => {
    setError(null);
    await writeSourceKv('computer');

    const folder = await (window as any).ether.dialog.openDirectory();
    if (!folder) return; // picker cancelled — stay on idle; KV stays 'computer'

    setSub('scanning');
    try {
      // Recursive folder scan (pattern from ImportDialog.tsx:62-80)
      const files: string[] = [];
      const scanDir = async (dirPath: string) => {
        const entries = await (window as any).ether.fs.readDir(dirPath);
        for (const entry of entries) {
          const fullPath = dirPath + "/" + entry.name;
          if (entry.isDir) {
            await scanDir(fullPath);
          } else {
            const ext = "." + (entry.name.split(".").pop() || "").toLowerCase();
            if (PAL_AUDIO_EXTS.includes(ext)) files.push(fullPath);
          }
        }
      };
      await scanDir(folder);

      // Basename → song-id map from the DB. SELECTs bypass the db:execute
      // guard (main.js:1275); skip fs.existsSync per Q6 — re-pointing a valid
      // path to a different valid path is a no-op.
      const dbRes = await (window as any).ether.db.query(
        "SELECT id, file_path FROM songs WHERE file_path IS NOT NULL AND file_path != '' AND deleted_at IS NULL",
        []
      );
      const rows: Array<{ id: number; file_path: string }> =
        Array.isArray(dbRes) ? dbRes : (dbRes?.data ?? dbRes?.rows ?? []);
      const byBasename = new Map<string, number>();
      for (const r of rows) {
        const bn = r.file_path.split(/[\\/]/).pop()?.toLowerCase();
        if (bn) byBasename.set(bn, r.id);
      }

      // Compute matches
      const pairs: Array<{ id: number; file_path: string }> = [];
      for (const fp of files) {
        const bn = fp.split(/[\\/]/).pop()?.toLowerCase();
        if (bn && byBasename.has(bn)) {
          pairs.push({ id: byBasename.get(bn)!, file_path: fp });
        }
      }

      setScannedCount(files.length);
      setMatchedPairs(pairs);
      setSub('preview');
    } catch (e: any) {
      console.error('[onboarding] folder scan failed:', e);
      setError(e?.message || 'Folder scan failed');
      setSub('idle');
    }
  };

  const handleConfirmApply = async () => {
    setSub('applying');
    setApplyDone(0);
    for (let i = 0; i < matchedPairs.length; i++) {
      const { id, file_path } = matchedPairs[i];
      try {
        await (window as any).ether.songs.setLocalFilePath(id, file_path);
      } catch (e) {
        console.warn('[onboarding] setLocalFilePath failed for song id', id, e);
      }
      setApplyDone(i + 1);
    }
    onDone();
  };

  const handleCancelPreview = () => {
    setMatchedPairs([]);
    setScannedCount(0);
    setError(null);
    setSub('idle');
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={OVERLAY_STYLE}>
      <div style={GLOW_STYLE} />
      <div style={SHELL_STYLE}>
        <div style={{ animation: "onb-in 0.4s ease both" }}>

          {sub === 'idle' && (
            <>
              <div style={{ textAlign: "center", marginBottom: 32 }}>
                <div style={LABEL_STYLE}>Setup</div>
                <h1 style={HEADING_STYLE}>Where's your audio?</h1>
                <p style={{ ...SUB_STYLE, marginTop: 8, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
                  Your song list is already synced. Now we need to find the audio files —
                  on this computer, in the cloud, or skip for now and add them later.
                </p>
              </div>

              {error && (
                <div style={{
                  maxWidth: 520, margin: "0 auto 16px",
                  padding: "10px 14px", borderRadius: 0,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.4)",
                  color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
                }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520, margin: "0 auto" }}>
                <SourceCard
                  title="From this computer"
                  subtitle="Pick a folder. We match by filename and link the files we recognize."
                  onClick={handleComputer}
                />
                <SourceCard
                  title="From the cloud"
                  subtitle={isStation
                    ? "Download all R2-backed audio. Continues in the background."
                    : "Upgrade to Network to sync from cloud"}
                  onClick={handleCloud}
                  disabled={!isStation}
                />
                <SourceCard
                  title="Skip for now"
                  subtitle="I'll add audio files later through Library → Import."
                  onClick={handleSkip}
                />
              </div>
            </>
          )}

          {sub === 'scanning' && (
            <div style={{ textAlign: "center" }}>
              <div style={LABEL_STYLE}>Setup</div>
              <h1 style={HEADING_STYLE}>Scanning your folder…</h1>
              <p style={{ ...SUB_STYLE, marginTop: 8 }}>
                Looking for audio files and matching them to your library.
              </p>
            </div>
          )}

          {sub === 'preview' && (
            <>
              <div style={{ textAlign: "center", marginBottom: 32 }}>
                <div style={LABEL_STYLE}>Setup</div>
                <h1 style={HEADING_STYLE}>
                  Matched {matchedPairs.length.toLocaleString()} of {scannedCount.toLocaleString()} songs
                </h1>
                <p style={{ ...SUB_STYLE, marginTop: 8, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
                  Unmatched files will be ignored — you can add them later through
                  Library → Import. Continue to link the matches we found.
                </p>
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 12, maxWidth: 520, margin: "0 auto" }}>
                <button
                  onClick={handleCancelPreview}
                  style={{
                    padding: "12px 24px", borderRadius: 0,
                    background: "transparent", color: "rgba(255,255,255,0.4)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                    letterSpacing: "0.04em", cursor: "pointer",
                  }}
                >
                  ← Choose a different folder
                </button>
                <PrimaryButton
                  label={matchedPairs.length === 0 ? "No matches — continue anyway" : "Continue"}
                  onClick={handleConfirmApply}
                />
              </div>
            </>
          )}

          {sub === 'applying' && (
            <div style={{ textAlign: "center" }}>
              <div style={LABEL_STYLE}>Setup</div>
              <h1 style={HEADING_STYLE}>Linking your audio…</h1>
              <p style={{ ...SUB_STYLE, marginTop: 8 }}>
                {applyDone.toLocaleString()} of {matchedPairs.length.toLocaleString()} files linked.
              </p>
              <div style={{ maxWidth: 520, margin: "24px auto 0", height: 4, background: "rgba(255,255,255,0.06)" }}>
                <div style={{
                  height: "100%",
                  width: matchedPairs.length > 0 ? `${(applyDone / matchedPairs.length) * 100}%` : "0%",
                  background: "linear-gradient(135deg, var(--accent-cyan), #a78bfa)",
                  transition: "width 0.15s",
                }} />
              </div>
            </div>
          )}

        </div>
      </div>
      <style>{ANIMATION_CSS}</style>
    </div>
  );
}

function SourceCard({ title, subtitle, onClick, disabled }: { title: string; subtitle: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Upgrade to Network to sync from cloud" : undefined}
      style={{
        ...CARD_STYLE,
        opacity: disabled ? 0.4 : 1,
        cursor:  disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = "var(--accent-cyan)";
        e.currentTarget.style.background  = "rgb(from var(--accent-cyan) r g b / 0.06)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
        e.currentTarget.style.background  = "rgba(255,255,255,0.03)";
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, color: "#f0f0f8", letterSpacing: "-0.02em", marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.5 }}>
          {subtitle}
        </div>
      </div>
    </button>
  );
}

function PrimaryButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "13px 32px", borderRadius: 0,
        background: disabled ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg, var(--accent-cyan), #a78bfa)",
        color: disabled ? "rgba(255,255,255,0.2)" : "#000",
        fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
        border: "none", cursor: disabled ? "default" : "pointer",
        letterSpacing: "0.04em",
        boxShadow: disabled ? "none" : "0 0 32px rgb(from var(--accent-cyan) r g b / 0.3)",
        transition: "all 0.2s",
      }}
    >
      {label}
    </button>
  );
}
