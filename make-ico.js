const fs = require('fs');
const path = require('path');

// This script expects a square PNG at C:\openair\icon.png
const sourcePng = path.join(__dirname, 'icon.png');
const destIco = path.join(__dirname, 'src-tauri', 'icons', 'icon.ico');

if (!fs.existsSync(sourcePng)) {
    console.error("❌ Error: Could not find icon.png in C:\\openair");
    process.exit(1);
}

// We use the Tauri CLI's built-in icon generator
// It is the most reliable way to get a valid .ico for Windows
const { execSync } = require('child_process');

try {
    console.log("Creating icon set...");
    // This command takes your PNG and creates the .ico + all required sizes
    execSync(`npx tauri icon ${sourcePng}`, { stdio: 'inherit' });
    console.log("✅ Success! Icons generated in src-tauri/icons/");
} catch (error) {
    console.error("❌ Failed to generate icons:", error.message);
}
