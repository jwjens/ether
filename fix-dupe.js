const fs = require('fs');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Remove the duplicate line
app = app.replace(
  '  const [autoXfade, setAutoXfade] = useState(true);\n\n  const [autoXfade, setAutoXfade] = useState(true);',
  '  const [autoXfade, setAutoXfade] = useState(true);'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('FIXED — removed duplicate autoXfade line');
