# Spike CRDT — période budgétaire, option D

- Branche : `spike/budget-period-option-d`
- Date : 2026-09-02
- Portée : preuve technique sans code de production ni migration
- Références : [premier POC](./budget-period-crdt.md),
  [ADR-0002](../adr/0002-budget-period-persistence.md)
- Verdict : **READY FOR ADR AMENDMENT**

## Résumé

Le POC teste l'option D avec deux cellules CRDT indépendantes :

```text
manual_budget_period: YYYYMM | null
rule_assignment: { period: YYYY-MM, ruleId: string } | null
```

La provenance et la période effective ne sont pas persistées :

```text
source = manual si manual_budget_period != null
         sinon rule si rule_assignment != null
         sinon default

effectiveBudgetPeriod = manual_budget_period
                        sinon rule_assignment.period
                        sinon month(date)
```

Le vrai mécanisme CRDT d'Actual garantit l'indépendance et la convergence de
`manual_budget_period` et `rule_assignment`. Une écriture Rule, même plus
récente, ne supprime donc pas une Manual non nulle, car les deux valeurs
occupent des cellules différentes. Le CRDT n'applique cependant pas lui-même la
priorité `manual > rule > default` : il résout uniquement le LWW interne à
chaque cellule. La priorité appartient à la dérivation métier.

Le résultat rend l'option D apte à remplacer dans ADR-0002 le tuple à trois
colonnes indépendantes. Il ne rend pas la feature prête à être implémentée :
l'ADR doit d'abord être amendée et accepter explicitement le format du
composite, les règles de reset et les limites multi-lignes.

## Règle normative de projection

`effectiveBudgetPeriod` est une règle normative du domaine, et non un simple
helper propre au POC. Tous les consommateurs d'une période budgétaire doivent
obligatoirement l'utiliser :

- budgets ;
- filtres ;
- tris ;
- agrégations ;
- API ;
- UI ;
- exports ;
- règles ;
- prévisions budgétaires.

Aucun consommateur ne doit lire directement `rule_assignment.period` comme
période effective sans vérifier d'abord `manual_budget_period`. La séparation
des cellules préserve les deux entrées concurrentes ; seule cette projection
normative applique leur priorité métier.

Certaines assertions du POC comparent deux implémentations proches de cette
projection : le helper qui lit l'état effectif et le helper qui construit
l'attendu. Les preuves indépendantes principales sont la convergence observée
des cellules brutes dans SQLite et `messages_crdt`, puis les résultats littéraux
des requêtes AQL sur la vue effective.

## Périmètre expérimental

Le seul nouveau harness est :

```text
packages/loot-core/src/server/sync/budget-period-option-d.test.ts
```

Il crée deux tables SQLite en mémoire de forme identique, une par encodage de
`rule_assignment`, ainsi qu'une petite table représentant le cycle de vie d'une
règle. Ces objets n'existent que pendant les tests.

Le harness utilise directement :

- `db.update`, `sendMessages` et `batchMessages` pour les écritures locales ;
- `applyMessages` pour toutes les livraisons concurrentes ;
- les vrais `Timestamp` HULC ;
- `messages_crdt` pour observer les messages techniques persistés ;
- `compileAndRunAqlQuery`, un schéma de test injecté et `tableViews` ;
- SQLite JSON1 et `EXPLAIN QUERY PLAN`.

`compareMessages` est une fonction privée de `sync/index.ts`. Elle n'est donc
pas importable sans modifier la production. Elle est exercée par son appel réel
depuis `applyMessages` : le test observe le marquage `old: true` d'un message
plus ancien et le filtrage complet d'un rejeu de même timestamp.

Les helpers du POC construisent les messages, encodent les composites et
dérivent l'état métier lu. Aucun helper ne compare les timestamps ni ne choisit
le gagnant CRDT.

## Protocole reproductible

Commandes depuis la racine :

```bash
corepack yarn workspace @actual-app/core exec vitest --run \
  src/server/sync/budget-period-option-d.test.ts \
  src/server/sync/budget-period-crdt.test.ts \
  src/server/sync/sync.test.ts

corepack yarn workspace @actual-app/crdt exec vitest --run \
  src/crdt/timestamp.test.ts \
  src/crdt/merkle.test.ts

corepack yarn lint
corepack yarn typecheck
git diff --check
```

