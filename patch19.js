const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  ') : compact ? (\n                  <ChannelStrip\n                    label={config?.label || slot}',
  ') : deckType === "desk" && compact ? (\n                  <InlineProducerDesk episodeTitle={undefined} />\n                ) : compact ? (\n                  <ChannelStrip\n                    label={config?.label || slot}'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
