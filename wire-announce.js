const fs = require('fs');

console.log('  Wiring Announcements into App...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('"announce"')) {
  app = app.replace(
    'import VoiceTracker from "./components/VoiceTracker";',
    'import VoiceTracker from "./components/VoiceTracker";\nimport Announcements, { startAnnouncementEngine } from "./components/Announcements";'
  );

  app = app.replace(
    'type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "streaming" | "settings";',
    'type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings";'
  );

  app = app.replace(
    '{ id: "voicetrack" as Panel, label: "Voice Track" },',
    '{ id: "voicetrack" as Panel, label: "Voice Track" },\n    { id: "announce" as Panel, label: "Announce" },'
  );

  app = app.replace(
    '{panel === "voicetrack" && <VoiceTracker',
    '{panel === "announce" && <Announcements />}\n          {panel === "voicetrack" && <VoiceTracker'
  );

  app = app.replace(
    '  useEffect(() => {\n    engine.init();',
    '  useEffect(() => {\n    engine.init();\n    startAnnouncementEngine();'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  DONE — Announce tab added');
} else {
  console.log('  Already wired');
}

console.log('  npm run tauri:dev\n');
