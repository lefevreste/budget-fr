# POC clients mixtes — colonnes Budget FR inconnues

- Date : 09/09/2026
- Branche : `spike/budget-period-mixed-clients`
- Base : `4baa7dacb3158c649a9412dcddb53c1691c10dd3`
- Statut : **NOT READY FOR PRODUCTION MIGRATION OR RELEASE**

## Objectif et périmètre

Ce POC caractérise le comportement actuel de `fullSync` lorsqu'un client
legacy reçoit les cellules futures `manual_budget_period` ou
`rule_assignment`, absentes de son schéma SQLite. Il s'agit d'une preuve de
comportement et non d'une correction ou d'une activation.

Le test utilise une **table de probe SQLite en mémoire** nommée
`budget_period_mixed_clients_probe` :

```sql
-- Client legacy
CREATE TABLE budget_period_mixed_clients_probe (
  id TEXT PRIMARY KEY,
  known_value INTEGER
);

-- Client Budget FR
CREATE TABLE budget_period_mixed_clients_probe (
  id TEXT PRIMARY KEY,
  known_value INTEGER,
  manual_budget_period INTEGER,
  rule_assignment TEXT
);
```

Cette table représente une ligne et des cellules synchronisées génériques.
Elle n'est pas la vraie table `transactions` et ne démontre pas le comportement
de la persistance applicative réelle, des vues, des listeners, des exécuteurs
AQL spécialisés, de `selectWithSchema`, des tombstones, d'un reset, d'un upload
complet, d'un remplacement de fichier ou de l'ouverture d'un fichier réellement
migré.

Le POC ne modifie ni schéma ou migration de production, ni protocole,
`SYNC_FORMAT_VERSION`, synchronisation générique, API, UI, ADR ou donnée
utilisateur.

## Harness et isolation des clients

Le test [budget-period-mixed-clients.test.ts](../../../packages/loot-core/src/server/sync/budget-period-mixed-clients.test.ts)
exerce les chemins publics Actual suivants :

- `db.update`, qui produit une écriture CRDT par propriété ;
- `sendMessages`, utilisé directement pour une Rule canonique ;
- `fullSync`, l'encodeur et le serveur `mockSyncServer` officiel ;
- `receiveMessages`, donc indirectement `compareMessages` et `applyMessages`.

Chaque client logique conserve indépendamment :

- son objet base SQLite en mémoire et sa propre table de probe ;
- ses tables `messages_crdt` et `messages_clock` ;
- son objet horloge, son Merkle, son timestamp HULC et son `node` ;
- une copie de ses préférences, notamment `groupId` et
  `lastSyncedTimestamp`.

Tous les clients emploient le même `cloudFileId` et le même `groupId` afin de
représenter une identité de fichier distante commune. Le harness vérifie ces
deux valeurs dans les préférences immédiatement avant chaque appel à `fullSync`,
puis décode la `SyncRequest` binaire reçue par le handler officiel pour confirmer
les mêmes `fileId` et `groupId`. Les objets de préférences et tous leurs états
locaux restent néanmoins propres à chaque client.

Un changement de client sauvegarde les préférences actives, installe la base
du client avec `db.setDatabase`, restaure son objet horloge avec `setClock`,
recharge les préférences de test puis restaure sa copie. Les bases et horloges
ne sont donc pas partagées. Seul l'état du `mockSyncServer` est volontairement
conservé pendant un scénario afin de représenter le groupe de synchronisation
commun.

Après chaque test, le mode de synchronisation, les préférences globales, le
serveur mock, le temps factice et l'horloge globale sont réinitialisés. Toutes
les bases clientes sont fermées et la référence globale de base active est
retirée. Aucune substitution du handler du serveur n'est installée.

## Protocole expérimental

Les écritures locales sont préparées en mode `offline`, ce qui fait passer
`db.update` ou `sendMessages` par `applyMessages` sans déclencher une
synchronisation automatique. `fullSync` est ensuite appelé explicitement en
mode `enabled`.

