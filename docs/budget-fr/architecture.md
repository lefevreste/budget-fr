# Budget FR — Architecture technique

**Version :** 0.1
**Date :** 01/09/2026
**Statut :** architecture de cadrage
**Base :** fork de `actualbudget/actual`
**Document fonctionnel associé :** [spécification fonctionnelle](./functional-spec.md)

---

## Références de décision

- [ADR-0006 — Affectation de période budgétaire en couches](./adr/0006-layered-budget-period-assignment.md)
- [Premier POC de concurrence CRDT](./spikes/budget-period-crdt.md)
- [POC CRDT de l'option D](./spikes/budget-period-option-d.md)
- [POC de convergence CRDT/HULC de l'option D](./spikes/budget-period-option-d-convergence.md)
- [Spike Rule stockée invalide](./spikes/budget-period-invalid-rule-assignment.md)
- [ADR-0002 — Persistance de la période budgétaire](./adr/0002-budget-period-persistence.md),
  conservée comme historique et non normative pour les sujets supersédés

---

## 1. Décision générale

Budget FR part d'Actual Budget afin de bénéficier immédiatement :

- de son interface React ;
- de sa gestion des comptes et transactions ;
- de ses catégories ;
- de ses règles ;
- de ses budgets ;
- de ses schedules ;
- de son stockage local SQLite ;
- de sa synchronisation ;
- de son écosystème de tests.

La cible peut intégrer Java / Spring Boot, mais **le premier lot ne réécrit pas Actual en Java**.

La transformation suit un **Strangler Pattern** :

1. stabiliser le fork ;
2. ajouter les concepts Budget FR dans l'architecture existante ;
3. produire des tests fonctionnels de référence ;
4. extraire progressivement le domaine vers Java ;
5. comparer les résultats TypeScript et Java ;
6. basculer un domaine vers Java seulement lorsque les résultats sont identiques.

---

## 2. Architecture Actual de référence

Au démarrage du projet, Actual est considéré comme la baseline.

Architecture simplifiée :

```text
                 React
          packages/desktop-client
                    |
                    v
               loot-core
        packages/loot-core
        /       |        \
       /        |         \
   client     shared      server
                           |
                           v
                         SQLite
                           |
                    sync / CRDT
                           |
                     sync-server
```

Particularité importante : Actual est **local-first**.

Dans le navigateur, le serveur local de données s'exécute dans un Web Worker.

Dans l'application Electron, la logique de fond tourne dans un processus Node distinct.

Le `sync-server` n'est donc pas le backend métier classique d'une architecture trois tiers.

---

## 3. Principes d'architecture Budget FR

### ARCH-001 — Conserver le fonctionnement existant au début

Le premier objectif n'est pas de "moderniser" Actual.

Le premier objectif est d'introduire nos besoins sans casser :

- imports ;
- transactions ;
- budgets ;
- règles ;
- synchronisation ;
- application Web ;
- application Desktop ;
- tests existants.

### ARCH-002 — `budgetPeriod` est un concept métier distinct

Le domaine doit distinguer :

```text
bankDate
budgetPeriod
```

`bankDate` représente le fait bancaire.

`budgetPeriod` représente l'affectation budgétaire.

Exemple :

```text
bankDate     = 2026-08-28
budgetPeriod = 2026-09
```

La date bancaire ne doit jamais être modifiée pour obtenir un résultat budgétaire.

### ARCH-003 — Affectation budgétaire en couches

[ADR-0006](./adr/0006-layered-budget-period-assignment.md) remplace la décision
à trois colonnes d'ADR-0002. L'affectation repose sur deux cellules
transaction-locales indépendantes : une correction Manual nullable et un
composite Rule nullable. La source et `budgetPeriod` sont dérivés et ne sont
jamais persistés.

La priorité `Manual > Rule > Default` est une règle de domaine appliquée par
une projection centralisée. Elle n'est pas fournie par le CRDT.

Cette décision autorise l'implémentation expérimentale écrite par les tests.
Elle n'autorise encore aucune migration de données utilisateur, activation ou
release.

### ARCH-004 — Le calcul financier est déterministe

Les montants ne proviennent jamais d'un LLM.

Le moteur doit être testable par entrées/sorties.

### ARCH-005 — La prévision doit être explicable

Chaque valeur du forecast doit pouvoir être décomposée :

```text
solde début
+ revenus réels
+ revenus prévus
- charges fixes réelles
- charges fixes prévues
- enveloppes variables
+/- événements
= solde fin
```

### ARCH-006 — Le réel remplace le prévu

Un rapprochement entre une opération prévue et une transaction réelle supprime le double comptage.

### ARCH-007 — Les données financières restent minimisées

Aucun export automatique de transactions complètes vers un LLM.

L'assistant IA recevra en priorité :

- agrégats ;
- catégories ;
- tendances ;
- anomalies déjà calculées ;
- scénarios structurés.

---

## 4. Découpage par phases

## Phase 0 — Baseline du fork

Objectif : disposer d'une base reproductible avant toute modification.

Travaux :

- fork du dépôt ;
- branche dédiée ;
- installation ;
- build ;
- démarrage Web ;
- typecheck ;
- lint ;
- tests ;
- inventaire des packages ;
- documentation de la version upstream de référence.

Livrable :

```text
docs/budget-fr/actual-baseline.md
```

Aucune évolution fonctionnelle.

---

## Phase 1 — Budget Period

Objectif : introduire la séparation entre date bancaire et mois budgétaire.

Fonctions :

- correction Manual nullable ;
- affectation Rule composite nullable ;
- `budgetPeriod` et source calculés par projection effective ;
- valeur Default dérivée du mois de `bankDate` ;
- affichage ;
- modification manuelle ;
- filtre ;
- tri ;
- traçabilité ;
- règles d'affectation ;
- action M+1.

Tous les consommateurs d'une période budgétaire doivent utiliser la même
projection centralisée : budgets, filtres, tris, agrégations, API, UI, exports,
règles et prévisions budgétaires. Les soldes bancaires, la trésorerie et le
forecast journalier continuent d'utiliser `bankDate`.

Le premier cas de test structurant est :

```text
SALAIRE reçu le 28/08
=> date bancaire = 28/08
=> budgetPeriod = septembre
```

À ce stade, tout reste TypeScript / SQLite / architecture Actual.

La phase autorise les tests de production écrits d'abord, la projection
centralisée, le validateur et l'encodeur JSON, les prototypes de migration sur
fixtures, le traitement expérimental des messages invalides ainsi que les tests
réels de synchronisation, de splits, de transferts et de compatibilité. Elle
n'autorise aucune migration de données utilisateur, activation, diffusion à des
clients ou mise en production.

---

## Phase 2 — Prévision déterministe

Objectif : disposer d'un vrai budget prévisionnel 12 mois.

Nouveaux concepts :

- `RecurringItem` ;
- `ForecastItem` ;
- `Assumption` ;
- `Scenario` ;
- rapprochement prévu/réel ;
- niveau de confiance ;
- provenance d'une prévision.

Le moteur doit fournir une fonction conceptuelle pure :

```text
ForecastResult forecast(
    StartingBalance,
    ActualTransactions,
    RecurringItems,
    Assumptions,
    BudgetEnvelopes,
    Scenario,
    PeriodRange
)
```

Le résultat doit pouvoir être snapshot-testé.

---

## Phase 3 — Contrat métier indépendant

Objectif : découpler progressivement le domaine du framework Actual.

Créer un contrat logique versionné :

```text
budget-fr-domain/
  account
  transaction
  budget-period
  category
  recurrence
  forecast
  scenario
  reconciliation
  rule
```

Le contrat doit préciser :

- entrées ;
- sorties ;
- invariants ;
- erreurs ;
- précision monétaire ;
- formats de date ;
- versionnement.

Cette phase prépare Java mais ne nécessite pas encore de remplacer le code existant.

---

## Phase 4 — Moteur Java en parallèle

Objectif : construire le moteur Java sans basculer immédiatement l'application.

Architecture :

```text
                    Jeux de tests
                         |
             +-----------+-----------+
             |                       |
             v                       v
      TypeScript Engine         Java Engine
             |                       |
             +-----------+-----------+
                         |
                    comparaison
```

Stack :

- Java LTS ;
- Spring Boot ;
- Maven ou Gradle à décider ;
- JUnit ;
- Testcontainers lorsque PostgreSQL est introduit ;
- types monétaires décimaux ;
- API REST/OpenAPI pour les cas distants.

Le moteur Java commence par :

1. règles d'affectation ;
2. périodes budgétaires ;
3. prévision ;
4. scénarios ;
5. rapprochement.

Aucun composant ne devient autoritaire tant que les tests de parité ne passent pas.

---

## Phase 5 — Backend Budget FR

Après validation du moteur Java :

```text
                  React / PWA
                      |
                 HTTP / JSON
                      |
                      v
                Spring Boot
           +----------+----------+
           |          |          |
        Budget      Rules     Forecast
         Engine     Engine      Engine
           |          |          |
           +----------+----------+
                      |
                  PostgreSQL
```

Cette architecture devient pertinente lorsque Budget FR a besoin de :

- comptes utilisateurs ;
- foyers partagés ;
- traitements serveur ;
- Open Banking ;
- IA centralisée ;
- synchronisation multi-device simplifiée ;
- exploitation SaaS.

Le passage vers cette cible sera incrémental.

---

## Phase 6 — Open Banking France

Le connecteur bancaire est placé derrière un port métier :

```text
BankingProvider
  listInstitutions()
  connect()
  refresh()
  listAccounts()
  listTransactions()
```

Un fournisseur PSD2 concret implémente ce port.

Le domaine Budget FR ne doit pas dépendre directement du modèle d'un agrégateur.

---

## Phase 7 — Intelligence

Deux moteurs distincts.

### Forecast Intelligence

Responsable de :

- saisonnalité ;
- tendances ;
- estimation des variables ;
- détection de récurrences ;
- détection d'anomalies ;
- intervalle de confiance.

### LLM Assistant

Responsable de :

- langage naturel ;
- explication ;
- proposition de règle ;
- proposition de catégorie ;
- création de scénario structuré ;
- questions/réponses.

Architecture :

```text
          données financières
                  |
                  v
          moteurs déterministes
                  |
          résultats structurés
             /          \
            v            v
     Dashboard        LLM Assistant
                         |
                         v
                    explication
```

Le LLM n'est jamais la source du montant financier de référence.

---

## 5. Structure cible du fork

Au départ, la structure upstream est conservée.

Les éléments Budget FR sont regroupés afin d'éviter une dispersion incontrôlée.

Proposition initiale :

```text
actual/
├── AGENTS.md
├── packages/
│   ├── loot-core/
│   ├── desktop-client/
│   ├── component-library/
│   └── ...
├── docs/
│   └── budget-fr/
│       ├── functional-spec.md
│       ├── architecture.md
│       ├── actual-baseline.md
│       ├── domain-model.md
│       └── adr/
│           ├── 0001-budget-period-concept.md
│           ├── 0002-budget-period-persistence.md # historique supersédé
│           └── 0006-layered-budget-period-assignment.md
└── budget-fr-java/                 # créé seulement en phase 4
    ├── pom.xml / build.gradle
    └── src/
```

**Important :** ne pas créer `budget-fr-java/` pendant la phase 0 ou le diagnostic initial.

---

## 6. Packages Actual à étudier en priorité

### `packages/loot-core`

Zone la plus importante.

À cartographier :

```text
src/client
src/server
src/shared
src/types
```

Domaines à rechercher :

- transactions ;
- budget ;
- rules ;
- forecast ;
- schedules ;
- accounts ;
- database ;
- imports ;
- sync.

### `packages/desktop-client`

À étudier pour :

- grille des transactions ;
- filtres ;
- écrans budgets ;
- règles ;
- formulaires ;
- composants réutilisables.

### `packages/api`

À étudier pour identifier les contrats existants et les possibilités d'automatisation de tests.

### `packages/sync-server`

À comprendre avant toute évolution susceptible d'affecter la synchronisation.

---

## 7. Modèle conceptuel Budget FR

```text
Household
   |
   +-- Account
   |     |
   |     +-- BankTransaction
   |              |
   |              +-- BudgetAssignment
   |
   +-- Category
   |
   +-- BudgetRule
   |
   +-- RecurringItem
   |
   +-- ForecastItem
   |
   +-- Assumption
   |
   +-- Scenario
```

### BankTransaction

Immutable sur ses données brutes importées :

```text
id
accountId
bankDate
valueDate
amount
rawLabel
source
fingerprint
```

### BudgetAssignment

Interprétation budgétaire :

```text
transactionId
manualBudgetPeriod
ruleAssignment { period, ruleId }
budgetPeriod
budgetPeriodSource
categoryId
nature
includedInBudget
```

Le modèle conceptuel utilise camelCase. `manualBudgetPeriod` et
`ruleAssignment` sont les deux couches d'affectation ; `budgetPeriod` et
`budgetPeriodSource` sont des projections dérivées.

Le mapping vers le modèle interne Actual est :

| Concept métier       | Interne Actual                                        | Persistance                |
| -------------------- | ----------------------------------------------------- | -------------------------- |
| `bankDate`           | `date`                                                | existante, date bancaire   |
| `manualBudgetPeriod` | `manual_budget_period`                                | cellule nullable           |
| `ruleAssignment`     | `rule_assignment`                                     | cellule composite nullable |
| `budgetPeriod`       | aucune colonne ; projection `effectiveBudgetPeriod`   | jamais persistée           |
| `budgetPeriodSource` | aucune colonne ; source `manual`, `rule` ou `default` | jamais persistée           |

La séparation logique BankTransaction / BudgetAssignment est un invariant de
conception, même si les deux cellules sont physiquement portées par la
transaction Actual pendant la phase 1.

### Projection effective

```text
decode(rule_assignment): absent | valid | invalid

bankDate invalide -> erreur
Manual invalide -> erreur
Manual valide -> Manual, avec diagnostic obligatoire si Rule est invalide
Manual absente + Rule valide -> Rule
Manual absente + Rule absente -> Default dérivé de month(date)
Manual absente + Rule invalide -> erreur sans projection
```

Le CRDT résout le conflit interne à chaque cellule, mais n'applique pas la
priorité métier. La priorité d'erreur est `bankDate > Manual > Rule`. Aucun
consommateur ne peut lire ou parser directement `rule_assignment`, ni produire
une période effective sans passer par l'adaptateur discriminé et la priorité
Manual.

L'adaptateur et la projection existent dans le module de domaine expérimental.
Ils ne sont ni réexportés ni branchés sur l'application.

### SQLite, AQL et JSON canonique

| Colonne interne        | SQLite         | AQL futur    | Rôle                                |
| ---------------------- | -------------- | ------------ | ----------------------------------- |
| `manual_budget_period` | `INTEGER NULL` | `date-month` | correction Manual                   |
| `rule_assignment`      | `TEXT NULL`    | `string`     | composite Rule `{ period, ruleId }` |

L'encodage canonique exact de `rule_assignment` est :

```text
{"period":"2024-10","ruleId":"rule-1"}
```

L'ordre `period`, puis `ruleId`, l'absence d'espace et l'absence de clé
supplémentaire sont une décision d'encodage Budget FR. Ce comportement n'est
garanti ni par JSON, ni par SQLite, ni par le CRDT, ni par le type AQL `string`,
qui transporte la valeur brute sans la valider. Un encodeur et un validateur
métier centralisés sont donc obligatoires.

Les types AQL `json` et `json/fallback` sont interdits pour cette cellule : le
premier confond un JSON syntaxiquement invalide avec une absence et le second
ne préserve pas toujours sa représentation brute. Le décodage Budget FR doit
produire l'un des états `absent`, `valid` ou `invalid`. Une valeur invalide ne
devient jamais `null` ou Default.

Le spike Rule stockée invalide valide dynamiquement ce transport uniquement par
le chemin AQL générique `execQuery`. Les exécuteurs AQL spécialisés des
transactions et `db.selectWithSchema` ont seulement été inspectés statiquement
et restent à tester.

Une projection SQL directe avec `json_extract`, une expression `COALESCE`
fondée sur la Rule brute et tout index construit sur cette projection sont
reportés. Aucun de ces chemins n'est considéré sûr avant l'intégration de
l'état discriminé dans les lectures réelles.

La migration envisagée reste additive et nullable, sans backfill ni index
initial. Les anciennes transactions restent Default par projection. Aucun
numéro ou patch de migration n'est défini ici, et aucune modification de
`SYNC_FORMAT_VERSION` n'est autorisée par cette décision.

### Synchronisation et cycle de vie

`manual_budget_period` et `rule_assignment` sont deux cellules CRDT LWW
indépendantes. Le composite Rule est indivisible : `period` et `ruleId` gagnent,
sont rejoués ou sont supprimés ensemble.

Une règle, un import ou un réimport ne peut écrire que `rule_assignment` et ne
touche jamais `manual_budget_period`. Supprimer Manual révèle la dernière Rule
si elle est valide, l'erreur Rule si elle est invalide, sinon Default. La
suppression ou la désactivation d'une règle ne modifie pas rétroactivement les
snapshots Rule existants ; une réévaluation explicite peut remplacer ou effacer
uniquement `rule_assignment`.

Le reset complet écrit :

```text
manual_budget_period = null
rule_assignment = null
```

`batchMessages` rend ces deux écritures atomiques dans la transaction SQLite
locale. Le protocole ne conserve toutefois aucune frontière de batch durable
entre appareils : des états intermédiaires sont acceptés et la convergence
finale est déterminée séparément par le gagnant LWW de chaque cellule. Une
écriture concurrente plus récente peut survivre au reset dans sa cellule.

Le POC de convergence couvre dynamiquement les permutations bornées, les
livraisons mixtes par cellule et l'égalité HULC départagée par `node`, pour le
modèle expérimental mono-ligne. Ces preuves ne couvrent pas les opérations
multi-lignes ni les clients de versions différentes. Les clients partageant un
budget doivent connaître les deux colonnes ; la stratégie de clients mixtes
reste un gate.

Le spike Rule stockée invalide démontre dynamiquement, avec une table de probe
SQLite en mémoire, `receiveMessages`, `applyMessages` et `messages_crdt` : une
valeur invalide reste persistée sans réparation ou effacement automatique. La
récupération nécessite une écriture CRDT plus récente contenant une Rule
canonique ou un `null` explicite. Une Manual valide reste effective avec un
diagnostic obligatoire ; sans Manual, la Rule invalide bloque toute projection.

Cette table représente une cellule synchronisée générique ; elle n'est pas la
vraie table `transactions` et ne démontre pas le comportement de la persistance
applicative réelle, des vues, des listeners, des exécuteurs AQL spécialisés ou
de `db.selectWithSchema`. Ces limites ne réduisent pas les observations directes
obtenues par le chemin générique `execQuery`, `receiveMessages`,
`applyMessages` et `messages_crdt`.

`messages_crdt` conserve l'état technique nécessaire à la convergence. Il ne
constitue jamais un journal d'audit métier. La valeur brute invalide ne doit
pas être journalisée automatiquement.

Cette interdiction est une exigence d'architecture. Le spike constate seulement
que le module de domaine expérimental ne journalise pas la valeur brute. Aucun
consommateur ou adaptateur applicatif n'étant branché, aucune garantie globale
de journalisation n'est encore démontrée ; elle devra être vérifiée lors de
l'intégration applicative.

### Splits et transferts

L'option D garantit la cohérence d'une affectation sur une ligne, mais ne rend
pas atomique un split ou les deux côtés d'un transfert. Les vrais workflows
Actual et la politique de propagation/récupération multi-lignes restent un gate
distinct. Cette architecture ne les résout pas.

---

## 8. Gestion des montants

Règles :

- jamais de flottants binaires dans le domaine ;
- conserver la convention monétaire existante d'Actual tant que le domaine reste dans Actual ;
- lors du passage Java : `BigDecimal` avec règles d'arrondi explicites ou stockage en unité mineure ;
- ne jamais mélanger des unités majeures et mineures dans un même contrat ;
- tests obligatoires sur centimes, valeurs négatives et agrégations.

Une ADR fixera le contrat monétaire Java avant implémentation.

---

## 9. API cible

L'API n'est pas nécessaire à la phase 1.

Contrat futur indicatif :

```text
GET    /api/v1/accounts
GET    /api/v1/transactions
PATCH  /api/v1/transactions/{id}/budget-assignment

GET    /api/v1/budget-periods/{period}
GET    /api/v1/forecasts?from=2026-09&months=12

GET    /api/v1/rules
POST   /api/v1/rules
PATCH  /api/v1/rules/{id}

GET    /api/v1/scenarios
POST   /api/v1/scenarios
POST   /api/v1/scenarios/{id}/forecast
```

Tout contrat transaction exposant une période budgétaire doit retourner
`budgetPeriod` depuis la projection centralisée et une source dérivée. Il ne
doit jamais exposer `rule_assignment.period` comme période effective sans
appliquer la priorité Manual. Les opérations de correction Manual, de
réévaluation Rule et de reset doivent rester distinctes.

Cette API ne doit pas être créée tant qu'un besoin concret ne l'exige pas.

---

## 10. Sécurité

Les données manipulées sont sensibles.

Exigences minimales :

- secrets hors dépôt ;
- `.env` jamais commité ;
- logs sans données bancaires inutiles ;
- masquage des tokens ;
- validation stricte des imports ;
- protection contre CSV injection dans les exports ;
- aucune exécution de formule issue d'un CSV ;
- dépendances analysées ;
- authentification avant exposition réseau d'un backend ;
- contrôle d'accès au niveau du foyer ;
- audit des mutations critiques ;
- validation stricte des affectations Rule produites localement ;
- état d'erreur explicite pour une affectation synchronisée invalide, sans
  conversion silencieuse vers Default.

Lors de l'introduction de l'IA :

- minimisation des données ;
- aucune clé API dans le frontend ;
- proxy backend ;
- journalisation sans prompt financier complet par défaut ;
- opt-in explicite pour l'analyse détaillée.

---

## 11. Stratégie de tests

### Niveau 1 — Tests upstream

Ne jamais les sacrifier.

Commandes de référence depuis la racine :

```text
yarn typecheck
yarn lint:fix
yarn test
```

### Niveau 2 — Tests métier Budget FR

Cas minimaux :

- salaire M+1 ;
- charge M+1 ;
- Default sans valeur persistée ;
- Rule seule ;
- Manual masquant Rule ;
- suppression Manual révélant Rule ;
- deux Rule concurrentes sans mélange du composite ;
- deux Manual concurrentes ;
- suppression Rule ;
- reset complet et resets concurrents ;
- rejeu idempotent ;
- désactivation de règle sans réécriture rétroactive ;
- réévaluation limitée à Rule ;
- JSON invalide local et synchronisé ;
- états Rule absente, valide et invalide, avec priorité d'erreur
  `bankDate > Manual > Rule` ;
- projection identique pour budgets, filtres, tris, agrégations, API, UI,
  exports, règles et prévisions budgétaires ;
- non-régression des permutations bornées, des livraisons mixtes et de
  l'égalité HULC départagée par `node` ;
- exécuteurs AQL spécialisés des transactions et `db.selectWithSchema` avec les
  trois états Rule ;
- clients de versions différentes ;
- migration sur fixtures, ouverture, réouverture, backup et restauration ;
- vrais workflows de splits et transferts, sans présumer leur résolution ;
- transfert interne exclu du résultat consolidé ;
- hors budget ;
- rapprochement prévu/réel ;
- dépense en N fois ;
- changement d'hypothèse ;
- prévision 12 mois ;
- mois partiel ;
- découvert.

### Niveau 3 — Golden Master

Créer un jeu de données anonymisé dérivé du budget de référence.

Pour chaque mois :

```text
revenus
fixes
variables
solde mensuel
solde cumulé
```

Le moteur doit produire le même résultat attendu.

### Niveau 4 — Parité Java

Pendant la migration :

```text
same input
  -> TypeScript result
  -> Java result
  -> deep equality / tolerance explicite
```

---

## 12. Données de test

Les données personnelles réelles ne doivent pas être commitées.

Créer un dataset synthétique reproduisant les comportements :

```text
PERSON_A_SALARY
PERSON_B_SALARY
LOAN_A
LOAN_B
ELECTRICITY
GROCERIES
TRANSPORT_REFUND
```

Les montants peuvent être modifiés tout en conservant la structure des cas métier.

Le fichier réel de budget reste hors dépôt.

---

## 13. Branching

Proposition :

```text
upstream/master
       |
       v
fork/master
       |
       +-- budget-fr/main
              |
              +-- feat/budget-period
              +-- feat/budget-rule-next-month
              +-- feat/forecast-engine
```

Pendant la phase initiale :

- une fonctionnalité par branche ;
- petits commits ;
- aucun refactoring opportuniste massif ;
- ne pas mélanger migration technique et règle métier.

---

## 14. ADR obligatoires

Les décisions importantes sont documentées.

ADR initiales :

### ADR-0001 — Séparer date bancaire et période budgétaire

Statut : accepté.

### ADR-0002 — Persistance de `budgetPeriod`

Statut : supersédée par
[ADR-0006](./adr/0006-layered-budget-period-assignment.md). Elle reste
consultable comme historique, mais n'est plus normative pour la persistance,
les invariants et sémantiques d'affectation, les politiques
Rule/Manual/Default ou les comportements splits/transferts remplacés.

### ADR-0003 — Format monétaire du contrat Java

Statut : futur. Numéro réservé à cette décision.

### ADR-0004 — Mode d'exécution Java

Options futures :

- service central ;
- service self-hosted ;
- autre.

Statut : futur. Numéro réservé à cette décision.

### ADR-0005 — Fournisseur Open Banking

Statut : futur. Numéro réservé à cette décision.

### ADR-0006 — Affectation de période budgétaire en couches

Statut : acceptée. Elle décide les deux cellules CRDT indépendantes, le
composite Rule JSON canonique stocké en `TEXT NULL` et exposé brut en AQL
`string`, la projection normative `Manual > Rule > Default`, la priorité
d'erreur `bankDate > Manual > Rule` et les gates de préparation à
l'implémentation. L'exposition AQL `string` résulte de l'amendement du
09/09/2026 ; la décision initiale utilisait `json`.

---

## 15. Definition of Done d'une évolution

Une évolution n'est terminée que si :

1. le comportement est défini ;
2. les tests sont présents ;
3. les tests ciblés passent ;
4. le typecheck passe ;
5. le lint passe ;
6. aucun secret n'est ajouté ;
7. les données personnelles ne sont pas ajoutées ;
8. les migrations sont réversibles ou documentées ;
9. la synchronisation est testée si elle est concernée ;
10. la documentation Budget FR est mise à jour.

---

## 16. Première étape Codex — historique accompli

La première analyse Codex a été réalisée comme un diagnostic sans modification
fonctionnelle.

Elle a produit :

```text
docs/budget-fr/actual-baseline.md
```

avec :

- architecture réelle du fork ;
- fichiers impliqués dans Transaction ;
- schéma SQLite ;
- migrations ;
- règles ;
- schedules ;
- imports ;
- synchronisation ;
- UI de transaction ;
- API ;
- options de persistance alors envisagées pour `budgetPeriod` ;
- recommandation argumentée ;
- liste exacte des fichiers qui seraient touchés par la première feature.

Aucun code métier n'a été ajouté pendant ce premier diagnostic. Cette section
est conservée comme historique du cadrage initial.

---

## 17. Gate de passage au développement

### ADR-0006

**ACCEPTÉE** — la persistance en deux cellules indépendantes, le composite Rule
indivisible, la source dérivée et la projection effective normative remplacent
ADR-0002 pour la persistance et toutes les sémantiques d'affectation qui en
dépendent.

### Architecture option D

**READY FOR EXPERIMENTAL / TEST-FIRST IMPLEMENTATION** — l'implémentation
expérimentale est étayée, pour le modèle mono-ligne couvert, par les
permutations CRDT/HULC bornées et la distinction Rule absente, valide ou
invalide. Elle peut inclure :

- des tests de production écrits d'abord ;
- la projection effective centralisée ;
- le validateur et l'encodeur JSON ;
- des prototypes de migration sur fixtures ;
- l'intégration expérimentale de l'adaptateur discriminé ;
- les tests réels des splits et transferts ;
- les tests de compatibilité.

Elle n'autorise pas :

- la migration de données utilisateur ;
- l'activation de la fonctionnalité ;
- la diffusion à des clients ;
- le déploiement en production.

### Migration, activation et livraison en production

**NOT READY FOR PRODUCTION MIGRATION OR RELEASE** — restent bloquants :

- l'intégration de l'adaptateur discriminé dans l'application ;
- la validation dynamique des exécuteurs AQL spécialisés des transactions et
  de `db.selectWithSchema` ;
- le contrat centralisé `effectiveBudgetPeriod` et les tests de tous les
  consommateurs et agrégations ;
- la stratégie de compatibilité des clients de versions différentes ;
- la conception et la validation de la migration réelle, des anciennes bases,
  du backup et de la restauration ;
- la conception et la validation des vues et index réels ;
- les splits et transferts multi-lignes.

Le contrat API/UI expliquant un snapshot Rule lié à une règle supprimée et la
pertinence d'un éventuel index d'expression restent également à définir ou à
mesurer avant production.

La spécification fonctionnelle reste compatible : elle décrit les résultats
métier sans imposer le transport AQL. Le présent réalignement documentaire ne
lève aucun des gates ci-dessus et n'autorise ni migration, ni activation, ni
release.
