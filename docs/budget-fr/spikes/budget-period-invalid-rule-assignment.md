# Spike — Rule absente et Rule synchronisée invalide

- Date : 2026-09-08
- Commit de référence : `89a5b23ae5d314c6a0286a0f246b44a8dde10910`
- Branche : `spike/budget-period-invalid-rule-assignment`
- Portée : domaine pur, tests et rapport ; aucun schéma de production
- Statut : **NOT READY FOR PRODUCTION MIGRATION OR RELEASE**

## Objectif

Ce lot distingue strictement une Rule absente, représentée uniquement par
SQLite `NULL`, d'une valeur `rule_assignment` présente mais invalide. Il teste
la conservation de la valeur synchronisée brute et interdit qu'une erreur soit
silencieusement convertie en Default.

Le lot ajoute au module expérimental `budget-period.ts` un adaptateur pur. Il
ne le réexporte pas et ne le branche sur aucun consommateur applicatif.

## Contrat de domaine observé

`decodeStoredRuleAssignment` produit un état discriminé :

| Valeur stockée               | État      | Données conservées                        |
| ---------------------------- | --------- | ----------------------------------------- |
| `null`                       | `absent`  | `raw: null`                               |
| chaîne JSON canonique valide | `valid`   | chaîne exacte et `RuleAssignment` décodée |
| toute autre valeur           | `invalid` | valeur brute exacte et code d'erreur      |

Le décodeur réutilise `decodeRuleAssignment`. Il ne connaît ni SQLite, ni AQL,
ni `TransactionEntity`, ni identifiant de transaction. Aucun identifiant et
aucune valeur brute ne sont journalisés par le domaine.

`deriveStoredBudgetPeriod` rend la politique suivante visible dans ses types :

| Manual   | Rule stockée      | Résultat                                                 |
| -------- | ----------------- | -------------------------------------------------------- |
| valide   | absente ou valide | projection Manual, sans diagnostic                       |
| valide   | invalide          | projection Manual et diagnostic obligatoire non bloquant |
| absente  | absente           | projection Default issue de `month(bankDate)`            |
| absente  | valide            | projection Rule                                          |
| absente  | invalide          | erreur bloquante, sans propriété `projection`            |
| invalide | toute valeur      | erreur bloquante, sans propriété `projection`            |

Une suppression de Manual qui révèle une Rule invalide produit donc une erreur
bloquante, jamais Default. Les variantes bloquantes déclarent
`projection?: never` ; les variantes de succès sans diagnostic n'acceptent pas
un état Rule invalide.

La validation conserve la priorité d'erreur du contrat existant : `bankDate`
invalide, puis Manual invalide, puis Rule invalide. Une `bankDate` invalide est
donc rejetée avant toute inspection de Manual ou de Rule. Avec une `bankDate`
valide, une Manual invalide est rejetée avant le décodage JSON de Rule.

## Chemin exact de la valeur

Le chemin de test est celui du code Actual existant :

```text
Message.value
  -> receiveMessages
  -> Timestamp.recv
  -> applyMessages
  -> compareMessages par (dataset, row, column)
  -> colonne TEXT de la table de probe
  -> messages_crdt avec serializeValue
  -> lecture AQL avec compileAndRunAqlQuery
  -> convertOutputType
  -> deriveStoredBudgetPeriod
```

`receiveMessages`, `applyMessages`, le `compareMessages` privé, les vrais objets
`Timestamp` HULC et la persistance `messages_crdt` sont ainsi exercés. La table
et le schéma AQL injecté n'existent que dans la base SQLite en mémoire du test.
Ils représentent une cellule synchronisée de transaction, car la résolution
générique dépend uniquement du triplet `(dataset, row, column)` et non du nom
de la table. Ils ne prouvent pas l'ouverture d'un ancien fichier ni le
comportement des vues de transactions réelles.

La preuve AQL dynamique appelle `compileAndRunAqlQuery` sans
`schemaExecutor` : elle passe exclusivement par le chemin générique `execQuery`.
Elle n'exerce ni les exécuteurs AQL spécialisés des transactions, ni
`db.selectWithSchema`. Ces deux chemins sont seulement inspectés statiquement
et devront être intégrés à de futurs tests de consommateurs.

## Protocole et matrice exécutée

Les tests I01 à I08 couvrent `null`, JSON canonique, JSON invalide, JSON valide
non canonique, clés dupliquées, clés et champs invalides, tableaux, objets,
primitives JSON, `undefined`, nombre et objet JavaScript. La valeur brute reste
identique et les objets d'entrée ne sont pas modifiés.

Les tests I09 à I17 constituent les témoins AQL, SQLite et synchronisation :

