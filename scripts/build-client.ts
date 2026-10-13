// Bundles the browser application (src/client/main.ts) into
// static/app.js. --minify for production builds.

import { build } from 'esbuild';

const minify = process.argv.includes('--minify');
await build({
  entryPoints: [new URL('../src/client/main.ts', import.meta.url).pathname],
  outfile: new URL('../static/app.js', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'edge110'],
  platform: 'browser',
  charset: 'ascii',
  legalComments: 'none',
  minify,
  sourcemap: minify ? false : 'linked',
  logLevel: 'warning',
});
console.log(`static/app.js built${minify ? ' (minified)' : ''}`);