Les scénarios partagent le même `groupId`. Le rejeu conserve le même client,
sa base, ses préférences et le même historique du serveur. La mise à niveau
simulée exécute deux `ALTER TABLE ADD COLUMN` sur cette même base legacy ; elle
ne remplace pas le client par une base neuve.

Les snapshots de rollback couvrent :

- toutes les lignes de la table de probe ;
- toutes les lignes pertinentes de `messages_crdt` ;
- `messages_clock` ;
- le Merkle en mémoire ;
- `lastSyncedTimestamp`.

Le timestamp HULC en mémoire est capturé séparément, car `receiveMessages`
appelle `Timestamp.recv` avant d'entrer dans la transaction SQLite de
`applyMessages`.

## Matrice exécutée

| ID  | Scénario                                                                   | Résultat observé |
| --- | -------------------------------------------------------------------------- | ---------------- |
| M01 | legacy vers legacy, cellule connue                                         | succès           |
| M02 | nouveau vers nouveau, Manual et Rule canonique                             | succès           |
| M03 | nouveau vers legacy, Manual, ligne existante / UPDATE                      | échec atomique   |
| M04 | nouveau vers legacy, Rule canonique, ligne existante / UPDATE              | échec atomique   |
| M05 | nouveau vers legacy, Rule invalide sentinelle                              | échec + meta     |
| M06 | nouveau vers legacy, Rule à `null`                                         | échec atomique   |
| M07 | lot cellule connue puis inconnue, puis ordre HULC inverse                  | échec atomique   |
| M08 | connue et deux Budget FR inconnues dans deux ordres HULC opposés           | échec atomique   |
| M09 | envoi legacy accepté avant échec entrant et observation par un client neuf | sync partielle   |
| M10 | rejeu du même historique sur le même client                                | même échec       |
| M11 | ajout simulé des colonnes sur le même client puis rejeu                    | reprise          |
| M12 | conflits valeur/valeur et valeur/`null` après mise à niveau                | convergence LWW  |
| M13 | nouveau vers legacy, Rule invalide, ligne absente / INSERT                 | échec distinct   |

La première exécution effective du fichier a réussi ses 15 tests. Les deux cas
paramétrés de M07 et les deux cas de M08 sont comptés séparément par Vitest.
Une tentative préalable avec un chemin de filtre relatif à la racine n'a
découvert aucun test dans le workspace ; elle n'a exécuté aucune hypothèse.

## Observations dynamiques

### Contrôles et cellules indépendantes

M01 confirme qu'un client legacy reçoit une cellule `known_value` connue. M02
confirme qu'un client disposant des deux colonnes reçoit Manual et la chaîne
Rule canonique. Le test ne décode pas cette Rule et ne réimplémente aucune
résolution LWW.

M12 livre volontairement le message Manual récent avant l'ancien, puis le
`null` Rule récent avant la valeur Rule ancienne. `receiveMessages` et
`compareMessages` choisissent les gagnants : Manual reste `202411` et Rule
reste `null`. Le helper ne calcule aucun gagnant.

### Point d'échec et rollback local

Pour une ligne existante, l'échec se produit dans l'UPDATE dynamique construit
par `apply` :

```text
SyncError: invalid-schema
no such column: manual_budget_period
no such column: rule_assignment
```

Pour une ligne absente, l'échec se produit dans l'INSERT dynamique :

```text
SyncError: invalid-schema
table budget_period_mixed_clients_probe has no column named rule_assignment
```

Dans les deux cas, `fullSync` retourne `reason: invalid-schema`. Le
classificateur partagé `getSyncError` reconnaît la forme UPDATE
`no such column` et affiche le message de schéma plus récent. Il ne reconnaît
pas la forme INSERT `has no column named` et tombe sur son message générique.
Ce contre-exemple est figé sans modifier le classificateur.

