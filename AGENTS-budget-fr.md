# Budget FR — Instructions complémentaires pour Codex

> Ce document complète le `AGENTS.md` upstream d'Actual Budget.
> Lors de l'installation du fork, intégrer cette section dans le `AGENTS.md` racine ou ajouter une référence explicite depuis celui-ci.

## Mission

Nous construisons **Budget FR**, un fork orienté gestion budgétaire prévisionnelle pour les foyers français.

Le projet part d'Actual Budget mais introduit un concept fondamental :

```text
bankDate != budgetPeriod
```

Une transaction peut être enregistrée par la banque en août et appartenir au budget de septembre.

Le projet doit rester fiable, testable et explicable.

---

## Documents normatifs

Avant toute modification, lire :

1. `docs/budget-fr/functional-spec.md`
2. `docs/budget-fr/architecture.md`
3. les ADR dans `docs/budget-fr/adr/`
4. le `AGENTS.md` upstream
5. les règles de contribution et de tests du dépôt.

En cas de contradiction :

1. sécurité et intégrité des données ;
2. règles upstream nécessaires au fonctionnement du dépôt ;
3. ADR Budget FR acceptées ;
4. architecture Budget FR ;
5. spécification fonctionnelle.

Ne jamais inventer une règle métier absente des documents sans la signaler.

---

## Règles absolues

### 1. Ne jamais modifier la date bancaire pour simuler une période budgétaire

Interdit :

```text
transaction.date = firstDayOfNextMonth
```

Attendu :

```text
bankDate = originalBankDate
budgetPeriod = selectedBudgetPeriod
```

### 2. Ne jamais utiliser un LLM comme calculateur financier de référence

Les soldes et prévisions sont calculés par du code déterministe.

### 3. Ne jamais utiliser de `float` pour une nouvelle logique monétaire

Respecter la représentation existante d'Actual dans la partie upstream.

Dans le futur moteur Java, utiliser un type monétaire déterministe défini par ADR.

### 4. Ne jamais exposer de données personnelles réelles dans le dépôt

Interdits :

- relevés bancaires réels ;
- vrais noms ;
- vrais IBAN ;
- adresses ;
- numéros de comptes ;
- CSV utilisateur ;
- budget familial original.

Les tests utilisent des données synthétiques.

### 5. Ne jamais faire un refactoring massif sans rapport direct avec la tâche

Une feature = changement minimal nécessaire + tests.

### 6. Ne jamais casser l'architecture local-first par accident

Toute évolution du schéma, des transactions ou de la synchronisation nécessite une analyse préalable.

### 7. Ne jamais lancer une migration Java "big bang"

Java est une cible d'extraction progressive.

---

## Méthode de travail

Pour chaque tâche :

### Étape A — Comprendre

Avant de modifier :

- retrouver les types ;
- retrouver la persistance ;
- retrouver les appels ;
- retrouver les tests ;
- retrouver l'UI ;
- vérifier l'impact sync.

### Étape B — Proposer

Dans le compte rendu de tâche, donner :

- fichiers concernés ;
- invariants ;
- stratégie ;
- risques ;
- tests.

### Étape C — Modifier

Faire le changement minimal.

### Étape D — Vérifier

Exécuter les tests ciblés, puis les contrôles de dépôt appropriés.

### Étape E — Résumer

Donner :

- fichiers modifiés ;
- comportement obtenu ;
- tests exécutés ;
- résultat ;
- dette ou risque restant.

---

## Première mission : DIAGNOSTIC UNIQUEMENT

La première mission après clonage ne doit apporter **aucune modification métier**.

Créer :

```text
docs/budget-fr/actual-baseline.md
```

Le document doit répondre précisément aux questions suivantes.

### Transactions

- Quel est le type TypeScript canonique d'une transaction ?
- Où est-il défini ?
- Quelle structure est réellement persistée ?
- Quels champs sont synchronisés ?
- Quelles vues SQL sont utilisées ?
- Comment une transaction est-elle créée ?
- Comment une transaction est-elle mise à jour ?
- Comment est-elle importée ?
- Comment est-elle affichée dans la grille ?

### Base de données

- Où est le schéma initial ?
- Où sont les migrations ?
- Comment une nouvelle colonne est-elle introduite ?
- Comment les vues sont-elles recréées ?
- Quel mécanisme permet à une nouvelle donnée d'être synchronisée ?

### Règles

- Où sont définies les conditions ?
- Où sont définies les actions ?
- Une action personnalisée Budget FR peut-elle être ajoutée proprement ?
- Comment les règles sont-elles testées ?

### Budgets et schedules

- Comment Actual représente-t-il les mois ?
- Comment les transactions programmées sont-elles stockées ?
- Comment le forecast existant fonctionne-t-il ?
- Quelles briques peuvent être réutilisées ?

### Synchronisation

- Quel serait l'impact de l'ajout d'un champ à une transaction ?
- Quel serait l'impact d'une table d'extension ?
- Quelles migrations/schémas sync seraient nécessaires ?

### UI

- Où se trouve le tableau des transactions ?
- Comment ajouter une colonne ou un champ éditable ?
- Quels composants existants peuvent être réutilisés ?

### API

- Quelles fonctions exposent les transactions ?
- Comment une future propriété Budget FR pourrait-elle apparaître sans casser la compatibilité ?

---

## Analyse de persistance obligatoire

Comparer au minimum ces options :

### Option A — Champ dans transaction existante

Évaluer :

- simplicité ;
- migrations ;
- synchronisation ;
- compatibilité ;
- requêtes ;
- impact upstream.

### Option B — Table Budget FR séparée

Conceptuellement :

