const fs = require('fs');
const conf = {
  "productName": "Ether",
  "version": "1.9.1",
  "identifier": "com.ether.radio",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Ether",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://itunes.apple.com https://www.instagram.com; img-src 'self' data: blob: https: asset: http://asset.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.ico", "icons/icon.png"]
  },
  "plugins": {
    "sql": {
      "preload": ["sqlite:openair.db"]
    }
  }
};
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2));
console.log('Done');
