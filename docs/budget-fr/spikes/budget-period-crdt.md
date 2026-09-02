# Spike CRDT — concurrence Rule / Manual

- Date d'exécution : 2026-09-02
- Branche : `spike/budget-period-crdt`
- ADR évaluée : `docs/budget-fr/adr/0002-budget-period-persistence.md`
- Gate d'implémentation : **NOT READY**

## Objet et périmètre

Ce spike vérifie si une affectation concurrente Rule/Manual peut déchirer le
tuple `budget_period` / `budget_period_source` / `budget_period_rule_id` retenu
par ADR-0002. Il compare trois représentations : trois colonnes indépendantes,
une colonne composite et trois colonnes avec validation/réparation.

Le spike n'ajoute ni schéma de production, ni migration, ni code métier. Il ne
modifie pas `SYNC_FORMAT_VERSION`, le protobuf, AQL, l'API ou l'UI. Le fichier
`packages/loot-core/src/server/sync/budget-period-crdt.test.ts` est le seul
harness expérimental.

## Mécanismes Actual exercés

Le test appelle les mécanismes de production suivants sans réimplémenter leur
résolution :

- `db.update` dans `packages/loot-core/src/server/db/index.ts`, qui construit
  un message et un `Timestamp.send()` par propriété ;
- `batchMessages`, `sendMessages` et `applyMessages` dans
  `packages/loot-core/src/server/sync/index.ts` ;
- `compareMessages`, appelée de façon interne par `applyMessages`, qui compare
  les messages par `(dataset, row, column)` ;
- la transaction SQLite de `applyMessages` et la table `messages_crdt` ;
- `Timestamp.send()` pour les émissions du scénario de batch, et de vrais
  objets `Timestamp` portant deux identifiants de nœud logiques pour les
  chronologies déterministes injectées ;
- l'encodage et l'envoi vers `mockSyncServer`, par le chemin normal de
  `fullSync` déclenché après `batchMessages`.

Les helpers du test construisent des messages, lisent la table de probe et
classifient les trois formes autorisées par ADR-0002. Ils ne choisissent jamais
le gagnant d'un conflit : cette décision reste celle de `applyMessages` et
`compareMessages`.

## Table de probe

Chaque remise à zéro du test crée uniquement dans la base SQLite en mémoire la
table suivante :

```sql
CREATE TABLE budget_period_crdt_probe (
  id TEXT PRIMARY KEY,
  budget_period INTEGER,
  budget_period_source TEXT,
  budget_period_rule_id TEXT,
  budget_period_assignment TEXT,
  rejected_value TEXT CHECK (rejected_value IS NULL)
);
```

Les trois premières colonnes représentent A et C. La colonne
`budget_period_assignment` représente B ; son JSON est un encodage de test, pas
une décision de format de production. `rejected_value` sert seulement à
provoquer un échec au milieu d'une application et à observer le rollback.

Cette table est représentative d'une table `transactions` synchronisée pour le
risque étudié : elle possède la clé primaire texte `id` attendue par `apply`, et
les écritures passent par le même SQL dynamique, la même résolution par cellule,
la même transaction et la même persistance `messages_crdt`. Elle n'est pas
représentative des vues, conversions AQL, projections budgétaires, tombstones ou
listeners propres à `transactions` ; ces aspects ne sont pas testés ici.

## Protocole reproductible

Commandes exécutées depuis la racine :

```bash
corepack yarn workspace @actual-app/core exec vitest --run \
  src/server/sync/budget-period-crdt.test.ts \
  src/server/sync/sync.test.ts

corepack yarn workspace @actual-app/crdt exec vitest --run \
  src/crdt/timestamp.test.ts \
  src/crdt/merkle.test.ts
```

Résultats observés :

- spike et baseline sync : **19/19 tests réussis** dans 2 fichiers, dont
  **10/10** pour le spike et **9/9** pour `sync.test.ts` ;
- Timestamp/Merkle : **20/20 tests réussis** dans 2 fichiers, dont 15 tests
  Timestamp et 5 tests Merkle.

Un premier lancement du spike a rencontré uniquement un matcher Chai absent
(`toHaveSize`). L'assertion a été remplacée par la lecture de `Set.size` ; aucun
scénario ni résultat CRDT n'a été modifié.

Contrôles de dépôt exécutés après le dernier changement :

