# Première mission Codex — Baseline Actual Budget

**Mode : analyse uniquement. Ne pas implémenter `budgetPeriod`.**

## Objectif

Après clonage du fork Actual Budget et validation qu'il démarre, produire une cartographie technique suffisamment précise pour décider comment introduire `budgetPeriod` sans casser le fonctionnement local-first ni la synchronisation.

## Pré-requis

Lire :

- `AGENTS.md`
- `docs/budget-fr/functional-spec.md`
- `docs/budget-fr/architecture.md`

## Étapes

1. Identifier la version Git actuelle et le commit de départ.
2. Installer les dépendances selon les instructions upstream.
3. Vérifier que l'application Web démarre.
4. Exécuter les contrôles baseline appropriés.
5. Cartographier le chemin complet d'une transaction :
   - type ;
   - persistence ;
   - migration ;
   - import ;
   - mutation ;
   - règle ;
   - sync ;
   - API ;
   - UI.
6. Cartographier budgets, schedules et forecast existant.
7. Comparer les options de persistance de `budgetPeriod`.
8. Produire `docs/budget-fr/actual-baseline.md`.

## Livrable attendu

Le document doit contenir :

```text
1. Commit baseline
2. Packages concernés
3. Modèle Transaction
4. Schéma DB et migrations
5. Imports
6. Rules engine
7. Schedules
8. Forecast
9. Sync
10. API
11. UI
12. Options de persistance budgetPeriod
13. Recommandation
14. Risques
15. Liste exacte des fichiers pressentis pour feat/budget-period
16. Tests à écrire avant implémentation
```

## Interdictions

Dans cette mission :

- ne pas ajouter de migration ;
- ne pas modifier un type métier ;
- ne pas ajouter de champ ;
- ne pas créer de module Java ;
- ne pas ajouter de dépendance ;
- ne pas refactorer ;
- ne pas toucher au comportement utilisateur.

Les seuls changements autorisés sont les fichiers de documentation dans `docs/budget-fr/`.

## Rapport final Codex

À la fin, afficher :

```text
Baseline:
Tests:
Warnings:
Recommended persistence:
Files likely impacted:
Ready for feat/budget-period: YES/NO
Reason:
```

Si la réponse est `NO`, expliquer précisément le blocage.