```text
budget_fr_transaction_assignment
  transaction_id
  budget_period
  source
  manual_override
```

Évaluer :

- synchronisation ;
- jointures ;
- suppression transaction ;
- import/export ;
- API ;
- backup ;
- maintenance.

### Option C — Autre mécanisme natif Actual

Si Actual possède une abstraction plus adaptée, la documenter.

Le diagnostic doit terminer par une recommandation.

**Ne pas implémenter la recommandation dans la même tâche.**

---

## Format de `budgetPeriod`

Conceptuellement :

```text
YYYY-MM
```

Exemples :

```text
2026-09
2026-10
2027-01
```

Le format physique peut s'adapter aux conventions Actual, mais l'API métier doit représenter une période mensuelle sans ambiguïté.

---

## Invariants Budget FR

### INV-001

`bankDate` reste la date bancaire originale.

### INV-002

Sans règle ou correction :

```text
budgetPeriod = month(bankDate)
```

### INV-003

Une affectation manuelle a priorité sur une règle automatique.

### INV-004

Une transaction prévue rapprochée d'une transaction réelle n'est comptée qu'une fois.

### INV-005

Un transfert interne ne modifie pas le revenu net ou les dépenses consolidées du foyer.

### INV-006

Toute prévision doit être décomposable en éléments sources.

### INV-007

Une correction historique est auditée si la fonctionnalité d'audit est présente.

---

## Cas de tests fonctionnels prioritaires

### TEST-BFR-001 — Salaire M+1

Entrée :

```text
bankDate = 2026-08-28
label = "SALAIRE ENTREPRISE"
amount = +5000
```

Règle :

```text
si salaire et jour >= 25
alors budgetPeriod = mois suivant
```

Résultat :

```text
bankDate = 2026-08-28
budgetPeriod = 2026-09
```

### TEST-BFR-002 — Charge M+1

Entrée :

```text
bankDate = 2026-08-30
label = "PRELEVEMENT CREDIT EXEMPLE"
amount = -1200
```

Règle explicite :

```text
budgetPeriod = 2026-09
```

La date bancaire reste inchangée.

### TEST-BFR-003 — Pas de règle

```text
bankDate = 2026-09-12
budgetPeriod = 2026-09
```

### TEST-BFR-004 — Override manuel

Une affectation manuelle ne doit pas être remplacée par une règle.

### TEST-BFR-005 — Réimport

Le même import ne doit pas créer de doublon ni perdre l'affectation budgétaire existante.

---

## Java

Ne pas créer de module Java pendant la phase 0 ou la première feature `budgetPeriod`.

Le module Java sera créé seulement lorsque :

- le domaine est compris ;
- les tests fonctionnels Budget FR existent ;
- le contrat de données est documenté ;
- une ADR autorise l'extraction.

Lorsqu'il sera créé, le principe sera :

```text
mêmes entrées
=> moteur TypeScript
=> moteur Java
=> mêmes sorties
```

Aucun remplacement avant parité.

---

## IA

Ne pas ajouter de dépendance OpenAI ou autre LLM pendant le MVP initial.

Plus tard :

- LLM = langage naturel et explication ;
- moteur déterministe = chiffres ;
- forecast statistique = algorithme spécifique.

Aucune clé IA dans le frontend.

---

## Sécurité

Traiter les données comme sensibles.

Avant toute modification d'import ou export :

- vérifier CSV injection ;
- vérifier encodage ;
- vérifier formules ;
- vérifier doublons ;
- vérifier taille limite ;
- vérifier erreurs sans fuite de données.

Avant toute nouvelle dépendance :

- justifier son utilité ;
- préférer l'existant ;
- vérifier sa maintenance ;
- éviter une dépendance pour une fonction triviale.

---

## Commandes

Respecter le `AGENTS.md` upstream.

Les commandes Yarn doivent être lancées depuis la racine.

Avant de considérer une tâche terminée, exécuter les contrôles appropriés, en particulier :

```text
yarn typecheck
yarn lint:fix
yarn test
```

Pour un changement ciblé, commencer par les tests ciblés puis élargir.

Ne jamais masquer un test rouge pour faire passer la CI.

---

## Style de code

Conserver les conventions Actual.

Notamment :

- TypeScript strict ;
- types explicites lorsque nécessaire ;
- éviter `any` ;
- pas de cast injustifié ;
- réutiliser les abstractions existantes ;
- préférer une fonction pure pour les règles métier ;
- pas de duplication de logique budget ;
- chaînes utilisateur internationalisées selon les conventions du projet.

---

## Commits

Petits commits cohérents.

Exemples :

```text
[AI] docs: map transaction persistence for Budget FR
[AI] feat: add budget period domain model
[AI] test: cover next-month budget assignment
```

Suivre les règles upstream concernant les contributions générées avec un agent.

---

## Stop conditions

Arrêter l'implémentation et produire une analyse si :

- le schéma sync est ambigu ;
- deux mécanismes de persistance concurrents existent ;
- une migration peut casser des fichiers existants ;
- une modification nécessite de changer massivement `loot-core` ;
- une règle métier n'est pas spécifiée ;
- une donnée financière risque d'être envoyée hors du poste.

Dans ces cas, proposer les options et leurs impacts au lieu de choisir silencieusement.

---

## Definition of Done

Une tâche Budget FR est terminée seulement si :

- le besoin est satisfait ;
- les invariants sont respectés ;
- les tests ciblés existent ;
- les tests passent ;
- le typecheck est propre ;
- le lint est propre ;
- aucune donnée réelle n'est commise ;
- l'impact sync est maîtrisé ;
- la documentation est à jour ;
- le résumé final indique clairement ce qui a été fait et ce qui reste.
