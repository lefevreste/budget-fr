# Baseline technique Actual Budget pour Budget FR

Date du diagnostic : 2026-09-01
Mode : analyse uniquement, sans implémentation de `budgetPeriod`.

Ce document décrit le fork au commit indiqué ci-dessous. Il distingue les faits
observés dans le code des recommandations qui doivent encore être validées par
une ADR.

> **Note historique :** ce diagnostic a été réalisé avant ADR-0002 et sa
> conclusion de gate reflète cet instant. ADR-0002 a ensuite été créée et
> constitue désormais la décision applicable.

## 1. Commit baseline

| Élément                   | Valeur observée                               |
| ------------------------- | --------------------------------------------- |
| Dépôt `origin`            | `https://github.com/lefevreste/budget-fr.git` |
| Dépôt `upstream`          | `https://github.com/actualbudget/actual.git`  |
| Branche                   | `feature/budget-fr-foundation`                |
| Commit                    | `b83eefd25d09e6d6cd6e49a48eaaf830c91cdbb0`    |
| Commit court              | `b83eefd25`                                   |
| Date du commit            | `2026-09-01T18:59:46+02:00`                   |
| Sujet                     | `docs: add Budget FR foundation`              |
| Version racine            | `0.0.1`                                       |
| Node exécuté              | `v24.15.0`                                    |
| Node demandé par `.nvmrc` | `v24.18.1`                                    |
| Yarn                      | `4.17.1` via Corepack                         |

Le checkout était propre avant la création de ce document.

Contrôles effectués depuis la racine :

- `corepack yarn install --immutable` : succès ; avertissements de peer
  dependencies uniquement ;
- `corepack yarn start` : succès, Vite `v8.1.5` disponible sur
  `http://localhost:3001` ; une requête HTTP a obtenu `200` ; le processus a
  ensuite été arrêté volontairement ;
- `corepack yarn typecheck` : succès, 10 workspaces, 0 échec ;
- `corepack yarn test` : succès, 9 workspaces, 0 échec ;
- `corepack yarn lint` : échec du contrôle de formatage sur le fichier
  préexistant `docs/budget-fr/functional-spec.md` uniquement. Aucun correctif
  automatique n'a été appliqué, conformément au périmètre de cette mission.

Avertissements de baseline :

- Node satisfait l'engine `>=22`, mais ne correspond pas exactement à
  `.nvmrc` ;
- l'installation signale des plages React/React DOM et plusieurs peer
  dependencies non fournies directement ;
- le démarrage Web signale que le navigateur n'a pas accordé le stockage
  persistant et peut donc évincer des données locales sous pression ;
- le répertoire ADR annoncé par l'architecture, `docs/budget-fr/adr/`,
  n'existe pas encore.

## 2. Packages concernés

### `packages/loot-core`

Centre du changement éventuel : modèle public, schéma AQL, SQLite, migrations,
mutations, imports, règles, budgets, schedules, forecast et synchronisation
cliente. Les symboles principaux sont `TransactionEntity`, `DbTransaction`,
`schema.transactions`, `batchUpdateTransactions`, `reconcileTransactions`,
`runRules`, `generateForecast` et `applyMessages`.

### `packages/desktop-client`

Affichage, édition, filtre et tri des transactions. Les points d'entrée sont
`TransactionsTable`, `TransactionList`, `Account`, `FiltersMenu` et
`RuleEditor`.

### `packages/api`

API publique TypeScript, notamment `addTransactions`, `importTransactions`,
`getTransactions` et `updateTransaction` dans `packages/api/methods.ts`.

### `packages/crdt`

Le protocole de synchronisation est générique. Le message défini dans
`packages/crdt/src/proto/sync.proto` transporte `dataset`, `row`, `column` et
`value`, sans liste fermée des champs de transaction.

### `packages/sync-server`

Le serveur conserve des enveloppes binaires opaques dans `messages_binary`
(`packages/sync-server/src/sql/messages.sql`, fonction `sync` dans
`packages/sync-server/src/sync-simple.js`). Aucun changement serveur n'est a
priori requis pour un champ de transaction, mais la compatibilité entre
versions clientes reste un risque bloquant détaillé en section 9.

## 3. Modèle Transaction

### Type canonique et représentation persistée

Le type TypeScript canonique est `TransactionEntity`, défini dans
`packages/loot-core/src/types/models/transaction.ts`. Il emploie les noms AQL
publics (`account`, `payee`, `imported_id`, `transfer_id`) et représente la date
bancaire par une chaîne `YYYY-MM-DD`. Les montants sont des unités mineures
entières via `IntegerAmount`.

La structure réellement persistée est `DbTransaction` dans
`packages/loot-core/src/server/db/types/index.ts`, alignée sur la table SQLite
`transactions`. Elle utilise notamment :

