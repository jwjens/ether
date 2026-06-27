// electron/gpio-engine.js — Broadcast GPIO (General Purpose I/O) engine.
//
// Manages TCP/UDP connections to GPIO hardware for contact closures.
// GPI (inputs):  external triggers → fire macros/commands in Ether
// GPO (outputs): station events → send signals to external hardware
//
// Protocol support:
//   - TCP text (newline-delimited commands, e.g., "GPI:1:ON\n")
//   - UDP datagram (same format)
//   - HTTP webhook (GET/POST to trigger GPI events)
//
// Common hardware this supports:
//   - Axia GPIO nodes (TCP port 93)
//   - WheatNet Logic (TCP)
//   - Broadcast Tools SS-series (TCP/Serial bridge)
//   - SAS Sierra (TCP)
//   - Any device speaking simple text over TCP/UDP

const net = require("net");
const dgram = require("dgram");

// Active connections
const connections = new Map(); // id -> { type, socket, host, port, status }
// GPI pin → action mappings (loaded from DB)
let gpiMappings = []; // { device_id, pin, action_type, action_value }
// GPO state tracking
const gpoState = new Map(); // "deviceId:pin" -> boolean

// Event callback — set by installGpioEngine
let onGpiEvent = null;
let getDb = () => null;   // resolves the LIVE connection (set in install); survives a reopen

