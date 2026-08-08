#!/usr/bin/env node
/**
 * Builds a package twice: once for `require`, once for `import`.
 *
 * The two packages that emit runtime code were CommonJS only, which every
 * bundler consuming them reports as an optimization bailout - it cannot see
 * through `require` to know what is unused. Nest is CommonJS and stays on the
 * `require` branch; browsers and bundlers take the `import` one.
 *
 *   node scripts/build-dual.mjs packages/protocol
 *
 * The `package.json` written into `dist/esm` is what tells Node those `.js`
 * files are modules. Without it they are read by the rule of the enclosing
 * package - CommonJS - and every import fails on the first `export`.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved rather than run through `npx`: this is called from an npm script in
// a workspace, where `npx` is not always on the path that lifecycle inherits.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const asked = process.argv[2];
if (!asked) {
  console.error('usage: build-dual.mjs <package directory>');
  process.exit(1);
}

// Read from the repository root, not from wherever this was called: an npm
// script runs with the package as its working directory, and the same argument
// has to mean the same thing from both.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = isAbsolute(asked) ? asked : join(root, asked);

const dist = join(target, 'dist');
rmSync(dist, { recursive: true, force: true });

function compile(module, outDir) {
  execFileSync(
    process.execPath,
    [tsc, '-p', 'tsconfig.build.json', '--module', module, '--moduleResolution', 'node10', '--outDir', outDir],
    { cwd: target, stdio: 'inherit' },
  );
}

compile('commonjs', 'dist/cjs');
compile('es2022', 'dist/esm');

writeFileSync(join(dist, 'esm', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
writeFileSync(join(dist, 'cjs', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

console.log(`${asked}: built for require and for import`);
