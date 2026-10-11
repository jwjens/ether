# Announcements schedule editor: rows reorder while editing (2026-10-11)

**Jeff's report (verbatim):** "while editing a 'before closing' line, clicking the minute arrows or typing makes the
rows reorder. The list re-sorts by computed time on every change, so the row moves out from under the cursor, and the
next click edits a different announcement ('the file names adjust with the entire row'). A line ended up at +33 (after
closing) instead of -33."

Read-only. No code changed.

## Findings

1. **The list re-sorts on every edit: CONFIRMED.**
   - `src/components/Announcements.tsx:560`: `const ordered = [...draft].sort(...)`, by `resolvedSeconds` (`:539`).
     It is recomputed on every render, and every keystroke or arrow click is a render (`patchLine`, `:577` → `setDraft`).
   - The rows render from `ordered` (`:729`).
   - It is deliberate: the comment at `:536–537` says "typing a new one visibly reorders the list before Apply is
     pressed".
   - So the row being edited moves to its new time position at once. The next click lands on whatever row now sits
     under the pointer, which is a different announcement.

2. **Row identity is NOT the index.** `<DraftRow key={l.id} …>` (`:730`), with `id` a per-draft sequence (`_draftSeq`,
   `:575`). Values stay with their own row. What moves is the row's **position**, which matches "the file names adjust
   with the entire row".

3. **How −33 becomes +33.** This is a second defect in the minute input (`:356–358`):
   - The input is `type="number"` with **no min/max**, and `onChange` sets `offset: parseInt(value, 10) || 0`.
   - Typing "-33": the first keystroke "-" parses to NaN, then `|| 0` gives **0**. The controlled input re-renders
     showing 0 and the minus is gone. "33" then becomes **+33**.
   - Mid-typing, 0 resolves to closing time itself, so the row also jumps in the list (finding 1).
   - The arrows have no lower or upper bound, so a few clicks past 0 cross into "after closing" with nothing said.
   - The seconds input (`:364–366`) has min/max ±59, but the same `|| 0` loses a typed "-".
   - The row is labelled "before closing" whatever the sign. Positive values silently mean after closing.

## Proposed fix (Jeff's, plus one item; for approval, not built)

- **Stable order while editing.** The editor keeps rows in the order the operator added or arranged them, with the
  existing stable `l.id` keys. Sorting by time happens on **Apply**, or from an explicit **"Sort by time"** button.
  The resolved-time preview stays on each row, so the computed time is still visible.
- **The sign survives typing.** A partial entry ("-", "") is held as text while the field is focused, and only a
  complete number is committed (on change when it parses, otherwise on blur). Typing "-33" can then never become 33.
- **Warn on after-closing.** A "before closing" line set to a positive value shows "plays N min AFTER closing" on the
  row, and Apply asks for confirmation naming those lines.
- **Test:** a renderer test (or smoke script) for type "-33" → −33, row order unchanged during edits, sorted on Apply,
  and a positive offset requiring confirmation.
- **Help:** update the announcements help entry to say the list sorts on Apply.