function installGpioEngine(ipcMain, database, opts = {}) {
  getDb = (typeof database === 'function') ? database : () => database;
  onGpiEvent = opts.onGpiEvent || null;

  // Ensure tables exist
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS gpio_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'tcp',
        host TEXT NOT NULL DEFAULT '127.0.0.1',
        port INTEGER NOT NULL DEFAULT 93,
        is_active INTEGER DEFAULT 1,
        auto_connect INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS gpio_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER REFERENCES gpio_devices(id),
        direction TEXT NOT NULL DEFAULT 'gpi',
        pin INTEGER NOT NULL DEFAULT 1,
        action_type TEXT NOT NULL DEFAULT 'command',
        action_value TEXT NOT NULL DEFAULT '',
        label TEXT,
        is_active INTEGER DEFAULT 1
      );
    `);
  } catch (e) { console.warn("[GPIO] table init:", e.message); }

  // Load mappings
  loadMappings();

  // ── IPC handlers ──────────────────────────────────────────────

  ipcMain.handle("gpio:list-devices", () => {
    const devices = getDb().prepare("SELECT * FROM gpio_devices ORDER BY name").all();
    return devices.map(d => ({
      ...d,
      status: connections.has(d.id) ? connections.get(d.id).status : "disconnected",
    }));
  });

  ipcMain.handle("gpio:add-device", (_evt, device) => {
    const { name, protocol, host, port } = device;
    getDb().prepare("INSERT INTO gpio_devices (name, protocol, host, port) VALUES (?, ?, ?, ?)")
      .run(name || "GPIO Device", protocol || "tcp", host || "127.0.0.1", port || 93);
    return true;
  });

  ipcMain.handle("gpio:update-device", (_evt, id, device) => {
    const { name, protocol, host, port, is_active, auto_connect } = device;
    getDb().prepare("UPDATE gpio_devices SET name=?, protocol=?, host=?, port=?, is_active=?, auto_connect=? WHERE id=?")
      .run(name, protocol, host, port, is_active ?? 1, auto_connect ?? 0, id);
    return true;
  });

  ipcMain.handle("gpio:delete-device", (_evt, id) => {
    disconnect(id);
    getDb().prepare("DELETE FROM gpio_mappings WHERE device_id = ?").run(id);
    getDb().prepare("DELETE FROM gpio_devices WHERE id = ?").run(id);
    return true;
  });

  ipcMain.handle("gpio:connect", (_evt, id) => connect(id));
  ipcMain.handle("gpio:disconnect", (_evt, id) => disconnect(id));

  ipcMain.handle("gpio:list-mappings", (_evt, deviceId) => {
    return getDb().prepare("SELECT * FROM gpio_mappings WHERE device_id = ? ORDER BY direction, pin").all(deviceId);
  });

  ipcMain.handle("gpio:add-mapping", (_evt, mapping) => {
    const { device_id, direction, pin, action_type, action_value, label } = mapping;
    getDb().prepare("INSERT INTO gpio_mappings (device_id, direction, pin, action_type, action_value, label) VALUES (?,?,?,?,?,?)")
      .run(device_id, direction || "gpi", pin || 1, action_type || "command", action_value || "", label || null);
    loadMappings();
    return true;
  });

  ipcMain.handle("gpio:update-mapping", (_evt, id, mapping) => {
    const { pin, action_type, action_value, label, is_active } = mapping;
    getDb().prepare("UPDATE gpio_mappings SET pin=?, action_type=?, action_value=?, label=?, is_active=? WHERE id=?")
      .run(pin, action_type, action_value, label, is_active ?? 1, id);
    loadMappings();
    return true;
  });

  ipcMain.handle("gpio:delete-mapping", (_evt, id) => {
    getDb().prepare("DELETE FROM gpio_mappings WHERE id = ?").run(id);
    loadMappings();
    return true;
  });

  ipcMain.handle("gpio:send-gpo", (_evt, deviceId, pin, state) => {
    sendGpo(deviceId, pin, state);
    return true;
  });

  ipcMain.handle("gpio:get-status", () => {
    const statuses = {};
    for (const [id, conn] of connections) {
      statuses[id] = { status: conn.status, host: conn.host, port: conn.port };
    }
    return statuses;
  });

  // Auto-connect devices on startup
  setTimeout(() => {
    if (!getDb()) return;
    try {
      const autoDevices = getDb().prepare("SELECT * FROM gpio_devices WHERE auto_connect = 1 AND is_active = 1").all();
      for (const d of autoDevices) {
        connect(d.id).catch(e => console.warn(`[GPIO] auto-connect ${d.name} failed:`, e));
      }
    } catch (e) { console.warn("[GPIO] auto-connect scan failed:", e.message); }
  }, 3000);

  console.log("[GPIO] engine installed");
}

// ── Connection management ────────────────────────────────────

async function connect(deviceId) {
  const device = getDb().prepare("SELECT * FROM gpio_devices WHERE id = ?").get(deviceId);
  if (!device) throw new Error(`GPIO device ${deviceId} not found`);

  disconnect(deviceId); // clean up any existing connection

  if (device.protocol === "tcp") {
    return connectTcp(device);
  } else if (device.protocol === "udp") {
    return connectUdp(device);
  }
  throw new Error(`Unknown protocol: ${device.protocol}`);
}

function connectTcp(device) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const conn = { type: "tcp", socket, host: device.host, port: device.port, status: "connecting", buffer: "" };
    connections.set(device.id, conn);

    socket.connect(device.port, device.host, () => {
      conn.status = "connected";
      console.log(`[GPIO] TCP connected: ${device.name} (${device.host}:${device.port})`);
      resolve({ status: "connected" });
    });

    socket.on("data", (data) => {
      conn.buffer += data.toString();
      // Process complete lines
      let idx;
      while ((idx = conn.buffer.indexOf("\n")) >= 0) {
        const line = conn.buffer.slice(0, idx).trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (line) handleGpiMessage(device.id, line);
      }
    });

    socket.on("error", (err) => {
      console.error(`[GPIO] TCP error on ${device.name}:`, err.message);
      conn.status = "error";
    });

    socket.on("close", () => {
      conn.status = "disconnected";
      connections.delete(device.id);
      console.log(`[GPIO] TCP disconnected: ${device.name}`);
    });

    socket.setTimeout(5000, () => {
      if (conn.status === "connecting") {
        socket.destroy();
        conn.status = "timeout";
        reject(new Error("Connection timeout"));
      }
    });
  });
}

function connectUdp(device) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const conn = { type: "udp", socket, host: device.host, port: device.port, status: "listening" };
    connections.set(device.id, conn);

    socket.on("message", (msg) => {
      const line = msg.toString().trim();
      if (line) handleGpiMessage(device.id, line);
    });

    socket.bind(device.port, () => {
      console.log(`[GPIO] UDP listening: ${device.name} on port ${device.port}`);
      resolve({ status: "listening" });
    });

    socket.on("error", (err) => {
      console.error(`[GPIO] UDP error on ${device.name}:`, err.message);
      conn.status = "error";
    });
  });
}

function disconnect(deviceId) {
  const conn = connections.get(deviceId);
  if (!conn) return;
  try {
    if (conn.type === "tcp") conn.socket.destroy();
    else if (conn.type === "udp") conn.socket.close();
  } catch {}
  connections.delete(deviceId);
}

// ── GPI message parsing ──────────────────────────────────────
// Supports common broadcast GPIO formats:
//   "GPI:1:ON"   / "GPI:1:OFF"      — standard
//   "PIN 1 HIGH" / "PIN 1 LOW"      — alternative
//   "1"          / "0"              — raw binary
//   "CC 1 1"     / "CC 1 0"        — contact closure

function handleGpiMessage(deviceId, message) {
  const upper = message.toUpperCase().trim();
  let pin = null, state = null;

  if (upper.startsWith("GPI:")) {
    const parts = upper.split(":");
    pin = parseInt(parts[1]);
    state = parts[2] === "ON" || parts[2] === "1" || parts[2] === "HIGH";
  } else if (upper.startsWith("PIN ")) {
    const parts = upper.split(/\s+/);
    pin = parseInt(parts[1]);
    state = parts[2] === "HIGH" || parts[2] === "ON" || parts[2] === "1";
  } else if (upper.startsWith("CC ")) {
    const parts = upper.split(/\s+/);
    pin = parseInt(parts[1]);
    state = parts[2] === "1" || parts[2] === "ON";
  } else if (/^\d+$/.test(upper)) {
    pin = 1;
    state = upper !== "0";
  }

  if (pin === null || state === null) {
    console.log(`[GPIO] unrecognized message from device ${deviceId}: "${message}"`);
    return;
  }

  console.log(`[GPIO] GPI event: device=${deviceId} pin=${pin} state=${state ? "ON" : "OFF"}`);

  // Find matching mapping and fire action
  if (state) { // only trigger on rising edge (ON)
    const mapping = gpiMappings.find(m =>
      m.device_id === deviceId && m.pin === pin && m.is_active && m.direction === "gpi"
    );
    if (mapping && onGpiEvent) {
      onGpiEvent(mapping.action_type, mapping.action_value, { deviceId, pin });
    }
  }
}

// ── GPO output ───────────────────────────────────────────────

function sendGpo(deviceId, pin, state) {
  const conn = connections.get(deviceId);
  if (!conn) return false;
  const msg = `GPO:${pin}:${state ? "ON" : "OFF"}\n`;
  try {
    if (conn.type === "tcp") {
      conn.socket.write(msg);
    } else if (conn.type === "udp") {
      const buf = Buffer.from(msg);
      conn.socket.send(buf, 0, buf.length, conn.port, conn.host);
    }
    gpoState.set(`${deviceId}:${pin}`, state);
    return true;
  } catch (e) {
    console.error(`[GPIO] GPO send error:`, e.message);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function loadMappings() {
  try {
    gpiMappings = getDb().prepare("SELECT * FROM gpio_mappings WHERE is_active = 1").all();
  } catch { gpiMappings = []; }
}

module.exports = { installGpioEngine };
