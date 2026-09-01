# ADR-0002 — Persistance de la période budgétaire

- Statut : Acceptée
- Date : 2026-09-01
- Décideurs : équipe Budget FR
- Portée : MVP Budget FR dans Actual Budget
- Diagnostic de référence : `docs/budget-fr/actual-baseline.md`

## Contexte

Actual Budget représente une transaction bancaire par `TransactionEntity` et
la persiste dans la table SQLite `transactions`. La date `date` est utilisée à
la fois par les vues de transactions, les calculs de trésorerie, le forecast et
les agrégations budgétaires historiques.

Budget FR doit pouvoir affecter une opération bancaire à un autre mois
budgétaire sans modifier le fait bancaire. Par exemple, un salaire reçu le
28 août peut appartenir au budget de septembre tout en restant un encaissement
de trésorerie du 28 août.

Le diagnostic a comparé trois familles de solutions :

- ajouter les données d'affectation à la transaction existante ;
- créer une table d'extension Budget FR ;
- détourner un mécanisme natif tel que les règles, schedules, notes ou tags.

Actual synchronise les mutations SQLite sous forme de messages CRDT génériques
`dataset`/`row`/`column`/`value`. Une colonne de transaction est donc
synchronisable sans modifier le protobuf ou le sync-server, à condition que
tous les clients aient déjà migré leur schéma local.

La décision doit préserver les invariants fonctionnels suivants : date bancaire
immuable du point de vue budgétaire, priorité de l'utilisateur, idempotence des
imports, cohérence des splits et transferts, et séparation entre budget et
trésorerie.

## Décision

Le MVP retient **l'option A : stockage transaction-local**.

Trois propriétés synchronisées sont ajoutées à chaque transaction :
`budget_period`, `budget_period_source` et `budget_period_rule_id`.

La propriété existante `date` reste strictement la date bancaire. Elle n'est
jamais modifiée pour simuler une affectation budgétaire.

La période utilisée par le domaine est la **période budgétaire effective** :

```text
effectiveBudgetPeriod(transaction) =
  transaction.budget_period
    si transaction.budget_period_source vaut "manual" ou "rule"
  month(transaction.date)
    sinon
```

La valeur `null` n'est donc pas une période inconnue. Elle représente
explicitement le comportement par défaut calculé depuis la date bancaire.

Les filtres, tris, affichages et agrégations qui parlent de période budgétaire
doivent utiliser la période effective. Ils ne doivent pas supposer que
`budget_period` est toujours matérialisé.

## Modèle de données

### Représentation logique et AQL/API

| Propriété               | Type logique                   | Signification                              |
| ----------------------- | ------------------------------ | ------------------------------------------ |
| `date`                  | `YYYY-MM-DD`, non nullable     | Date bancaire                              |
| `budget_period`         | `YYYY-MM` ou `null`            | Affectation persistée rule/manual          |
| `budget_period_source`  | `"rule"`, `"manual"` ou `null` | Provenance courante de l'affectation       |
| `budget_period_rule_id` | identifiant de règle ou `null` | Règle ayant produit l'affectation courante |

Les noms internes suivent la convention snake_case de `TransactionEntity` et
du schéma AQL. Un futur contrat métier indépendant pourra les exposer en
camelCase, sans changer leur sémantique.

`budget_period` utilise le type AQL `date-month`. Une valeur non nulle est
exposée par l'API et AQL au format strict `YYYY-MM`.

### Représentation SQLite

| Colonne                 | Type SQLite | Valeurs                        |
| ----------------------- | ----------- | ------------------------------ |
| `budget_period`         | `INTEGER`   | `YYYYMM` ou `NULL`             |
| `budget_period_source`  | `TEXT`      | `rule`, `manual` ou `NULL`     |
| `budget_period_rule_id` | `TEXT`      | identifiant de règle ou `NULL` |

La conversion `YYYY-MM` ↔ `YYYYMM` est déléguée au type AQL existant
`date-month`. Aucun jour fictif n'est introduit.

Le MVP n'ajoute pas de clé étrangère SQLite sur `budget_period_rule_id`. Actual
emploie des tombstones et la règle source peut être supprimée ou remplacée ;
l'identifiant est une provenance courante, pas une contrainte de cycle de vie.

### États valides

