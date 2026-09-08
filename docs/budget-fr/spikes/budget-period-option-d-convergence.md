# Spike CRDT — clôture de la convergence de l'option D

- Date : 2026-09-08
- Commit de référence : `922dd527857a4032c225e80327e5a9f60be116de`
- Branche : `spike/budget-period-option-d-convergence`
- Portée : tests et rapport uniquement, sans code de production ni migration
- Statut : **NOT READY FOR PRODUCTION MIGRATION OR RELEASE**

## Objectif

Ce lot complète le POC de l'option D défini par ADR-0006 sur deux risques
précis :

1. les permutations et partitions de livraison des cellules indépendantes
   `manual_budget_period` et `rule_assignment` ;
2. le départage de deux HULC ayant le même temps physique et le même compteur,
   mais des `node` différents.

Il ne modifie ni la décision de persistance, ni le schéma de production, ni le
protocole de synchronisation. Le départage par `node` est observé comme un ordre
technique déterministe. Il ne constitue jamais une priorité métier.

## Périmètre exact

Le test complète la table SQLite en mémoire et les deux encodages déjà présents
dans `budget-period-option-d.test.ts` :

- JSON canonique, retenu par ADR-0006 ;
- texte historique du POC, conservé uniquement comme comparaison technique.

Les nouveaux scénarios utilisent les fonctions Actual existantes :

- `applyMessages`, qui exerce indirectement `compareMessages` ;
- `receiveMessages`, qui appelle réellement `Timestamp.recv` avant
  `applyMessages` ;
- les vrais objets `Timestamp` HULC ;
- la persistance technique `messages_crdt` ;
- la transaction SQLite en mémoire du harness.

Les helpers ajoutés construisent uniquement des permutations et des plans de
livraison, appliquent les messages et lisent les résultats. Ils ne trient pas
les messages pour produire une attente et ne réimplémentent pas la résolution
LWW. Chaque gagnant attendu est déclaré explicitement dans son scénario.

## Isolation

Chaque permutation ou plan repart de `resetProbeDatabase`, qui recrée une base
SQLite en mémoire, recharge une horloge CRDT et recrée les tables de probe. Le
temps simulé stable du harness sert de référence au scénario `receiveMessages` ;
aucun test du lot ne le fait avancer.

Les scénarios utilisent des plages de temps ou de compteurs distinctes. Les
seules réutilisations exactes de timestamps sont les rejeux idempotents
intentionnels. Les égalités temps-compteur emploient toujours des `node`
différents, de sorte que les timestamps sérialisés restent uniques et ne
heurtent pas la contrainte globale `UNIQUE` de `messages_crdt.timestamp`.

## Matrice réellement exécutée

| ID  | Scénario exécuté                                                                      | Encodages   |
| --- | ------------------------------------------------------------------------------------- | ----------- |
| C01 | 24 permutations unitaires de `R1`, `R2`, `M1`, `M2`                                   | JSON, texte |
| C02 | Rule livrée directement et Manual en ordre inverse                                    | JSON, texte |
| C03 | Rule livrée en ordre inverse et Manual directement                                    | JSON, texte |
| C04 | deux valeurs Manual au même temps-compteur, départagées par `node`                    | JSON, texte |
| C05 | valeur Manual sur le `node` supérieur contre `null` sur le `node` inférieur           | JSON, texte |
| C06 | `null` Manual sur le `node` supérieur contre une valeur sur le `node` inférieur       | JSON, texte |
| C07 | deux composites Rule au même temps-compteur, départagés par `node`                    | JSON, texte |
| C08 | valeur Rule sur le `node` supérieur contre `null` sur le `node` inférieur             | JSON, texte |
| C09 | `null` Rule sur le `node` supérieur contre une valeur sur le `node` inférieur         | JSON, texte |
| C10 | Manual et Rule dans deux cellules au même temps-compteur et avec des nodes différents | JSON, texte |
| C11 | trois partitions réseau mixtes, avec ordres croisés                                   | JSON, texte |
| C12 | rejeu exact des gagnants                                                              | JSON, texte |
| C13 | messages anciens livrés après les gagnants, avec vérification de `old`                | JSON, texte |
| C14 | comparaison des mêmes résultats via `applyMessages` et `receiveMessages`              | JSON, texte |
| C15 | persistance des deux concurrents départagés par `node` dans chaque cellule            | JSON, texte |
| C16 | comparaison du résultat logique JSON canonique / ancien texte du POC                  | JSON, texte |

C01 exécute 24 permutations pour chacun des deux encodages, soit 48 états
SQLite indépendants. Les cas C02 et C03 rendent explicites les deux livraisons
mixtes par cellule que les quatre plans historiques ne nommaient pas.

Pour C01, chaque signature concatène les timestamps dans leur ordre de
livraison, sans tri ni calcul de gagnant. Le test vérifie séparément que 24 plans
sont générés et que le `Set` de leurs signatures contient exactement 24
éléments.

