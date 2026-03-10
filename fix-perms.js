const fs = require('fs');

console.log('\n  Fixing GitHub Actions permissions...\n');

let yml = fs.readFileSync('.github/workflows/build.yml', 'utf8');

// Add permissions after on: block
if (!yml.includes('permissions:')) {
  yml = yml.replace(
    'jobs:',
    'permissions:\n  contents: write\n\njobs:'
  );
  fs.writeFileSync('.github/workflows/build.yml', yml, 'utf8');
  console.log('  FIXED — added write permissions for releases');
} else {
  console.log('  Already has permissions');
}

console.log('\n  Push:');
console.log('    git add -A');
console.log('    git commit -m "fix release permissions"');
console.log('    git push');
console.log('    git tag -f v1.5.0');
console.log('    git push --tags --force\n');