- `yarn lint` : réussi ;
- `yarn typecheck` : réussi ; 6 workspaces exécutés et 4 résultats récupérés du
  cache Lage ;
- `git diff --check` : réussi ; les deux fichiers étant non suivis, un
  `git diff --no-index --check /dev/null <fichier>` a aussi été exécuté pour
  chacun sans signaler d'erreur whitespace (le code retour `1` signifie ici
  que le nouveau fichier diffère de `/dev/null`).

## Observations brutes

### 1. `batchMessages` et atomicité locale

Une unique invocation de `batchMessages` contenant un `db.update` des trois
propriétés produit :

- 3 lignes dans `messages_crdt` ;
- 3 timestamps HULC distincts, strictement croissants et issus du même nœud ;
- 3 messages reçus par le mock sync-server, un par colonne.

Le scénario discriminant effectue ensuite deux émissions distinctes : un
`db.update` valide, puis un `sendMessages` qui viole la contrainte artificielle
`rejected_value`.

Sans `batchMessages`, le premier appel est déjà appliqué et envoyé avant le
second : l'échec tardif laisse la période dans la table de probe, une ligne dans
`messages_crdt` et un message sur le mock sync-server.

Avec `batchMessages`, les mêmes appels `db.update` et `sendMessages` sont
tamponnés avant l'application. L'échec tardif provoque le rollback de la ligne
de probe et des messages CRDT ; aucun message partiel n'atteint le mock
sync-server. La différence entre les deux phases démontre que plusieurs
émissions sont regroupées avant l'unique `applyMessages` local.

Ces observations doivent être séparées :

| Propriété                                               | Résultat                                                  |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Atomicité de l'application SQLite locale d'une liste    | Démontrée par rollback complet                            |
| Regroupement de plusieurs émissions par `batchMessages` | Démontré par le résultat différent avec et sans batch     |
| Unité CRDT persistée                                    | Une ligne indépendante par colonne                        |
| Frontière de batch durable                              | Absente du schéma `messages_crdt` et de `MessageEnvelope` |
| Atomicité de livraison entre clients                    | Non démontrée et non représentée par le protocole actuel  |
| Cohérence sémantique du tuple après conflit             | Non garantie ; contre-exemples ci-dessous                 |

L'absence de frontière durable repose à la fois sur les trois lignes/enveloppes
observées et sur l'inspection de `packages/loot-core/src/server/sql/init.sql`,
`packages/loot-core/src/server/sync/encoder.ts` et
`packages/crdt/src/proto/sync.proto` : aucun champ d'identifiant ou de frontière
de batch n'y existe. Des timestamps voisins ne sont pas interprétés comme un
batch.

### 2. Option A — trois colonnes séparées

Les contrôles Rule seul, Manual seul et Rule suivi d'un Manual entièrement plus
récent produisent respectivement les états Rule, Manual et Manual attendus.

Chaque conflit ci-dessous a ensuite été livré selon cinq plans : six messages
en une liste, batch Rule puis batch Manual, ordre inverse, message par message
et trois groupes par colonne. Les six messages sont conservés dans
`messages_crdt`. Les cinq plans convergent vers le même état final pour chaque
chronologie.

| Chronologie HULC `(period, source, ruleId)`   | Résultat observé           | Diagnostic                                      |
| --------------------------------------------- | -------------------------- | ----------------------------------------------- |
| Rule `(200,202,206)` / Manual `(199,204,205)` | `(202410, manual, rule-1)` | Invalide : Manual avec un identifiant Rule      |
| Rule `(199,204,205)` / Manual `(200,203,206)` | `(202411, rule, null)`     | Invalide : Rule sans identifiant                |
| Rule `(199,204,206)` / Manual `(200,203,205)` | `(202411, rule, rule-1)`   | Forme Rule valide, mais période issue de Manual |

La convergence CRDT est donc obtenue au niveau des cellules, y compris vers un
état métier invalide. Le troisième résultat prouve qu'une validation limitée à
la forme du tuple ne peut pas détecter tous les mélanges. Un seul de ces
contre-exemples suffit à invalider le critère de confirmation de A.

### 3. Option B — affectation composite

Deux affectations complètes encodées dans une seule colonne ne sont jamais
déchirées :

- Manual à `300`, puis Rule à `301` donne l'objet Rule complet ;
- Rule à `400`, puis Manual à `401`, livré dans l'ordre inverse, donne l'objet
  Manual complet.

