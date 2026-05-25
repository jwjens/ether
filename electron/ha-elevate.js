'use strict';
// Pure builder for the elevated ha-setup.exe launch command. Kept free of
// electron/native deps so the quoting/escaping is unit-testable (ha-elevate.test.js).
//
// A non-elevated process cannot spawn an elevated child directly (Windows returns
// ERROR_ELEVATION_REQUIRED / 740) — the only path is ShellExecute with the "runas"
// verb, which PowerShell's Start-Process wraps cleanly. -Verb RunAs triggers one
// UAC prompt; -PassThru + -Wait lets us recover the helper's exit code.
//
// SECURITY: the password is NEVER passed here. It travels out-of-band over a named
// pipe. Only the verb, file paths, the pipe NAME, and the username reach the
// command line — and every argument is single-quote-escaped against injection.

// PowerShell single-quoted string: the only metacharacter is the single quote
// itself, escaped by doubling. No other character is special inside '...'.
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Returns the -Command payload for: launch <exePath> <args> elevated, wait, and
// propagate its exit code.
function buildElevatePs(exePath, args) {
  const list = args.map(psSingleQuote).join(',');
  return `$p = Start-Process -FilePath ${psSingleQuote(exePath)} -ArgumentList ${list} -Verb RunAs -PassThru -Wait; exit $p.ExitCode`;
}

module.exports = { buildElevatePs, psSingleQuote };
