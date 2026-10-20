#!/usr/bin/env node
/**
 * Bumps every package to the same version, and points them at each other.
 *
 * The wire contract is described on both sides. A release where the server and
 * the client disagree about it is a release nobody can install safely, so there
 * is one version number for the workspace and the cross-dependencies follow it
 * rather than floating on a range.
 *
 *   node scripts/version-all.mjs 0.2.0
 *
 * The Maven poms of quarkus/ follow the same number.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('usage: version-all.mjs <version>');
  process.exit(1);
}

// Whatever is there: the packages land one at a time, and a release before the
// last of them exists is still a release the others have to agree on.
const packages = ['packages/protocol', 'packages/mock', 'packages/nestjs', 'packages/angular'].filter((dir) =>
  existsSync(join(dir, 'package.json')),
);
const names = packages.map((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name);

// The root manifest is not in the list: the release action owns it - it is what
// it bumps, and what it reads to know the version before. This script's job is
// to carry that number to the packages.
for (const dir of packages) {
  const path = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = version;
  // Pinned, not ranged: two packages of one contract move together or not at all.
  //
  // `devDependencies` included, and it is not a detail: the mock is a
  // devDependency of the two servers, and a version left behind there stops
  // matching the workspace - npm then looks for it in the registry, where it is
  // not, and every `npm ci` in the repository fails at once.
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of names) {
      if (manifest[field]?.[name]) {
        manifest[field][name] = version;
      }
    }
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name} → ${version}`);
}

// The Quarkus server, a Maven reactor: the parent's version and the one each module names as
// its parent. Only those - the first <version> of a pom, and the one inside <parent> - so a
// dependency's version is never touched.
for (const pom of ['quarkus/pom.xml', 'quarkus/runtime/pom.xml', 'quarkus/conformance/pom.xml'].filter((path) => existsSync(path))) {
  const before = readFileSync(pom, 'utf8');
  const after = pom === 'quarkus/pom.xml'
    ? before.replace(/(<artifactId>quarkus-livewire-parent<\/artifactId>\s*<version>)[^<]+(<\/version>)/, `$1${version}$2`)
    : before.replace(/(<parent>[\s\S]*?<version>)[^<]+(<\/version>[\s\S]*?<\/parent>)/, `$1${version}$2`);
  if (after === before && !before.includes(`<version>${version}</version>`)) {
    console.error(`${pom}: no version to set`);
    process.exit(1);
  }
  writeFileSync(pom, after);
  console.log(`${pom} → ${version}`);
}
