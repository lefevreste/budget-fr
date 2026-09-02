# RTK — Rust Token Killer (Codex CLI)

RTK est le proxy CLI installé localement pour réduire la taille des sorties de
commandes tout en conservant les informations utiles au diagnostic.

## Règle d'utilisation

Préfixer les commandes prises en charge avec `rtk`, en choisissant le filtre
adapté :

```bash
rtk git status
rtk git diff
rtk git log
rtk rg "motif" packages/
rtk read AGENTS.md
rtk tree packages/loot-core/src
```

Pour une commande non prise en charge, notamment Yarn, utiliser `rtk proxy`
afin de conserver la sortie brute tout en comptabilisant son usage. Pour les
tests et les commandes dont seuls les échecs ou avertissements sont utiles,
utiliser respectivement `rtk test` et `rtk err`.

Utiliser directement la commande native lorsque l'exactitude intégrale de la
sortie est indispensable. RTK ne remplace ni les règles d'autorisation ni les
consignes du dépôt.

## Commandes usuelles du dépôt

Toutes les commandes Yarn doivent être lancées depuis la racine du dépôt.

```bash
# Installation ou commande avec sortie complète
rtk proxy yarn install
rtk proxy yarn lint:fix

# Contrôles avec sortie réduite
rtk err yarn typecheck
rtk err yarn lint
rtk test yarn test

# Test ciblé
rtk test yarn workspace @actual-app/core run test
rtk test yarn workspace @actual-app/web run playwright test accounts.test.ts --browser=chromium
```

Pour les tests Playwright lancés directement, utiliser le filtre dédié :

```bash
rtk playwright test packages/desktop-client/e2e/accounts.test.ts
```

Commencer par les tests ciblés, puis élargir les contrôles selon le risque et
les instructions de `AGENTS.md` et `AGENTS-budget-fr.md`. Ne jamais masquer un
échec en filtrant sa sortie ; revenir à `rtk proxy` ou à la commande native si
le résumé n'est pas suffisant pour le diagnostic.

## Vérification et dépannage

```bash
rtk --version
rtk gain
command -v rtk
rtk verify
```

Pour savoir si RTK sait réécrire une commande, utiliser :

```bash
rtk rewrite 'git status'
```

Une commande sans équivalent RTK ne produit aucune réécriture. Dans ce cas,
utiliser `rtk proxy <commande>` ou le filtre générique approprié.

Ne jamais placer de secret, jeton, mot de passe ou donnée financière personnelle
dans une ligne de commande. Les sorties compactées ne constituent pas un
mécanisme de masquage des secrets ou des données sensibles.
