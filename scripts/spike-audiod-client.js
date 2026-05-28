// Validates electron/audio-daemon-client.js standalone (Item 10 Phase 2 Step 1) — without
// launching the Electron GUI. Proves: ensure() spawns+connects the daemon, cmd() round-trips,
// events forward to the handler, and the client RECONNECTS (respawns) after the daemon dies.
//   node scripts/spike-audiod-client.js
process.env.ETHER_AUDIO_DAEMON = "1";
const cp = require("child_process");
const client = require("../electron/audio-daemon-client");

let events = 0;
client.setEventHandler(() => { events++; });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitConnected(timeoutMs) {
  const t0 = Date.now();
  while (!client.isConnected() && Date.now() - t0 < timeoutMs) { client.ensure(); await sleep(200); }
  return client.isConnected();
}

(async () => {
  let ok = true;
  console.log("isEnabled:", client.isEnabled());

  if (!(await waitConnected(6000))) { console.error("❌ never connected"); process.exit(1); }
  console.log("✅ connected (daemon spawned by client)");

  console.log("ping →", await client.cmd("ping"));
  console.log("init(99) →", await client.cmd("init", { stationId: 99 }));
  const st = await client.cmd("getState", { stationId: 99 });
  console.log("✅ getState round-trip:", st && typeof st === "object" ? "object returned" : st);

  await sleep(1200); // collect a few forwarded events (levels broadcast for metered stn 99)
  console.log((events > 0 ? "✅" : "⚠️ ") + " forwarded events received:", events);

  // Reconnect test: kill the daemon, confirm the client re-establishes (respawns).
  console.log("\nkilling daemon to test reconnect…");
  cp.execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\' OR Name=\'electron.exe\' OR Name=\'Ether.exe\'\\" | Where-Object { $_.CommandLine -like \'*ether-audiod*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { stdio: "ignore" });
  await sleep(1500);
  console.log("connected right after kill:", client.isConnected());
  const recon = await waitConnected(8000);
  console.log((recon ? "✅" : "❌") + " reconnected after daemon death:", recon);
  if (recon) console.log("ping after reconnect →", await client.cmd("ping"));
  ok = ok && recon && events > 0;

  client.stop();
  // best-effort cleanup of the daemon we spawned
  try { cp.execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\' OR Name=\'electron.exe\' OR Name=\'Ether.exe\'\\" | Where-Object { $_.CommandLine -like \'*ether-audiod*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { stdio: "ignore" }); } catch {}
  console.log("\n→ STEP 1 CLIENT VERDICT: " + (ok ? "✅ spawn + forward + reconnect all work" : "❌ see above"));
  process.exit(ok ? 0 : 1);
})();
