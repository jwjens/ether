const fs = require('fs');

fs.writeFileSync('src-tauri/capabilities/default.json', JSON.stringify({
  "identifier": "default",
  "description": "Default permissions for Ether",
  "windows": ["main", "nowplaying"],
  "permissions": [
    "core:default",
    "core:window:allow-create",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:webview:allow-create-webview-window",
    "sql:default",
    "sql:allow-execute",
    "sql:allow-select",
    "dialog:default",
    "dialog:allow-open",
    "fs:default",
    "fs:read-all",
    {
      "identifier": "fs:scope",
      "allow": [{"path": "**"}]
    }
  ]
}, null, 2));

console.log('Done');
