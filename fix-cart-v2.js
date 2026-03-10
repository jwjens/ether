const fs = require('fs');

console.log('\n  Ether — Fix Cart Layout\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Remove cart wall from wherever it currently is
app = app.replace(/\s*\{\/\* Cart Wall.*?\n.*?<CartWall \/>.*?\n.*?<\/div>\s*\)\}/s, '');
app = app.replace(/\s*\{showCarts && \(\s*<div className="bg-zinc-900[^]*?<CartWall \/>\s*<\/div>\s*\)\}/s, '');

// Now find the LivePanel return's outermost closing
// The structure is: return ( <div className="flex gap-3 h-full"> ... </div> ... </div> );
// We want cart wall INSIDE the return but OUTSIDE the flex, before the final );

// Find the LivePanel function
const lpIdx = app.indexOf('function LivePanel(');
if (lpIdx >= 0) {
  // Find the return statement
  const retIdx = app.indexOf('return (', lpIdx);
  if (retIdx >= 0) {
    // Find the matching closing  );
    // The return ends with "  );\n}" for the function
    const funcEndSearch = app.indexOf('\n}\n', retIdx + 100);
    if (funcEndSearch >= 0) {
      // Find the last </div> before the );
      const returnEnd = app.lastIndexOf('  );', funcEndSearch);
      const lastDiv = app.lastIndexOf('</div>', returnEnd);
      
      // Insert cart wall before that last </div>
      const cartWallJsx = `
      {showCarts && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 mt-3" style={{ marginLeft: 0, marginRight: 0 }}>
          <div className="text-[10px] font-bold text-zinc-400 uppercase mb-3">Cart Wall — press CARTS to hide</div>
          <CartWall />
        </div>
      )}
`;
      app = app.slice(0, lastDiv) + cartWallJsx + app.slice(lastDiv);
    }
  }
}

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  FIXED — cart wall moved to bottom, full width');
console.log('  App should hot-reload.\n');
