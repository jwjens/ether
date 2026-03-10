const fs = require('fs');

console.log('\n  Ether — Cart Wall 2 Rows + Scroll\n');

let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');

// Replace the grid container to limit height to 2 rows with scroll
cart = cart.replace(
  '<div className="grid grid-cols-8 gap-2">',
  '<div className="grid grid-cols-8 gap-2 overflow-y-auto" style={{ maxHeight: "220px" }}>'
);

fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
console.log('  UPDATED CartWall.tsx (2 rows visible + scroll)');
console.log('  Kill switch already works — click or press hotkey again to stop.');
console.log('  App should hot-reload.\n');