## Première exécution des nouveaux tests

Commande reproductible depuis la racine :

```bash
yarn workspace @actual-app/core exec vitest --run \
  src/server/sync/budget-period-option-d.test.ts
```

Résultat observé :

- 1 fichier réussi ;
- **55/55 tests réussis** ;
- aucun test ignoré signalé ;
- durée totale : **12,03 s** ;
- durée des tests : **8,38 s** ;
- aucun contre-exemple observé.

Une tentative antérieure avec `rtk test yarn ...` n'a pas lancé Vitest : le
sous-processus ne trouvait pas `yarn` et a quitté avec le code 127. Elle ne
constitue donc pas une exécution de tests. La première exécution effective est
celle rapportée ci-dessus ; l'environnement a invoqué le binaire Yarn versionné
par l'intermédiaire du runtime Node disponible.

### Première exécution des assertions complémentaires C02/C03

La première comparaison a volontairement confronté en une seule assertion le
contenu persistant et les résultats retournés par `applyMessages`. Elle a donné :

- **2 tests en échec**, un par encodage ;
- 53 tests non sélectionnés par le filtre ;
- durée totale : **3,12 s** ;
- aucune différence dans les cinq propriétés persistées comparées : `dataset`,
  `row`, `column`, `value` et `timestamp` ;
- une différence limitée à l'indicateur transitoire `old` : `M1` est ancien
  pour Rule directe / Manual inverse, tandis que `R1` est ancien pour Rule
  inverse / Manual directe.

`old` n'est pas une colonne de `messages_crdt`. Le test définitif compare donc
directement les contenus persistés complets hors `id`, puis vérifie séparément
les deux cartes de résultats `applyMessages`, comprenant explicitement
`dataset`, `row`, `column`, `value`, `timestamp` et `old` pour chaque message.
Cette séparation ne masque pas la différence d'ordre d'arrivée.

Après cette qualification, l'exécution ciblée de C01, C02 et C03 réussit :
**4/4 tests réussis**, 51 tests non sélectionnés, durée totale **5,46 s**.

## Résultats dynamiques observés

### Convergence des deux cellules

Pour les 24 permutations de C01 et pour les partitions de C02, C03 et C11 :

- `manual_budget_period` converge vers sa valeur au HULC maximal ;
- `rule_assignment` converge indépendamment vers son composite au HULC
  maximal ;
- l'état SQLite brut, la projection effective et les timestamps gagnants sont
  identiques ;
- les lignes pertinentes de `messages_crdt` sont identiques après convergence ;
- une Manual non nulle reste effective, même lorsque le HULC gagnant de Rule
  est globalement supérieur.

C02 et C03 comparent directement les cinq propriétés persistées de chaque
message, hors identifiant d'insertion. Leurs indicateurs `old` diffèrent comme
attendu selon le message perdant arrivé après son gagnant ; cette information
transitoire est testée séparément et n'altère pas le contenu convergé de
`messages_crdt`.

Le composite Rule gagnant conserve ensemble sa `period` et son `ruleId`. Aucun
mélange entre deux composites Rule n'a été observé.

### Départage HULC par `node`

Les nodes courts `a` et `z` sont sérialisés sur 16 caractères :

```text
000000000000000a
000000000000000z
```

À temps physique et compteur identiques, le timestamp portant le node
normalisé `000000000000000z` gagne dans une même cellule, indépendamment de
l'ordre de livraison. Ce résultat est observé pour :

- deux valeurs Manual ;
- une valeur Manual contre `null`, dans les deux sens ;
- deux composites Rule ;
- une valeur Rule contre `null`, dans les deux sens.

`null` suit donc le même arbitrage LWW qu'une valeur non nulle. Le `node` ne
porte aucune sémantique Manual, Rule, utilisateur ou priorité fonctionnelle.

### Réception, rejeu et historique technique

Le passage par `receiveMessages` avance l'horloge HULC locale. Il ne modifie pas
les timestamps des messages reçus et produit les mêmes gagnants, le même état
SQLite et les mêmes lignes pertinentes de `messages_crdt` que l'application
directe par `applyMessages`.

Le rejeu exact d'un timestamp déjà persisté est filtré et ne crée pas de ligne
supplémentaire. Un message strictement ancien reçu après le gagnant est retourné
avec l'indicateur technique `old: true`, reste présent dans `messages_crdt` et
ne remplace pas la valeur courante.

`messages_crdt` est observé uniquement comme stockage technique de convergence.
Il ne constitue pas un journal d'audit métier.

## Analyse statique complémentaire

Les observations sont cohérentes avec le code existant :

- `Timestamp.toString()` sérialise le temps, le compteur, puis le `node`
  normalisé ;
- `compareMessages` compare ces chaînes par cellule
  `(dataset, row, column)` ;
- `applyMessages` applique et persiste les messages dans une transaction
  SQLite ;
- `receiveMessages` appelle `Timestamp.recv` avant cette application.

