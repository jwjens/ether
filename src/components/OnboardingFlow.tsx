import { useState, useEffect } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import type { VenueProfile, VenueType } from "./FirstRunWizard";

// Replaces FirstRunWizard at the first_run_complete gate in App.tsx.
// Implements the four screens of docs/onboarding-spec-v1.md with the
// three FirstRunWizard fields (venue_type, experience_mode, station_name +
// station_tagline) bolted on between Screen 3/3b and Screen 4 so the
// downstream readers in OnShiftScreen / SettingsPanel / App.tsx persona
// labels keep working.

const ETHER_BACKEND_URL = "https://ether-backend-production.up.railway.app";

type OnboardingState =
  | 'welcome'            // Screen 1 — path picker
  | 'create'             // Screen 2a — POST /account/create
  | 'connect'            // Screen 2b — POST /account/connect
  | 'pickStation'        // Screen 3  — list from /account/connect
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
  background: "radial-gradient(circle, rgba(34,211,238,0.05) 0%, transparent 70%)",
  pointerEvents: "none",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: "0.2em",
  color: "#22d3ee", textTransform: "uppercase",
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
  const [state, setState] = useState<OnboardingState>('welcome');
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
        if (get('first_run_complete') === '1' || get('onboarding_library_pulled') === '1') {
          setState('done');
          setResumeChecking(false);
          return;
        }

        // ── 2. Account joined → land on first bolted step not yet filled (or pulling) ──
        if (get('onboarding_account_joined') === '1') {
          if      (!expSaved) setState('experienceMode');
          else if (!venSaved) setState('venueType');
          else if (!snSaved)  setState('nameStation');
          else                setState('pulling');
          setResumeChecking(false);
          return;
        }

        // ── 3. Connect path mid-pickStation → re-fetch /account/connect ──
        if (get('onboarding_license_entered') === '1' && get('onboarding_path') === 'connect') {
          if (!lkSaved) {
            setState('welcome');
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
              setState('welcome');
            }
          } catch (err) {
            console.error('[onboarding] resume /account/connect threw:', err);
            if (!cancelled) setState('welcome');
          }
          if (!cancelled) setResumeChecking(false);
          return;
        }

        // ── 4. Anything else (including the Create-path-mid-2a partial-write
        //    edge case where license_entered=1 but account_joined=0 — should
        //    never happen since /account/create writes both atomically — but
        //    be defensive) → restart from welcome. ──
        setState('welcome');
        setResumeChecking(false);
      } catch (e) {
        console.error('[onboarding] resume check failed:', e);
        if (!cancelled) {
          setState('welcome');
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
        setState('welcome');
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
      await kv.upsertByKey(stationId, 'onboarding_path',            'connect');
      await kv.upsertByKey(stationId, 'onboarding_license_entered', '1');
      // onboarding_account_joined is set on Screen 3 (bind-seat / add-station),
      // not here — Connect path has not joined a station yet.

      setConnectAccountName(data.account_name || '');
      setConnectStations(data.stations as OnboardingStation[]);
      setSubmitting(false);
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

      setSubmitting(false);
      setState('experienceMode'); // first bolted screen (placeholder until task #7)
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
    setState('pulling'); // Screen 4 (placeholder until task #9)
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
                  onClick={() => setState('welcome')}
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
                onClick={() => setState('welcome')}
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
                  onClick={() => setState('welcome')}
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
            onClick={() => setState('welcome')}
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
    case 'create':            return 'Screen 2a — Create new account';
    case 'connect':           return 'Screen 2b — Connect to existing account';
    case 'pickStation':       return 'Screen 3 — Pick or add a station';
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
        e.currentTarget.style.borderColor = "#22d3ee";
        e.currentTarget.style.background  = "rgba(34,211,238,0.06)";
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
      <div style={{ fontSize: 18, color: "rgba(34,211,238,0.5)" }}>→</div>
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
        onFocus={(e) => (e.target.style.borderColor = "#22d3ee")}
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
  const borderColor = selected ? "#22d3ee" : (isAddNew ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)");
  const background  = selected ? "rgba(34,211,238,0.08)" : "rgba(255,255,255,0.03)";
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
        boxShadow: selected ? "0 0 24px rgba(34,211,238,0.12)" : "none",
      }}
    >
      <div style={{
        width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
        border: `2px solid ${selected ? "#22d3ee" : "rgba(255,255,255,0.2)"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {selected && <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22d3ee" }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{
          fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700,
          color: selected ? "#22d3ee" : "#f0f0f8",
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

function PrimaryButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "13px 32px", borderRadius: 0,
        background: disabled ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg, #22d3ee, #a78bfa)",
        color: disabled ? "rgba(255,255,255,0.2)" : "#000",
        fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
        border: "none", cursor: disabled ? "default" : "pointer",
        letterSpacing: "0.04em",
        boxShadow: disabled ? "none" : "0 0 32px rgba(34,211,238,0.3)",
        transition: "all 0.2s",
      }}
    >
      {label}
    </button>
  );
}
