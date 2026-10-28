# Patch Bay, inputs (step 2), and the board work of 2026-10-28

Branch `feat/patch-bay-outputs`. Local commits only: not merged into `release/1019`, not pushed, no installer.

## Step 2: inputs

**Jeff (verbatim):** "go on step 2, Patch Bay inputs, on feat/patch-bay-outputs: device inputs and Remote Link feeds patched
to source faders in the same Patch Bay window. The fader SOURCE dropdown on the board stays as it is and must agree with
the inputs grid. Own commits with tests. Stop when step 2 is done, show me in plain English, and wait for my go before
Remote Link."

| Commit | What |
|---|---|
| `82cdc4a` | One rule (`src/lib/inputPatch.ts`): what feeds a source fader is held in three records only (`deck_configs.kind`, `mic_input_<slot>`, `link_input`). The dropdown and the grid both read them and write them through the same writers. |
| `1fab6c6` | The Inputs grid under each station's outputs; Preferences → Mic Inputs keeps gain and state, its device and input-number pickers become a pointer to the Patch Bay; help. |
| `8ce3dce` | Faders named with the board's letters (S1 is G), as Jeff saw on screen. |

- Rows: the station's source faders on the board. Columns: every input of every input device, Park Mic 1 and 2, and
  the station's Remote Link feed. A click connects; a click on a lit square disconnects.
- Agreement: `src/lib/inputPatch.test.ts` clicks every crosspoint, two clicks deep (over 200 states), and checks the
  dropdown and the grid say the same thing after each one. Engine patches are written before the board's kind, so a
  refused patch never leaves the dropdown wrong.
- Not built: an input pair as one stereo source (open question 4 in the plan).
- UNVERIFIED: a click in the grid on screen, on a real input. Only the window itself was seen.

## The release check (`ef00cc9`)

The engine binary carries a fingerprint of the engine source it was built from (`native/build.rs`). Packaging computes
the same from the tree (`build-resources/engine-source-fp.js`) and fails if they differ, or if the binary has none
(built before this check, so older than the source). Checked before packing and on the packaged file. A test also fails
whenever the committed `native/ether-audio.node` is not built from the source in the tree.

## The board

| Commit | What |
|---|---|
| `51d3efe` | ☰ → Patch Bay |
| `6768cb2` | A real console cap on every fader; double-click = 0 dB; typing a level on a channel fader moved to Enter |
| `2ae0fa6`, `7779fe5` | The source name under the dropdown is not shown twice (and its space is gone) |
| `a757045` | Fader bank: minimum strip width, sideways scroll, Master Out pinned, FADERS overview, narrow layout |
| `60f8029` | Decks A, B and C collapse into one strip that is the playing deck's fader; presets and this computer remember it |
| `0d3d63b` | Help for both |

Screenshots (OVEVENTS, dev mode, halloVeen): `board-wide.png`, `board-medium.png`, `board-narrow.png`,
`abc-expanded.png`, `abc-collapsed.png` (on B), `abc-frames\collapsed-on-A_120928_721.png` and
`abc-frames\switch-to-B_121321_002.png` (both mid-rotation), in the session scratch folder.

## Open

- Golden re-baseline: waits for Jeff (`docs/golden-rebaseline-check-2026-10-28.md`, the third change `02e7f80`).
- `electron/profile-move.test.js` fails under load (a different case each run) and passes alone; untouched code.
