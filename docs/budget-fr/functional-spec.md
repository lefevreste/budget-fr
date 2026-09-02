# Spécification fonctionnelle — Budget intelligent France

**Version :** 0.1
**Date :** 01/09/2026
**Statut :** cadrage MVP
**Nom de travail :** Budget FR
**Référence fonctionnelle :** classeur `Budget_famille_202608.xlsx`

---

## Références de décision

La décision de référence pour l'affectation de période budgétaire est
[ADR-0006 — Affectation de période budgétaire en couches](./adr/0006-layered-budget-period-assignment.md).
Elle s'appuie sur le [premier POC de concurrence](./spikes/budget-period-crdt.md)
et le [POC de l'option D](./spikes/budget-period-option-d.md). ADR-0002 reste
consultable comme historique, mais n'est plus normative pour la persistance et
les comportements d'affectation remplacés par ADR-0006.

---

## Statut de livraison temporaire

Ce statut de livraison est temporaire, distinct des exigences fonctionnelles et
ne constitue pas une exigence produit permanente :

- ADR-0006 : **ACCEPTÉE** ;
- Architecture option D :
  **READY FOR EXPERIMENTAL / TEST-FIRST IMPLEMENTATION** ;
- Migration, activation et livraison en production :
  **NOT READY FOR PRODUCTION MIGRATION OR RELEASE**.

---

## 1. Vision

Budget FR est une application de gestion budgétaire destinée en priorité aux foyers français.

Elle doit réunir quatre fonctions aujourd'hui généralement séparées :

1. récupérer ou importer les opérations bancaires réelles ;
2. rattacher chaque opération à la bonne période budgétaire, indépendamment de sa date bancaire ;
3. construire un budget prévisionnel fiable sur plusieurs mois ;
4. expliquer les écarts et améliorer les prévisions grâce à l'IA, sans confier les calculs financiers au LLM.

Le principe fondateur est de distinguer :

- **la vérité bancaire** : ce qui s'est réellement produit sur le compte ;
- **la vérité budgétaire** : le mois auquel l'opération doit être rattachée pour piloter le budget.

Exemple : un salaire reçu le 28 août peut conserver sa date bancaire du 28/08 tout en étant affecté au budget de septembre.

---

## 2. Problème à résoudre

Les applications de finances personnelles classiques savent généralement :

- agréger des comptes ;
- catégoriser des transactions ;
- présenter des graphiques de dépenses ;
- calculer un budget mensuel.

Elles sont moins adaptées lorsque le foyer raisonne en cycle de trésorerie plutôt qu'en mois civil.

Le produit doit notamment gérer correctement :

- les salaires reçus en fin de mois et destinés au mois suivant ;
- les charges prélevées en fin de mois mais appartenant au cycle budgétaire suivant ;
- les dépenses récurrentes ;
- les échéanciers ;
- les dépenses en plusieurs fois ;
- les dépenses exceptionnelles ;
- les remboursements ;
- les transferts entre comptes ;
- les dépenses à exclure du budget courant ;
- la distinction entre réel, estimé et hypothèse ;
- les changements de revenus à une date donnée ;
- les simulations sur les mois futurs ;
- le rapprochement entre opérations prévues et opérations réellement importées.

---

## 3. Principes fonctionnels

### PF-001 — La date bancaire n'est jamais falsifiée

La date d'une transaction importée représente le fait bancaire réel et doit rester inchangée.

Une propriété distincte `budgetPeriod` détermine son mois budgétaire.

`budgetPeriod` est toujours la période effective : la correction manuelle si
elle existe, sinon l'affectation produite par une règle si elle existe, sinon le
mois de `bankDate`.

### PF-002 — Les calculs sont déterministes

À données et règles identiques, le moteur doit toujours retourner le même résultat.

Le LLM ne calcule jamais directement :

- un solde ;
- une mensualité ;
- un reste à vivre ;
- un taux d'endettement ;
- un montant de prévision.

### PF-003 — Toute décision automatique est explicable

Une opération automatiquement classifiée ou réaffectée doit indiquer :

- la règle appliquée ;
- sa source ;
- sa priorité ;
- éventuellement son niveau de confiance.

### PF-004 — L'utilisateur conserve le dernier mot

Toute classification, affectation ou prévision automatique peut être corrigée manuellement.

Une correction manuelle doit pouvoir :

- ne s'appliquer qu'à l'opération ;
- devenir une règle pour les prochaines opérations similaires.

### PF-005 — Pas de double comptage

Lorsqu'une opération prévue est rapprochée d'une opération réelle, elle est remplacée par le réel dans les calculs.

---

## 4. Périmètre du MVP

Le MVP doit permettre de gérer correctement un budget familial sans connexion bancaire automatique.

### Inclus

- création d'un foyer budgétaire ;
- gestion d'un ou plusieurs comptes ;
- import CSV bancaire ;
- détection des doublons d'import ;
- liste et recherche des transactions ;
- catégorisation ;
- règles automatiques ;
- mois budgétaire distinct de la date bancaire ;
- revenus et charges récurrentes ;
- opérations prévues ;
- dépenses en plusieurs fois ;
- budgets par catégorie ;
- réalisé mensuel ;
- prévision sur 12 mois ;
- solde prévisionnel ;
- reste à vivre ;
- marge par rapport au découvert autorisé ;
- hypothèses datées ;
- scénarios ;
- rapprochement prévu/réel ;
- traçabilité des corrections.

### Hors MVP

- synchronisation bancaire PSD2 ;
- application mobile native ;
- investissements et patrimoine ;
- PEA, assurance-vie et PER ;
- virements bancaires depuis l'application ;
- paiement ;
- conseil financier réglementé ;
- IA générative ;
- prévision statistique avancée ;
- gestion multi-devise avancée.

Ces fonctions pourront être ajoutées après validation du moteur budgétaire.

---

## 5. Modèle métier

### 5.1 Household

Représente le foyer budgétaire.

Attributs principaux :

- `id`
- `name`
- `currency`
- `timezone`
- `defaultBudgetCycle`
- `createdAt`

Un foyer peut avoir plusieurs utilisateurs et plusieurs comptes.

### 5.2 Account

Représente un compte financier.

Attributs :

- `id`
- `householdId`
- `name`
- `bankName`
- `accountType`
- `currency`
- `openingBalance`
- `overdraftLimit`
- `active`

Types initiaux :

- courant ;
- joint ;
- épargne ;
- carte ;
- autre.

### 5.3 BankTransaction

Représente le fait bancaire importé.

Attributs principaux :

- `id`
- `accountId`
- `bankDate`
- `valueDate`
- `amount`
- `currency`
- `rawLabel`
- `normalizedLabel`
- `importBatchId`
- `externalFingerprint`
- `createdAt`

Ces informations brutes ne doivent pas être écrasées par le moteur budgétaire.

### 5.4 BudgetTransaction

Représente l'interprétation budgétaire d'une opération.

Attributs :

- `id`
- `bankTransactionId`
- `manualBudgetPeriod`
- `ruleAssignment`
- `budgetPeriod`
- `budgetPeriodSource`
- `categoryId`
- `transactionNature`
- `budgetStatus`
- `includedInBudget`
- `recurrenceId`
- `forecastItemId`
- `confidence`

Pour l'affectation de période :

- `manualBudgetPeriod` représente une correction manuelle facultative ;
- `ruleAssignment` représente la dernière affectation produite par une règle,
  avec sa période et l'identifiant de la règle ;
- `budgetPeriod` est la période effective dérivée ;
- `budgetPeriodSource` est la provenance dérivée `manual`, `rule` ou `default`,
  correspondant respectivement à une correction manuelle, une affectation par
  règle ou au mois bancaire.

Les deux dernières valeurs décrivent le résultat courant. Elles ne constituent
ni une couche d'affectation supplémentaire ni un historique des changements.

Natures initiales :

- revenu ;
- dépense fixe ;
- dépense variable ;
- remboursement ;
- transfert ;
- hors budget.

### 5.5 Category

Structure hiérarchique de catégories.

Exemples :

- Revenus
  - Salaires
  - Primes
  - Remboursements
- Logement
- Crédits
- Impôts
- Transport
- Alimentation
- Santé
- Loisirs
- Abonnements
- Animaux
- Enfants
- Shopping
- Hors budget

L'utilisateur peut créer et modifier les catégories.

### 5.6 BudgetRule

Règle automatique appliquée aux opérations.

Critères possibles :

- libellé ;
- expression régulière ;
- bénéficiaire ;
- émetteur ;
- montant ;
- fourchette de montant ;
- type de transaction ;
- compte ;
- jour du mois ;
- période du mois ;
- catégorie existante.

Actions possibles :

- affecter une catégorie ;
- affecter une nature ;
- inclure/exclure du budget ;
- affecter le mois budgétaire ;
- rattacher à une récurrence ;
- ajouter une note ;
- proposer un rapprochement.

Une action de règle qui affecte le mois budgétaire ne modifie jamais une
correction manuelle existante. Elle met uniquement à jour l'affectation par
règle, qui peut rester masquée tant que la correction manuelle existe.

### 5.7 RecurringItem

Représente une recette ou une dépense récurrente connue.

Attributs :

- `id`
- `label`
- `categoryId`
- `amountType`
- `expectedAmount`
- `minAmount`
- `maxAmount`
- `frequency`
- `expectedDay`
- `budgetPeriodRule`
- `startDate`
- `endDate`
- `active`

Fréquences :

- hebdomadaire ;
- mensuelle ;
- bimestrielle ;
- trimestrielle ;
- annuelle ;
- personnalisée.

### 5.8 ForecastItem

Opération future calculée à partir :

- d'une récurrence ;
- d'une hypothèse ;
- d'un échéancier ;
- d'un scénario ;
- d'une saisie manuelle.

Statuts :

- prévu ;
- estimé ;
- confirmé ;
- rapproché avec réel ;
- annulé.

### 5.9 BudgetEnvelope

Montant cible disponible pour une catégorie et une période.

Exemple :

- courses : 600 € ;
- restaurants : 50 € ;
- carburant : 190 €.

Une enveloppe peut être :

- fixe ;
- reportable ;
- non reportable.

### 5.10 Assumption

Hypothèse utilisée dans les projections.

Exemples :

- salaire à partir d'octobre ;
- augmentation d'une charge ;
- fin d'un abonnement ;
- changement de mensualité.

Attributs :

- `effectiveFrom`
- `effectiveTo`
- `value`
- `source`
- `status`
- `comment`.

Statuts :

- hypothèse ;
- à confirmer ;
- confirmé ;
- réel.

### 5.11 Scenario

Une simulation ne modifie jamais le budget de référence.

Exemples :

- augmentation de salaire ;
- nouveau crédit ;
- achat automobile ;
- hausse EDF ;
- prime exceptionnelle.

---

## 6. Règles métier prioritaires

### BR-001 — Mois budgétaire par défaut

La période budgétaire effective suit toujours cet ordre :

1. correction manuelle si elle existe ;
2. affectation produite par une règle si elle existe ;
3. mois de `bankDate` sinon.

Sans correction manuelle ni affectation par règle :

`budgetPeriod = mois(bankDate)`

### BR-002 — Revenu reçu en fin de mois

Une règle configurable peut affecter un revenu reçu en fin de mois M au budget M+1.

Exemple :

`bankDate = 28/08/2026`
`budgetPeriod = 2026-09`

La date bancaire reste 28/08/2026.

### BR-003 — Charge de fin de mois appartenant au cycle suivant

Une charge récurrente prélevée en fin de mois peut être rattachée au mois suivant.

Cette règle doit pouvoir être définie par créancier ou récurrence.

### BR-004 — Priorité à l'affectation manuelle

Pour le mois budgétaire, toute correction manuelle a priorité sur toute
affectation par règle, indépendamment de l'ordre dans lequel elles ont été
produites ou reçues.

Supprimer la correction manuelle révèle la dernière affectation par règle. S'il
n'en existe aucune, le mois budgétaire redevient le mois de `bankDate`.

Un import, un réimport, un rapprochement ou une règle ne remplace jamais une
correction manuelle. Les priorités entre règles utilisateur, règles système et
classifications automatiques déterminent quelle affectation par règle est
produite ; elles ne remettent pas en cause la priorité de la correction
manuelle.

### BR-005 — Transferts internes

Un transfert entre deux comptes appartenant au même foyer :

- ne constitue ni un revenu ni une dépense ;
- ne doit pas modifier le résultat global du foyer ;
- peut modifier la trésorerie de chaque compte.

La propagation d'une affectation de période entre les lignes d'un split ou les
deux côtés d'un transfert fait l'objet d'une décision distincte. Elle n'est pas
résolue par la présente règle fonctionnelle.

### BR-006 — Hors budget

Une opération peut être réelle mais exclue du budget courant.

Elle reste visible dans :

- l'historique bancaire ;
- la trésorerie réelle ;
- les rapports dédiés.

Elle est exclue du calcul du budget structurel si l'utilisateur le décide.

### BR-007 — Rapprochement d'une opération prévue

Une opération réelle est rapprochée d'une prévision selon :

- libellé ;
- montant avec tolérance ;
- compte ;
- fenêtre de date ;
- récurrence.

Après rapprochement, le montant réel remplace le montant prévu.

### BR-008 — Tolérance de montant

Une récurrence peut accepter un montant variable.

Exemple :

- prévision : 80 € ;
- réel : 82,34 €.

Le moteur considère l'opération comme la même échéance si elle respecte la tolérance définie.

### BR-009 — Changement d'une hypothèse à une date donnée

Une nouvelle hypothèse ne modifie pas les mois antérieurs.

Exemple :

- salaire actuel jusqu'en septembre ;
- nouveau salaire à partir d'octobre.

### BR-010 — Dépense en plusieurs fois

Un achat en N échéances génère N prévisions distinctes.

Chaque échéance peut ensuite être rapprochée de son opération réelle.

### BR-011 — Dépense périodique non mensuelle

Exemple : 100 € tous les deux mois.

Le moteur ne doit pas obligatoirement lisser cette dépense.

Deux modes sont proposés :

- échéancier réel : 100 € tous les deux mois ;
- lissage budgétaire : provision de 50 € par mois.

### BR-012 — Mois partiel

Le moteur doit permettre de démarrer un budget en cours de mois avec :

- un solde bancaire de référence ;
- une date de coupure ;
- uniquement les dépenses restant à payer.

### BR-013 — Solde de fin de mois

Pour un compte :

`soldeFin = soldeDébut + recettesRéellesEtPrévues + dépensesRéellesEtPrévues`

Le moteur calcule ensuite le solde de départ du mois suivant.

### BR-014 — Marge par rapport au découvert

`margeDécouvert = soldeFin - limiteDécouvert`

Exemple avec un découvert autorisé de -2 500 € :

- solde fin : -2 000 € ;
- marge disponible : 500 €.

### BR-015 — Reste à vivre

`resteAVivreAvantVariables = recettes - dépensesFixes`

Le montant doit être disponible au niveau :

- mois ;
- foyer ;
- compte si nécessaire.

### BR-016 — Réel, prévu et écart

Pour chaque poste :

- prévu ;
- réel ;
- écart montant ;
- écart pourcentage.

### BR-017 — Clôture mensuelle

Un mois peut être marqué clôturé.

Les opérations du mois restent modifiables, mais toute modification après clôture doit être tracée.

### BR-018 — Audit

Le journal d'audit métier complet reste un objectif fonctionnel cible. Pour
chaque changement significatif, il devra pouvoir conserver :

- ancienne valeur ;
- nouvelle valeur ;
- utilisateur ;
- date ;
- origine ;
- commentaire éventuel.

La provenance courante d'une période indique seulement si le résultat vient
d'une correction manuelle, d'une règle ou du mois bancaire. L'identifiant de
la règle explique l'affectation automatique courante. Ces informations ne sont
pas un historique des changements et ne remplacent pas le futur journal
d'audit métier, reporté après le MVP.

### BR-019 — Aucune utilisation de nombres flottants

Les montants monétaires sont stockés avec une précision décimale adaptée aux devises.

### BR-020 — Absence de double comptage

Une même échéance ne peut être simultanément comptée :

- comme prévision ;
- et comme transaction réelle rapprochée.

### BR-021 — Cycle de vie d'une affectation par règle

La suppression ou la désactivation d'une règle ne modifie pas rétroactivement
les affectations déjà produites par cette règle.

Une réévaluation demandée explicitement peut remplacer ou retirer uniquement
l'affectation par règle. Elle ne modifie jamais une correction manuelle, même
si celle-ci masque le nouveau résultat automatique.

### BR-022 — Réinitialisation de la période budgétaire

Une réinitialisation complète retire la correction manuelle et l'affectation
par règle. En l'absence d'une action concurrente plus récente, la période
effective redevient le mois de `bankDate`.

Entre appareils, des états intermédiaires peuvent être visibles pendant la
synchronisation. Après convergence, tous les appareils compatibles doivent
aboutir au même résultat, déterminé séparément pour la correction manuelle et
l'affectation par règle.

---

## 7. Import bancaire CSV

### 7.1 Étapes

1. sélection du compte ;
2. chargement du fichier ;
3. détection du format ;
4. prévisualisation ;
5. normalisation ;
6. génération d'une empreinte de transaction ;
7. détection des doublons ;
8. import ;
9. application des règles ;
10. affichage des opérations nécessitant une validation.

### 7.2 Idempotence

Réimporter deux fois le même fichier ne doit pas créer deux fois les mêmes opérations.

### 7.3 Format interne normalisé

Indépendamment de la banque source :

- date ;
- date de valeur ;
- montant ;
- devise ;
- libellé ;
- type ;
- identifiant source si disponible.

Un adaptateur par format bancaire convertit le CSV source vers ce modèle.

---

## 8. Moteur de règles

Chaque règle possède :

- un nom ;
- une priorité ;
- une activation ;
- des conditions ;
- des actions ;
- une date de validité ;
- une origine.

Exemple conceptuel :

```text
SI
  libellé contient "SALAIRE"
  ET jour(date bancaire) >= 25
ALORS
  nature = REVENU
  catégorie = SALAIRE
  mois budgétaire = MOIS_SUIVANT
```

Autre exemple :

```text
SI
  libellé contient "CREATIS"
ALORS
  catégorie = CRÉDIT
  nature = DÉPENSE_FIXE
  rattachement = CYCLE_BUDGÉTAIRE_SUIVANT
```

Les règles doivent être testables avant activation sur l'historique.

Désactiver ou supprimer une règle ne relance pas automatiquement son exécution
sur les opérations déjà affectées. Une réévaluation de ces opérations est une
action explicite, prévisualisable, qui ne peut modifier que leur affectation
par règle.

---

## 9. Prévision déterministe 12 mois

Le forecast de base combine :

1. solde de départ ;
2. opérations réelles déjà connues ;
3. opérations récurrentes ;
4. échéanciers ;
5. hypothèses ;
6. enveloppes variables ;
7. événements ponctuels ;
8. scénario actif.

Pour chaque mois, il produit :

- recettes ;
- dépenses fixes ;
- dépenses variables ;
- reste à vivre ;
- variation mensuelle ;
- solde de fin ;
- marge de découvert ;
- niveau de confiance.

Une prévision doit pouvoir être recalculée immédiatement après toute modification.

---

## 10. Écrans du MVP

### 10.1 Tableau de bord

Affiche :

- solde bancaire actuel ;
- solde budgétaire du mois ;
- revenus du mois ;
- dépenses fixes ;
- dépenses variables ;
- reste à vivre ;
- solde prévisionnel fin de mois ;
- marge de découvert ;
- projection 12 mois ;
- principales alertes.

### 10.2 Transactions

Colonnes principales :

- date bancaire ;
- libellé ;
- montant ;
- compte ;
- catégorie ;
- nature ;
- mois budgétaire ;
- statut ;
- règle appliquée.

Le mois budgétaire affiché est toujours la période effective. Sa provenance
courante doit être explicable sans présenter cette information comme un
historique complet.

Filtres :

- compte ;
- mois bancaire ;
- mois budgétaire ;
- catégorie ;
- réel/prévu ;
- inclus/hors budget ;
- à valider.

Le filtre et le tri par mois budgétaire utilisent la période effective. Ils ne
peuvent pas ignorer une correction manuelle au profit d'une affectation par
règle.

L'utilisateur peut créer, modifier ou supprimer une correction manuelle. Une
action distincte permet de réinitialiser complètement l'affectation de période.

### 10.3 Budget mensuel

Vue par poste :

- budget ;
- réel ;
- restant ;
- prévision fin de mois ;
- écart.

Les montants réels et les agrégations mensuelles utilisent la période
budgétaire effective.

### 10.4 Prévision 12 mois

Tableau :

| Mois | Solde début | Revenus | Fixes | Variables | Variation | Solde fin |
| ---- | ----------: | ------: | ----: | --------: | --------: | --------: |

La sélection d'un mois ouvre le détail des opérations qui construisent la prévision.

Les prévisions budgétaires mensuelles utilisent la période effective. Les
soldes bancaires et la trésorerie conservent la date bancaire.

### 10.5 Règles

Permet :

- créer ;
- tester ;
- activer ;
- désactiver ;
- réordonner ;
- prévisualiser puis demander une réévaluation explicite ;
- voir l'historique d'exécution.

La présentation d'une affectation par règle masquée par une correction manuelle
reste à concevoir avant la mise à disposition de la fonctionnalité.

### 10.6 Hypothèses et scénarios

Permet de modifier un paramètre futur sans altérer le scénario de référence.

---

## 11. Critères de recette MVP

### AC-001

Étant donné un salaire reçu le 28 août et une règle M+1, la transaction :

- conserve `bankDate = 28/08` ;
- possède `budgetPeriod = septembre`.

### AC-002

Une charge de fin août configurée comme appartenant au cycle de septembre apparaît dans le budget de septembre sans modification de sa date bancaire.

### AC-003

Étant donné une transaction de salaire datée du 28/08/2026 et une affectation
existante à septembre 2026 produite par la règle M+1 utilisée dans AC-001, qui
affecte les salaires reçus en fin de mois au budget du mois suivant :

- la désactivation de cette règle ne modifie pas rétroactivement l'affectation
  existante ;
- `budgetPeriod` reste égal à `2026-09` ;
- seule une réévaluation explicitement demandée peut remplacer ou retirer
  l'affectation par règle ;
- cette réévaluation ne modifie aucune correction manuelle éventuelle.

### AC-004

Une correction manuelle de mois budgétaire n'est écrasée ni par un import, ni
par un réimport, ni par une nouvelle affectation produite par une règle.

### AC-005

Le réimport du même CSV ne crée aucun doublon.

### AC-006

Une mensualité prévue rapprochée d'un prélèvement réel n'est comptée qu'une fois.

### AC-007

Un transfert entre deux comptes du foyer n'affecte pas le résultat consolidé.

### AC-008

Une dépense hors budget affecte le solde bancaire mais peut être exclue du budget structurel.

### AC-009

La modification d'un revenu futur à compter d'octobre recalcule octobre à décembre sans changer septembre.

### AC-010

Une dépense en quatre fois génère exactement quatre échéances et chacune peut être rapprochée indépendamment.

### AC-011

Un changement d'enveloppe variable recalcule immédiatement le forecast.

### AC-012

Le détail d'un solde prévisionnel permet de retrouver toutes les opérations qui contribuent au calcul.

### AC-013

Le calcul d'un mois fermé est reproductible à données et règles identiques.

### AC-014

Le système affiche séparément :

- réel ;
- prévu ;
- écart.

### AC-015

Aucun appel à un LLM n'est nécessaire pour obtenir les résultats financiers du MVP.

### AC-016

Supprimer une correction manuelle révèle la dernière affectation par règle. Si
aucune règle n'a affecté l'opération, le mois budgétaire redevient le mois de la
date bancaire.

### AC-017

Une réévaluation explicite peut remplacer ou retirer l'affectation par règle,
mais conserve toute correction manuelle existante.

### AC-018

Une réinitialisation complète sans action concurrente plus récente ramène la
période budgétaire au mois de la date bancaire. Des états intermédiaires peuvent
être visibles entre appareils, mais les appareils compatibles convergent vers
le même résultat final.

### AC-019

Pour une même opération, la projection effective détermine la même période
budgétaire pour :

- l'affichage ;
- les filtres ;
- les tris ;
- les budgets ;
- les agrégations ;
- l'API ;
- les exports ;
- les règles ;
- les prévisions budgétaires.

---

## 12. Exigences non fonctionnelles

### NFR-001 — Exactitude monétaire

Utiliser des types décimaux ; aucun `float` pour les montants.

### NFR-002 — Traçabilité

Toute opération calculée doit être explicable.

### NFR-003 — Performance

Un budget domestique comprenant 100 000 transactions doit rester utilisable sans dégradation significative.

### NFR-004 — Confidentialité

Les données financières sont considérées sensibles.

Principes :

- chiffrement en transit ;
- chiffrement des secrets ;
- limitation des logs ;
- pas d'envoi de transactions complètes vers un LLM sans action explicite ;
- minimisation des données.

### NFR-005 — Portabilité

L'utilisateur doit pouvoir exporter :

- transactions ;
- règles ;
- catégories ;
- budgets ;
- hypothèses ;
- prévisions.

La période budgétaire exportée est la période effective. Sa provenance
courante est dérivée de la correction manuelle, de l'affectation par règle ou
du mois bancaire ; elle ne doit pas être présentée comme un historique.

### NFR-006 — Réversibilité

Le produit ne doit pas enfermer les données dans un format propriétaire inaccessible.

---

## 13. Architecture cible

Architecture cible envisagée :

```text
React / TypeScript
        |
        v
Spring Boot API
        |
        +---- moteur budget
        +---- moteur règles
        +---- moteur forecast
        +---- import bancaire
        +---- rapprochement
        |
        v
PostgreSQL
```

Principes :

- frontend React conservé autant que possible depuis Actual Budget ;
- domaine budgétaire progressivement extrait vers Java ;
- API explicite entre frontend et moteur ;
- base PostgreSQL côté serveur ;
- tests de non-régression entre comportements existants et nouveau moteur.

La migration ne doit pas être une réécriture automatique complète du code TypeScript.

---

## 14. Stratégie par rapport à Actual Budget

### Phase 0 — Baseline

- fork du dépôt ;
- build reproductible ;
- exécution des tests ;
- documentation de l'architecture ;
- inventaire des entités et règles actuelles.

### Phase 1 — Extension fonctionnelle

Introduire `budgetPeriod` comme période effective distincte de `bankDate`, à
partir d'une correction manuelle, d'une affectation par règle ou du mois
bancaire.

Valider les cas métier français sur le frontend existant.

Le statut de livraison applicable à cette phase est :

- ADR-0006 : **ACCEPTÉE** ;
- Architecture option D :
  **READY FOR EXPERIMENTAL / TEST-FIRST IMPLEMENTATION** ;
- Migration, activation et livraison en production :
  **NOT READY FOR PRODUCTION MIGRATION OR RELEASE**.

Ce statut de livraison est temporaire, distinct des exigences fonctionnelles et
ne constitue pas une exigence produit permanente.

### Phase 2 — Budget engine Java

Créer les composants Java :

```text
account
transaction
category
budget
rule
recurrence
forecast
scenario
reconciliation
import
```

Les premiers tests Java utilisent des jeux de données dérivés du budget de référence.

### Phase 3 — API

Le frontend consomme progressivement les services Spring Boot.

### Phase 4 — PostgreSQL

Migration du stockage métier vers le modèle cible.

### Phase 5 — Open Banking

Ajouter un fournisseur PSD2 après stabilisation du moteur.

### Phase 6 — IA

Ajouter les fonctions intelligentes sans remettre en cause le déterminisme financier.

---

## 15. IA — cible V2

L'IA comporte deux niveaux distincts.

### 15.1 Intelligence quantitative

Elle peut :

- détecter des récurrences ;
- détecter la saisonnalité ;
- estimer les variables ;
- identifier les anomalies ;
- calculer des intervalles de prévision ;
- mesurer la confiance.

Cette partie utilise des algorithmes statistiques ou de machine learning adaptés aux séries temporelles.

### 15.2 Assistant LLM

Le LLM peut :

- expliquer le forecast ;
- expliquer les écarts ;
- proposer une catégorisation ;
- proposer une règle ;
- répondre aux questions ;
- traduire une simulation exprimée en langage naturel en paramètres structurés.

Exemple :

> "Que se passe-t-il si mon salaire augmente de 300 € à partir de novembre et si je prends un crédit de 250 € par mois en janvier ?"

Le LLM traduit la demande en scénario structuré.

Le moteur Java effectue les calculs.

Le LLM explique le résultat.

### 15.3 Garde-fou

Le montant présenté comme résultat financier doit toujours provenir du moteur de calcul, jamais directement d'une génération de texte.

---

## 16. Indicateurs futurs

Après le MVP :

- taux de dépenses fixes ;
- taux d'endettement ;
- reste à vivre ;
- capacité d'épargne ;
- trésorerie minimale projetée ;
- nombre de jours avant passage sous un seuil ;
- dépenses inhabituelles ;
- écart budget/réel ;
- précision des forecasts passés.

---

## 17. Premier backlog Codex

### EPIC 0 — Comprendre Actual Budget

1. cartographier le monorepo ;
2. identifier les composants métier ;
3. documenter le flux transaction → budget ;
4. documenter les règles ;
5. identifier le stockage ;
6. identifier les points d'extension ;
7. exécuter la totalité des tests existants.

### EPIC 1 — Introduire `budgetPeriod`

1. écrire d'abord les tests des cas mois bancaire, affectation par règle et
   correction manuelle ;
2. définir le modèle conceptuel en couches ;
3. centraliser le calcul de la période effective ;
4. afficher et filtrer les transactions par période effective ;
5. créer, modifier et supprimer une correction manuelle ;
6. réinitialiser séparément la correction manuelle ou l'affectation complète ;
7. appliquer la même projection aux budgets, prévisions, API et exports ;
8. tester la convergence entre appareils et les états intermédiaires ;
9. respecter le statut de livraison suivant :

   - ADR-0006 : **ACCEPTÉE** ;
   - Architecture option D :
     **READY FOR EXPERIMENTAL / TEST-FIRST IMPLEMENTATION** ;
   - Migration, activation et livraison en production :
     **NOT READY FOR PRODUCTION MIGRATION OR RELEASE**.

   Ce statut de livraison est temporaire, distinct des exigences fonctionnelles
   et ne constitue pas une exigence produit permanente.

### EPIC 2 — Règle M+1

1. créer l'action `ASSIGN_NEXT_BUDGET_PERIOD` ;
2. condition par jour du mois ;
3. condition par libellé ;
4. priorité ;
5. test sur historique ;
6. visualisation de la règle appliquée ;
7. réévaluation explicite limitée à l'affectation par règle ;
8. désactivation sans réécriture rétroactive.

### EPIC 3 — Forecast déterministe

1. modèle de récurrence ;
2. opérations prévues ;
3. rapprochement ;
4. projection mensuelle ;
5. scénarios ;
6. API de calcul ;
7. tests de référence.

### EPIC 4 — Backend Java

1. squelette Spring Boot ;
2. modèle domaine ;
3. moteur de règles ;
4. moteur forecast ;
5. tests ;
6. API REST ;
7. adaptation progressive du frontend.

---

## 18. Définition de réussite du MVP

Le MVP est validé lorsque :

1. un CSV bancaire peut être importé sans doublon ;
2. les opérations sont correctement classées ;
3. une date bancaire et un mois budgétaire peuvent être différents ;
4. le cycle M+1 fonctionne automatiquement ;
5. les revenus et charges récurrents construisent les mois futurs ;
6. le prévu est remplacé par le réel sans double comptage ;
7. le budget mensuel est expliqué opération par opération ;
8. la prévision à 12 mois est reproductible ;
9. un scénario peut être comparé au budget de référence ;
10. les résultats correspondent au jeu de référence issu du budget familial utilisé pour le cadrage.

---

## 19. Décision de conception principale

La première évolution à implémenter n'est ni l'IA ni la synchronisation bancaire.

C'est la séparation explicite entre :

```text
bankDate
```

et :

```text
budgetPeriod
```

Cette décision structure tout le reste du produit.

Elle permet ensuite de construire proprement :

- le cycle M+1 ;
- les règles ;
- les forecasts ;
- les scénarios ;
- le rapprochement bancaire ;
- l'IA explicative.
