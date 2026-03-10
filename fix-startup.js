const fs = require('fs');

console.log('  Fixing startup...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Make sure showNowPlaying defaults to false
app = app.replace(
  /const \[showNowPlaying, setShowNowPlaying\] = useState\(true\)/,
  'const [showNowPlaying, setShowNowPlaying] = useState(false)'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  FIXED — showNowPlaying defaults to false');
console.log('  Close app (Alt+F4), then: npm run tauri:dev\n');
