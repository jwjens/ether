const fs = require('fs');

console.log('\n  Ether — Auto-Start from Schedule\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Replace the toggleContinuous function to auto-fill and play
if (!app.includes('autoStart')) {
  app = app.replace(
    "const toggleContinuous = () => { const n = !continuous; setContinuous(n); engine.continuous = n; };",
    [
      "const toggleContinuous = async () => {",
      "    const n = !continuous;",
      "    setContinuous(n);",
      "    engine.continuous = n;",
      "    if (n) {",
      "      // Auto-start: fill queue from schedule and play",
      "      engine.autoAdvance = true;",
      "      setAutoAdv(true);",
      "      engine.shuffle = true;",
      "      setShuffle(true);",
      "      if (engine.getQueue().length === 0) {",
      "        const count = await fillQueueFromSchedule();",
      "        if (count > 0) {",
      "          const q = engine.getQueue();",
      "          if (q.length > 0) {",
      "            const first = q.shift();",
      "            if (first) {",
      "              engine.clearQueue();",
      "              engine.addToQueue(q);",
      "              await engine.loadToDeck('A', first.filePath, first.title, first.artist);",
      "              engine.getDeck('A')?.play();",
      "            }",
      "          }",
      "        }",
      "      }",
      "    }",
      "  };"
    ].join("\n")
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED src/App.tsx (24/7 button auto-starts playback)');
} else {
  console.log('  SKIPPED — autoStart already present');
}

console.log('\n  Done! App should hot-reload.');
console.log('  Now clicking 24/7 will:');
console.log('    1. Turn on AUTO and SHUFFLE automatically');
console.log('    2. Generate a log from the current hour clock');
console.log('    3. Load the first song to Deck A');
console.log('    4. Start playing immediately');
console.log('  One button. Walk away.\n');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "24/7 auto-starts playback from schedule"');
console.log('    git push\n');
