# Livewire — mémo de passation

Ce fichier dit **où en est le dépôt, ce qui a déjà été tranché, et ce qu'il ne
faut pas défaire**. La feuille de route détaillée est dans [TODO.md](./TODO.md) ;
le contrat normatif est dans [packages/protocol/SPEC.md](./packages/protocol/SPEC.md).
Ici : l'état, les conventions, et les pièges.

État au **8 août 2026**. Dépôt `git@github.com:softwarity/livewire.git`, branche
`main`. **0.1.0 est publiée** : quatre paquets sur npm, `go/v0.1.0` sur le proxy
Go, et une Release GitHub dont le corps vient de `RELEASE_NOTES.md`.

---

## 1. Ce que c'est

Un client s'abonne à une **requête** sur un WebSocket ; il reçoit sa réponse,
puis toutes les réponses suivantes. La fenêtre (filtres, tri, `offset`, `limit`)
fait partie de l'abonnement — c'est ce qui rend une liste *paginée* poussable.

Extrait du socle temps réel de `fpl-svc` / `fpl-ui` (en production), généralisé.

## 2. État

| | Paquet | Tests |
|---|---|---|
| ✅ | `packages/protocol` — types + `SPEC.md` normative + le diff (`snapshotOf`, `patchOf`, `signatureOf`) | 15 |
| ✅ | `packages/mock` — serveur en mémoire **et** les 12 scénarios de conformité | 28 |
| ✅ | `packages/nestjs` — `@softwarity/nestjs-livewire` | 49 |
| ✅ | `packages/angular` — `@softwarity/livewire` | 23 |
| ✅ | `go/` — `github.com/softwarity/livewire/go` | 32, sous `-race` |
| ✅ | `docs/` — site GitHub Pages, 7 pages, **démo qui tourne** | — |

Les 12 scénarios passent contre **trois** serveurs : en mémoire, NestJS (socket
`ws` réel), Go (binaire compilé, socket réel).

