# Iris-as-Platform — Content Types and Architecture Notes

**Date:** 2026-05-13
**Type:** Forward-looking architectural notes — NOT a spec, NOT implementation work.
**Trigger:** Industry survey of third-party AI radio automation workflows reviewed in conversation May 13, 2026.

---

## 1 — Purpose

This document captures observations from third-party AI radio automation systems for use as starting context when the Iris-as-platform arc begins. The primary reference is a publicly demonstrated workflow by RadioDJ Dude (March 2025) that adds AI voice tracking to RadioDJ using a 6-agent external pipeline.

The document records: what that pattern does, why it is architecturally wrong for Ether, which specific ideas from it are worth importing, and the open questions that need decisions before implementation work starts.

Nothing here is a specification. Nothing here requires code changes now. This is reference material captured before the observations are lost.

---

## 2 — The Third-Party Pattern Observed

RadioDJ has no native AI. To add AI voice tracking, the demonstrator built a visual workflow in a low-code automation platform (n8n / Make.com style) running entirely outside RadioDJ.

### 2.1 Agent count and topology

Six or more separate agents/processes, wired together as a visual workflow graph:

- **Drive-Search** — locates the appropriate script template in Google Drive
- **Collect-Script-Info** — assembles context data for the content type
- **Airtable-Search** / **Airtable-Update** — reads and writes content metadata from an Airtable database
- **Prepare-Audio-Links** — resolves source material references to playable URLs
- **Script-Merge** → **Script-Final** — two-pass script generation via LLM
- **ElevenLabs** — sends the finalized script to ElevenLabs for voice synthesis
- **Drive-Upload** — writes the generated audio file back to Google Drive
- **Gmail-Final-Approval** — sends the audio to a human for review via email before it goes to air
- **Process-Replies** — monitors the approval inbox and acts on approve/reject replies

### 2.2 Content categories defined as named workflows

Each content type is a separate named workflow with its own trigger and configuration:

- "Rad Rewind" — date-specific historical content
- "Upcoming Music Tease" — previews of songs coming up in rotation
- "Station Promos" — station identification and promotional content

### 2.3 File-system integration with RadioDJ

Generated audio files are written to folders that RadioDJ watches: `OnAir`, `OnAir_Final`, `Playlists`, `Scripts`. RadioDJ picks them up by polling. The agents and RadioDJ share no runtime state — the file system is the message bus.

### 2.4 Voice source

ElevenLabs voices selected from the public voice library (not custom-trained), grouped by category: Narrative & Story, Conversational, Characters & Animation, Social Media, Entertainment & TV, Advertisement, Informative & Educational.

### 2.5 Human-in-the-loop

Gmail-Final-Approval requires a human to listen to and reply to an email before content clears for air. There is no in-app approval UI.

---

## 3 — Why This Architecture Is Wrong for Ether

The 6-agent pattern is a workaround for RadioDJ's complete absence of native AI. It is the right approach for RadioDJ. It would be the wrong approach for Ether.

**Latency.** Every inter-agent hop is a file-system write, a network call, or a polling cycle. Generating a Music Tease takes minutes, not seconds. Ether's direct function call path can produce the same output without leaving the process.

**State inconsistency.** Each agent maintains its own stale view of the world. The ElevenLabs agent does not know what is currently queued in RadioDJ. The Script-Final agent does not know whether the song it is teasing has already played. Ether's Iris has direct read access to the live playout queue, schedule, and rotation state at every step.

**Attack surface multiplication.** Each agent needs its own API keys, file-system permissions, and cloud service credentials. Six agents means six independent secrets management problems and six separate authorization surfaces.

**Failure mode multiplication.** Any one agent crash breaks the chain silently. Debugging requires reading six separate process logs. In Ether, a single process means a single failure domain and a single structured log.

**No real-time reactivity.** The workflow generates content on a schedule. It cannot react to a caller phoning in, a weather alert firing, or a schedule change mid-flight. Iris runs inside Ether and can subscribe to any internal event.

---

## 4 — What to Import from the Third-Party Pattern

Three ideas in the third-party demo are legitimately good and worth bringing into Iris-as-platform.

### 4.1 Named content categories with specialized templates

The demo treats "Rad Rewind," "Music Tease," and "Station Promo" as distinct content types with their own generation logic. Iris should adopt this structure. One generic "make a voice track" prompt produces generic output. Named templates per content category produce content that sounds right for its purpose.

Each template should encode its own rules:

- **Music Tease** — must query the NEXT song in rotation after the rotation decision is made, not before. Must not reveal songs that have already played in the last two hours.
- **Station Promo** — includes call letters, station ID conventions, and any legally required identifiers configured per station.
- **Rad Rewind** — date-specific historical context; may reference archived `play_log` data for "on this day we first played..." hooks.
- **Caller Shoutout** — triggered by a phone-bank event; references the caller's name and the reason they called in.
- **Weather Insert** — triggered by an NWS alert or a scheduled weather break slot; draws from a configured weather data adapter.
- **Dead Air Fill** — system-initiated emergency content; no wait for approval, fires immediately.

Templates are first-class entities in Iris. They have identifiers, version history, and per-station overrides.

### 4.2 Optional human-in-the-loop approval per content category

The demo's Gmail-Final-Approval step is good broadcast design. Mistakes on air can be career-ending: FCC violations, defamation, off-brand content. The right response is not to remove the approval step — it is to bring it inside Ether and make it fast.

Iris should support three approval modes, configurable per content category:

- **AUTO** — content generates and fires to air without human review. Appropriate for low-stakes content: time-of-day greetings, weather inserts with no editorial judgment required, station ID legal reads.
- **REVIEW** — content generates and sits in an approval queue. Fires to its scheduled slot only after an operator taps approve. Appropriate for paid promos, editorial content, anything with legal or brand sensitivity.
- **HOLD** — content generates and queues for review, but does not auto-fire even after approval. The operator must explicitly drag it into the rotation or schedule it. Appropriate for experimental or high-value content where timing matters.

Approval must be possible from the Ether dashboard and from mobile (push notification → tap-to-approve). Email is an acceptable secondary path, not the primary one.

### 4.3 Visible pipeline and workflow view

The demo's biggest unintended advantage is psychological: broadcasters can see the workflow as a visual graph. Operators trust what they can see. They can audit it, explain it to a station manager, and diagnose it when something goes wrong.

Iris's all-in-one architecture is technically superior. Internally it is a pipeline: data fetch → template fill → LLM generation → TTS → approval gate → scheduling. But that pipeline is invisible to the operator.

Iris should expose a read-only workflow visualization per content category showing the same internal stages it always executes. The visualization is for trust and discoverability. It is not an editable graph. Operators cannot rewire the pipeline — they can read it and understand what Iris is doing.

---

## 5 — What NOT to Import

### 5.1 Multiple processes or agents

Iris is one module inside the Ether main process. Internal modularity yes (voice generation as a swappable module, script writing as a swappable module, each with a clear interface). Separate processes, no. The shared-state advantages of running in-process are too significant to give up.

If process isolation for crash safety becomes a real requirement, the correct answer is a supervised child process for the TTS step only — not a 6-agent mesh.

### 5.2 File-system message passing

Iris communicates with the rest of Ether via direct function calls and shared in-process state. No folder-watching, no JSON file shuffling, no polling loops. Generated audio is placed directly into the scheduler queue by reference, not written to a watched directory.

### 5.3 External cloud services on the critical path

The demo uses Google Drive (source content), Airtable (metadata database), and Gmail (approval). These are cloud services on the critical path — if any one is unreachable, the pipeline stalls.

The equivalent capabilities in Ether live inside the system:

- Source content → Ether's library and content stores (local SQLite + optional R2)
- Metadata database → Ether's SQLite (with optional CRDT sync to cloud)
- Approval queue → Ether's dashboard queue and notification system

External cloud services may be optional integrations. They are never on the critical path for basic Iris operation. Iris must work fully offline for a station without internet access during a broadcast.

### 5.4 Public voice library as the default voice source

The demo uses ElevenLabs' public voice library of thousands of voices. The result is content that sounds like it could be from any station, because it can be. For Ether:

- Public ElevenLabs voice library is available and supported
- Custom-cloned voices for station hosts are supported via existing Lila integration
- Each station should have a configurable Iris persona — a specific voice selected or cloned for that station's brand

Default behavior is station-configurable. Iris does not randomly pick from the global public library. It uses the station's configured Iris voice unless an operator explicitly requests otherwise.

---

## 6 — Iris Module Shape

For the Iris-as-platform arc, the internal structure of Iris should be modular with clean interfaces at each boundary. All modules run in-process inside Ether.

**Voice generation module** — produces audio from a script string and a voice ID. Backed by ElevenLabs today. Interface should allow substitution with Cartesia, PlayHT, or a local TTS model without changing any upstream code.

**Script generation module** — produces a script string from a template, context data, and an LLM. Backed by Claude today. Interface should allow substitution or fallback to a deterministic template fill if the LLM backend is unavailable.

**Data fetch module** — retrieves context data for a given content type from Ether's internal sources and any configured external adapters. Sources include: current queue state, play_log history, show schedule, NWS weather feed, configured RSS news feeds, operator-provided notes.

