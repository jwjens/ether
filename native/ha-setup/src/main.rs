//! ha-setup.exe — Ether HA auto-logon helper (Phase 4).
//!
//! Elevated one-shot tool that configures (or clears) Windows automatic logon so
//! a station PC returns to air unattended after a reboot. Ether's main process
//! launches it via ShellExecute "runas" (one UAC prompt). It does only the two
//! things that genuinely require admin — the HKLM Winlogon registry values and
//! the LSA "DefaultPassword" secret — and nothing else. The per-user Scheduled
//! Task and ha-config.json are written by the non-elevated app.
//!
//! Usage:
//!   ha-setup.exe enable  --pipe <\\.\pipe\name> --result <path> --user <DOMAIN\User>
//!   ha-setup.exe disable --result <path>
//!
//! The password is read from the named pipe (in memory only) — never an argument,
//! never on disk. The result is a tiny JSON file (no secrets) the parent reads
//! back: {"ok":bool,"step":string,"error":string|null}. Exit 0 on success, 1 on
//! failure.

use std::io::Read;
use windows::core::PWSTR;
use windows::Win32::Security::Authentication::Identity::{
    LsaClose, LsaOpenPolicy, LsaStorePrivateData, LSA_HANDLE, LSA_OBJECT_ATTRIBUTES,
    LSA_UNICODE_STRING,
};
use winreg::enums::*;
use winreg::RegKey;
use zeroize::Zeroizing;

const WINLOGON: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
const LSA_KEY: &str = "DefaultPassword";
// Access right needed to store an LSA private-data secret. Defined locally to
// avoid depending on the exact name/type the windows crate exports it under.
const POLICY_CREATE_SECRET: u32 = 0x0000_0020;

fn main() {
    std::process::exit(real_main());
}

fn real_main() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let verb = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let result_path = flag(&args, "--result");

    let outcome = match verb {
        "enable" => do_enable(&args),
        "disable" => do_disable(),
        other => Err(("args".to_string(), format!("unknown verb '{}'", other))),
    };

    match &outcome {
        Ok(()) => {
            write_result(result_path.as_deref(), true, "done", None);
            0
        }
        Err((step, err)) => {
            write_result(result_path.as_deref(), false, step, Some(err));
            1
        }
    }
}

/// Value following `name` in argv, if present.
fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn do_enable(args: &[String]) -> Result<(), (String, String)> {
    let pipe = flag(args, "--pipe").ok_or(("args".to_string(), "--pipe required".to_string()))?;
    let user = flag(args, "--user").ok_or(("args".to_string(), "--user required".to_string()))?;
    let (domain, username) = split_user(&user);

    let password = read_pipe(&pipe).map_err(|e| ("pipe".to_string(), e))?;

    // 1. HKLM Winlogon registry: AutoAdminLogon + the account to log in as.
    set_winlogon(&domain, &username).map_err(|e| ("registry".to_string(), e))?;

    // 2. LSA secret — Windows reads "DefaultPassword" from the encrypted LSA
    //    store at logon. This keeps the password OUT of the registry in plaintext
    //    (the naive DefaultPassword-as-REG_SZ alternative we deliberately avoid).
    store_lsa_secret(Some(&password)).map_err(|e| ("lsa".to_string(), e))?;

    Ok(())
}

fn do_disable() -> Result<(), (String, String)> {
    clear_winlogon().map_err(|e| ("registry".to_string(), e))?;
    store_lsa_secret(None).map_err(|e| ("lsa".to_string(), e))?;
    Ok(())
}

/// Split `DOMAIN\User` into (domain, user). Local accounts (no domain, or a
/// leading backslash) get "." — the Winlogon-recognised "this machine" domain.
fn split_user(user: &str) -> (String, String) {
    match user.split_once('\\') {
        Some((d, u)) if !d.is_empty() => (d.to_string(), u.to_string()),
        _ => (".".to_string(), user.trim_start_matches('\\').to_string()),
    }
}

/// Read one password line off the named pipe. Both the read buffer and the
/// returned string are zeroized on drop.
fn read_pipe(name: &str) -> Result<Zeroizing<String>, String> {
    let mut f = std::fs::File::open(name).map_err(|e| format!("open pipe: {}", e))?;
    let mut buf = Zeroizing::new(String::new());
    f.read_to_string(&mut buf)
        .map_err(|e| format!("read pipe: {}", e))?;
    let pw = buf.trim_end_matches(['\r', '\n']).to_string();
    Ok(Zeroizing::new(pw))
}