La colonne composite fournit donc une unité de conflit cohérente, mais conserve
la règle LWW de la colonne. Une Rule concurrente horodatée après Manual gagne ;
la priorité métier `manual > rule` n'est pas garantie par cette représentation
seule.

### 4. Option C — validation et réparation déterministe

Le prototype de réparation ne reconnaît que les formes Default, Rule et Manual
d'ADR-0002. Toute autre forme est remise à Default par trois messages HULC plus
récents, sans inventer de provenance.

Résultats observés :

- après convergence vers `(202410, manual, rule-1)`, la réparation produit
  Default ; un second passage ne produit aucun message : elle est idempotente ;
- les messages de réparation et les six messages initiaux, rejoués dans un
  autre ordre sur une base neuve, convergent aussi vers Default sans
  oscillation ;
- après réception du seul champ période d'une correction Manual, l'état
  temporaire est invalide ; une réparation immédiate vers Default empêche les
  deux messages Manual restants, plus anciens, de compléter l'affectation : la
  correction Manual est perdue ;
- `(202411, rule, rule-1)` est de forme Rule valide. La réparation ne détecte
  pas que `202411` vient du client Manual et n'émet aucun message.

C est donc idempotente dans les cas détectés, mais elle ne satisfait ni la
préservation de Manual en réception partielle, ni la détection de tous les
mélanges.

## Comparaison A/B/C

| Critère                                    | A — 3 colonnes       | B — composite                                         | C — 3 colonnes + réparation   |
| ------------------------------------------ | -------------------- | ----------------------------------------------------- | ----------------------------- |
| Convergence CRDT                           | Oui, par colonne     | Oui, par affectation                                  | Oui dans les cas testés       |
| Tuple non déchiré                          | Non                  | Oui                                                   | Non avant réparation          |
| Mélange sémantique détectable              | Non                  | Sans objet pour un objet intact                       | Non                           |
| Priorité `manual > rule`                   | Non                  | Non, LWW simple                                       | Non ; Manual peut être effacé |
| Réception partielle sûre                   | Non                  | Oui pour une affectation, hors livraison inter-lignes | Non                           |
| Intégration possible avec `date-month` AQL | Inférence non testée | À concevoir                                           | Inférence non testée          |
| Verdict de la variante naïve               | Rejetée              | Incomplète                                            | Rejetée                       |

## Option D — hypothèse de suivi

Cette option n'est pas exercée par le spike. Elle séparerait deux couches
indépendantes :

- `manual_budget_period`, nullable et exposé en `date-month` ;
- `rule_assignment`, composite nullable `{ period, ruleId }` ;
- une source dérivée de la première couche non nulle, et non persistée.

La période effective serait `manual_budget_period`, sinon
`rule_assignment.period`, sinon `month(date)`. Cette sélection donne une
priorité inter-couches structurelle `manual > rule > default` : une règle ne
peut pas gagner en modifiant sa propre colonne lorsqu'une valeur Manual existe.
Le composite évite aussi de séparer la période Rule de son identifiant.

Les conflits entre deux écritures ou entre une valeur et un effacement dans une
même couche resteraient néanmoins LWW. La sémantique d'un retour complet à
Default, susceptible d'effacer les deux colonnes, reste à définir. Le format
SQLite du composite, sa conversion AQL, ses requêtes et son indexation doivent
être étudiés. D ne résout pas le risque multi-lignes des splits et transferts.

## Recommandation pour ADR-0002

ADR-0002 ne doit pas être confirmée dans sa stratégie actuelle des trois
colonnes simplement regroupées par `batchMessages`. Les contre-exemples de A
montrent qu'un batch local ne constitue pas une unité de conflit CRDT.

B est la meilleure base des trois pour garantir la cohérence intra-transaction,
mais la variante testée reste insuffisante : il faut une décision distincte et
testable pour rendre `manual > rule` indépendante de l'ordre HULC. Cette
décision devra aussi préciser la représentation SQLite/AQL et ne doit pas être
déduite de l'encodage JSON du test.

C ne doit pas être retenue comme filet de sécurité autonome. Une réparation de
forme ne connaît ni l'origine de chaque cellule ni si un batch distant est
encore incomplet ; elle peut perdre Manual et laisser passer un mélange
sémantique.

