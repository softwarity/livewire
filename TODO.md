# Livewire — feuille de route

Ce fichier dit **où on en est, ce qui reste, et pourquoi c'est dans cet ordre**.
Il n'est pas une liste de tâches : chaque entrée porte la décision qui l'a
placée là, pour qu'on n'ait pas à la reprendre dans trois mois.

---

## Le périmètre, et pourquoi il est étroit

Livewire synchronise **le résultat d'une requête**. Un client s'abonne à une
question, reçoit sa réponse, puis toutes ses réponses suivantes.

Ce qu'on a explicitement **refusé** de faire, et qui doit le rester :

- **Pas de pub/sub générique.** Pousser `insert` / `update` / `delete` et laisser
  le client maintenir sa liste oblige à réimplémenter côté navigateur le
  prédicat du filtre et le comparateur du tri — deux copies libres de diverger
  du SQL. C'est le refus fondateur de la conception, et c'est ce qui distingue
  Livewire de `postgres_changes` (Supabase) ou d'un canal Socket.IO.
- **Pas de base de données.** Livewire ne possède rien. Il ne remplace pas
  Firebase : ni cache local, ni écritures optimistes, ni résolution de conflits,
  ni règles de sécurité déclaratives. Il tourne sur *ta* base, avec *ton* SQL.
- **Pas de rendu serveur.** Malgré le nom, rien à voir avec Laravel Livewire ou
  Phoenix LiveView : eux poussent du HTML parce que le serveur possède le
  rendu ; nous poussons des données et le client rend.

Le périmètre restreint est ce qui rend la spécification courte (deux pages), la
suite de conformité tenable (une trentaine de scénarios) et un portage Go
réaliste (trois jours). Élargir se paie sur ces trois lignes à la fois.

---

## État

| | |
|---|---|
| ✅ | `packages/protocol` — types + **SPEC.md normative** |
| ⬜ | `packages/nestjs` — implémentation serveur |
| ⬜ | `packages/angular` — implémentation client |
| ⬜ | suite de conformité |
| ⬜ | doc GitHub Pages, CI, publication |
| ⬜ | niveau 2 : commandes et notifications |
| ⬜ | implémentation Go |

---

## 1. `packages/nestjs` — le serveur

Extrait de `fpl-svc/src/modules/realtime/`, qui est en production et a payé ses
bugs. Ce qui change à l'extraction :

- **La gateway ne connaît plus de rôles.** Aujourd'hui elle lit `KNOWN_ROLES` et
  deux en-têtes ; ça devient un callback `authorize(request): boolean` passé au
  `forRoot`. C'est la **seule** accroche applicative de tout le socle serveur.
- **Le chemin devient une option** (`path`), au lieu d'être écrit en dur.

Ce qui ne change pas, et qu'il ne faut pas « améliorer » en chemin :

- `WindowedSource` garde ses quatre méthodes : `readQuery`, `wake`, `keyOf`,
  `read`. Elles ont été trouvées à l'usage, pas dessinées.
- Le diff reste **par abonnement**, jamais par fenêtre. Diffuser un patch
  identique à tout le monde est faux pour quiconque s'est abonné en cours de
  route, et il n'y a aucun moyen bon marché de savoir qui.
- Une lecture inchangée ne publie rien. Voir SPEC §5.3.

**Tests attendus** (ils existent en partie dans fpl-svc, à porter et compléter) :

- `patchOf` : ligne ajoutée, retirée, modifiée, **déplacée sans changer de
  version** (ne doit pas être dans `upserted`), fenêtre vidée, fenêtre vide → vide.
- `WindowedSource` : deux abonnés à la même clé = une lecture ; le départ du
  dernier abonné arrête la lecture et retire la clé ; une lecture identique ne
  publie pas ; une rafale est groupée.
- Gateway : `subscribe` sur un id déjà ouvert ferme le précédent et repart à
  `sequence: 1` ; `unsubscribe` inconnu ignoré ; topic inconnu → `error` sans
  ouvrir ; socket refusé → frame **puis** fermeture 1008 ; trame illisible
  ignorée sans fermer.

## 2. `packages/angular` — le client

Extrait de `fpl-ui/src/app/{core/services,shared}/`. Ce qui change :

- **Le chemin devient une option** (`provideLivewire({ path })`).
- **`<lib-live-indicator>` doit se détacher du thème FPL** : il tire aujourd'hui
  sur `--fpl-warning` et sur l'animation `beat` d'un `_icon.scss` applicatif.
  Des variables CSS à défauts raisonnables, et l'animation embarquée.

Points à ne pas perdre à la réécriture — chacun a coûté une session de débogage :

- **Un `WebSocket` natif, pas `rxjs/webSocket`.** Ce sujet lie la connexion au
  nombre d'abonnés : il ferme quand le dernier part, rouvre au suivant, et un
  `retry` autour fait les deux à chaque erreur. Trois pannes distinctes sont
  venues de ce couplage, dont une où il complétait sans jamais se connecter.
