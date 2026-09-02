# Windows SIGNED build failure — v4.4.233 (CI run 33551716416)

**Date:** 2026-09-01 · **Branch:** log-reader-flip · **Tag:** v4.4.233 → 61ba7b9
**Job:** `build (windows-latest, win)` · **Step:** "Build and publish (Windows, SIGNED — v* tag push only)"
**Status:** test / mac / linux PASSED. Windows failed at signing. Mac+Linux 4.4.233 release published;
Windows installer + `latest.yml` absent from that release.

## The actual error (log, verbatim)

```
  • signing with Azure Trusted Signing  path=dist-electron\win-unpacked\resources\native\ether-audio.node
  • identified pwsh.exe
  • installing required module (TrustedSigning) with scope CurrentUser
  • verifying env vars for authenticating to Microsoft Entra ID
  ⨯ pwsh.exe process failed 1
...
Checking for required dependencies.
	Build tools package installed: False
	Trusted signing package installed: False
	Sign CLI package installed: False
	Installing required dependencies.
		Installing package: Microsoft.Windows.SDK.BuildTools 10.0.26100.4188
		Installing package: Microsoft.Trusted.Signing.Client 1.0.95
		Installing package: sign 0.9.1-beta.24469.1
Getting the list of files to be signed.
	Listed files: 1
		D:\a\ether\ether\dist-electron\win-unpacked\resources\native\ether-audio.node
	Batched SignTool files: 1
Signing SignTool file batch 1 of 1.
	Executing signtool.exe: ...signtool.exe sign /v /debug /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib ...
{
  "Endpoint": "https://eus.codesigning.azure.net",
  "CodeSigningAccountName": "ethercast",
  "CertificateProfileName": "ethercast-release",
  "ExcludeCredentials": []
}
Submitting digest for signing...
Unhandled managed exception
Azure.RequestFailedException: Service request failed.
Status: 403 (Forbidden)
Date: Tue, 01 Sep 2026 19:56:21 GMT
Server: Kestrel
Content-Length: 0
   at Azure.CodeSigning.CertificateProfileRestClient.SignAsync(...)
   at Azure.CodeSigning.CertificateProfileClient.StartSignAsync(...)
   at Azure.CodeSigning.Dlib.Core.DigestSigner.SignAsync(...)
SignTool Error: An unexpected internal error has occurred.
Exception: SignTool failed with exit code 1
```

Two identical attempts (electron-builder retried once), both on the **same first file**, both 403.

## What this rules OUT

- **NOT the `.node` / non-PE hypothesis.** The prior guess was that Azure choked on the 4 non-PE
  `.node` files, fix `signExts: ["ether-audio.node", ".dll"]`. Dead: the failure is on file **1 of 1**
  in the first batch, and the service never rejected the *content* — it refused the *request*.
  A malformed-input rejection is a 400 with a body; this is a bodiless 403. Also `.node` is a
  renamed DLL (valid PE); signing it is normal.
- **NOT `Install-Module TrustedSigning`.** The module installed, and all three NuGet packages
  (SDK.BuildTools, Trusted.Signing.Client 1.0.95, sign 0.9.1-beta) installed cleanly.
- **NOT Entra token acquisition.** `verifying env vars for authenticating to Microsoft Entra ID`
  passed, and the client reached the data-plane `StartSign` call. A bad `AZURE_CLIENT_SECRET`
  or wrong `AZURE_TENANT_ID` fails at token acquisition with an `AADSTS…` error, or returns **401**.
  **403 = authenticated, not authorized.**
- **NOT wrong endpoint / account / profile name.** The client echoed back exactly what
  `electron-builder.signed.json` configures (`eus.codesigning.azure.net` / `ethercast` /
  `ethercast-release`). A wrong account or profile name returns **404**, not 403.
- **NOT a repo/config defect.** `electron-builder.signed.json` and the tag-gated workflow step are
  correct as written. No source change fixes this.

## Root cause (Azure-side; UNVERIFIED from this machine)

The service principal behind `AZURE_CLIENT_ID` authenticated to the Trusted Signing service but is
**not authorized to sign with the `ethercast-release` certificate profile** — i.e. it is missing the
data-plane role assignment.

Trusted Signing requires the specific role **`Trusted Signing Certificate Profile Signer`**, assigned
on the Code Signing Account (or the certificate profile) — Owner/Contributor on the resource is
**not** sufficient and is the usual reason a correctly-configured pipeline 403s.

## The fix (Azure Portal — Jeff, no repo change)

1. Portal → Trusted Signing account **`ethercast`** → **Access control (IAM)** → **Role assignments**.
2. Confirm whether the app registration matching `AZURE_CLIENT_ID` appears with
   **Trusted Signing Certificate Profile Signer**. It almost certainly does not.
3. **Add role assignment** → role `Trusted Signing Certificate Profile Signer` → assign to that
   app registration / service principal. Scope: the account (covers all profiles), or the
   `ethercast-release` certificate profile specifically.
4. Wait for propagation (minutes; MS documents it can take longer) before re-running.

Secondary check if the role is already present and correct:
- The certificate profile `ethercast-release` status must be **Active/Completed**, not
  identity-validation-pending. A profile that has not finished identity validation cannot sign.