En conséquence, les trois variantes naïves testées sont insuffisantes pour
garantir simultanément convergence, cohérence du tuple et priorité Manual. Il
est recommandé d'amender ADR-0002 avant toute migration ou implémentation, puis
de faire accepter et tester un mécanisme où l'affectation est une unité de
conflit et où la priorité de provenance est explicitement déterministe. D est
une hypothèse de suivi, pas un résultat de ce spike.

## Impacts à traiter dans une future décision

- **SQLite** : A/C restent faciles à filtrer mais ne sont pas cohérentes sous
  conflit. B nécessite un format physique, des règles d'indexation et une
  stratégie de migration explicitement décidés.
- **AQL** : selon une inférence architecturale non testée par ce spike, A/C
  devraient pouvoir réutiliser `date-month`. B exige soit une projection de
  champs logiques, soit un type/convertisseur composite ; les filtres, tris et
  abonnements doivent rester déterministes.
- **CRDT** : le LWW générique par colonne ne porte aucune priorité métier. Une
  nouvelle stratégie ne doit ni inférer des batches par proximité temporelle,
  ni modifier `SYNC_FORMAT_VERSION` sans ADR explicite.
- **Imports et règles** : la relecture locale de `source=manual` protège un état
  déjà visible, pas une correction Manual concurrente encore inconnue. Le
  réimport doit rester incapable de l'écraser.
- **Splits** : même B ne rend atomique que l'affectation d'une ligne. La
  cohérence parent/enfants traverse plusieurs lignes CRDT et nécessite ses
  propres scénarios concurrents.
- **Transferts** : les deux côtés sont aussi deux lignes distinctes ; aucune
  frontière de batch durable ne garantit leur livraison conjointe.
- **API** : B doit préserver le contrat logique `budget_period`,
  `budget_period_source`, `budget_period_rule_id` ou documenter une évolution
  compatible. A/C exposeraient potentiellement des états transitoires invalides.
- **UI** : l'affichage et l'édition doivent présenter une affectation cohérente
  et ne pas transformer un Default de réparation en décision utilisateur. Les
  états de synchronisation partielle devront être définis avant exposition.
- **Trésorerie et forecast** : ce spike ne touche pas `date`; l'invariant qui
  leur réserve la date bancaire reste inchangé.

`messages_crdt` est utilisé ici comme stockage technique pour vérifier les
messages appliqués. Il ne contient pas les attributs nécessaires à BR-018 et ne
constitue pas un journal d'audit métier.

## Limites expérimentales

- Le harness utilise la base SQLite en mémoire et le mock sync-server du dépôt,
  pas deux processus clients ni deux fichiers persistants sur appareils réels.
- Les conflits A/B/C sont injectés directement dans `applyMessages` avec de
  vrais objets `Timestamp`, sans passer par `receiveMessages` ou
  `Timestamp.recv`. Les clients sont distingués par leurs identifiants de nœud,
  mais deux horloges globales actives simultanément ne sont pas instanciées.
- Les ordres et découpages de livraison sont contrôlés explicitement. Les pertes,
  duplications réseau, chiffrement, reprise après crash et pruning Merkle ne
  sont pas couverts par le nouveau test.
- L'atomicité SQLite observée couvre l'appel local à `applyMessages`, pas une
  atomicité distribuée, une durabilité disque/WAL ou une livraison tout-ou-rien
  depuis le serveur.
- La contrainte `rejected_value` utilisée pour provoquer le rollback est
  artificielle. Elle observe la transaction générique d'`applyMessages`, pas
  une contrainte existante de `transactions`.
- La colonne composite démontre l'unité LWW, mais aucun format SQLite/AQL de
  production, index ou compatibilité de requête n'est évalué.
- La réparation est un prototype de test exécuté explicitement. Aucun point
  d'intégration, déclenchement automatique ou comportement UI n'est démontré.
- Les vues, conversions AQL, listeners et tombstones propres à `transactions`
  ne sont pas exercés. Les conflits multi-lignes des splits et transferts
  restent non démontrés.
- La compatibilité entre versions clientes et le comportement
  `invalid-schema` restent hors de ce spike.

## Gate

**NOT READY** — le critère CRDT bloquant d'ADR-0002 n'est pas satisfait. Une
décision d'architecture acceptée sur l'unité de conflit et la priorité
`manual > rule`, suivie de nouveaux tests de concurrence, est obligatoire avant
la migration et le code métier de `budget_period`.