- `date INTEGER` au format `YYYYMMDD` ;
- `acct` pour `account` ;
- `description` pour `payee` ;
- `financial_id` pour `imported_id` ;
- `imported_description` pour `imported_payee` ;
- `transferred_id` pour `transfer_id` ;
- `isParent` et `isChild` pour les transactions ventilées.

`schema.transactions` dans
`packages/loot-core/src/server/aql/schema/index.ts` constitue le contrat entre
les objets publics et SQLite. `schemaConfig.views.transactions.fields` y
définit les correspondances de noms physiques. Les fonctions
`convertForInsert`, `convertForUpdate` et `convertFromSelect`, dans
`packages/loot-core/src/server/aql/schema-helpers.ts`, valident et convertissent
les valeurs.

### Vues SQL

Les lectures courantes passent par les vues générées :

- `v_transactions_internal` : projection interne avec mappings de payee et de
  catégorie ;
- `v_transactions_internal_alive` : élimination des tombstones et enfants
  orphelins ;
- `v_transactions` : vue publique, références vivantes et ordre par date.

Ces vues sont décrites par `schemaConfig.views.transactions` dans
`packages/loot-core/src/server/aql/schema/index.ts`, puis produites par
`makeViews` dans `packages/loot-core/src/server/aql/views.ts`. Les anciennes
migrations `1608652596044_trans_views.sql` et `1614782639336_trans_views2.sql`
ne sont plus la source de vérité des vues courantes.

### Création et mise à jour

Chemin principal :

1. le client appelle le handler `transactions-batch-update`, enregistré dans
   `packages/loot-core/src/server/transactions/app.ts` ;
2. `batchUpdateTransactions`, dans
   `packages/loot-core/src/server/transactions/index.ts`, traite les ajouts,
   mises à jour et suppressions dans un lot ;
3. `db.insertTransaction` ou `db.updateTransaction`, dans
   `packages/loot-core/src/server/db/index.ts`, applique le schéma AQL ;
4. les primitives génériques `insert`, `update` et `delete_` émettent un
   message CRDT par colonne au lieu d'exécuter directement un `INSERT` ou un
   `UPDATE` métier ;
5. les post-traitements gèrent transferts et apprentissage des catégories.

La suppression est logique : `delete_` synchronise `tombstone = 1`.

### Transactions ventilées et transferts

`makeChild`, `updateTransaction`, `splitTransaction` et
`realizeTempTransactions` dans
`packages/loot-core/src/shared/transactions.ts` contrôlent l'héritage entre
parent et enfants. `makeChild` copie explicitement certains champs seulement
(`account`, `date`, `cleared`, etc.). Un futur champ ne serait donc pas hérité
automatiquement.

`addTransfer` et `updateTransfer` dans
`packages/loot-core/src/server/transactions/transfer.ts` matérialisent la
contrepartie d'un transfert. Ils recopient la date bancaire mais pas un champ
inconnu. Les règles d'héritage de `budgetPeriod` pour splits et deux côtés d'un
transfert doivent être écrites avant l'implémentation, même si les transferts
restent exclus du résultat consolidé.

## 4. Schéma DB et migrations

Le schéma initial historique se trouve dans
`packages/loot-core/src/server/sql/init.sql`. Une nouvelle base utilisateur est
copiée depuis `packages/loot-core/default-db.sqlite` par la création de budget
dans `packages/loot-core/src/server/budgetfiles/app.ts`.

Les migrations versionnées sont dans `packages/loot-core/migrations/`.
`migrate` dans `packages/loot-core/src/server/migrate/migrations.ts` :

- liste les fichiers `.sql` et `.js` ;
- les trie par préfixe numérique ;
- compare cette suite à `__migrations__` ;
- refuse une suite divergente avec `out-of-sync-migrations` ;
- applique les migrations en attente dans l'ordre et enregistre leur identifiant.

Le modèle courant pour une colonne est `ALTER TABLE ... ADD COLUMN`, par
exemple `schedule` dans `1618975177358_schedules.sql`, `reconciled` dans
`1697046240000_add_reconciled.sql` et `raw_synced_data` dans
`1739139550000_bank_sync_page.sql`.

`updateVersion`, dans `packages/loot-core/src/server/update.ts`, exécute les
migrations puis `updateViews`. Cette dernière compare le hash du SQL généré par
`makeViews` à `__meta__.view-hash` et recrée les vues si nécessaire. Ajouter un
champ à `schema.transactions` suffit donc à le faire apparaître dans les vues
générées, à condition que la colonne SQLite existe déjà et que les types/mappings
soient cohérents.

Actual connaît déjà le type AQL `date-month` :