Dans M03, M07, M08, M09, M10 et M13, les snapshots complets avant/après des
lignes applicatives, de `messages_crdt`, de `messages_clock`, du Merkle et de
`lastSyncedTimestamp` sont strictement identiques. Les messages locaux qui
existaient avant `fullSync` restent présents ; aucun message entrant des lots
échoués n'est ajouté à `messages_crdt`. M04 à M06 vérifient les erreurs et leurs
métadonnées sans revendiquer un snapshot complet supplémentaire.

M07 envoie le même couple fonctionnel dans deux ordres HULC effectivement
opposés. Lorsque `known_value` est antérieur, il est appliqué avant l'erreur
puis annulé par la transaction. Lorsque la colonne inconnue est antérieure,
l'erreur survient avant l'UPDATE connue. Les deux ordres aboutissent au même
rollback persistant. M08 ajoute simultanément `known_value` et les deux colonnes
Budget FR inconnues. Il vérifie sans tri que les trois messages attendus sont
présents, inverse explicitement la relation HULC entre la cellule connue et la
première cellule inconnue, puis constate que `manual_budget_period` déclenche le
premier plan et `rule_assignment` le second. Les deux plans conservent le même
rollback persistant complet.

L'horloge HULC en mémoire avance néanmoins à chaque tentative échouée. Elle
n'est pas couverte par la transaction SQLite : `Timestamp.recv` traite le lot
avant `applyMessages`. Au rejeu M10, elle avance de nouveau, tandis que tous les
éléments persistants du snapshot restent inchangés.

Ces résultats prouvent l'atomicité du traitement local observé sur la table de
probe et les tables techniques du client. Ils ne prouvent aucune atomicité
distribuée.

### Acceptation sortante et synchronisation partielle

M09 démontre dynamiquement l'ordre dangereux avec `fullSync` et le serveur mock
officiel :

1. un nouveau client place Manual et Rule sur le serveur ;
2. le client legacy prépare localement `known_value = 99` ;
3. son `fullSync` envoie cette cellule connue ;
4. le serveur mock la conserve, puis le client échoue sur le lot entrant
   contenant les colonnes inconnues ;
5. un autre client Budget FR synchronise et observe simultanément
   `known_value = 99`, Manual et Rule inchangées.

L'acceptation sortante est vérifiée à la fois dans l'état observable du serveur
mock et depuis l'autre client, pas seulement dans les arguments réseau. Une
écriture legacy d'une cellule connue ne supprime donc pas, dans ce scénario
cellulaire, les cellules Budget FR distinctes déjà détenues par le serveur et
le nouveau client.

Le client legacy, lui, reste en échec entrant et ne met pas à jour son
`lastSyncedTimestamp`. Le système peut donc être partiellement synchronisé : le
serveur et un nouveau client ont accepté l'écriture sortante, alors que le
client legacy n'a appliqué aucune cellule entrante du lot.

### Rejeu et reprise après mise à niveau simulée

M10 rappelle `fullSync` sur le même client, dans le même groupe et sans remettre
à zéro le serveur. Le même message inconnu est renvoyé et produit la même erreur
SQLite. Le serveur n'ajoute pas de doublon de message, les états persistants du
client restent inchangés et son HULC en mémoire avance encore.

M11 ajoute ensuite `manual_budget_period` et `rule_assignment` à la base de ce
même client. La tentative suivante rejoue les messages précédemment bloquants,
applique Manual et Rule, conserve la cellule connue et rejoint le Merkle du
serveur mock. Cette reprise est démontrée pour la table de probe, sans migration
Actual réelle, fermeture/réouverture du fichier, backup ni restauration.

### Valeur sentinelle dans les métadonnées

M05 et M13 utilisent uniquement la sentinelle synthétique
`SYNTHETIC_INVALID_RULE_SENTINEL_{`. La valeur brute figure dans
`SyncError.meta.query.params`, et donc dans le résultat observable retourné par
`fullSync`. Le POC ne capture pas les logs, les événements UI ou tous les
consommateurs de l'erreur. Il ne démontre aucune fuite de donnée utilisateur,
mais établit un gate de sécurité séparé : avant intégration, il faut décider si
les métadonnées SQL peuvent traverser les frontières de journalisation et de
présentation, puis tester ces chemins sans valeur sensible.