| État    | `budget_period` | `budget_period_source` | `budget_period_rule_id` |
| ------- | --------------- | ---------------------- | ----------------------- |
| Default | `NULL`          | `NULL`                 | `NULL`                  |
| Rule    | `YYYYMM`        | `rule`                 | identifiant non nul     |
| Manual  | `YYYYMM`        | `manual`               | `NULL`                  |

Les combinaisons qui ne figurent pas dans ce tableau sont invalides. Les
mutations des trois propriétés doivent passer par une opération de domaine
unique et être envoyées dans le même batch de messages Actual.

Réinitialiser une correction ou une règle vers le comportement par défaut
efface les trois propriétés. Remplacer une règle met à jour simultanément la
période, la source et l'identifiant de règle. Une correction manuelle efface
`budget_period_rule_id`.

## Invariants

### Date et période effective

1. `date` reste la date bancaire originale ; aucune action Budget FR ne la
   déplace.
2. Si `budget_period_source` est `null`, la période effective vaut toujours
   `month(date)`.
3. Une modification de `date` ne recalcule que la période effective default :
   comme elle n'est pas matérialisée, la nouvelle valeur découle immédiatement
   de `month(date)`.
4. Une période `manual` ou `rule` reste inchangée lors d'une modification de
   `date`, jusqu'à une action explicite de l'utilisateur ou une réévaluation de
   règle autorisée.

### Priorité et provenance

5. La priorité est `manual > rule > default`.
6. Le moteur de règles ne modifie aucune des trois propriétés quand la source
   courante vaut `manual`.
7. Une règle appliquée écrit `budget_period_source = rule` et conserve son
   identifiant dans `budget_period_rule_id`.
8. Une correction manuelle écrit `budget_period_source = manual` et
   `budget_period_rule_id = null`.
9. Un import, un réimport, un rapprochement ou un nouvel apprentissage de règle
   ne peut jamais écraser une affectation `manual`.
10. `budget_period_rule_id` décrit uniquement la règle à l'origine de
    l'affectation courante. Il ne constitue pas un historique complet.

### Splits et transferts

11. Pour le MVP, le parent et tous les enfants d'un split portent le même tuple
    période/source/règle. L'édition d'une ligne du split met à jour le groupe
    entier ; un nouvel enfant hérite du tuple du parent.
12. Pour le MVP, les deux côtés d'un transfert portent le même tuple. La
    création ou la mise à jour de la contrepartie propage le tuple.
13. Les transferts internes restent exclus du revenu net et des dépenses
    consolidées, indépendamment de leur période.

### Calculs

14. Les soldes de comptes, la trésorerie et le forecast journalier continuent
    d'utiliser `date`.
15. Les agrégations budgétaires mensuelles utilisent la période effective,
    conceptuellement `COALESCE(budget_period, date / 100)` dans la
    représentation SQLite actuelle.
16. Une transaction ne peut contribuer qu'une fois à une même agrégation ; la
    présence d'une période explicite ne crée pas une seconde transaction.

## Conséquences

### Conséquences positives

- La date bancaire et l'affectation budgétaire sont séparées sans jointure
  supplémentaire.
- Le modèle s'intègre aux mutations, vues AQL, backups et messages CRDT
  existants d'Actual.
- Les transactions existantes ont immédiatement un comportement valide sans
  backfill de données.
- La valeur par défaut suit naturellement une correction de date bancaire sans
  écriture supplémentaire.
- La provenance minimale permet d'appliquer la priorité manuelle et d'expliquer
  si la valeur courante vient d'une règle.

### Coûts et limitations

- Trois colonnes spécifiques au fork élargissent le modèle transaction
  upstream.
- Les créations spéciales, imports, splits, transferts, règles, API et UI
  doivent respecter le tuple d'affectation.
- Les requêtes budgétaires doivent utiliser la période effective et non la seule
  colonne nullable.
- La provenance courante ne remplace pas un journal d'audit avec acteur, date,
  ancienne valeur et motif.
- Le MVP ne prend pas en charge l'utilisation simultanée de versions clientes
  dont les schémas SQLite diffèrent.

Le journal d'audit métier complet est reporté après le MVP. Cette décision ne
supprime pas l'obligation de persister `budget_period_source` et
`budget_period_rule_id` dès le MVP.

## Stratégie de migration

La migration est additive, versionnée et atomique :

1. ajouter les trois colonnes nullables à `transactions` ;
2. ne réaliser aucun backfill ;
3. ajouter les propriétés au type DB, à `TransactionEntity` et à
   `schema.transactions` ;