- `convertInputType` transforme `YYYY-MM` en entier `YYYYMM` avec
  `toDateRepr` ;
- `convertOutputType` restitue `YYYY-MM` ;
- `isValidYearMonth` dans `packages/loot-core/src/shared/months.ts` valide le
  mois et sa plage `01..12`.

Ce mécanisme est le candidat natif pour le format physique de `budgetPeriod`.
Une migration future devrait être atomique et testée sur une copie de fichier
existant. Ce diagnostic ne crée ni ne nomme cette migration.

## 5. Imports

Le type d'entrée est `ImportTransactionEntity` dans
`packages/loot-core/src/types/models/import-transaction.ts`. Il conserve la
date, le montant entier, le libellé importé, `imported_id`, les splits et les
indicateurs de rapprochement.

`parseFile` dans
`packages/loot-core/src/server/transactions/import/parse-file.ts` distribue les
formats CSV, QIF, OFX et CAMT/XML. L'import final passe par
`importTransactions` dans `packages/loot-core/src/server/accounts/app.ts`, puis
par `reconcileTransactions` et `addTransactions` dans
`packages/loot-core/src/server/accounts/sync.ts`.

`reconcileTransactions` :

- cherche d'abord un `imported_id` existant ;
- tente sinon un rapprochement par compte, montant et date proche ;
- protège les transactions `reconciled` ;
- met à jour une liste explicite de champs bancaires/importés ;
- exécute les règles sur les transactions normalisées avant l'ajout.

Conséquence favorable : un champ `budget_period` absent de cette liste ne
serait pas effacé lors d'un rapprochement. Cela ne suffit pas pour garantir
AC-004 : il faut tester explicitement l'override manuel, les splits et une
transaction dont la date importée est mise à jour. Les nouveaux imports doivent
recevoir une valeur par défaut déterministe, et les réimports anciens ne doivent
pas transformer une valeur manuelle en valeur automatique.

Le mapping CSV de l'interface est géré sous
`packages/desktop-client/src/components/modals/ImportTransactionsModal/`. Il
n'est pas nécessaire d'exposer `budgetPeriod` comme colonne bancaire au premier
lot : ce concept est une interprétation budgétaire, pas une donnée brute du
relevé.

## 6. Rules engine

Les contrats sont dans `packages/loot-core/src/types/models/rule.ts` :

- `FieldValueTypes` énumère les champs utilisables ;
- `RuleConditionEntity` décrit les conditions ;
- `RuleActionEntity` décrit les actions, dont l'action générique `set`.

`FIELD_INFO` et `FIELD_TYPES` dans
`packages/loot-core/src/shared/rules.ts` associent les champs aux types et
opérateurs. `Condition` dans
`packages/loot-core/src/server/rules/condition.ts` valide et évalue une
condition. `Action` dans `packages/loot-core/src/server/rules/action.ts`
valide les opérateurs et applique les mutations.

`runRules` dans
`packages/loot-core/src/server/transactions/transaction-rules.ts` prépare la
transaction, classe les règles par étape, les applique séquentiellement puis
finalise les données. `rankRules` dans
`packages/loot-core/src/server/rules/rule-utils.ts` ordonne les étapes
`pre`/normale/`post`, puis le score et l'identifiant ; il n'existe pas de champ
de priorité utilisateur correspondant directement à BR-004.

Une action Budget FR peut être ajoutée proprement, mais deux niveaux doivent
être distingués :

- rendre `budget_period` affectable pourrait réutiliser `set` après ajout dans
  `FieldValueTypes`, `FIELD_INFO` et l'éditeur ;
- l'action métier `ASSIGN_NEXT_BUDGET_PERIOD` demandée par EPIC 2 mérite un
  opérateur explicite si elle doit porter sa sémantique, son explication et sa
  priorité. La faire passer pour une modification de `date` violerait INV-001.

L'éditeur est `RuleEditor` dans
`packages/desktop-client/src/components/rules/RuleEditor.tsx`. Ses listes
`conditionFields`, `getActionFields` et `getSplitActionFields` sont explicites ;
`mapField` dans `packages/desktop-client/src/util/rule.ts` fournit les libellés.

Les tests actuels se trouvent notamment dans :

- `packages/loot-core/src/server/rules/index.test.ts` ;
- `packages/loot-core/src/server/rules/formula-action.test.ts` ;
- `packages/loot-core/src/server/rules/formula-action-integration.test.ts` ;
- `packages/loot-core/src/server/rules/rule-utils.test.ts` ;
- `packages/loot-core/src/server/transactions/transaction-rules.test.ts`.

## 7. Schedules