Résultats observés :

- nouveau POC seul : **32/32 tests réussis** ;
- nouveau POC, premier POC et baseline sync : **51/51 tests réussis** dans
  trois fichiers ;
- Timestamp et Merkle : **20/20 tests réussis** dans deux fichiers ;
- `yarn lint` : réussi sans erreur ;
- `yarn typecheck` : réussi, 6 workspaces exécutés et 4 sans tâche ;
- `oxfmt --check` ciblé sur les deux nouveaux fichiers : réussi ;
- `git diff --check` : réussi sans sortie ; le contrôle `--no-index --check`
  ciblé sur chacun des deux fichiers non suivis ne rapporte aucune erreur de
  whitespace.

Le nouveau POC exécute les mêmes scénarios pour JSON et texte. Onze ensembles
de conflits par représentation passent chacun par quatre plans de livraison :
lot unique, messages unitaires dans l'ordre, ordre inverse et deux lots
entrelacés.

Ces plans sont représentatifs mais non exhaustifs. Ils ne couvrent pas :

- toutes les permutations possibles ;
- une livraison en sens inverse dans une cellule et en sens direct dans
  l'autre ;
- l'égalité du temps physique et du compteur HULC, départagée uniquement par le
  `node`.

La convergence rapportée ci-dessous signifie donc « convergence pour tous les
plans testés », complétée par le comportement LWW inspecté dans Actual. Elle ne
constitue pas une exploration exhaustive de tous les ordres réseau possibles.

## Observations CRDT brutes

### Cellules et écritures locales

Une écriture locale groupée de Manual et Rule produit deux messages CRDT, un
par colonne. `batchMessages` les applique dans une même transaction SQLite
locale, mais ne les transforme pas en unité de conflit commune.

La table du POC ne contient aucune colonne `source`. La source observée est
toujours dérivée après lecture.

### Rule contre Manual

État convergé observé pour chaque ordre de livraison :

```text
manual_budget_period = 202411
rule_assignment = Rule 2, période 2024-12
source dérivée = manual
effectiveBudgetPeriod = 202411
```

La Rule la plus récente reste stockée en arrière-plan, mais ne devient pas
effective tant que Manual est non nulle. L'ordre HULC entre les deux colonnes
n'a aucune incidence sur cette priorité dérivée.

### Suppression de Manual

Séquence testée :

```text
Rule 2024-10 -> Manual 2024-11 -> Manual null
```

Après convergence, la suppression gagnante de la cellule Manual révèle la Rule
antérieure :

```text
manual_budget_period = null
rule_assignment = Rule 2024-10
source dérivée = rule
effectiveBudgetPeriod = 202410
```

La suppression Manual ne supprime ni ne réécrit `rule_assignment`.

### Conflits dans une même couche

- Deux Manual concurrentes : la Manual au timestamp HULC maximal gagne.
- Manual contre suppression Manual : la valeur ou `null` au timestamp maximal
  gagne.
- Deux Rule concurrentes : le composite complet au timestamp maximal gagne.
- Rule contre suppression Rule : le composite ou `null` au timestamp maximal
  gagne.

Pour deux Rule concurrentes, aucun résultat ne mélange la période d'une Rule et
le `ruleId` de l'autre. `rule_assignment` est bien une seule unité de conflit.

### Reset complet

Le reset complet émet deux suppressions :

```text
manual_budget_period = null
rule_assignment = null
```

Toutes les permutations testées convergent vers Default si ces deux
suppressions sont les gagnantes de leurs cellules respectives.

La visibilité intermédiaire n'est pas atomique :

| Première suppression livrée | État intermédiaire | État après la seconde |
| --------------------------- | ------------------ | --------------------- |
| Manual                      | Rule               | Default               |
| Rule                        | Manual             | Default               |

Cette non-atomicité est acceptée pour le critère du POC. Elle doit être décrite
dans ADR-0002 et ne doit pas être présentée comme une transaction distribuée.

### Reset concurrent

Le résultat est déterminé cellule par cellule :