- **Un id d'abonnement unique par fenêtre**, jamais réutilisé : sinon le
  `unsubscribe` de la page qu'on quitte annule l'abonnement de celle qu'on ouvre.
- **`revision()` doit être lu dans le template.** En zoneless, une ligne arrivant
  d'un callback socket ne déclenche aucun cycle de détection. C'est le seul geste
  contre-intuitif de toute l'API ; la lib devrait **avertir en développement** si
  le signal n'est jamais lu (une piste : un `effect` qui vérifie qu'il a été
  consommé au premier repaint).
- **`LiveWindowDataSource` : la fenêtre doit couvrir la plage rendue.** L'offset
  centré puis arrondi à un bloc peut tomber à côté des lignes affichées — une
  bande de lignes vides qui ne se remplit jamais, parce que l'offset calculé est
  déjà l'offset courant. Le clamp final n'est pas un détail de confort.
- **La taille de fenêtre est une constante par écran**, jamais dérivée du
  viewport : publier → le viewport se remesure → nouvelle fenêtre → publier est
  une boucle qui gèle le rendu.

**Tests attendus** : `RealtimeList` (snapshot, patch, trou de séquence, patch
nommant une ligne inconnue), `LiveWindowDataSource` (couverture de la plage
rendue, hystérésis, plage vide ignorée, `ensure`, marquage `fresh` uniquement
sur patch), `LiveTopic` (id unique par fenêtre, resync nomme le bon id).

## 3. Suite de conformité

**À faire avant toute deuxième implémentation, pas après.**

Un client de test qui parle le protocole et déroule les scénarios de SPEC.md
contre un serveur quelconque. Sans elle, on n'a pas deux implémentations d'un
protocole, on a deux protocoles qui se ressemblent — et la dérive se voit six
mois plus tard, sur un écran, en production.

Elle doit couvrir en particulier les cas que personne n'écrit spontanément :
resubscribe sous le même id, fenêtre vide, `pivot` absent, ligne dont seule la
version change, trame illisible, `unsubscribe` inconnu.

## 4. Doc, CI, publication

Sur le modèle de `softwarity/nestjs-granted` : `docs/` est une application
Angular publiée sur GitHub Pages, `release.yml` bump et pose le tag avec le PAT,
`tag.yml` publie sur npm.

**Ce qui diffère ici** : trois paquets versionnés **ensemble**. Le contrat est
décrit des deux côtés ; une version où les deux ne s'accordent pas est une
version que personne ne peut installer sans risque. `scripts/version-all.mjs`
propage le numéro et les dépendances croisées, et la CI doit refuser de publier
si les trois ne concordent pas.

La démo GitHub Pages a une difficulté propre : elle a besoin d'un serveur. Deux
pistes — un serveur de démonstration hébergé, ou un faux serveur en mémoire dans
la page qui rejoue le protocole. La seconde est plus fiable et montre mieux le
mécanisme.

## 5. Niveau 2 — commandes et notifications

**Après** la première version publiée, pas avant.

- `command(name, payload)` client → serveur avec accusé, sur le même socket.
  Règle une gêne réelle : aujourd'hui une écriture part en REST et sa
  confirmation revient par un autre canal.
- `notify(topic, payload)` serveur → client, ponctuel, sans fenêtre.

Les deux tiennent dans le modèle mental existant et n'obligent pas à toucher
aux abonnements. Compter deux à trois jours, spécification et conformité
comprises.

## 6. Implémentation Go

Réalisable, et sans doute plus propre qu'en TypeScript : `WindowedSource` fait
du fan-out avec comptage de références, de la coalescence et de la mémorisation
de la dernière valeur — ce que goroutines et channels expriment nativement,
alors qu'en RxJS c'est un `shareReplay({refCount: true})` dont le cycle de vie
est une propriété émergente. C'est précisément ce `refCount` qui nous a valu
neuf sockets ouverts pour une seule liste.

L'API perd les décorateurs (pas d'annotations ni d'injection par réflexion en
Go) au profit d'un enregistrement explicite :

```go
registry.Register("messages", &MessagesSource{db: db, events: events})
```

Même concept, quatre méthodes, dans l'idiome du langage.

---

## Ce qu'il ne faut pas faire

- **Ne pas publier avant que la suite de conformité passe.** L'API est jeune :
  trois défauts structurels ont été corrigés le jour même de l'extraction.
- **Ne pas ajouter d'option « au cas où ».** Chaque option est une promesse à
  tenir dans les deux implémentations et un scénario de conformité de plus.
- **Ne pas laisser le transport connaître le domaine.** Le socle ignore ce qu'est
  un vol, un message, un réglage. Le jour où il le sait, il n'est plus
  réutilisable — et c'est arrivé, dans la première version, par la gateway qui
  lisait les rôles de l'application.