## Inspections statiques

### Client Actual

Dans [`sync/index.ts`](../../../packages/loot-core/src/server/sync/index.ts) :

- `_fullSync` capture les messages locaux, les encode et appelle le serveur
  avant de traiter la réponse avec `receiveMessages` ;
- `receiveMessages` appelle `Timestamp.recv` pour chaque enveloppe avant
  `applyMessages` ;
- `compareMessages` compare par triplet `(dataset, row, column)` et timestamp ;
- `applyMessages` trie les messages par HULC puis place les écritures de la
  table, `messages_crdt` et `messages_clock` dans une transaction SQLite ;
- le Merkle en mémoire n'est remplacé qu'après le succès de cette transaction ;
- `lastSyncedTimestamp` n'est sauvegardé qu'après convergence des Merkles ;
- `fullSync` transforme le `SyncError` en résultat
  `{ error: { message, reason, meta } }`.

Le protobuf transporte `dataset`, `row`, `column`, `value` et `timestamp`. Il
ne porte ni schéma de table ni capacité déclarée du client.

### Serveur réel inspecté, non exécuté

Le POC n'exécute aucun serveur réel. L'ordre du serveur Actual est seulement
confirmé par inspection statique de
[`sync-simple.js`](../../../packages/sync-server/src/sync-simple.js), fonction
`sync` : le serveur sélectionne d'abord les messages postérieurs à `since`,
puis `addMessages` persiste les messages entrants et son Merkle dans une
transaction serveur, avant de retourner la réponse. Le mock officiel reproduit
cet ordre.

Le mock officiel ne valide pas `fileId`. Le harness emploie malgré cela un
`cloudFileId` commun, transmis par l'encodeur, car le serveur réel utilise ce
champ pour sélectionner le fichier avant d'appeler `simpleSync.sync`.

Cette transaction serveur est indépendante de la transaction SQLite du client.
Un échec lors de l'application entrante côté client ne retire donc pas les
messages sortants déjà acceptés.

### Portée de `SYNC_FORMAT_VERSION`

[`validation.js`](../../../packages/sync-server/src/app-sync/validation.js)
compare `SYNC_FORMAT_VERSION` à la version du fichier synchronisé enregistrée
côté serveur. La requête de sync cellulaire ne transporte pas une version de
schéma ou une capacité propre au client. Dans l'état inspecté, ce mécanisme ne
protège donc pas directement un ancien client contre une colonne ajoutée au
schéma applicatif.

## Hypothèses non démontrées

- Le comportement d'un sync-server déployé, avec sa base réelle, ses erreurs
  réseau, plusieurs processus ou plusieurs requêtes simultanées, n'est pas
  mesuré.
- La table `transactions`, ses vues, listeners, exécuteurs AQL spécialisés et
  `selectWithSchema` ne sont pas exercés.
- Les tombstones, resets, uploads complets, remplacements de fichier et fichiers
  réellement migrés ne sont pas couverts par la preuve de non-effacement.
- La reprise après redémarrage du processus ou après fermeture puis ouverture
  d'une base réellement migrée n'est pas démontrée.
- Les règles de rétention, de taille et de durée de vie nécessaires à une
  quarantaine durable ne sont pas prototypées.
- L'UI et les chemins globaux de journalisation des métadonnées d'erreur ne sont
  pas testés.
- Les splits et transferts multi-lignes restent hors périmètre.

## Contre-exemples conservés

1. L'atomicité locale ne rend pas la synchronisation distribuée atomique : un
   message sortant est accepté avant l'échec entrant.
2. Le rollback SQLite n'annule pas l'avancement de l'horloge HULC en mémoire.
3. Les formes SQLite UPDATE et INSERT produisent deux textes différents ; le
   classificateur partagé ne reconnaît que la première.