`ScheduleEntity` et `RecurConfig` sont définis dans
`packages/loot-core/src/types/models/schedule.ts`.
`1618975177358_schedules.sql` crée :

- `schedules`, qui référence une règle et porte les états active/completed ;
- `schedules_next_date`, projection des prochaines dates ;
- `schedules_json_paths`, index des chemins JSON utiles ;
- la colonne `transactions.schedule`.

`createSchedule` dans `packages/loot-core/src/server/schedules/app.ts` crée une
règle liée par l'action `link-schedule`. `postTransactionForSchedule` crée une
transaction réelle avec `date = schedule.next_date` ou la date courante, puis
passe par `addTransactions` : le futur défaut `month(bankDate)` pourrait donc
s'appliquer sans chemin parallèle.

Briques réutilisables :

- calcul de récurrence et prochaine occurrence dans
  `packages/loot-core/src/shared/schedules.ts` ;
- liens transaction/schedule existants ;
- exécution des règles sur les occurrences ;
- détection d'une occurrence déjà postée par
  `isScheduleOccurrencePosted`/`getHasTransactionsQuery`.

Une schedule est une prévision de trésorerie datée ; elle ne remplace pas une
affectation budgétaire et ne constitue donc pas une option C de persistance.

## 8. Forecast

Le fork contient déjà un forecast de solde expérimental :

- contrats dans `packages/loot-core/src/types/models/forecast.ts` ;
- handler `forecast/generate` et fonction `generateForecast` dans
  `packages/loot-core/src/server/forecast/app.ts` ;
- génération des occurrences dans `forecast-schedules.ts` ;
- projection quotidienne dans `forecast-projection.ts` ;
- variante tracking budget dans `forecast-tracking-budget.ts` ;
- hook `useBalanceForecast` et composants sous
  `packages/desktop-client/src/components/reports/` ;
- feature flag `balanceForecastReport` dans
  `packages/desktop-client/src/hooks/useFeatureFlag.ts`.

La source par défaut combine les transactions réelles et les occurrences de
schedules sur un horizon allant par défaut jusqu'à douze mois. La fonction
`summarizePostedTransactions` groupe les montants par `tx.date` et calcule un
solde quotidien. Cette date est une date de trésorerie et doit rester la date
bancaire.

Le forecast est donc réutilisable pour les occurrences, le rapprochement et
les points quotidiens, mais pas tel quel pour le budget mensuel Budget FR. Il
faudra conserver deux axes explicites :

- `bankDate` pour le solde réel/prévisionnel de trésorerie ;
- `budgetPeriod` pour l'agrégation budgétaire mensuelle.

`getSumAmountsByMonth`, `createCategory` et `handleTransactionChange` dans
`packages/loot-core/src/server/budget/base.ts` groupent actuellement par
`t.date / 100`. C'est le point central à adapter pour qu'une charge bancaire de
fin août puisse appartenir au budget de septembre sans déplacer le flux de
trésorerie.

## 9. Sync

### Fonctionnement observé

`insert`, `update` et `delete_` dans
`packages/loot-core/src/server/db/index.ts` appellent `sendMessages` avec un
message par cellule : table (`dataset`), identifiant (`row`), colonne et valeur.
`applyMessages` dans `packages/loot-core/src/server/sync/index.ts` :

- compare les horodatages CRDT ;
- regroupe les identifiants par table ;
- applique tous les messages retenus dans une transaction SQLite ;
- conserve les messages dans `messages_crdt` ;
- notifie budgets, tableurs, subscriptions et UI.

Le serveur de sync ne valide pas le schéma métier. `SYNC_FORMAT_VERSION = 2`
dans `packages/sync-server/src/app-sync/validation.js` versionne le format
interne des enveloppes, pas les colonnes SQLite clientes.

### Ajout d'un champ de transaction

Après migration locale et ajout dans `schema.transactions`, le champ est
synchronisé automatiquement lorsqu'il est inséré ou mis à jour. Il n'existe pas
de schéma protobuf à étendre.

Risque critique : `apply` construit dynamiquement
`UPDATE transactions SET <column>` ou `INSERT INTO transactions
(id, <column>)`. Un client ancien qui reçoit `budget_period` sans avoir exécuté
la migration lèvera `SyncError('invalid-schema')`. Le serveur opaque ne bloque
pas cette combinaison. Aucune garantie de compatibilité rolling upgrade n'a
été identifiée dans ce diagnostic.

### Ajout d'une table d'extension

Une table synchronisable devrait respecter les conventions réelles du moteur :

- une clé primaire texte `id`, car `apply` insère toujours `id` ;
- un `tombstone`, car `delete_` ne fait pas de `DELETE` physique ;
- une entrée dans le schéma AQL et, si elle est exposée, des vues/jointures ;
- des mutations passant par `db.insert`/`db.update`/`db.delete_` ;
- une gestion explicite de la suppression/tombstone de la transaction parente.