- `AZURE_TENANT_ID` must be the tenant that owns the `ethercast` account (an SP from another
  tenant authenticates but is unauthorized → 403).

## Re-run

No code change. Once the role assignment is in place, re-point the tag so CI rebuilds and publishes
the signed Windows installer into the existing 4.4.233 release:

```
git tag -f v4.4.233 61ba7b9
git push -f origin v4.4.233
```

(Tag push is the only trigger for the SIGNED step; the mac/linux assets already on the release are
not rebuilt destructively — electron-builder publishes the missing Windows artifacts alongside them.)

---

# RESOLUTION (2026-09-02) — the 403 was the first of four distinct failures

The 403 above was real but was only the outermost layer. Each fix revealed the next
failure, and the error code moved earlier in the pipeline every time. Recorded in full
because the sequence is the diagnostic: **an error that changes is progress.**

| # | UTC | Error | HTTP | What it proved |
|---|-----|-------|------|----------------|
| 1 | 21:50:28Z | `Azure.RequestFailedException` 403 on `StartSign` | 403 | Token issued; service refused authorization |
| 2 | 22:10:31Z | `AADSTS700016` app not found in directory | 400 | `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` disagreed |
| 3 | 02:24:47Z | `AADSTS7000215` invalid client secret | 401 | IDs now correct; secret wrong (Secret **ID** pasted, not **Value**) |
| 4 | 02:58:38Z | `SignTool Error: This file format cannot be signed` | — | **Auth fully working. 25 files signed.** Non-PE file killed the run |

## What actually fixed the signing chain

1. Role: `Artifact Signing Certificate Profile Signer` on the `ethercast` account,
   assigned to the CI service principal. Proven by files signing — authorization is
   never reached until a token exists, and step 4 signed 25 files.
2. `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` taken from the SAME app registration Overview
   blade. A mismatch gives `AADSTS700016`, not a 403.
3. `AZURE_CLIENT_SECRET` = the secret's **Value** (~40 chars, mixed case, contains
   `~` `.` `-`), NOT the **Secret ID** (a GUID). Azure's own error text names this
   exact confusion. The Value is visible only at creation time.

## The final blocker: foreign-platform .node files

`win.signExts: [".node", ".dll"]` matches by extension, so electron-builder handed
signtool `onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node` — an ELF
shared object. Windows `.node` files are renamed DLLs (PE) and sign fine; a Linux or
macOS `.node` cannot be Authenticode-signed at all.

`onnxruntime-node@1.14.0` arrives transitively via `@xenova/transformers@2.17.2`
(`electron/whisper-engine.js:51`) and ships all three platforms:
`napi-v3/{win32,darwin,linux}/{x64,arm64}`.

A magic-byte scan of every `.node`/`.dll` in the tree found **40 PE, 2 ELF, 2 Mach-O** —
all four non-PE files belong to onnxruntime-node. No other transitive dependency ships a
foreign-platform native binary, so the two globs below close the whole class.

**Fix (v4.4.234), scoped to the `win` block only** — the mac and linux builds need their
own onnxruntime binaries at runtime, so this must NOT go in the base `files` array:

```json
"win": {
  "files": [
    "!node_modules/onnxruntime-node/bin/napi-v3/linux/**",
    "!node_modules/onnxruntime-node/bin/napi-v3/darwin/**"
  ]
}
```

Platform `files` is **additive**, not a replacement — verified in the installed
`app-builder-lib/out/fileMatcher.js`, where `addPatterns(config[name])` and
`addPatterns(options.customBuildOptions[name])` both feed the same matcher. So the base
array does not need restating, and the negations apply on top of `node_modules/**/*`.
The six win32 onnxruntime binaries stay in the package and stay signed.

## Publishing: electron-builder's 2-hour guard

An unsigned `workflow_dispatch` build (run 33581636262) went green on all four jobs and
still published nothing:

```
• GitHub release not created  reason=existing release published more than 2 hours ago tag=v4.4.233
• skipped publishing  file=Ether-Setup-4.4.233.exe   reason=existing release published more than 2 hours ago
• skipped publishing  file=latest.yml                reason=existing release published more than 2 hours ago
```

It **skips and still exits 0** — a green job with no artifact. This is why v4.4.233 was
never completable: the release was published at 20:00:41Z and every later build refused
to attach to it. Cutting v4.4.234 sidesteps it by creating a fresh release.

## Still to verify on the v4.4.234 artifact

- `signtool verify /pa /v` → subject exactly `CN=Jeffrey Jens`, timestamp present.
  Cert subject is `CN=Jeffrey Jens, O=Jeffrey Jens, L=Las Vegas`; electron-updater
  matches on CN. A mismatch silently breaks updates for every client.
- The Rust NAPI `ether-audio.node` signed, not just `Ether.exe` and the installer.
- `publisherName` is currently the string `"Jeffrey Jens"`. Jeff wants it as an ARRAY
  from day one — when an entity forms and an OV cert appears, the new name appends and
  one build ships carrying both, so existing installs keep accepting updates.
  NOT retrofittable. Not yet done.