| ID  | Preuve dynamique                                                                                   |
| --- | -------------------------------------------------------------------------------------------------- |
| I09 | AQL `json` rend identiques en sortie un JSON syntaxiquement invalide et SQL `NULL`                 |
| I10 | AQL `json/fallback` transforme un JSON valide non canonique en objet et perd sa forme lexicale     |
| I11 | AQL `string` restitue exactement `NULL`, JSON canonique, JSON non canonique et JSON invalide       |
| I12 | `receiveMessages` conserve la chaîne invalide dans la table et dans `messages_crdt`                |
| I13 | une valeur invalide LWW gagnante bloque la projection et ne produit pas Default                    |
| I14 | une écriture CRDT canonique plus récente rétablit une projection Rule                              |
| I15 | un `null` CRDT plus récent rétablit Default comme effacement explicite                             |
| I16 | l'affinité SQLite `TEXT` convertit le nombre CRDT `202410` en texte `202410.0`, qui reste invalide |
| I17 | `json_extract` lève une erreur sur le JSON syntaxiquement invalide                                 |

I18 vérifie la forme bloquante sans `projection`. I19 vérifie la projection
Manual accompagnée du diagnostic obligatoire d'une Rule masquée invalide. I20
vérifie que la suppression de Manual révèle l'erreur. I21 vérifie qu'une
Manual invalide bloque avant toute projection Rule ou Default et espionne
`JSON.parse` pour démontrer que Rule n'est pas décodée. Deux tests combinés
vérifient qu'une `bankDate` invalide est prioritaire sur une Manual invalide ou
sur une Rule syntaxiquement invalide, sans appel à `JSON.parse`.

## Résultats AQL et SQLite

### Type AQL `json`

Dans `convertOutputType`, une erreur de `JSON.parse` retourne `null` pour le
type `json`. I09 observe donc une perte d'information : le JSON invalide
`{"period":"2024-10"` devient indistinguable d'une Rule réellement absente.
Ce type ne convient pas au futur champ synchronisé.

### Type AQL `json/fallback`

I10 observe qu'un JSON valide non canonique est parsé en objet. Les espaces et
la forme lexicale exacte disparaissent avant la validation canonique du
domaine. Le fallback ne protège que le cas où `JSON.parse` échoue ; il ne
préserve pas toutes les valeurs présentes.

### Type AQL `string`

I11 observe que le schéma de test `string` préserve les quatre états physiques
sans conversion. La représentation future proposée reste donc `TEXT NULL` en
SQLite et `string` en AQL. Le présent lot ne modifie aucun de ces schémas en
production.

### Affinité `TEXT` et JSON1

I16 injecte réellement une valeur numérique par la synchronisation générique.
`messages_crdt` conserve `N:202410`, tandis que la colonne SQLite `TEXT`
contient la chaîne `202410.0`. Cette chaîne est présente et invalide ; elle
n'est jamais assimilée à `null`.

I17 observe que `json_extract` échoue sur le JSON syntaxiquement invalide. Une
projection SQL avec `json_extract` et `COALESCE` risquerait soit d'échouer, soit
de masquer l'erreur si un fallback était ajouté. Aucune projection SQL
effective ne doit être créée avant la conception d'un état de validité
explicite.

## Synchronisation et récupération

I12 montre que la valeur invalide traverse `receiveMessages`, est appliquée à
la cellule et persiste sous la forme `S:<valeur brute>` dans `messages_crdt`.
Le sync générique ne valide pas le domaine Budget FR et ne doit pas rejeter la
valeur avant la résolution CRDT.

I13 à I15 montrent trois états successifs possibles :

1. un invalide LWW gagnant reste présent et bloque la projection ;
2. une Rule canonique plus récente remplace la cellule et rend Rule effective ;
3. un `null` plus récent efface explicitement la Rule et autorise Default.

Les anciens messages restent des traces techniques dans `messages_crdt`. Ils
ne sont ni une frontière de batch, ni une source de restauration métier, ni un
journal d'audit. Une procédure de resynchronisation est une voie de récupération
future non conçue par ce spike.

## Agrégations futures

La politique retenue, non branchée ici, est :

- une erreur effective bloquante fait échouer l'agrégation entière ;
- aucune transaction n'est exclue silencieusement ;
- une transaction avec Manual valide et Rule masquée invalide reste utilisable
  dans sa période Manual, avec diagnostic applicatif obligatoire.

Le futur consommateur ajoutera l'identifiant de transaction au diagnostic. Le
domaine pur ne reçoit pas cet identifiant et n'expose aucune journalisation
automatique de la valeur brute.

## Preuves dynamiques

L'exécution rouge initiale effective a produit **48 tests réussis et 34 en
échec** : 25 échecs provenaient des deux fonctions encore absentes ; les neuf
tests SQLite ne pouvaient pas charger `better-sqlite3`, compilé pour une autre
ABI Node. Le lancement préalable via `rtk test` n'avait pas exécuté Vitest, car
son sous-processus ne trouvait pas `yarn`.

Après reconstruction locale des modules natifs pour le runtime actif :

- tests purs : **73/73 réussis** ;
- première exécution de l'intégration avec le module natif chargé : **4/9
  réussis** ; I09 à I11 et I17 ont réussi, tandis que les cinq passages par
  `receiveMessages` ont signalé `clock-drift`, car la base de temps fixe du
  test n'était pas alignée sur l'horloge simulée du harness ;
