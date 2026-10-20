#!/usr/bin/env bash
# Publishes one release everywhere: run by softwarity/release-flow (its `publish`
# input) once the release commit and tag exist on the runner, before anything is
# pushed. A failure here pushes nothing - no tag, no GitHub Release, no commit.
#
# Maven Central first: it is the registry that validates what it is given
# (signatures, javadoc, pom metadata) and can refuse, and the deploy waits for that
# validation. npm takes whatever it is handed, and no registry gives a version back.
set -euo pipefail

echo "Publishing ${RELEASE_VERSION} (${RELEASE_TAG})"

# The parent pom and quarkus-livewire, signed, with sources and javadoc; the
# conformance fixture is excluded in the pom. Already tested by the workflow.
(cd quarkus && ./mvnw -B -Prelease -DskipTests deploy)

# npm, in dependency order: the protocol first, since every other one names it.
#
# The first three carry `main`/`types` pointing into their own `dist`, so the
# workspace root is the package. The Angular one does not: ng-packagr writes the
# real manifest into `dist`, and that directory *is* the package.
npm publish --workspace @softwarity/livewire-protocol
npm publish --workspace @softwarity/livewire-mock
npm publish --workspace @softwarity/nestjs-livewire
npm publish ./packages/angular/dist