Cette lecture explique le résultat, mais les verdicts ci-dessous reposent sur
les tests dynamiques du présent lot, pas sur cette seule analyse statique.

## Contre-exemples

Aucun contre-exemple n'a été observé dans la matrice exécutée. En particulier :

- aucune permutation testée n'a produit des gagnants différents ;
- aucune livraison mixte n'a modifié la priorité effective Manual ;
- aucun conflit par `node` n'a dépendu de l'ordre d'arrivée ;
- aucun composite Rule n'a été déchiré ;
- aucun rejeu exact n'a altéré l'état convergé.

## Validations finales

- POC option D ciblé : **55/55 tests réussis**, 1 fichier, aucun test ignoré
  signalé ; dernière durée totale 10,92 s, dont 8,32 s de tests.
- C01, C02 et C03 ciblés après correction : **4/4 tests réussis**, 51 tests
  non sélectionnés par le filtre.
- POC option D, premier POC CRDT et baseline sync : **74/74 tests réussis**,
  3 fichiers.
- Timestamp et Merkle : **20/20 tests réussis**, 2 fichiers.
- Suite complète `loot-core` : commande officielle réussie sans cache Lage.
  - Node : **1 194 tests réussis et 2 ignorés** ; 78 fichiers réussis et
    1 ignoré.
  - Web : **9/9 tests réussis** ; 2 fichiers réussis.
  - Total : **1 203 tests réussis et 2 ignorés** ; 80 fichiers réussis et
    1 ignoré.
- `oxfmt --check` ciblé sur les deux fichiers du lot : réussi.
- `yarn lint` : réussi.
- `git diff --check` : réussi sans sortie ; le contrôle `--no-index --check` du
  rapport non suivi ne signale aucune erreur whitespace.
- recherche des appels `.skip`, `.todo` et `.only` dans le fichier de test :
  aucun résultat.
- `yarn typecheck` : réussi, y compris le contrôle TypeScript racine. Lage a
  exécuté 6 tâches (`core`, API, Web, CLI, sync-server et desktop-electron) et
  récupéré 4 tâches du cache (`ci-actions`, component-library, CRDT et
  plugins-service) ; aucune tâche en échec, en attente ou abandonnée.

## Limites

- Les tables de probe existent uniquement dans SQLite en mémoire. La durabilité
  disque, WAL, crash et reprise ne sont pas testés.
- Les messages sont exercés dans un seul processus de test. Le serveur réel, le
  chiffrement, les pertes réseau et la synchronisation entre processus ne sont
  pas couverts.
- Les 24 permutations sont exhaustives pour l'ensemble borné
  `R1, R2, M1, M2`, pas pour toute séquence possible de messages.
- Les partitions réseau sont représentatives et non exhaustives.
- `receiveMessages` et `Timestamp.recv` sont exercés, mais pas un cycle complet
  `fullSync` avec serveur distant.
- La table `transactions`, ses vues, ses listeners et ses executors AQL ne sont
  pas modifiés ou testés par ce lot.
- Le texte historique reste une comparaison de POC. ADR-0006 retient toujours
  le JSON canonique.
- Ce lot ne teste ni JSON synchronisé invalide, ni client de version
  différente, ni adaptateur ou consommateur applicatif.
- Il ne traite pas les opérations multi-lignes de splits ou transferts.

## Verdict des gates

### Permutations CRDT élargies

**FERMÉ POUR LE MODÈLE EXPÉRIMENTAL MONO-LIGNE** — les 24 permutations
unitaires, les deux directions mixtes par cellule, les partitions et les rejeux
testés convergent vers les mêmes gagnants, le même état SQLite, la même
projection et le même contenu pertinent de `messages_crdt`.

### Égalité HULC départagée par `node`

**FERMÉ POUR LE MODÈLE EXPÉRIMENTAL MONO-LIGNE** — à temps et compteur égaux,
le `node` normalisé lexicographiquement supérieur gagne de façon déterministe
dans la cellule concernée. Cette règle vaut également lorsque l'un des messages
porte `null`.

Ces verdicts ne transforment pas l'ordre du `node` en priorité métier et ne
garantissent rien entre plusieurs lignes.

## Gates restant ouverts

Restent explicitement ouverts :

- le JSON synchronisé invalide ;
- la distinction entre Rule absente et Rule invalide ;
- les clients de versions différentes ;
- l'adaptateur entre données synchronisées et domaine ;
- la centralisation chez les consommateurs ;
- la migration et le schéma de production ;
- les vrais workflows multi-lignes de splits et transferts ;
- l'API, l'UI et l'activation de la fonctionnalité.

## Gate final

**NOT READY FOR PRODUCTION MIGRATION OR RELEASE** — les deux risques ciblés par
ce lot sont fermés pour le modèle expérimental mono-ligne, mais les gates
critiques de validation des données synchronisées, de compatibilité des clients
et d'intégration applicative restent ouverts. Ce lot n'autorise aucune
migration, activation ou diffusion.