La forme conceptuelle à seule clé `transaction_id` n'est donc pas directement
compatible avec le mécanisme générique. Une clé `id` — éventuellement égale à
l'identifiant de transaction — serait nécessaire. Les clés étrangères SQLite
et `ON DELETE CASCADE` ne résolvent pas la suppression, puisqu'Actual utilise
des tombstones.

### Migrations et schémas sync requis

- Option A : migration SQLite cliente, types DB/Entity, schéma AQL et vues ; pas
  de migration sync-server ni de changement protobuf attendu.
- Option B : migration SQLite de table, schéma AQL, types, CRUD synchronisé,
  gestion des tombstones et subscriptions ; pas de changement protobuf attendu.
- Dans les deux cas : un test avec deux bases synchronisées, ainsi qu'un test
  explicite nouveau client/ancien client, est obligatoire avant diffusion.

Incertitude bloquante : faut-il interdire les clients anciens, déclencher un
reset de sync, ou introduire une stratégie tolérante aux champs inconnus ? Le
code actuel ne tranche pas ce point. Modifier `SYNC_FORMAT_VERSION` forcerait
un reset de tous les fichiers synchronisés et ne doit pas être choisi sans ADR.

## 10. API

L'API publique expose dans `packages/api/methods.ts` :

- `addTransactions` ;
- `importTransactions` ;
- `getTransactions` ;
- `updateTransaction` ;
- `deleteTransaction`.

Les contrats de handlers correspondants sont dans
`packages/loot-core/src/types/api-handlers.ts` et les handlers dans
`packages/loot-core/src/server/api.ts`. `getTransactions` utilise AQL avec
`select('*')`; un nouveau champ de `schema.transactions` apparaîtrait donc dans
les objets retournés.

Compatibilité recommandée :

- propriété optionnelle pendant la transition ;
- format métier public sans ambiguïté `YYYY-MM` ;
- format physique `INTEGER YYYYMM` caché par le type AQL `date-month` ;
- conservation de `date` comme date bancaire ;
- acceptation de l'absence du champ sur les appels d'anciens clients, avec une
  valeur effective calculée depuis `date` ;
- validation stricte de `YYYY-MM`, sans accepter un jour arbitraire.

Actual utilise des noms snake_case dans `TransactionEntity`. Le nom interne le
plus cohérent est donc `budget_period`, tandis qu'un futur contrat métier Budget
FR indépendant pourra exposer `budgetPeriod`. Cette traduction doit être
formalisée, pas implicite.

## 11. UI

La grille principale est `TransactionsTable` dans
`packages/desktop-client/src/components/transactions/TransactionsTable.tsx`.
`TransactionList` orchestre l'ajout et la sauvegarde via
`transactions-batch-update`. `Account` construit les requêtes AQL et pilote le
refetch.

Les colonnes et leurs préférences sont centralisées dans
`packages/desktop-client/src/components/transactions/table/columns.ts` :

- `TRANSACTION_TABLE_COLUMN_IDS` fixe l'ordre ;
- `TransactionTableColumnId` ferme le type ;
- `useTransactionTableColumnLabels` fournit les libellés ;
- `parseTransactionTableColumns` réinsère les nouvelles colonnes absentes des
  préférences synchronisées.

Une colonne éditable implique au minimum :

- déclarer la colonne et son libellé ;
- ajouter header, cellule et chemin de sauvegarde dans `TransactionsTable` ;
- utiliser un sélecteur de mois strict, pas détourner `DateSelect` en date
  bancaire ;
- ajouter filtre et tri AQL ;
- couvrir le gestionnaire `TransactionTableColumnsModal` et la navigation
  clavier ;
- définir le comportement parent/enfants et mobile.

Les filtres s'appuient sur les mêmes champs que les règles via
`FiltersMenu`, `FilterExpression` et `subfieldToOptions` sous
`packages/desktop-client/src/components/filters/`. Le support mensuel déjà
présent pour la date peut inspirer l'éditeur, mais un champ `date-month` mérite
une entrée explicite.

Composants réutilisables : `DateSelect` pour les conventions d'interaction,
les primitives de popover/autocomplete et les fonctions de formatage de
`shared/months`. Aucun sélecteur de mois transactionnel dédié n'a été identifié.

## 12. Options de persistance `budgetPeriod`

### Option A — Champ dans `transactions`

Forme cible envisagée : champ public `budget_period: YYYY-MM`, colonne physique
`budget_period INTEGER` en `YYYYMM`, exposée avec le type AQL `date-month`.

Avantages :