| Concurrence                          | Gagnant dans la cellule  | État effectif final                   |
| ------------------------------------ | ------------------------ | ------------------------------------- |
| reset / nouvelle Manual plus récente | nouvelle Manual          | Manual                                |
| nouvelle Manual / reset plus récent  | `manual = null`          | Default si Rule est aussi supprimée   |
| reset / nouvelle Rule plus récente   | nouvelle Rule            | Rule si Manual est supprimée          |
| nouvelle Rule / reset plus récent    | `rule_assignment = null` | Default si Manual est aussi supprimée |

Une nouvelle Rule gagnante reste néanmoins masquée si une Manual non nulle est
elle-même gagnante dans l'autre cellule.

### Rejeu et messages anciens

Après application d'une Rule récente :

- une Rule plus ancienne est retournée par `applyMessages` avec `old: true`,
  enregistrée dans le trie CRDT, mais pas appliquée à la ligne ;
- le rejeu exact de la Rule récente est filtré et ne crée pas une seconde ligne
  dans `messages_crdt` ;
- la valeur effective reste celle de la Rule récente.

Ce comportement exerce indirectement le vrai `compareMessages` privé.

### Suppression ou désactivation de la règle source

Après production de `rule_assignment`, le POC désactive puis tombstone la règle
source dans une autre table synchronisée. Le composite déjà produit reste
stocké et effectif.

C'est un comportement technique de snapshot, pas encore une règle produit. Le
POC ne décide pas si la suppression d'une règle doit déclencher une
réévaluation explicite des transactions précédemment affectées.

## Comparaison des représentations

### JSON canonique

Format testé :

```json
{ "period": "2024-10", "ruleId": "rule-1" }
```

Le constructeur canonique réordonne toujours les propriétés en `period`, puis
`ruleId`. Le parseur strict rejette :

- une valeur non objet ou un JSON invalide ;
- une clé manquante ou supplémentaire ;
- une période hors du format `YYYY-MM` ou un mois hors de `01..12` ;
- un `ruleId` vide ;
- un JSON sémantiquement valide mais non canonique.

L'ordre canonique `period`, puis `ruleId`, est une politique d'encodage du POC.
Il n'est imposé ni par le CRDT ni par le type AQL `json`.

Le type AQL natif `json` appelle seulement `JSON.stringify` à l'entrée et
`JSON.parse` à la sortie. Le test lui fournit volontairement une période
invalide, un `ruleId` vide et une clé supplémentaire : la conversion AQL les
accepte et les sérialise. La validation métier doit donc être explicite en
amont ; elle n'est pas une garantie du type AQL.

La frontière chargée de valider les messages synchronisés entrants reste une
décision ouverte. Le helper du POC n'est branché ni dans `applyMessages`, ni
dans un schéma AQL de production.

SQLite JSON1 démontre `json_valid`, l'extraction de `period` et `ruleId`, ainsi
que l'énumération des deux clés.

### Texte canonique

Format testé :

```text
YYYYMM|<ruleId percent-encoded>
```

Exemple :

```text
202412|rule%2F2%7Creplacement
```

Le parseur valide le mois, décode le `ruleId`, refuse un identifiant vide puis
réencode la valeur pour vérifier sa forme canonique. Le préfixe fixe permet à
SQLite d'extraire la période avec `SUBSTR`.

AQL expose toutefois cette représentation comme une simple `string`. Il ne
connaît ni le composite ni ses champs internes ; toute exposition structurée
demanderait des champs de vue supplémentaires ou un parseur applicatif.

### Résultat comparatif

| Critère                         | JSON canonique                | Texte canonique                 |
| ------------------------------- | ----------------------------- | ------------------------------- |
| Unité CRDT indivisible          | démontrée                     | démontrée                       |
| Encodage déterministe           | démontré avec encodeur métier | démontré avec encodeur métier   |
| Type AQL existant               | `json`                        | `string`                        |
| Retour AQL structuré            | oui                           | non                             |
| Extraction SQLite               | JSON1                         | `SUBSTR` et décodage applicatif |
| Validation métier AQL native    | non                           | non                             |
| Filtre/tri/agrégation effective | démontrés                     | démontrés                       |
| Index d'expression utilisable   | démontré                      | démontré                        |

