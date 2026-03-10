const fs = require('fs');

console.log('\n  Ether — Big Cart Wall\n');

let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');

// Replace the grid class to make squares bigger
cart = cart.replace(
  'grid grid-cols-8 gap-1.5',
  'grid grid-cols-8 gap-2'
);

// Make empty slots bigger with min height
cart = cart.replace(
  'className="aspect-square rounded-lg flex flex-col items-center justify-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 border-dashed">',
  'className="rounded-lg flex flex-col items-center justify-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 border-dashed" style={{ minHeight: "80px" }}>'
);

// Make filled slots bigger
cart = cart.replace(
  'className={"aspect-square rounded-lg flex flex-col items-center justify-center text-center p-1 transition-all "',
  'className={"rounded-lg flex flex-col items-center justify-center text-center p-2 transition-all "'
);

// Increase font sizes
cart = cart.replace(
  '<span className="text-[10px] font-bold text-white leading-tight truncate w-full">',
  '<span className="text-xs font-bold text-white leading-tight truncate w-full">'
);

cart = cart.replace(
  '<span className="text-[8px] text-white opacity-60 mt-0.5">',
  '<span className="text-[10px] text-white opacity-60 mt-1">'
);

cart = cart.replace(
  '<span className="text-[8px] text-white font-bold animate-pulse mt-0.5">',
  '<span className="text-[10px] text-white font-bold animate-pulse mt-1">'
);

// Make empty slot text bigger
cart = cart.replace(
  '<span className="text-[10px] text-zinc-600">+</span>',
  '<span className="text-lg text-zinc-600">+</span>'
);

cart = cart.replace(
  '<span className="text-[8px] text-zinc-700">',
  '<span className="text-xs text-zinc-500">'
);

// Add min-height style to filled slots
cart = cart.replace(
  'style={{ backgroundColor: slot.color }}>',
  'style={{ backgroundColor: slot.color, minHeight: "80px" }}>'
);

fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
console.log('  UPDATED CartWall.tsx (big squares)');

console.log('\n  Done! App should hot-reload.\n');
