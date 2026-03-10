const fs = require('fs');

console.log('\n  Ether — GitHub Actions CI/CD\n');

fs.mkdirSync('.github/workflows', { recursive: true });

fs.writeFileSync('.github/workflows/build.yml', `name: Build Ether

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        platform:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: macos-latest
            target: x86_64-apple-darwin
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu

    runs-on: \${{ matrix.platform.os }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: \${{ matrix.platform.target }}

      - name: Install Linux dependencies
        if: matrix.platform.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - name: Install JS dependencies
        run: npm install

      - name: Build Tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: \${{ github.ref_name }}
          releaseName: 'Ether \${{ github.ref_name }}'
          releaseBody: 'Download the installer for your platform below.'
          releaseDraft: true
          prerelease: false
          args: --target \${{ matrix.platform.target }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ether-\${{ matrix.platform.target }}
          path: |
            src-tauri/target/*/release/bundle/**/*.exe
            src-tauri/target/*/release/bundle/**/*.msi
            src-tauri/target/*/release/bundle/**/*.dmg
            src-tauri/target/*/release/bundle/**/*.AppImage
            src-tauri/target/*/release/bundle/**/*.deb
`, 'utf8');
console.log('  CREATED .github/workflows/build.yml');

console.log('\n  Done! Push to GitHub:');
console.log('    git add -A');
console.log('    git commit -m "add CI/CD - builds Windows, Mac, Linux"');
console.log('    git push\n');
console.log('  What happens:');
console.log('    - Every push to main triggers builds on all 3 platforms');
console.log('    - Windows: .exe and .msi installers');
console.log('    - Mac: .dmg (both Intel and Apple Silicon)');
console.log('    - Linux: .deb and .AppImage');
console.log('');
console.log('  To create a release:');
console.log('    git tag v1.5.0');
console.log('    git push --tags');
console.log('  GitHub creates a release page with all installers attached.');
console.log('');
console.log('  View builds: https://github.com/jwjens/ether/actions');
console.log('  Download artifacts from any build run.\n');