- suit le mécanisme natif des propriétés de transaction ;
- aucune jointure pour la grille, les filtres, les règles ou l'API ;
- CRUD, tombstone, backup et synchronisation par colonne déjà disponibles ;
- impact limité sur les subscriptions et requêtes AQL ;
- format de mois déjà supporté.

Limites et risques :

- migration et backfill de toutes les bases existantes ;
- risque inter-version sync `invalid-schema` ;
- chaque création spéciale, split, transfert, schedule et import doit conserver
  l'invariant ;
- un champ seul ne distingue pas défaut, règle et correction manuelle ;
- une valeur concrète backfillée ne permet pas de savoir si elle doit suivre un
  changement ultérieur de `bankDate` ;
- l'audit ne peut pas reposer sur `messages_crdt`, qui n'est pas un journal
  métier avec acteur, motif et source.

### Option B — Table `budget_fr_transaction_assignment`

Forme compatible Actual à étudier : `id`, `transaction_id`, `budget_period`,
`source`, `manual_override`, éventuellement `rule_id`, et `tombstone`.

Avantages :

- reflète directement la séparation logique `BankTransaction` /
  `BudgetAssignment` ;
- accueille provenance, verrouillage manuel et futurs attributs sans élargir
  continuellement `transactions` ;
- réduit le delta visible sur le modèle transaction upstream.

Limites et risques :

- table, CRUD, schéma AQL, jointures et subscriptions supplémentaires ;
- lecture de grille et budget plus complexes ;
- état partiel possible entre messages CRDT de deux datasets ;
- tombstone à propager explicitement lors d'une suppression ;
- splits, transfers et fusion de transactions plus difficiles ;
- API et export tabulaire doivent joindre les données ;
- maintenance durable d'un sous-domaine propre au fork.

Le backup ZIP copie `db.sqlite` en entier dans
`packages/loot-core/src/server/budgetfiles/backups.ts` et préserverait donc la
table. En revanche, les exports/API qui projettent seulement les transactions
ne l'incluraient pas automatiquement.

### Option C — Mécanisme natif alternatif

Aucun mécanisme existant plus adapté n'a été trouvé :

- les notes/tags ne sont pas typés comme une période et seraient fragiles ;
- les préférences ne sont pas liées à une transaction ;
- les rules décrivent une transformation, pas son résultat persistant ;
- les schedules décrivent une récurrence et un lien de rapprochement ;
- le champ natif `schedule` montre plutôt que les données directement liées à
  une transaction sont ajoutées à `transactions`.

Option C n'est donc pas recommandée.

## 13. Recommandation

Recommandation de diagnostic : **Option A, stockage transaction-local**, avec
les réserves suivantes à inscrire dans ADR-0002 avant tout code :

1. API/AQL en `YYYY-MM`, SQLite en `INTEGER YYYYMM` via `date-month` ;
2. `date` reste strictement la date bancaire ;
3. la valeur effective par défaut est `month(date)` ;
4. la persistance doit aussi permettre de connaître la provenance ou le
   verrouillage manuel. Un champ `budget_period` isolé est insuffisant pour
   INV-003, AC-003, AC-004 et la traçabilité ;
5. le choix exact entre un indicateur transaction-local
   (`budget_period_manual`/`budget_period_source`) et un journal d'audit séparé
   doit être arrêté dans l'ADR ;
6. les calculs de trésorerie continuent d'utiliser `date`, seuls les calculs
   budgétaires utilisent la période effective ;
7. la stratégie de compatibilité des clients synchronisés doit être prouvée par
   test avant livraison.

Cette recommandation minimise le delta avec Actual et exploite son AQL/CRDT
natif. Elle ne vaut pas autorisation d'implémenter : les points 4 et 7 sont des
stop conditions actuelles.

## 14. Risques

| Risque                                                    | Niveau                | Mesure requise                                                                         |
| --------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| Ancien client recevant une colonne inconnue               | Critique              | Test inter-version et stratégie de déploiement/compatibilité dans ADR-0002             |
| Migration SQLite sur fichiers existants                   | Élevé                 | Copie de sauvegarde, test migration réel, contrôle après réouverture et sync           |
| Backfill détruisant la distinction défaut/manuel          | Élevé                 | Modèle de provenance défini avant SQL                                                  |
| `NOT NULL` ou `CHECK` trop strict pendant rolling upgrade | Élevé                 | Migration additive/tolérante, validation applicative et plan de durcissement ultérieur |
| Vues AQL recréées avant colonne disponible                | Élevé                 | Conserver l'ordre `migrate` puis `updateViews`, test d'ouverture d'une ancienne base   |
| Parent/enfants ayant des périodes divergentes             | Élevé                 | Invariant split et tests de `makeChild`/édition parent                                 |
| Contreparties de transfert divergentes                    | Moyen                 | Règle explicite ; conserver exclusion du consolidé                                     |
| Réimport écrasant un override                             | Élevé                 | AC-004/AC-005 au niveau `reconcileTransactions`                                        |
| Mélange budget et trésorerie                              | Critique              | Interdire tout remplacement global de `date`; tests séparés budget/forecast            |
| Règles sans priorité métier                               | Élevé                 | Définir source/verrou et ordre BR-004 avant action M+1                                 |
| Audit supposé fourni par CRDT                             | Élevé                 | Journal métier ou provenance explicite ; ne pas présenter `messages_crdt` comme audit  |
| Requêtes budget historiques plus coûteuses                | Moyen                 | Index éventuel `(budget_period, category)` mesuré avant ajout                          |
| Lint baseline non vert                                    | Faible pour l'analyse | Corriger séparément le format de la spécification, avec autorisation explicite         |

