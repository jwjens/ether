# Phase 3.5 Deferral — PublishEpisode.tsx

## Status: Deferred (not included in F-3b)

## Reason

`PublishEpisode.tsx` contains a comment "Drop into:" but is never imported or rendered
anywhere in the application (confirmed: no reference in `src/App.tsx` or any other live
component). Migrating dead code to typed handlers would add noise with zero runtime benefit.

## What it would need (when integrated)

- `publishedEpisodes.create` is already available via the typed handler in `preload-handlers.js`
- Any direct `execute()` / `executeScopedInsert()` calls in `PublishEpisode.tsx` would need to
  migrate to the appropriate `window.ether.*` handler call before the component is wired up

## Action required before wiring up

1. Reachability check: verify the component is imported and rendered in App.tsx
2. Audit for any raw SQL writes (grep for `execute`, `executeScopedInsert`)
3. Migrate each write site to the corresponding typed handler
4. Single focused commit before the feature PR
