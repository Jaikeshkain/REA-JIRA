// Release build for customers: one minified server file (licensing enforced) + schema; no source, tests or tools.
//   npm run release        → release/server/tracker.mjs, release/server/schema.sql (and the web app in client/dist)
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'server');
rmSync(join(root, 'release'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'server', 'src', 'index.ts')],
  outfile: join(out, 'tracker.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external', // open-source libraries come from node_modules at runtime
  minify: true, // whitespace removed, local names mangled
  legalComments: 'none',
  sourcemap: false,
  define: { __RELEASE__: 'true' }, // turns licence enforcement on
  logLevel: 'warning',
});
copyFileSync(join(root, 'server', 'src', 'schema.sql'), join(out, 'schema.sql'));
console.log(`release/server/tracker.mjs  ${(statSync(join(out, 'tracker.mjs')).size / 1024).toFixed(0)} KB (minified, licensing enforced)`);
