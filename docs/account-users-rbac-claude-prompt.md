# Prompt to paste into Claude Desktop (architecture / planning chat)

---

We're designing a new feature for EtherCast (broadcast automation platform): **account-level user management with roles and per-station access — RBAC.** I need you to help design it end-to-end (data model → backend → platform UI → in-app for Network/Enterprise) before we build. This is a fresh build, not a tweak.

**The requirement.** An account holds multiple people, each a login (email) with a **position** (PD, MD, President, Engineer, Jock…) and a **scope of which stations** in the cluster they can access/edit. A PD, MD, president and engineer all editing a cluster of stations is the standard broadcast model (Zetta/WideOrbit). Key points:
- Managed from our **platform admin console**: add email → assign position → assign which stations it can access.
- **Delegated admin:** a PD controls their own employees' access (which employees, which stations) — a role hierarchy, with the account owner/platform above the PD.
- For **Network & Enterprise** tier accounts, the same user management must also live **in the app backend** (in-app self-service), not only on the platform.
- Coexists with single-tenant-per-install (one account per install at a time; an account has many users).

**This is NOT** new-customer onboarding/signup, and NOT the cross-account `library_grants` (library sharing) feature — that was the wrong tool we'd been mis-applying.

**Current state of the codebase (already mapped):**
- 1 license = 1 account.
- `users` table (email+password logins) is **already one-to-many per license** — multi-email-per-account exists at the data layer. NO role column there.
- `account_users` table (operator logins, username+PIN) has a **coarse role only: `admin` | `user`**, plus `origin` (dashboard|install).
- `stations` are scoped by license only — **NO per-user per-station access** exists; everyone on an account sees all its stations.
- Web user management is currently **read-only** ("remote user management coming later"); create/PIN endpoints exist but no write UI.
- Desktop has separate in-app profiles (admin/jock/music_director, PIN) that sync UP only.

**Gaps to design:** (1) a real position taxonomy beyond admin/user; (2) a per-station access mapping; (3) delegated administration (PD manages employees within their scope); (4) write-capable platform UI; (5) in-app management gated to Network/Enterprise; (6) how account users + scopes reach the desktop install (today sync is install→backend only).

**Open decisions I want your help resolving:**
1. Consolidate to one cloud user model, or keep email-login (`users`) and PIN-operator (`account_users`) as two projections of one person?
2. Scope users to individual stations or to station-groups/clusters (for Enterprise scale)?
3. Fixed position enum or account-configurable positions?
4. Down-sync model for getting account users + scopes onto the desktop install.
5. Migration for existing single-owner accounts (owner → account-wide position, no disruption).

A full design doc with file:line references lives in the repo at `docs/account-users-rbac.md`. Please propose the data model, the permission matrix, the API surface, and how the platform vs in-app management split works — and push back on anything above that's the wrong call.
