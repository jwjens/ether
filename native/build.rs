extern crate napi_build;

// THE ENGINE SOURCE FINGERPRINT (release check, Jeff 2026-10-28: "the installer's engine file must be built from the same
// commit as the app, and the build fails if native/ether-audio.node is older than the engine source").
// FNV-1a 64 over the engine's source — every file under src/ plus Cargo.toml, Cargo.lock and this file — in sorted path
// order, "<path>\0<content without \r>\0" each. It is compiled into the binary (lib.rs ENGINE_SOURCE_MARK) and computed
// again from the tree by build-resources/engine-source-fp.js, which must give the same number: the packaging fails if
// they differ. A commit cannot contain its own hash, so the source is what is compared, not the commit id.
use std::path::{Path, PathBuf};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("read src").filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        if p.is_dir() { files(&p, out); } else { out.push(p); }
    }
}

fn main() {
    napi_build::setup();
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let mut list: Vec<(String, PathBuf)> = Vec::new();
    let mut src = Vec::new();
    files(&root.join("src"), &mut src);
    for p in src {
        let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        list.push((rel, p));
    }
    // Cargo.toml is committed as "cargo.toml" (CI renames it); it is hashed under one name either way.
    for (name, cands) in [("Cargo.toml", &["Cargo.toml", "cargo.toml"][..]), ("Cargo.lock", &["Cargo.lock"][..]), ("build.rs", &["build.rs"][..])] {
        if let Some(p) = cands.iter().map(|c| root.join(c)).find(|p| p.exists()) { list.push((name.to_string(), p)); }
    }
    list.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |b: &[u8]| for x in b { h ^= *x as u64; h = h.wrapping_mul(0x100000001b3); };
    for (rel, p) in &list {
        let body: Vec<u8> = std::fs::read(p).unwrap().into_iter().filter(|b| *b != b'\r').collect();
        feed(rel.as_bytes()); feed(&[0]); feed(&body); feed(&[0]);
    }
    println!("cargo:rustc-env=ETHER_ENGINE_SOURCE_FP={:016x}", h);
    println!("cargo:rerun-if-changed=src");
    for (_, p) in list.iter().filter(|(rel, _)| !rel.starts_with("src/")) { println!("cargo:rerun-if-changed={}", p.display()); }
}
