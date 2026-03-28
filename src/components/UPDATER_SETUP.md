# Ether Auto-Updater Setup

One-time setup. After this your buddy gets updates automatically inside Ether.

## Step 1 — Generate signing keys

Run this once on your machine:

```powershell
npm run tauri signer generate -- -w C:\Users\YourName\.tauri\ether.key
```

This outputs two things:
- **Private key** — keep this secret, never commit it
- **Public key** — a long string starting with `dW50cnVzdGVkIGNvbW1lbn...`

Copy the public key.

## Step 2 — Add public key to tauri.conf.json

In `src-tauri/tauri.conf.json`, replace `REPLACE_WITH_YOUR_PUBLIC_KEY`:

```json
"updater": {
  "endpoints": ["https://raw.githubusercontent.com/jwjens/ether/main/latest.json"],
  "dialog": false,
  "pubkey": "dW50cnVzdGVkIGNvbW1lbn..."
}
```

## Step 3 — Add secrets to GitHub

Go to: **github.com/jwjens/ether → Settings → Secrets → Actions**

Add these secrets:

| Secret Name | Value |
|-------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The private key file contents from Step 1 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password you set in Step 1 (or leave blank) |

For macOS notarization (removes "unidentified developer" warning):

| Secret Name | Value |
|-------------|-------|
| `APPLE_CERTIFICATE` | Your Developer ID cert exported as base64 |
| `APPLE_CERTIFICATE_PASSWORD` | Certificate export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-character Apple Team ID |

**Note:** macOS notarization requires an Apple Developer account ($99/year).
Without it, your buddy gets a "unidentified developer" popup but can still
right-click → Open to bypass it. Not ideal but workable.

## Step 4 — Add the workflow file

Copy `release.yml` to:
```
C:\openair\.github\workflows\release.yml
```

Create the `.github/workflows/` folder if it doesn't exist.

## Step 5 — Add latest.json to repo root

Copy `latest.json` to `C:\openair\latest.json`

Commit and push it:
```powershell
git add latest.json .github/workflows/release.yml
git commit -m "feat: add auto-updater"
git push origin main
```

## Step 6 — Ship your first update

Bump version in TWO places:
```
src-tauri/Cargo.toml  →  version = "1.9.2"
src-tauri/tauri.conf.json  →  "version": "1.9.2"
```

Then tag and push:
```powershell
git add -A
git commit -m "feat: whatever you built"
git tag v1.9.2
git push origin main
git push origin v1.9.2
```

GitHub Actions kicks off automatically. ~15 minutes later:
- Windows `.msi` built and signed
- macOS `.dmg` built, signed, and notarized  
- GitHub Release created with both installers
- `latest.json` updated automatically
- Your buddy sees "Ether 1.9.2 is ready" inside Ether and clicks Update Now

## That's it

Every future update:
1. Bump version in Cargo.toml + tauri.conf.json
2. `git tag vX.X.X && git push origin main --tags`
3. Done — GitHub Actions handles the rest