Incertitudes restantes :

- comportement supporté officiellement par Actual pendant une synchronisation
  entre deux versions de schéma différentes ;
- stratégie produit si la date bancaire change après une affectation par défaut ;
- granularité de la période sur un split : parent unique ou override par ligne
  catégorisée ;
- sémantique de l'autre côté d'un transfert ;
- niveau d'audit attendu dès la première feature ;
- éventuelle exigence d'index après mesure sur une base volumineuse.

## 15. Liste exacte des fichiers pressentis pour `feat/budget-period`

Cette liste concerne le plus petit lot complet champ + calcul budgétaire +
édition/filtre + API + sync. Une ADR peut retirer ou ajouter un fichier, mais ne
doit pas laisser un de ces chemins sans décision explicite.

### Décision préalable

- `docs/budget-fr/adr/0002-budget-period-persistence.md` — nouveau fichier à
  créer avant la feature ; le répertoire n'existe pas encore.

### Modèle, SQLite, AQL et mutations

- `packages/loot-core/src/types/models/transaction.ts`
- `packages/loot-core/src/types/models/import-transaction.ts`
- `packages/loot-core/src/server/db/types/index.ts`
- `packages/loot-core/src/server/aql/schema/index.ts`
- `packages/loot-core/src/server/transactions/index.ts`
- `packages/loot-core/src/shared/transactions.ts`
- `packages/loot-core/src/server/transactions/transfer.ts`
- `packages/loot-core/src/server/accounts/sync.ts`
- `packages/loot-core/src/server/budget/base.ts`
- `packages/loot-core/migrations/<timestamp>_add_budget_period.sql` — nom exact
  à fixer au moment de la création pour respecter l'ordre global des migrations.

`packages/loot-core/src/server/sql/init.sql` est une source de bootstrap à
vérifier, mais la convention observée impose d'abord une migration versionnée ;
il ne doit pas être modifié sans confirmer le pipeline de régénération de
`default-db.sqlite`.

### Règles

- `packages/loot-core/src/types/models/rule.ts`
- `packages/loot-core/src/shared/rules.ts`
- `packages/loot-core/src/server/rules/action.ts`
- `packages/loot-core/src/server/transactions/transaction-rules.ts`
- `packages/desktop-client/src/components/rules/RuleEditor.tsx`
- `packages/desktop-client/src/util/rule.ts`

L'opérateur M+1 peut être isolé dans un lot suivant si la première feature se
limite au défaut et à l'override manuel. Cette séparation doit conserver les
tests de priorité dès que les règles écrivent la période.

### API

- `packages/loot-core/src/types/api-handlers.ts`
- `packages/loot-core/src/server/api.ts`
- `packages/api/methods.ts`

### UI desktop et filtres

- `packages/desktop-client/src/components/transactions/table/columns.ts`
- `packages/desktop-client/src/components/transactions/table/utils.ts`
- `packages/desktop-client/src/components/transactions/TransactionsTable.tsx`
- `packages/desktop-client/src/components/transactions/TransactionList.tsx`
- `packages/desktop-client/src/components/accounts/Account.tsx`
- `packages/desktop-client/src/components/modals/TransactionTableColumnsModal.tsx`
- `packages/desktop-client/src/components/filters/FiltersMenu.tsx`
- `packages/desktop-client/src/components/filters/FilterExpression.tsx`
- `packages/desktop-client/src/components/filters/subfieldToOptions.ts`

### UI mobile à trancher dans le périmètre de recette

- `packages/desktop-client/src/components/mobile/transactions/TransactionEdit.tsx`

### Tests ciblés pressentis

- `packages/loot-core/src/server/migrate/migrations.test.ts` ou le test de
  migration équivalent à créer selon le harness existant