4. exposer `budget_period` en `date-month` ;
5. laisser `updateVersion` recréer les vues après la migration ;
6. ouvrir et vérifier une base créée avant la feature ;
7. vérifier qu'une seconde ouverture n'altère ni le schéma ni les données.

L'absence de backfill est intentionnelle : toutes les anciennes lignes restent
dans l'état Default et leur période effective vaut `month(date)`. Elle évite une
réécriture massive et conserve l'information « aucune affectation explicite ».

La première migration ne crée ni `NOT NULL`, ni `CHECK`, ni index. Les invariants
sont validés au niveau du domaine et des entrées AQL. Un index sur la période
effective ne sera ajouté qu'après mesure sur une base volumineuse ; SQLite ne
peut pas indexer directement une abstraction applicative sans choix explicite
d'expression ou de matérialisation.

La migration doit être testée sur une copie d'un fichier réel anonymisé ou sur
une fixture représentative. Aucune stratégie de rollback destructif n'est
présumée ; un backup doit exister avant ouverture par la nouvelle version.

## Stratégie de synchronisation

Les trois colonnes utilisent le mécanisme CRDT générique existant. Aucun
changement n'est prévu dans :

- `packages/crdt/src/proto/sync.proto` ;
- le schéma du sync-server ;
- `SYNC_FORMAT_VERSION`.

Les mutations du tuple sont regroupées par `batchMessages`. Les clients de même
version doivent accepter, persister et réémettre les trois colonnes.

Le MVP **ne garantit pas la synchronisation entre versions clientes
différentes**. Un ancien client peut recevoir une colonne inconnue et lever
`invalid-schema`. La règle opérationnelle est donc :

1. identifier tous les appareils utilisant le budget synchronisé ;
2. mettre à jour tous les clients avant d'activer ou d'utiliser la feature ;
3. ouvrir le budget sur chaque client afin d'exécuter la migration locale ;
4. seulement ensuite créer une valeur `rule` ou `manual` ;
5. ne plus rouvrir ce budget avec une version antérieure.

Si un client ancien produit `invalid-schema`, l'utilisateur doit arrêter les
mutations, mettre le client à jour, rouvrir le budget pour migrer SQLite, puis
relancer la synchronisation. Une réinitialisation de sync n'est pas la réponse
par défaut et ne doit être proposée qu'après sauvegarde et diagnostic.

Actual résout les conflits par colonne. Deux appareils de même version qui
modifient simultanément le tuple peuvent théoriquement produire une combinaison
invalide. Avant implémentation, un test de concurrence doit déterminer le
comportement réel. Les écritures de règles doivent toujours relire la source et
refuser d'écraser `manual`. Si le test démontre qu'un conflit inter-colonnes peut
perdre une correction manuelle, l'implémentation reste bloquée jusqu'à l'ajout
d'une résolution déterministe ou à l'amendement de cette ADR.

## Alternatives rejetées

### Table d'extension `budget_fr_transaction_assignment`

Rejetée pour le MVP : elle impose une clé `id` et un tombstone compatibles avec
Actual, des jointures, un CRUD et des subscriptions supplémentaires, ainsi
qu'une propagation explicite lors des suppressions, splits et transferts. Ces
coûts ne sont pas justifiés pour trois propriétés directement liées au cycle de
vie de la transaction.

### Notes, tags, préférences, rules ou schedules

Rejetés : ces mécanismes ne fournissent pas une propriété mensuelle typée,
requêtable et persistante par transaction. Une règle explique comment calculer
une valeur ; elle ne remplace pas la persistance de son résultat.

### Modifier `date`

Rejeté : cela falsifierait la chronologie bancaire, les soldes de trésorerie et
le forecast, en violation de l'invariant principal Budget FR.

### `budget_period` non nullable avec backfill

Rejeté : le backfill perdrait la distinction entre valeur par défaut et
affectation explicite, alourdirait la migration et obligerait à réécrire la
période lors de chaque changement de date.

### Journal d'audit complet dans le MVP

Reporté : un journal append-only avec acteur et historique est souhaitable mais
élargit le périmètre de persistance, de synchronisation et d'interface. Le MVP
conserve seulement la provenance de la valeur courante.

## Risques