4. Une valeur SQL brute inconnue est incluse dans les métadonnées retournées par
   `fullSync`.
5. `SYNC_FORMAT_VERSION` ne constitue pas, en l'état, une négociation de
   capacité client pour les colonnes.

## Comparaison des stratégies

| Stratégie                                               | Risque de perte ou divergence                                                                                                                                         | Compatibilité upstream                                        | Complexité et serveur                                                                      | Reprise                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Blocage explicite par capacité client avant activation  | Faible si tous les clients du groupe sont identifiés et bloqués avant la première écriture ; sinon fenêtre résiduelle                                                 | Bonne si la capacité reste une extension étroite et additive  | Moyenne ; exige une source de vérité de capacité et une politique de refus                 | Mise à niveau puis déblocage, sans interpréter les colonnes inconnues                   |
| Faire évoluer `SYNC_FORMAT_VERSION`                     | Peut empêcher des échanges incompatibles, mais le mécanisme actuel versionne le fichier serveur et implique un reset ; insuffisant sans sémantique de capacité client | Risque élevé de divergence avec upstream et de resets globaux | Élevée ; protocole de version, cycle upload/reset et compatibilité serveur à revoir        | Potentiellement lourde et destructive si elle impose un reset                           |
| Tolérance ou quarantaine durable des colonnes inconnues | Peut préserver les messages sans les appliquer, mais une quarantaine incomplète peut diverger, perdre l'ordre ou masquer les erreurs                                  | Risque élevé car elle change le sync générique                | Très élevée ; stockage durable, Merkle, rejeu, limites, chiffrement et erreurs à concevoir | Possible après mise à niveau si l'intégralité des enveloppes et du causal est conservée |

## Implications d'architecture et recommandation

Le gate clients mixtes reste **ouvert**. Le comportement actuel échoue de façon
locale et atomique, mais seulement après que le serveur a pu accepter les
messages sortants. Continuer à exiger que tous les clients d'un budget soient
mis à jour réduit le risque opérationnel, sans constituer à lui seul une
garantie mécanisée.

La recommandation pour le prochain lot est de concevoir en priorité un **blocage
explicite par capacité client avant activation et avant toute émission des
nouvelles colonnes**, avec une politique claire pour les clients hors ligne ou
inconnus. C'est l'option la plus petite qui traite directement le risque observé
sans modifier le CRDT générique. Elle doit faire l'objet d'une décision
d'architecture acceptée avant implémentation.

Une modification de `SYNC_FORMAT_VERSION` n'est pas recommandée comme simple
substitut : son contrat actuel n'est pas celui d'une négociation de colonnes et
son impact upstream/reset est disproportionné. Une quarantaine durable peut
être étudiée comme solution plus générale, mais nécessite un protocole et une
preuve de durabilité propres ; elle ne doit pas être improvisée dans
`applyMessages`.

## Décisions humaines encore ouvertes

- Quelle autorité enregistre et expire la capacité minimale de chaque client
  d'un groupe, notamment pour un client longtemps hors ligne ?
- Le blocage intervient-il à l'ouverture du budget, à l'activation de Budget FR,
  avant l'émission de chaque nouvelle cellule, ou à plusieurs de ces frontières ?
- Quelle expérience de récupération est proposée à l'ancien client qui a déjà
  émis des messages acceptés avant son erreur entrante ?
- La valeur brute des paramètres SQL doit-elle être retirée ou masquée aux
  frontières de logs, événements et UI ?
- Le contre-exemple INSERT du classificateur doit-il être corrigé dans un lot
  générique Actual séparé ?
- Une quarantaine durable est-elle souhaitée à long terme, et avec quelles
  bornes de stockage, de rejeu et de chiffrement ?
- Une évolution de protocole compatible upstream est-elle nécessaire, ou le
  blocage de capacité suffit-il au MVP du fork ?

## Gates

### Fermés uniquement dans le modèle de probe