- après alignement de la base HULC sur `Date.now()` du harness : **8/9
  réussis** ; I16 a observé `202410.0` au lieu de l'hypothèse initiale
  `202410` ;
- après alignement de l'assertion I16 sur l'observation : **9/9 réussis**.

Le correctif issu de la revue a été exécuté test-first :

- première exécution ciblée avant modification du domaine : **1 test réussi,
  2 en échec et 72 non sélectionnés** ; les deux erreurs reçues étaient
  respectivement `invalid-budget-period` et
  `rule-assignment-invalid-json` au lieu de `invalid-bank-date` ;
- après centralisation de la validation de `bankDate` en tête des deux fonctions
  de projection : **3/3 tests sélectionnés réussis**, 72 non sélectionnés ;
- fichiers complets après correction : **75/75 tests purs** et **9/9 tests
  d'intégration**.

Validations finales observées :

- tests purs et nouveau test ensemble : **84/84 réussis** ;
- domaine, nouveau test, option D, premier POC et sync : **158/158 réussis**
  dans cinq fichiers ;
- Timestamp et Merkle : **20/20 réussis** dans deux fichiers ;
- suite loot-core Node complète : **1 230 réussis et 2 ignorés**, 79 fichiers
  réussis et un fichier ignoré ;
- suite loot-core Web complète : **9/9 réussis** dans deux fichiers, aucun test
  ignoré ;
- `oxfmt --check` ciblé sur les quatre fichiers : réussi ;
- `yarn lint` : réussi ;
- `yarn typecheck` réel : réussi, avec six tâches Lage exécutées et quatre
  résultats récupérés du cache ;
- `git diff --check` et les contrôles de périmètre finaux : réussis.

L'environnement présentait initialement un cache
`.yarn/install-state.gz` appartenant à `root` et un binaire
`better-sqlite3` construit pour une autre ABI Node. Le cache a été régénéré
avec les droits de l'utilisateur et les modules natifs locaux ont été
reconstruits. Ces opérations concernent uniquement les dépendances ignorées et
n'ajoutent aucun fichier au diff.

## Analyse statique

La lecture du code explique, sans remplacer les preuves dynamiques :

- `convertOutputType` dans `server/aql/schema-helpers.ts` parse `json` et
  `json/fallback`, mais laisse `string` inchangé ;
- `compileAndRunAqlQuery` utilise `execQuery` lorsqu'aucun exécuteur spécialisé
  n'est fourni, ce qui est le chemin couvert dynamiquement par ce spike ;
- les exécuteurs AQL spécialisés des transactions appellent également
  `convertOutputType`, tandis que `db.selectWithSchema` passe par
  `convertFromSelect` ; ces deux chemins sont seulement inspectés, pas testés
  dynamiquement ici ;
- `receiveMessages` appelle `Timestamp.recv`, puis `applyMessages` ;
- `compareMessages` décide le LWW séparément par cellule ;
- `applyMessages` écrit la valeur applicative et `messages_crdt` dans une
  transaction SQLite ;
- `serializeValue` distingue `null`, nombre et chaîne.

Le test ne modifie ni ces fonctions, ni le protocole, ni Merkle, ni
`SYNC_FORMAT_VERSION`.

## Limites et risques ouverts

- Aucun schéma, vue, index, migration, ancien fichier ou cycle de réouverture
  n'est testé.
- Aucun adaptateur `TransactionEntity`, consommateur, agrégat, listener,
  abonnement AQL, import, export, API ou UI n'est branché.
- Les clients mixtes restent entièrement ouverts. Le harness ne démontre ni
  qu'un ancien client ignore sans perte les nouvelles colonnes, ni qu'il les
  retransmet, ni qu'il peut rouvrir une base migrée.
- La procédure applicative de diagnostic, de quarantaine éventuelle et de
  resynchronisation reste à définir. La valeur brute ne doit pas être placée
  dans les logs.
- Les tombstones de transaction, les splits et les transferts multi-lignes ne
  sont pas couverts.
- Le comportement multi-lignes et l'atomicité distribuée ne sont pas déduits de
  la transaction mono-ligne de la table de probe.
- Aucune agrégation n'est exercée ; sa politique d'échec intégral demeure un
  contrat à implémenter et tester.
- La compatibilité avec des mises à jour upstream devra préserver les chemins
  génériques AQL et CRDT sans fork parallèle.

## Conséquence pour ADR-0006

Le spike confirme la nécessité de distinguer `absent`, `valid` et `invalid`, et
confirme la conservation SQLite `TEXT NULL`. Il contredit en revanche le type
AQL `json` actuellement envisagé par ADR-0006 : la décision doit être amendée
vers `string` avant toute migration ou intégration applicative.

La frontière de détection peut être un adaptateur pur après lecture AQL, avec
erreur bloquante ou diagnostic Manual selon la politique ci-dessus. Son
branchement applicatif, la stratégie clients mixtes et la migration exigent
encore validation humaine et lots séparés.

**NOT READY FOR PRODUCTION MIGRATION OR RELEASE**