| Risque                                             | Niveau   | Réponse décidée                                                        |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| Client ancien recevant une colonne inconnue        | Critique | Mise à jour obligatoire de tous les clients avant utilisation          |
| Tuple incohérent après conflit CRDT inter-colonnes | Élevé    | Batch unique, relecture avant règle et test de concurrence bloquant    |
| Import écrasant une correction manuelle            | Élevé    | Import interdit de mutation quand la source est `manual`               |
| Divergence parent/enfants d'un split               | Élevé    | Propagation au groupe entier et tests dédiés                           |
| Divergence entre côtés d'un transfert              | Élevé    | Propagation à la contrepartie et tests dédiés                          |
| Agrégation utilisant `date` par erreur             | Critique | Helper/requête de période effective et tests budget/trésorerie séparés |
| Forecast déplacé sur le mois budgétaire            | Critique | Forecast maintenu exclusivement sur `date`                             |
| Migration partielle ou vues invalides              | Élevé    | Migration atomique, ordre migration puis vues, test d'ancienne base    |
| Valeur mensuelle invalide                          | Moyen    | Validation stricte `YYYY-MM`/`date-month` aux frontières               |
| Provenance présentée comme audit complet           | Moyen    | Libellé explicite et audit complet reporté après MVP                   |

## Critères permettant de passer à l'implémentation

L'implémentation peut commencer lorsque tous les critères suivants sont
satisfaits :

- cette ADR est relue et acceptée comme source de vérité de la persistance ;
- le nom, le type et les trois états valides sont repris sans ambiguïté dans les
  scénarios de tests ;
- la fonction de période effective et ses consommateurs budget/trésorerie sont
  inventoriés ;
- les chemins de création import, API, schedule, split et transfert ont chacun
  un test prévu ;
- le comportement de `reconcileTransactions` avec une source `manual` est
  couvert ;
- le test de conflit CRDT du tuple a un résultat acceptable ou une stratégie de
  résolution validée ;
- la procédure « tous les clients doivent être mis à jour » est intégrée à la
  livraison et aux avertissements utilisateur ;
- une fixture de base antérieure à la migration et une procédure de backup sont
  disponibles ;
- les tests upstream, le typecheck et le lint sont verts avant le premier
  changement métier.

## Tests préalables obligatoires

Les tests suivants doivent être écrits ou préparés avant le code de production
correspondant, puis exécutés pendant l'implémentation.

### Modèle et période effective

- état Default : trois valeurs nulles, période effective `month(date)` ;
- état Rule : période `YYYY-MM`, source `rule`, identifiant de règle non nul ;
- état Manual : période `YYYY-MM`, source `manual`, identifiant de règle nul ;
- rejet de chaque combinaison invalide du tuple ;
- rejet de `2026-00`, `2026-13`, `2026-9` et `2026-09-01` ;
- changement de date mettant à jour seulement la période effective Default ;
- changement de date conservant les valeurs Rule et Manual.

### Migration et AQL/API

- ouverture d'une base pré-MVP : colonnes créées et anciennes lignes nulles ;
- réouverture : migration idempotente et vues valides ;
- lecture/écriture AQL de `budget_period` au format `YYYY-MM` ;
- `select('*')` et API compatibles avec l'absence des propriétés en entrée ;
- backup, restauration et nouvelle synchronisation d'une base migrée.

### Priorité, règles et imports

- `manual > rule > default` sur les mêmes transactions ;
- une règle écrit son identifiant et ne remplace jamais Manual ;
- désactivation d'une règle réaffectant Rule vers la règle suivante ou Default ;
- import initial en Default ;
- réimport idempotent conservant Manual ;
- rapprochement avec mise à jour de date conservant Rule/Manual et recalculant
  seulement Default.

### Splits, transferts et calculs

- création, édition et ajout d'enfant conservant un tuple unique sur le split ;
- conversion split/non-split sans perte de provenance ;
- création et mise à jour d'un transfert partageant le tuple des deux côtés ;
- transfert exclu du résultat consolidé ;
- charge du 30 août affectée à septembre : budget de septembre, trésorerie du
  30 août ;
- forecast journalier inchangé par une affectation budgétaire manuelle.

### Synchronisation

- création et modification du tuple entre deux clients de même version ;
- propagation d'une remise à Default ;
- conflit concurrent Rule/Manual et vérification de la priorité ;
- ancien client recevant une colonne inconnue : comportement reproduit et
  procédure de récupération vérifiée ;
- client mis à jour après erreur : migration, reprise de sync et absence de
  perte de la correction manuelle.

Tant que le test de conflit Rule/Manual et le scénario de récupération d'un
ancien client ne sont pas compris, la migration ne doit pas être diffusée.