Les deux formats satisfont les propriétés CRDT. Le JSON canonique est la
représentation proposée pour l'amendement, car Actual possède déjà un type AQL
`json` et SQLite JSON1, et parce que le composite reste structuré à la lecture.
Cette proposition est conditionnée à un encodeur/validateur de domaine unique ;
une écriture AQL générique ne suffit pas.

L'inspection de `schema-helpers.ts` ne révèle pas d'autre type composite natif.
Les autres candidats disponibles sont des scalaires `string`/`text`, dont le
texte canonique testé est représentatif.

## Capacités SQLite et AQL démontrées

Le schéma AQL de production n'est pas modifié. Chaque représentation utilise
un schéma injecté dans `compileAndRunAqlQuery` et une vue SQLite éphémère.

| Capacité              | Résultat observé                                                                     |
| --------------------- | ------------------------------------------------------------------------------------ |
| Conversion d'écriture | `date`, `date-month`, `integer`, `json` ou `string` convertis par `convertForUpdate` |
| Écriture physique     | résultat converti envoyé par le vrai `db.update`                                     |
| Lecture               | période, Manual, composite, source dérivée et période effective lus par AQL          |
| Filtre                | filtre AQL sur `effective_budget_period = 2024-11`                                   |
| Tri                   | ordre AQL croissant par période effective et décroissant par montant                 |
| Agrégation            | groupes 2024-09, 2024-10 et 2024-11, avec sommes 100, 200 et 700                     |
| JSON SQLite           | validation syntaxique, extraction des deux propriétés et liste des clés              |
| Dépendance AQL        | compilateur lié au nom logique de la table de test                                   |

Les montants 100, 200, 300 et 400 sont des entiers synthétiques choisis
uniquement pour prouver le regroupement. Ils ne représentent aucune donnée
personnelle.

### Index d'expression

Pour chaque représentation, le test exécute la même requête avant et après la
création d'un index sur l'expression exacte :

```text
COALESCE(manual_budget_period, rulePeriod(rule_assignment), date / 100)
```

Observation `EXPLAIN QUERY PLAN` :

- avant création, le nom de l'index est absent du plan ;
- après création, SQLite rapporte l'utilisation de l'index d'expression exact.

Cela prouve uniquement la faisabilité syntaxique et l'éligibilité du plan.
Aucune mesure de temps, de volume, de coût d'écriture ou de sélectivité n'est
réalisée. Le POC ne justifie donc pas l'ajout d'un index en production.

## Risque multi-lignes

Le contrôle négatif utilise deux lignes pour représenter successivement un
split et un transfert. Après livraison de la Manual sur la première ligne
seulement, les états observés sont :

```text
ligne 1 = Manual
ligne 2 = Rule
```

Après livraison de la seconde Manual, les deux lignes convergent. L'option D
garantit donc la cohérence d'une affectation sur une ligne, pas l'atomicité d'un
groupe de split ou des deux côtés d'un transfert.

Ce POC démontre le risque mais ne teste pas les vrais workflows de création de
split/transfert et ne propose aucun protocole de coordination multi-lignes.

## Garanties, propositions et décisions ADR

| Nature               | Élément                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Démontré             | les deux cellules CRDT convergent indépendamment pour tous les plans testés               |
| Démontré             | les projections du POC et les requêtes AQL appliquent `manual > rule > default`           |
| Démontré             | conflits Manual et Rule résolus par le LWW réel de leur cellule                           |
| Démontré             | composite Rule indivisible pour JSON et texte                                             |
| Démontré             | reset complet convergent mais visible de façon non atomique                               |
| Démontré             | snapshot Rule conservé après désactivation ou suppression de sa règle                     |
| Démontré             | AQL/SQLite peuvent lire, filtrer, trier et agréger la période effective                   |
| Démontré             | SQLite peut utiliser les deux index d'expression exacts testés                            |
| Proposition produit  | retenir JSON canonique avec validation métier centralisée                                 |
| Proposition produit  | accepter les états intermédiaires du reset et afficher uniquement l'état dérivé courant   |
| Règle normative      | imposer `effectiveBudgetPeriod` à tous les consommateurs de période budgétaire            |
| Décision ADR requise | formaliser le LWW séparé de Manual et Rule et la priorité dérivée                         |
| Décision ADR requise | définir l'opération de reset comme deux suppressions convergentes                         |
| Décision ADR requise | décider le traitement des affectations issues d'une règle ensuite supprimée ou désactivée |
| Décision ADR requise | définir la frontière qui rejette un composite invalide, y compris en synchronisation      |
| Décision ADR requise | conserver les splits/transferts comme risque multi-lignes non résolu par l'option D       |