fn set_winlogon(domain: &str, username: &str) -> Result<(), String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(WINLOGON, KEY_SET_VALUE | KEY_WOW64_64KEY)
        .map_err(|e| format!("open Winlogon: {}", e))?;
    key.set_value("AutoAdminLogon", &"1")
        .map_err(|e| format!("set AutoAdminLogon: {}", e))?;
    key.set_value("DefaultUserName", &username.to_string())
        .map_err(|e| format!("set DefaultUserName: {}", e))?;
    key.set_value("DefaultDomainName", &domain.to_string())
        .map_err(|e| format!("set DefaultDomainName: {}", e))?;
    Ok(())
}

fn clear_winlogon() -> Result<(), String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(WINLOGON, KEY_SET_VALUE | KEY_WOW64_64KEY)
        .map_err(|e| format!("open Winlogon: {}", e))?;
    let _ = key.set_value("AutoAdminLogon", &"0");
    let _ = key.delete_value("DefaultUserName");
    let _ = key.delete_value("DefaultDomainName");
    let _ = key.delete_value("DefaultPassword"); // in case a plaintext one ever existed
    Ok(())
}

/// Store (Some) or delete (None) the LSA "DefaultPassword" private-data secret.
fn store_lsa_secret(value: Option<&str>) -> Result<(), String> {
    unsafe {
        let mut oa = LSA_OBJECT_ATTRIBUTES::default();
        oa.Length = std::mem::size_of::<LSA_OBJECT_ATTRIBUTES>() as u32;
        let mut policy = LSA_HANDLE::default();
        let st = LsaOpenPolicy(None, &oa, POLICY_CREATE_SECRET, &mut policy);
        if st.0 != 0 {
            return Err(format!("LsaOpenPolicy 0x{:08X}", st.0));
        }

        let key_u16: Vec<u16> = LSA_KEY.encode_utf16().collect();
        let key_lsa = lsa_unicode(&key_u16);

        let st = match value {
            Some(v) => {
                let val_u16: Vec<u16> = v.encode_utf16().collect();
                let val_lsa = lsa_unicode(&val_u16);
                LsaStorePrivateData(policy, &key_lsa, Some(&val_lsa))
                // val_u16 stays alive until end of this block, after the call
            }
            None => LsaStorePrivateData(policy, &key_lsa, None),
        };
        let _ = LsaClose(policy);
        if st.0 != 0 {
            return Err(format!("LsaStorePrivateData 0x{:08X}", st.0));
        }
    }
    Ok(())
}

/// Build an LSA_UNICODE_STRING that borrows `buf` (UTF-16, no NUL required).
/// Length/MaximumLength are in BYTES.
fn lsa_unicode(buf: &[u16]) -> LSA_UNICODE_STRING {
    LSA_UNICODE_STRING {
        Length: (buf.len() * 2) as u16,
        MaximumLength: (buf.len() * 2) as u16,
        Buffer: PWSTR(buf.as_ptr() as *mut u16),
    }
}

fn write_result(path: Option<&str>, ok: bool, step: &str, error: Option<&str>) {
    let path = match path {
        Some(p) => p,
        None => return,
    };
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let err = match error {
        Some(e) => format!("\"{}\"", esc(e)),
        None => "null".to_string(),
    };
    let json = format!(
        "{{\"ok\":{},\"step\":\"{}\",\"error\":{}}}",
        ok,
        esc(step),
        err
    );
    let _ = std::fs::write(path, json);
}

#[cfg(test)]
mod tests {
    use super::split_user;

    #[test]
    fn splits_domain_and_user() {
        assert_eq!(
            split_user("DESKTOP-AB12\\jensj"),
            ("DESKTOP-AB12".to_string(), "jensj".to_string())
        );
    }

    #[test]
    fn local_user_without_domain_gets_dot() {
        assert_eq!(split_user("jensj"), (".".to_string(), "jensj".to_string()));
    }

    #[test]
    fn leading_backslash_is_stripped() {
        assert_eq!(split_user("\\jensj"), (".".to_string(), "jensj".to_string()));
    }
}