- rollback atomique de la table de probe, `messages_crdt`, `messages_clock` et
  Merkle face à une colonne inconnue ;
- répétabilité de l'échec et reprise après ajout simulé des colonnes sur la même
  base en mémoire ;
- absence d'effacement des cellules Budget FR distinctes par une écriture legacy
  connue dans le scénario cellulaire couvert ;
- caractérisation UPDATE/INSERT et exposition de la sentinelle dans le résultat
  `fullSync`.

### Ouverts

- stratégie et enforcement de compatibilité des clients mixtes ;
- négociation de capacité et traitement des clients hors ligne ;
- comportement de la vraie table `transactions`, vues, listeners, AQL et
  `selectWithSchema` ;
- traitement de la valeur brute aux frontières de journalisation et UI ;
- correction éventuelle du classificateur INSERT ;
- adaptateur applicatif et consommateurs ;
- migration réelle, anciennes bases, backup et restauration ;
- tombstones, reset, upload complet et remplacement de fichier ;
- splits et transferts multi-lignes.

## Commandes de validation

Depuis la racine du dépôt :

```bash
corepack yarn workspace @actual-app/core vitest run src/server/sync/budget-period-mixed-clients.test.ts

corepack yarn workspace @actual-app/core vitest run \
  src/server/sync/budget-period-mixed-clients.test.ts \
  src/server/sync/sync.test.ts \
  src/server/sync/budget-period-option-d.test.ts \
  src/server/sync/budget-period-invalid-rule-assignment.test.ts \
  src/server/sync/budget-period-crdt.test.ts

corepack yarn workspace @actual-app/crdt vitest run \
  src/crdt/timestamp.test.ts \
  src/crdt/merkle.test.ts

corepack yarn workspace @actual-app/sync-server test \
  src/app-sync.test.ts -t "/sync"
corepack yarn workspace @actual-app/core test
corepack yarn workspace @actual-app/core test:browser
corepack yarn oxfmt --check \
  packages/loot-core/src/server/sync/budget-period-mixed-clients.test.ts \
  docs/budget-fr/spikes/budget-period-mixed-clients.md
corepack yarn typecheck
corepack yarn lint
git diff --check
```

## Résultats de validation

- fichier POC ciblé : 15/15 tests réussis ;
- matrice des cinq fichiers sync et Budget FR : 98/98 tests réussis ;
- `Timestamp` et Merkle : 20/20 tests réussis ;
- tests `/sync` ciblés du sync-server : 10 réussis et 62 non sélectionnés ;
- suite `loot-core` Node : 1 245 tests réussis et 2 ignorés, 80 fichiers
  réussis et 1 ignoré ;
- suite `loot-core` Web : 9/9 tests réussis ;
- `oxfmt --check` sur les deux nouveaux fichiers : réussi ;
- `yarn typecheck` : réussi. Après correction des types stricts du nouveau
  test, 6 tâches Lage ont été exécutées (`core`, `api`, `web`, `cli`,
  `sync-server`, `desktop-electron`) et 4 ont été récupérées du cache
  (`ci-actions`, `components`, `crdt`, `plugins-service`). Une relance de
  confirmation a récupéré les 10 tâches du cache ;
- `yarn lint` : réussi ;
- contrôles diff, whitespace et recherche de tests neutralisés : réussis.

## Verdict

Le POC confirme que le sync cellulaire conserve les cellules Budget FR sur le
serveur, mais qu'un client legacy ne peut pas les recevoir : son traitement
entrant échoue et se répète jusqu'à mise à niveau. Surtout, son envoi sortant
peut être accepté avant cet échec, créant une synchronisation partielle réelle
dans le modèle exercé.

La reprise après ajout simulé des colonnes est encourageante mais insuffisante
pour autoriser une migration ou une activation. ADR-0006 doit conserver une
stratégie explicite de clients mixtes comme gate critique.

**NOT READY FOR PRODUCTION MIGRATION OR RELEASE**
