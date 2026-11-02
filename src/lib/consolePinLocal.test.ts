import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// No dashboard failure can lock a PIN at the Ether console (Jeff, 2026-11-02): the console checks PINs against its own
// local users table, and the user mirror is ONE-WAY (install → server) — nothing the server holds (its lock fields
// included) ever reaches the console. The server side is test/team-login-email.test.js in ether-backend.
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("the Ether console's PINs never come from the server", () => {
  it("the user mirror only sends: it never reads the server's answer", () => {
    const s = read("lib/syncUsers.ts");
    expect(s).toMatch(/await fetch\(`\$\{ETHER_BACKEND_URL\}\/api\/account\/users\/sync`/);
    expect(s).not.toMatch(/\.json\(\)|locked_until|failed_attempts|UPDATE users|INSERT INTO users/);
  });
  it("the console sign-in checks the local PIN with no network and no server lock", () => {
    const s = read("components/UserLogin.tsx");
    expect(s).not.toMatch(/fetch\(|ETHER_BACKEND_URL|locked_until|failed_attempts|\/api\/auth/);
  });
});
