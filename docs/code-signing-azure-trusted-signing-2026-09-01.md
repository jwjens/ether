# Code signing — Azure Trusted Signing, gated twice (2026-09-01)

Status: **config committed, NOT yet exercised.** No signed build has run. Waiting on the Azure
identity-validation approval email before `v4.4.233` is tagged.

Target: `v4.4.233` on branch `log-reader-flip`. Last released tag: `v4.4.231`.

---

## The decision

CI signs (Jeff's "Option A") — the `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`
secrets live in GitHub repo secrets, not in a local shell. electron-builder is **26.8.1**, which
supports `azureSignOptions` natively; no upgrade was needed.

Signing is gated **twice**, by config *and* by env, and both gates must open before one file is
signed:

| Gate | Where | Opens only when |
|---|---|---|
| **Config** | `azureSignOptions` lives only in `electron-builder.signed.json` | the build passes `--config electron-builder.signed.json` |
| **Env** | `AZURE_*` set on one workflow step | `github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')` |

## Why two gates and not just the env gate

The original plan was to put `azureSignOptions` in the `win` block of `electron-builder.json` and
tag-gate only the environment. **That breaks every unsigned build**, because `azureSignOptions` is
not inert without credentials — it is fatal:

- `app-builder-lib/out/codeSign/windowsSignAzureManager.js` → `initialize()` **throws**
  `InvalidConfigurationError: Unable to find valid azure env field AZURE_TENANT_ID for signing.`
- It is reached from `windowsCodeSign.js: signWindows()` → `await packager.signingManager.value`,
  for **every** file signed.
- And earlier still on **non-CI** runs, at `winPackager.js:160`, where the signing manager is
  resolved for the executable cache digest (`isCI` false → not short-circuited).

Consequences had the Azure block sat in the base config:

1. `npm run electron:build:win -- --publish never` — the documented standard final step of *every*
   release — would hard-fail on Jeff's machine, and would try to `Install-Module TrustedSigning`
   from PSGallery.
2. A branch `workflow_dispatch` Windows build would **hard-fail** rather than build unsigned, which
   is the opposite of what tag-gating was meant to achieve.

Moving the Azure block into an overlay fixes both, and makes the tag gate structural rather than
merely environmental: off a `v*` tag there is no Azure block in the resolved config at all.

## The overlay

`electron-builder.signed.json`:

```json
{
  "extends": "file:electron-builder.json",
  "win": {
    "azureSignOptions": {
      "endpoint": "https://eus.codesigning.azure.net",
      "codeSigningAccountName": "ethercast",
      "certificateProfileName": "ethercast-release",
      "publisherName": "Jeffrey Jens"
    }
  }
}
```

`extends: file:` is resolved and deep-merged by electron-builder's own loader
(`app-builder-lib/out/util/config/config.js:60,63`). Verified: the merged result keeps every base
key — `nsis.include: build-resources/installer.nsh`, `asarUnpack`, `extraResources`,
`directories.output: dist-electron`, `publish`, `win.target`, `win.icon`, `win.extraFiles` — and adds
only `win.azureSignOptions`.

### `publisherName` is a STRING, not an array

Under `azureSignOptions` in 26.8.1, `publisherName` is a **required string**. The
`string | Array<string>` form exists only on `signtoolOptions.publisherName`, and signtoolOptions
cannot be combined with azureSignOptions. electron-builder's own validator, run against the array
form:

```
INVALID
 - configuration.win.azureSignOptions.publisherName should be a string.
```

Nothing is lost by the string: `windowsSignAzureManager.js:17` `asArray()`s it before
`PublishManager.js:204-206` writes it into `app-update.yml`, which is what electron-updater compares
the downloaded installer's signer subject against. It is *not* passed to `Invoke-TrustedSigning` —
`signFile()` destructures it out of `extraSigningArgs` (`windowsSignAzureManager.js:92`).

### `signExts` stays in the BASE config

`signExts: [".node", ".dll"]` is in `electron-builder.json`, not the overlay. It only selects which
files get signed, and `shouldSignFile()` (`winPackager.js:197-213`) falls through to
`file.endsWith(".exe")`, so `.exe` stays covered — the effect is `.exe` + the Rust NAPI `.node` and
`.dll` binaries. With no signing configured at all it is a no-op, so it is harmless in the base.

## The workflow

`.github/workflows/build.yml` — the single Windows step became two, mutually exclusive:

| Step | `if` | Command |
|---|---|---|
| Windows, SIGNED | `matrix.platform == 'win' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')` | `electron-builder --win --config electron-builder.signed.json --publish always` |
| Windows, UNSIGNED | `matrix.platform == 'win' && !(…same…)` | `electron-builder --win --publish always` |

Publish behaviour on the unsigned path is deliberately unchanged from before signing existed.
Mac and Linux steps are untouched.

Gate truth table, machine-checked against the parsed YAML:

```
push  refs/tags/v4.4.233  -> SIGNED=yes  UNSIGNED=no   exactly-one=OK
push  refs/tags/nightly   -> SIGNED=no   UNSIGNED=yes  exactly-one=OK
dispatch refs/heads/main  -> SIGNED=no   UNSIGNED=yes  exactly-one=OK
dispatch log-reader-flip  -> SIGNED=no   UNSIGNED=yes  exactly-one=OK
dispatch refs/tags/v9.9.9 -> SIGNED=no   UNSIGNED=yes  exactly-one=OK

steps carrying AZURE_* env = 1
```

Note the last row: a `workflow_dispatch` aimed at a tag ref still does **not** sign, because the
gate requires `event_name == 'push'`.

## What is NOT verified yet

- **No signed artifact exists.** Nothing has been tagged; `v4.4.231` is still the last release.
- **The certificate subject is unconfirmed.** `publisherName` must match the cert's subject CN
  exactly or electron-updater's signature check rejects updates. `"Jeffrey Jens"` is the expected
  value, not an observed one. After the first signed build, verify on the artifact:

  ```powershell
  $s = Get-AuthenticodeSignature 'dist-electron\Ether Setup 4.4.233.exe'
  $s.Status                        # expect Valid
  $s.SignerCertificate.Subject     # expect CN=Jeffrey Jens
  $s.TimeStamperCertificate        # expect non-null (timestamp present)
  ```

  If the subject differs, `publisherName` is wrong in the overlay and a follow-up tag is needed —
  a mismatch silently breaks auto-update for every client.
- **`.node` signing is unproven** — `signExts` is configured but no build has exercised it. Check
  the signed installer's unpacked `native/*.node` and the daemon's binaries.
- `Install-Module TrustedSigning` runs on the CI runner at `initialize()`; it has not run yet here.

## Gates at time of commit

`npx tsc --noEmit` 0 errors · `test:closing` 40/40 PASS · `test:announce` 28/28 PASS ·
`verify:schema` 8/8 PASS.