## Amendement précis proposé pour ADR-0002

Sous réserve de l'acceptation formelle de l'équipe :

1. remplacer les trois colonnes indépendantes par
   `manual_budget_period INTEGER NULL` et un `rule_assignment TEXT NULL`
   contenant un JSON canonique `{ period, ruleId }` ;
2. supprimer la persistance de `budget_period_source` et dériver la source ;
3. définir normativement la période effective comme Manual, sinon période Rule,
   sinon mois de la date bancaire, et interdire aux consommateurs de lire la
   période Rule sans vérifier Manual ;
4. centraliser cette projection pour les budgets, filtres, tris, agrégations,
   API, UI, exports, règles et prévisions budgétaires ;
5. spécifier que chaque couche est un registre LWW CRDT indépendant et qu'une
   Rule ne concurrence jamais directement Manual ;
6. spécifier que le reset complet efface les deux cellules, converge de façon
   déterministe, mais n'est pas atomique entre appareils ;
7. décider la frontière de validation des écritures locales et des messages
   synchronisés entrants ;
8. imposer un encodeur et un validateur canoniques avant toute émission ;
9. ne créer aucun index avant une mesure représentative ;
10. maintenir le blocage spécifique sur l'atomicité des splits et transferts,
    qui nécessite une décision séparée.

## Prérequis avant production

Avant toute implémentation de production, il reste nécessaire de prévoir :

- une matrice de permutations de livraison élargie ;
- un conflit HULC où temps physique et compteur sont égaux et où le `node`
  départage les messages ;
- une centralisation obligatoire de `effectiveBudgetPeriod` ;
- des tests de chaque famille de consommateurs empêchant tout contournement de
  la priorité Manual.

## Limites

- SQLite est en mémoire ; la durabilité disque, WAL, crash et reprise ne sont
  pas testés.
- Les messages concurrents utilisent de vrais `Timestamp`, mais sont injectés
  dans un seul processus de test.
- Les quatre plans de livraison sont représentatifs et non exhaustifs ; les
  permutations mixtes par cellule et le départage HULC par `node` ne sont pas
  exercés.
- Le serveur mock, le chiffrement, le pruning Merkle et les pertes réseau ne
  sont pas couverts par le nouveau test.
- Le schéma et les vues AQL sont injectés ; les vues `transactions`, les
  subscriptions et les executors spéciaux des splits ne sont pas exercés.
- Aucun client de version différente n'est testé.
- La validation canonique est un helper de POC, pas un point d'entrée de
  production.
- La validation des messages synchronisés entrants n'a pas encore de frontière
  décidée ou testée.
- Le maintien ou la réévaluation d'un snapshot après suppression de sa règle
  reste une décision produit.
- L'index prouve une utilisation possible, pas un gain de performance.
- `messages_crdt` est observé comme stockage technique CRDT et ne constitue pas
  un journal d'audit métier.

## Gate

**READY FOR ADR AMENDMENT** — l'indépendance, le LWW et la convergence des deux
cellules sont démontrés avec le mécanisme CRDT réel pour les plans testés. Les
projections du POC et les requêtes AQL démontrent la faisabilité de la règle
normative `manual > rule > default`. JSON et texte sont techniquement viables ;
JSON est proposé grâce aux capacités natives AQL/SQLite, avec une validation
métier obligatoire.

**NOT READY FOR PRODUCTION IMPLEMENTATION** — la couverture des permutations,
le départage HULC par `node`, la centralisation de la projection effective, les
tests de consommateurs et la validation des messages synchronisés entrants
restent à décider ou à démontrer.

Ce verdict n'autorise ni migration ni code métier. ADR-0002 doit être amendée
et acceptée avant toute implémentation de persistance ou de synchronisation.
