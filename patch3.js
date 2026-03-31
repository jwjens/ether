const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  'const [showCarts, setShowCarts] = useState(false);',
  'const [showCarts, setShowCarts] = useState(false);\n  const [globalSearch, setGlobalSearch] = useState("");'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