CI : `unit-tests.yml` (job TypeScript + job Go), `release.yml` (bump commun,
pose `vX.Y.Z` **et** `go/vX.Y.Z`, pousse avec `PAT_TOKEN`), `tag.yml` (publie sur
npm dans l'ordre protocol → mock → nestjs → angular, après le build), `deploy-doc.yml`.

**Il reste** : le niveau 2 (commandes et notifications, TODO §5). Rien d'autre
n'est en cours.

## 3. Carte du dépôt

```
packages/protocol/   le contrat. Types + SPEC.md + le diff (normatif, partagé)
packages/mock/       serveur en mémoire ; src/conformance.ts = Wire, Conversation, SCENARIOS
packages/nestjs/     LivewireModule.forRoot, LivewireGateway, WindowedSource/PagedSource/SingleWindowSource
packages/angular/    LivewireClient, LiveList, LiveTopic, LiveWindowDataSource, LiveIndicatorComponent
go/                  protocol.go, patch.go, window.go (Registry), server.go, cmd/conformance (fixture de test)
docs/                site Angular 21 autonome (pas un workspace npm) publié sur GitHub Pages
scripts/version-all.mjs   passe tous les paquets au même numéro et épingle les dépendances croisées
```

## 4. Décisions tranchées — ne pas rouvrir sans raison

Chacune a coûté une session de débogage ou une discussion déjà eue.

**Protocole**

- On pousse **le résultat de la requête**, jamais `insert`/`update`/`delete`.
  Refus fondateur : sinon le navigateur réimplémente le prédicat du filtre et le
  comparateur du tri, libres de diverger du SQL.
- `updatedAt` est la **version** de la ligne : *tout ce que la ligne affiche* doit
  y être, y compris ce qui dérive de l'horloge. C'est la règle qu'on répète
  partout, et c'est celle qu'on oublie.
- Le diff est **par abonnement**, jamais par fenêtre (un abonné arrivé en cours
  de route ne détient pas les mêmes lignes).
- Une lecture inchangée **ne publie rien** (§5.3). Comparaison par
  `signatureOf`, jamais à la main : `total` et `pivot` en font partie.
- Refus de connexion : **frame d'erreur d'abord, fermeture 1008 ensuite**.

**Serveur NestJS**

- `share({ connector: ReplaySubject, resetOnComplete: false, resetOnRefCountZero: true })`,
  pas `shareReplay({ refCount: true })` : une source statique (`wake()` =
  `of(null)`) complète immédiatement et le partage était perdu.
- Le comptage de références est écrit à la main (`watchers` + drapeau `done`) :
  `finalize` se déclenche aussi à la complétion et retirait la clé d'une fenêtre
  encore valable.
- La gateway configurée est définie **dans** `forRoot` (le chemin est un argument
  de décorateur) avec un constructeur explicite (`design:paramtypes` ne s'hérite
  pas).

**Client Angular**

- `WebSocket` natif, **jamais** `rxjs/webSocket` : celui-ci lie la connexion au
  nombre d'abonnés (neuf sockets pour une liste).
- Un id d'abonnement **unique par fenêtre**, jamais réutilisé.
- **Le `LiveWindowDataSource` s'injecte le `ChangeDetectorRef` de la vue** et
  appelle `markForCheck()` à chaque publication : en zoneless, rien d'autre ne
  reprogramme un cycle depuis un callback socket (`markViewDirty` appelle
  `changeDetectionScheduler.notify`). Construit hors contexte d'injection, il
  jette — c'est voulu. Il n'y a **plus** de `revision()` : deux façons de faire
  la même chose embrouillaient tout le monde. `test/repaint.spec.ts` compte les
  appels : rien sur une trame refusée, rien quand la fenêtre bouge, une fois
  quand sa réponse arrive.
- La taille de fenêtre est une **constante par écran**, jamais dérivée du
  viewport (boucle publier → remesurer → publier qui gèle le rendu). C'est un
  budget de transport : certains proxies coupent au-delà de ~64 kB.
- Le clamp de couverture dans `LiveWindowDataSource.follow()` n'est pas
  cosmétique : l'offset centré puis arrondi à un bloc peut tomber à côté des
  lignes rendues, et comme il est déjà l'offset courant, la bande reste vide.
- L'indicateur remplace le bouton *refresh*, il ne s'y ajoute pas.

**Doc**

- Le faux serveur est **dans le jeu de tests**, pas à côté : une démo qui ment
  est pire que pas de démo. Écrire la conformité contre lui a trouvé trois vrais
  défauts le soir même.
- `docs/` dépend des paquets en `file:` vers leur **build**, pas vers leurs
  sources, et `deploy-doc.yml` construit les paquets avant le site. Compiler les
  sources depuis `docs/` a été essayé et abandonné : leurs imports nus se
  résolvent depuis `livewire/node_modules` (Angular 19) pendant que le site
  compile en 21, et un `paths` sur `@angular/*` ne rattrape pas les sous-chemins
  (`@angular/cdk/collections` n'est pas un dossier). D'où aussi
  `preserveSymlinks: true` dans `docs/angular.json`.
- Les extraits de code sont passés en **`[code]="champ"`**, pas en contenu
  projeté : un template Angular oblige à échapper `{`, `@`, `<` dans chaque
  extrait.

## 5. Conventions de travail

- **Commits** : auteur `hhfrancois <francois.achache@gmail.com>`. **Jamais** de
  trailer `Co-Authored-By: Claude`, jamais d'identité git inventée. (Déjà
  reproché deux fois ; l'historique a dû être réécrit.)
- **Une seule version pour tous les paquets**, et **une seule action de release
  qui pose deux tags** (`vX.Y.Z` + `go/vX.Y.Z`). Go n'a pas de registre : le tag
  *est* la publication.
- `tag.yml` ne réagit qu'à `v*` — surtout pas `*`, sinon le tag Go republie tout.
- **RELEASE_NOTES.md** : n'écrire que dans la section du haut (celle que
  `release.yml` n'a pas encore refermée). Ne jamais toucher la ligne d'en-tête.
- **La conformité passe avant toute nouvelle implémentation**, pas après.
- Pas d'option « au cas où » : chaque option est une promesse à tenir dans les
  trois implémentations et un scénario de conformité de plus.
- Éviter `unknown` dans les types publics quand un type plus précis existe
  (`JsonValue` a été introduit pour ça).

## 6. Commandes

```bash
npm install                      # workspaces npm à la racine
npm run build                    # protocol → mock → nestjs → angular (ordre imposé : nestjs/angular importent protocol construit)
npm test                         # les quatre paquets
npm test -w @softwarity/livewire # un seul

cd go && go vet ./... && go test -race ./...

# Le site consomme les paquets construits : `npm run build` à la racine d'abord.
cd docs && npm ci && npm start   # le site, avec la démo, sur :4200
cd docs && npm run build         # ce que fait deploy-doc.yml (avec --base-href /livewire/)
```

Le job Go de la conformité TypeScript compile un binaire (`go build` puis
exécution) — `go run` laissait un processus parent et faisait pendre jest deux
minutes. La suite se saute d'elle-même là où Go est absent.

## 7. Ce qui reste

**Niveau 2** : `command(name, payload)` avec accusé et `notify(topic, payload)`.
Détail et justification dans TODO §5.

Tout le reste — README, doc, CI, conformité, publication — est fait.

### Releaser

Onglet Actions → *Create Tag/Release* → `patch` / `minor` / `major`. Le reste
est automatique : les quatre paquets et les deux lockfiles passent au numéro,
`softwarity/release-flow` referme `## NEXT RELEASE` sur la version et publie la
Release, `v X.Y.Z` déclenche npm et `go/vX.Y.Z` publie le module Go.

Trois pièges déjà payés, tous dans les workflows :

- `version-all.mjs` doit toucher les **devDependencies** — le mock en est une
  pour les deux serveurs, et une version laissée derrière envoie npm chercher au
  registre ce qui est dans le workspace : tous les `npm ci` du dépôt tombent.
- Le bump passe **avant** le build : le site de doc verrouille la version écrite
  dans la sortie de build des paquets.
- Publier, c'est `npm ci` → **`npm run build`** → `npm test`. Un paquet nomme son
  voisin par son nom npm, qui résout vers un `dist/` que le build seul produit.
