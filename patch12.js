const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// 1. Add showDeckConfig state if missing
if (!c.includes("showDeckConfig")) {
  c = c.replace(
    'const [showCarts, setShowCarts] = useState(false);',
    'const [showCarts, setShowCarts] = useState(false);\n  const [showDeckConfig, setShowDeckConfig] = useState(false);'
  );
  console.log("Added showDeckConfig state");
}

// 2. Add DeckConfigurator modal before closing EtherErrorBoundary
if (!c.includes("DeckConfigurator")) {
  c = c.replace(
    '{skinPickerPos && (',
    `{showDeckConfig && (
        <DeckConfigurator
          onClose={() => setShowDeckConfig(false)}
          onApply={(configs) => { saveDeckConfigs(configs); setShowDeckConfig(false); }}
        />
      )}
      {skinPickerPos && (`
  );
  console.log("Added DeckConfigurator modal");
}

// 3. Add DECKS button to toolbar row if missing
if (!c.includes('"DECKS"') && !c.includes("onConfigureDecks")) {
  c = c.replace(
    '<button\n          onClick={onConfigureDecks}',
    '<button\n          onClick={() => setShowDeckConfig(true)}'
  );
}

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
