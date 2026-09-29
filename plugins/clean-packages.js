const { execSync } = require('child_process');

// Limit concurrency: --parallel starts a clean for all packages at once, which
// can exhaust memory on small VMs
if (process.env.NODE_ENV === 'production') {
  execSync('npx lerna run clean --concurrency 2');
} else {
  execSync('npx lerna run clean --concurrency 2 --no-private');
}
