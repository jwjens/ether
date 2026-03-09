const fs = require('fs');

const conf = {
  productName: "Ether",
  version: "0.1.0",
  identifier: "com.ether.radio",
  build: {
    frontendDist: "../dist",
    devUrl: "http://localhost:1420",
    beforeDevCommand: "npm run dev",
    beforeBuildCommand: "npm run build"
  },
  app: {
    windows: [
      {
        title: "Ether",
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 600,
        resizable: true
      }
    ],
    security: {
      csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self' asset: https://asset.localhost; img-src 'self' asset: https://asset.localhost",
      assetProtocol: {
        enable: true,
        scope: ["**"]
      }
    }
  },
  bundle: {
    active: true,
    targets: "all",
    icon: [
      "icons/icon.ico",
      "icons/icon.png"
    ]
  },
  plugins: {
    sql: {
      preload: ["sqlite:openair.db"]
    }
  }
};

fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2), 'utf8');
console.log('FIXED tauri.conf.json');
console.log('Run: npm run tauri:build');
