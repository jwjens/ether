# Phase 3.5 Deferral — RulesEditor.tsx

## Status: Deferred (not included in F-4)

## Reason

`RulesEditor.tsx` is imported at `App.tsx:67` but never rendered anywhere in the
application — no `panel === "rules"` branch, no `<RulesEditor />` JSX. Same class
as `CartWall.tsx` (F-3a) and `PublishEpisode.tsx` (F-3b).

Migrating dead code adds noise with zero runtime benefit and would make a silent
failure look maintained.

## What it would need (when wired up)

- `RulesEditor.tsx:46`: `queryScoped("UPDATE separation_rules SET ...")` — uses
  `queryScoped` which calls `stmt.all()` on an UPDATE; will throw
  "This statement does not return data" at runtime. Migrate to:
  `await (window as any).ether.separationRules.updateById(id, { [field]: val });`
- Remove `import { query, execute } from "../db/client"` (both unused after migration)
- `separationRules.updateById` is available in `preload-handlers.js` after F-4

## Action required before wiring up

1. Add a `panel === "rules"` render branch in App.tsx (or embed in SettingsPanel)
2. Reachability check: confirm the component is rendered
3. Migrate the three call sites (`value`, `is_hard`, `is_active`) to `updateById`
4. Single focused commit
