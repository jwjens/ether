// Embed an explicit asInvoker manifest into the binary (and the test runner).
//
// Windows' installer-detection heuristic auto-elevates any executable whose name
// contains "setup" — that would force a UAC prompt on `cargo test` (error 740)
// and make elevation implicit. We elevate on purpose instead: Ether launches the
// helper via ShellExecute "runas", which elevates regardless of this manifest
// level. Using `rustc-link-arg` (not `-bins`) applies the manifest to every
// artifact including the unit-test exe, so the tests run unelevated.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ha-setup.manifest");
        println!("cargo:rerun-if-changed=ha-setup.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