- `packages/loot-core/src/server/aql/views.test.ts`
- `packages/loot-core/src/server/sync/sync.test.ts`
- `packages/loot-core/src/server/sync/sync.property.test.ts`
- `packages/loot-core/src/server/accounts/sync.test.ts`
- `packages/loot-core/src/shared/transactions.test.ts`
- `packages/loot-core/src/server/transactions/transaction-rules.test.ts`
- `packages/loot-core/src/server/rules/index.test.ts`
- `packages/loot-core/src/server/budget/base.test.ts` ou un test budget ciblé à
  créer selon le découpage retenu
- `packages/api/e2e/browser.test.ts`
- `packages/desktop-client/src/components/transactions/TransactionsTable.test.tsx`
- `packages/desktop-client/src/components/transactions/table/utils.test.ts`
- `packages/desktop-client/src/components/transactions/table/columns.test.ts` —
  test dédié à créer pour la préférence de colonne

`packages/crdt/src/proto/sync.proto` et le code de `packages/sync-server` ne
devraient pas être modifiés pour l'option A. Ils doivent néanmoins être inclus
dans la validation de compatibilité.

## 16. Tests à écrire avant implémentation

Les critères AC-001 à AC-005 sont transformés ci-dessous en spécifications de
tests. Les fixtures n'emploient que des données fictives.

### T-BFR-001 — Salaire M+1 (AC-001)

Étant donné `date = 2026-08-28`, un libellé fictif de salaire et la règle M+1,
attendre `date = 2026-08-28` et période effective `2026-09`. Vérifier le moteur
de règles, la persistance après réouverture et l'affichage.

### T-BFR-002 — Charge rattachée à septembre (AC-002)

Étant donné une charge au `2026-08-30` explicitement affectée à `2026-09`,
attendre qu'elle soit agrégée dans le budget de septembre, tout en restant dans
la trésorerie du 30 août.

### T-BFR-003 — Désactivation/reclassement de règle (AC-003)

Après désactivation de la règle M+1, recalculer uniquement les affectations non
manuelles selon la règle suivante ou `month(date)`. Vérifier qu'une correction
manuelle ne bouge pas.

### T-BFR-004 — Override manuel et réimport (AC-004)

Importer une transaction, fixer manuellement sa période, puis réimporter la
même ligne avec le même `imported_id`. Attendre une seule transaction, la date
bancaire correcte et l'override inchangé.

### T-BFR-005 — Idempotence CSV (AC-005)

Importer deux fois le même CSV fictif. Attendre le même nombre de transactions,
les mêmes identifiants rapprochés et les mêmes périodes.

### Tests structurels indispensables

- valeur par défaut pour ajout manuel, import CSV/QIF/OFX/CAMT, schedule postée
  et API ;
- validation/rejet de `2026-00`, `2026-13`, `2026-9`, `2026-09-01` comme
  périodes métier ;
- migration d'une base avant feature, réouverture et idempotence de migration ;
- vues recréées et `select('*')` retournant `YYYY-MM` ;
- sync bidirectionnelle de création, mise à jour, null/default et override ;
- test nouveau client vers ancien client démontrant le comportement retenu ;
- split : création enfant, édition parent, désassemblage et duplication ;
- transfert : deux côtés et non-impact sur le consolidé ;
- modification de `date` avec source default, rule et manual ;
- budget mensuel par période versus forecast de trésorerie par date ;
- API ancienne sans propriété et API nouvelle avec propriété optionnelle ;
- filtre, tri, préférence de colonne, navigation clavier et édition mobile si
  incluse.

Gate proposé : ne commencer l'implémentation qu'après validation d'ADR-0002,
choix de la provenance/override et preuve d'une stratégie inter-version. Les
tests ci-dessus peuvent alors être écrits en échec contrôlé avant le code
métier.

## Conclusion de gate

Baseline: commit `b83eefd25`, installation et démarrage Web validés.
Tests: typecheck et suite complète réussis ; lint non vert sur un formatage
préexistant de `functional-spec.md`.
Warnings: Node différent de `.nvmrc`, ADR-0002 absente, provenance et sync
inter-version non décidées.
Recommended persistence: Option A, champ transaction-local `date-month`, avec
provenance/override transaction-local à formaliser.
Files likely impacted: `loot-core`, `desktop-client`, `api`, une migration et
des tests sync ; aucun changement protobuf/sync-server attendu.
Ready for feat/budget-period: **NO**.
Reason: l'ADR de persistance n'existe pas, un champ seul ne respecte pas encore
la priorité manuelle/traçabilité, et le comportement d'un ancien client recevant
la nouvelle colonne peut provoquer `invalid-schema`. Ces blocages doivent être
tranchés et testés avant toute migration ou implémentation.
