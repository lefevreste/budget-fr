# Budget FR — Architecture technique

**Version :** 0.1  
**Date :** 01/09/2026  
**Statut :** architecture de cadrage  
**Base :** fork de `actualbudget/actual`  
**Document fonctionnel associé :** `functional-spec-budget-fr-v0.1.md`

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

### ARCH-003 — Ne pas choisir la persistance de `budgetPeriod` à l'aveugle

Avant toute migration SQL, Codex doit analyser :

- la table transaction réelle ;
- les vues `v_*` ;
- les migrations ;
- la couche de synchronisation ;
- le modèle CRDT ;
- les types ;
- l'API transaction ;
- les règles ;
- les imports.

À l'issue de cette analyse, une ADR choisira entre :

1. champ supplémentaire dans une structure existante ;
2. table d'extension synchronisée ;
3. autre mécanisme compatible avec l'architecture Actual.

Aucun choix de stockage n'est autorisé avant ce diagnostic.

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

- `budgetPeriod` ;
- valeur par défaut = mois de `bankDate` ;
- affichage ;
- modification manuelle ;
- filtre ;
- tri ;
- traçabilité ;
- règles d'affectation ;
- action M+1.

Le premier cas de test structurant est :

```text
SALAIRE reçu le 28/08
=> date bancaire = 28/08
=> budgetPeriod = septembre
```

À ce stade, tout reste TypeScript / SQLite / architecture Actual.

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
│           └── 0002-budget-period-persistence.md
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
budgetPeriod
categoryId
nature
includedInBudget
ruleId
source
manualOverride
```

La séparation logique BankTransaction / BudgetAssignment est un invariant de conception, même si l'implémentation physique dans Actual peut être différente pendant la phase 1.

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
- audit des mutations critiques.

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
- correction manuelle ;
- règle prioritaire ;
- transfert interne ;
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

Statut : à décider après analyse du fork.

### ADR-0003 — Format monétaire du contrat Java

Statut : futur.

### ADR-0004 — Mode d'exécution Java

Options futures :

- service central ;
- service self-hosted ;
- autre.

Statut : futur.

### ADR-0005 — Fournisseur Open Banking

Statut : futur.

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

## 16. Première étape Codex

Le premier travail dans VSCodium est **un diagnostic sans modification fonctionnelle**.

Codex devra produire :

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
- options de persistance pour `budgetPeriod` ;
- recommandation argumentée ;
- liste exacte des fichiers qui seraient touchés par la première feature.

Aucun code métier n'est autorisé pendant ce premier diagnostic.

---

## 17. Gate de passage au développement

Nous pouvons commencer `feat/budget-period` uniquement lorsque :

- Actual démarre localement ;
- les tests de baseline sont connus ;
- le diagnostic est écrit ;
- la persistance de `budgetPeriod` est décidée ;
- les risques de synchronisation sont compris ;
- les critères de recette AC-001 à AC-005 sont transformés en tests.

C'est à ce moment seulement que commence le premier développement fonctionnel.