**Content template module** — stores and evaluates named templates per content category (see section 4.1). Templates are first-class, versioned, and per-station overridable. Validation rules live in the template: minimum length, required fields, prohibited content categories, timing constraints.

**Approval queue module** — manages pending generated content. Surfaces to the dashboard approval view and to mobile push notifications. Processes approve / reject / hold decisions. Persists state in a dedicated SQLite table, synced via the Phase F CRDT engine to other devices.

**Scheduling integration** — writes approved content directly into Ether's scheduler with the correct priority, timing, and deck assignment. Iris does not write to folders. It calls the scheduler's insert API directly.

**Audit log module** — every piece of content Iris generates is written to a log entry containing: content type, template version, voice ID, LLM backend, generation timestamp, raw script, approval state, approval timestamp (if applicable), air timestamp (if applicable), operator who approved (if applicable). This log is non-deletable from the UI. It exists for FCC compliance, brand auditing, and debugging.

---

## 7 — Trigger Sources Iris Needs to React To

When the arc begins, the following trigger sources need adapter implementations. Some already exist partially:

**Time-based triggers** — scheduled content slots in the format clock, daypart transitions, hourly station IDs. The format clock infrastructure exists. Iris just needs to be a slot type.

**Event-based triggers** — NWS weather alerts, breaking news from configured RSS feeds, schedule changes made by an operator while automation is running.

**Operator-initiated** — "make me a music tease," "voice this script," "generate a promo for the upcoming event." These are direct UI commands from the Ether dashboard.

**Listener-initiated** — request line (listener phones in via PhoneDesk), social media mentions via configured adapter. These are lower priority for the initial arc.

**System-initiated** — dead air detected (emergency content, fires immediately with no approval gate), unscheduled gap in rotation (generic filler), playout error (technical difficulties insert pre-generated and cached).

Each trigger source is an adapter. The Iris core does not change when a new trigger source is added — the adapter maps the external event to an internal Iris command.

---

## 8 — Open Questions for the Implementation Arc

These questions need explicit decisions before code is written. They are noted here so they are not rediscovered from scratch.

**Process model** — Should Iris run as a supervised child process of the Ether main process (for crash isolation if the LLM or TTS call hangs) or inside the main process (for shared state simplicity and lower latency)? The current recommendation is in-process, but this needs a deliberate decision given that LLM and TTS calls can block for 5–30 seconds.

**Template storage** — Are content templates stored as code (TypeScript objects), database rows, JSON files in the app data directory, or a domain-specific language? Database rows allow per-station customization and sync. Code is simpler to version. JSON files are human-editable without redeployment. This decision affects the template editor UI and the sync story.

**Multi-station Iris coordination** — If an operator has multiple stations active, does one Iris instance serve all stations with per-station context, or does each station have its own Iris instance? Given the per-station AudioEngine architecture (the JS multi-engine refactor arc), the natural answer is one Iris context per station. But this needs confirmation.

**Approval queue persistence and sync** — The approval queue contains pending generated content that may have been generated on one machine and needs approval on another. How is this synced? Per-station table in the Phase F CRDT-synced DB seems correct, but the sync semantics for large audio blobs (not just metadata) need design.

**LLM unavailability fallback** — When Iris's LLM backend is unreachable (no internet, API outage, key exhausted), what happens? Options: generate cached fallback content from a local template, skip the slot silently, skip the slot and alert the operator, use a deterministic template fill with no LLM. Each content type may need a different answer.

**FCC compliance for AI-generated content** — AI-generated voice content may have disclosure requirements in some jurisdictions. The audit log module (section 6) addresses the internal record. The disclosure UI (on-air labeling, public inspection file entries) needs a separate design pass.

---

## 9 — Relationship to Other Architectural Documents

**`docs/multi-station-broadcast-architecture.md`** — Iris must respect per-station scoping throughout. All content generation, template storage, approval queues, and audit logs are scoped to a `station_id`.

**`docs/multi-station-infrastructure-audit-may-2026.md`** — Iris's data access patterns must account for the GATED / READY / PARTIAL state of the multi-station infrastructure documented here. Specifically: Iris cannot assume that a station_id other than 1 has a fully initialized data layer until the Phase A station-creation gate is lifted.

**Future: `docs/phase-a-multi-machine-architecture.md`** — Iris's process model and the approval queue sync design interact directly with the multi-machine deployment story. These two design threads need to be resolved together.

---

*Last updated: May 13, 2026*
*Captured from: industry survey of RadioDJ AI Voice Tracking workflows (RadioDJ Dude, March 2025 demo) + conversation with Jeff Jens about Iris-as-platform direction, May 13, 2026*
*Not a spec. Forward-looking notes for the future Iris-as-platform arc.*
