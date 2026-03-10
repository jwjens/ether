const fs = require('fs');

console.log('\n  Fixing Mac build — universal binary\n');

let yml = fs.readFileSync('.github/workflows/build.yml', 'utf8');

// Replace the two separate Mac builds with one universal build
yml = yml.replace(
  `          - os: macos-latest
            target: x86_64-apple-darwin
          - os: macos-latest
            target: aarch64-apple-darwin`,
  `          - os: macos-latest
            target: universal-apple-darwin`
);

// Update the args to use universal target
yml = yml.replace(
  '          args: --target ${{ matrix.platform.target }}',
  '          args: --target ${{ matrix.platform.target }}'
);

fs.writeFileSync('.github/workflows/build.yml', yml, 'utf8');
console.log('  UPDATED build.yml — single universal Mac build');
console.log('  One .dmg works on ALL Macs (Intel + Apple Silicon)\n');

// Also need to add both Rust targets for universal build
// Update the workflow to install both targets on Mac
yml = fs.readFileSync('.github/workflows/build.yml', 'utf8');
yml = yml.replace(
  `      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: \${{ matrix.platform.target }}`,
  `      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: \${{ matrix.platform.target }}

      - name: Add Apple targets for universal build
        if: matrix.platform.target == 'universal-apple-darwin'
        run: |
          rustup target add x86_64-apple-darwin
          rustup target add aarch64-apple-darwin`
);

fs.writeFileSync('.github/workflows/build.yml', yml, 'utf8');

console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "universal Mac build"');
console.log('    git push');
console.log('    git tag -f v1.5.0');
console.log('    git push --tags --force\n');
