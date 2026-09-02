# ADR-0006 — Affectation de période budgétaire en couches

- Statut : Acceptée
- Date : 2026-09-02
- Décideurs : équipe Budget FR
- Portée : phase Budget Period du MVP Budget FR dans Actual Budget
- Supersède :
  [ADR-0002 — Persistance de la période budgétaire](./0002-budget-period-persistence.md),
  pour sa décision de persistance et toutes les sémantiques d'affectation qui
  en dépendent, notamment les politiques Rule/Manual/Default et les
  comportements splits/transferts précédemment décidés
- Références :
  [premier POC CRDT](../spikes/budget-period-crdt.md),
  [POC option D](../spikes/budget-period-option-d.md),
  [spécification fonctionnelle](../functional-spec.md),
  [architecture Budget FR](../architecture.md)

## Contexte

Budget FR doit affecter une transaction à une période budgétaire distincte de
sa date bancaire, sans modifier le fait bancaire. Une correction manuelle doit
toujours rester prioritaire sur une règle automatique, y compris lorsque les
deux écritures sont concurrentes et synchronisées entre appareils.

ADR-0002 retenait trois propriétés synchronisées indépendantes :
`budget_period`, `budget_period_source` et `budget_period_rule_id`. Le premier
POC CRDT a démontré que `batchMessages` les applique atomiquement dans la
transaction SQLite locale, mais qu'elles restent trois cellules de conflit
indépendantes. Après synchronisation concurrente, elles peuvent converger vers
un tuple déchiré ou vers un tuple de forme valide dont les valeurs proviennent
de décisions différentes.

Une colonne composite unique empêche ce déchirement, mais son LWW simple permet
encore à une Rule plus récente de remplacer une Manual. Une réparation a
posteriori des trois colonnes ne distingue pas un état définitivement invalide
d'une livraison partielle et peut supprimer une correction Manual légitime.

Le second POC a exercé l'option D avec les vrais mécanismes `db.update`,
`sendMessages`, `batchMessages`, `applyMessages`, les timestamps HULC,
`messages_crdt`, SQLite et le compilateur AQL. Il démontre, pour les plans de
livraison testés, la convergence de deux couches indépendantes, l'indivisibilité
du composite Rule et la faisabilité d'une projection effective
`Manual > Rule > Default`.

Ces preuves autorisent une implémentation expérimentale écrite et validée avant
toute diffusion. Elles ne couvrent pas encore toutes les permutations réseau,
les clients de versions différentes, la migration réelle ni l'atomicité des
splits et transferts. Les divergences actuelles de `functional-spec.md` doivent
être corrigées avant l'implémentation fonctionnelle.

## Décision

L'affectation de période budgétaire est représentée par deux propriétés
transaction-locales, nullables et synchronisées séparément :

```text
manual_budget_period: date-month | null
rule_assignment: { period: date-month, ruleId: string } | null
```

La source et la période effective sont dérivées :

```text
source =
  manual si manual_budget_period != null
  sinon rule si rule_assignment != null
  sinon default

effectiveBudgetPeriod =
  manual_budget_period
  sinon rule_assignment.period
  sinon month(date)
```

`manual_budget_period` et `rule_assignment` sont deux cellules CRDT LWW
indépendantes. Le composite Rule est une seule cellule : sa période et son
`ruleId` gagnent, sont rejoués ou sont supprimés ensemble.

Le CRDT résout uniquement le conflit interne à chaque cellule. Il ne connaît
pas la priorité `Manual > Rule > Default`. Cette priorité est un invariant
métier appliqué par la projection effective après lecture des deux cellules.

La source n'est jamais persistée. Elle peut être exposée comme valeur dérivée
`manual`, `rule` ou `default`, mais aucune colonne `budget_period_source` n'est
créée. `ruleId` reste dans le composite Rule afin de préserver l'unité de
conflit et d'expliquer la règle ayant produit l'affectation courante.

## Modèle logique et invariants

### Date bancaire

1. `date` reste la date bancaire originale.
2. Aucune action Budget FR ne déplace `date` pour obtenir un résultat
   budgétaire.
3. Les soldes de compte, la trésorerie et le forecast journalier continuent
   d'utiliser `date`.
4. Les budgets et prévisions budgétaires utilisent
   `effectiveBudgetPeriod`.

### Priorité et cellules

5. Une Manual non nulle est toujours la période effective, quelle que soit la
   valeur ou l'horodatage de Rule.
6. Une Rule ne concurrence jamais directement Manual : elle ne peut écrire que
   `rule_assignment`.
7. Un import ou un réimport ne peut jamais écrire
   `manual_budget_period`.
8. Deux Manual concurrentes sont départagées par le LWW de la cellule Manual.
9. Deux Rule concurrentes sont départagées par le LWW du composite Rule.
10. Une suppression est une valeur `null` soumise au même LWW que les valeurs
    non nulles de sa cellule.
11. La suppression Manual révèle la dernière Rule persistée ; si Rule est
    également nulle, elle révèle Default.
12. Une valeur Default n'est pas matérialisée : elle suit immédiatement
    `month(date)`.

### Projection effective obligatoire

Une fonction ou abstraction de domaine unique doit centraliser la projection.
Tous les consommateurs d'une période budgétaire doivent obligatoirement
l'utiliser :

- budgets ;
- filtres ;
- tris ;
- agrégations ;
- API ;
- UI ;
- exports ;
- règles ;
- prévisions budgétaires.

Aucun consommateur ne doit lire `rule_assignment.period` comme période
effective sans vérifier d'abord `manual_budget_period`. Les tests de production
devront empêcher le contournement de cette abstraction.

## Représentation SQLite et AQL

### SQLite envisagé

| Colonne                | Type SQLite | Valeur physique                               |
| ---------------------- | ----------- | --------------------------------------------- |
| `manual_budget_period` | `INTEGER`   | `YYYYMM` ou `NULL`                            |
| `rule_assignment`      | `TEXT`      | JSON canonique `{ period, ruleId }` ou `NULL` |

`manual_budget_period` réutilise la représentation physique du type AQL
`date-month`. `rule_assignment` est stocké dans une seule colonne `TEXT` afin
de rester une cellule CRDT indivisible.

Aucune colonne de source dérivée n'est ajoutée. Aucun jour fictif, clé
étrangère vers une règle ou journal d'audit n'est introduit par cette décision.

### AQL envisagé

- `manual_budget_period` est exposé en `date-month` ;
- `rule_assignment` est exposé en `json` ;
- la vue transaction expose une source et une période effective dérivées ;
- lecture, écriture, filtre, tri et agrégation utilisent les conversions AQL
  existantes et la projection complète ;
- le convertisseur AQL `json` sérialise et désérialise, mais ne valide pas la
  forme métier du composite.

La projection SQLite conceptuelle est :

```text
COALESCE(
  manual_budget_period,
  period extraite de rule_assignment,
  date / 100
)
```

Le POC démontre que SQLite peut utiliser un index sur l'expression exacte pour
les représentations testées. Il ne démontre aucun gain de performance. Aucun
index n'est donc décidé avant une mesure sur une base représentative.

## JSON canonique

La représentation recommandée de `rule_assignment` est un JSON canonique :

```text
{"period":"2024-10","ruleId":"rule-1"}
```

Cette forme compacte exacte est la représentation canonique décidée.
L'encodeur de domaine doit produire exactement les clés `period`, puis
`ruleId`, sans espace et sans clé supplémentaire. Le validateur doit refuser :

- un JSON invalide ou une valeur qui n'est pas un objet ;
- une clé absente ou supplémentaire ;
- une période qui n'utilise pas strictement `YYYY-MM` ;
- un mois hors de `01` à `12` ;
- un `ruleId` vide ;
- une sérialisation qui ne respecte pas la forme canonique décidée.

L'ordre des clés est une politique d'encodage Budget FR. Il n'est imposé ni
par le CRDT, ni par SQLite, ni par le type AQL `json`.

Un encodeur et un validateur métier centralisés sont obligatoires avant toute
écriture locale. Une écriture AQL générique ne suffit pas à faire respecter le
contrat.

Une valeur synchronisée invalide ne doit jamais être interprétée
silencieusement comme Default. Elle doit être détectée et produire un état
d'erreur explicite. La frontière exacte de détection ainsi que la politique de
rejet, de quarantaine, de récupération et de resynchronisation restent à
décider avant toute migration, activation ou livraison en production.

## Politiques produit

### Cycle de vie des règles

Une affectation Rule est un snapshot de la décision produite. La suppression ou
la désactivation ultérieure de la règle source ne modifie pas rétroactivement
les `rule_assignment` existantes.

Une réévaluation explicite des règles peut remplacer ou effacer uniquement
`rule_assignment`. Elle ne modifie jamais `manual_budget_period`, y compris
lorsque la nouvelle Rule resterait masquée par une Manual non nulle.

Le `ruleId` du snapshot peut donc désigner une règle désactivée ou tombstonée.
Il explique l'origine de l'affectation courante, mais n'est ni une clé
étrangère de cycle de vie ni un historique complet.

### Imports et réimports

Un import peut créer une transaction en Default puis déclencher les règles
autorisées à écrire `rule_assignment`. Un import, un réimport, un rapprochement
ou un apprentissage de règle ne touche jamais `manual_budget_period`.

La détection des doublons et l'idempotence des imports restent inchangées. Une
mise à jour de la date bancaire recalcule uniquement le Default dérivé ; elle
ne réécrit ni Manual ni Rule.

### Suppression Manual et retour à Default

Effacer une correction Manual écrit `manual_budget_period = null`. Cette
opération révèle la dernière Rule persistée sans la recalculer. Si Rule est
nulle, la période effective redevient `month(date)`.

Le reset complet écrit :

```text
manual_budget_period = null
rule_assignment = null
```

Ces deux écritures sont regroupées par `batchMessages`. Leur application est
atomique dans la transaction SQLite locale, mais le protocole CRDT ne conserve
aucune frontière de batch durable entre appareils.

Les états intermédiaires sont acceptés : un appareil peut voir temporairement
Rule après la suppression Manual, ou Manual après la suppression Rule. La
convergence finale est déterminée séparément par le gagnant LWW de chaque
cellule. Une écriture concurrente plus récente peut donc survivre au reset dans
sa cellule.

## Stratégie de synchronisation

Les deux colonnes utilisent le mécanisme CRDT générique existant. Cette
décision n'autorise aucune modification de :

- `packages/crdt/src/proto/sync.proto` ;
- la persistance du sync-server ;
- `SYNC_FORMAT_VERSION`.

Les clients utilisant un même budget doivent disposer du schéma qui connaît
les deux colonnes avant l'activation de la fonctionnalité. Comme ADR-0002, cette
décision ne garantit pas la coexistence avec un ancien client recevant une
colonne inconnue.

Le POC démontre la convergence pour quatre plans de livraison représentatifs,
pas pour toutes les permutations possibles. Il ne couvre pas une livraison
mixte, inverse dans une cellule et directe dans l'autre, ni une égalité du temps
physique et du compteur HULC départagée par `node`.

`messages_crdt` contient l'état technique nécessaire à la convergence. Il ne
contient pas l'acteur, le motif ou le commentaire exigés d'un journal d'audit
métier et ne doit jamais être présenté comme tel.

## Splits et transferts

L'option D garantit la cohérence d'une affectation sur une ligne. Elle ne rend
pas atomique un ensemble de lignes représentant un split ou les deux côtés
d'un transfert.

Les POC montrent qu'une ligne peut déjà afficher Manual tandis qu'une autre
affiche encore Rule. Ils ne testent pas les vrais workflows Actual de création,
d'édition, de suppression ou de synchronisation de splits et transferts.

La politique de propagation et de récupération multi-lignes constitue un gate
d'architecture séparé avant la production. Cette ADR ne prétend pas le
résoudre.

## Migration envisagée

La future migration sera additive, nullable et sans backfill :

1. ajouter `manual_budget_period INTEGER NULL` à `transactions` ;
2. ajouter `rule_assignment TEXT NULL` à `transactions` ;
3. enregistrer leurs types dans le schéma AQL ;
4. recréer les vues transaction selon le mécanisme Actual ;
5. laisser toutes les anciennes transactions dans l'état Default dérivé ;
6. vérifier l'ouverture et la réouverture d'une base antérieure ;
7. exiger un backup avant l'ouverture par la nouvelle version.

Aucun index initial, aucune contrainte `NOT NULL` et aucun backfill ne sont
prévus. La validation métier ne doit toutefois pas être confondue avec
l'absence de contrainte SQLite.

Cette ADR ne crée pas la migration et n'en fixe pas encore le numéro ou le
patch exact. La stratégie réelle doit être revue avec les vues, les types DB,
les backups, la restauration et la compatibilité des clients avant toute
diffusion.

La décision à trois colonnes d'ADR-0002 n'a pas vocation à être déployée en
parallèle. Toute base expérimentale qui contiendrait déjà ces colonnes doit être
inventoriée séparément ; aucune conversion destructive ou perte de provenance
n'est présumée par cette ADR.

## Conséquences

### Conséquences positives

- Manual ne peut pas être masquée par une écriture Rule dans une autre
  cellule.
- La période et l'identifiant Rule forment une unité de conflit indivisible.
- Default suit naturellement une correction de date bancaire sans backfill.
- La source est cohérente par construction avec la couche effective.
- La solution reste transaction-locale et réutilise SQLite, AQL et le CRDT
  générique d'Actual.

### Coûts et limitations

- Tous les consommateurs doivent adopter une projection centralisée.
- Le JSON nécessite un encodeur et une validation métier qui n'existent pas
  encore en production.
- Deux cellules signifient qu'un reset distribué expose des états
  intermédiaires.
- Les clients de versions différentes et les messages invalides n'ont pas de
  stratégie de récupération validée.
- Les splits et transferts restent des opérations multi-lignes non atomiques.
- Un snapshot Rule conservé après suppression de sa règle peut demander une
  explication spécifique dans l'UI et l'API.
- Aucun résultat du POC ne constitue une mesure de durabilité ou de
  performance.

## Alternatives rejetées

### Trois colonnes indépendantes

Rejetées : leur application locale peut être regroupée, mais elles restent
trois unités de conflit et peuvent converger vers un tuple métier déchiré.

### Affectation complète dans une seule cellule

Rejetée : le composite est indivisible, mais une Rule plus récente peut gagner
contre Manual par LWW simple.

### Validation et réparation des trois colonnes

Rejetées : une réparation ne connaît pas les frontières de batch distantes,
peut effacer une Manual en cours de livraison et ne détecte pas tous les
mélanges sémantiques.

### Texte canonique

Le texte canonique testé est techniquement viable et conserve l'unité de
conflit. JSON est retenu comme recommandation parce qu'Actual possède déjà un
type AQL `json`, que SQLite JSON1 permet l'extraction et que la lecture AQL
reste structurée. Cette recommandation reste conditionnée à l'encodeur et au
validateur métier centralisés.

## Risques et décisions ouvertes

| Risque ou décision ouverte                      | Niveau   | Gate avant production                                |
| ----------------------------------------------- | -------- | ---------------------------------------------------- |
| JSON synchronisé invalide                       | Critique | Définir détection, rejet/quarantaine et récupération |
| Ancien client recevant une colonne inconnue     | Critique | Définir compatibilité et procédure clients mixtes    |
| Consommateur contournant Manual                 | Critique | Centraliser et tester `effectiveBudgetPeriod`        |
| Migration ou vues partiellement appliquées      | Élevé    | Concevoir et tester la migration réelle              |
| Permutation CRDT ou égalité HULC non testée     | Élevé    | Élargir la matrice et tester le départage par `node` |
| Divergence de lignes d'un split ou transfert    | Élevé    | Décider et tester une stratégie multi-lignes         |
| Snapshot lié à une règle supprimée mal expliqué | Moyen    | Définir le contrat API/UI de provenance              |
| Index d'expression coûteux ou inutile           | Moyen    | Mesurer avant toute création                         |

Les politiques ouvertes de synchronisation invalide, de clients mixtes et de
multi-lignes ne sont pas fermées par cette ADR. Elles doivent être décidées et
démontrées avant la migration de production.

## Tests obligatoires avant production

### CRDT et synchronisation

- étendre la matrice de permutations de livraison ;
- couvrir une livraison inverse dans une cellule et directe dans l'autre ;
- couvrir l'égalité du temps et du compteur HULC départagée par `node` ;
- conserver les scénarios Rule/Manual, deux Rule, deux Manual, suppressions,
  resets concurrents et rejeu idempotent ;
- exercer le comportement choisi pour un JSON synchronisé invalide ;
- reproduire un client ancien, sa mise à jour et la reprise de synchronisation.

### Domaine et consommateurs

- tester Default, Rule, Manual et la suppression Manual révélant Rule ;
- tester chaque famille de consommateurs contre un contournement de Manual ;
- tester le maintien de `date` pour soldes, trésorerie et forecast journalier ;
- tester la période effective pour budgets et prévisions budgétaires ;
- tester la suppression/désactivation d'une règle sans réécriture rétroactive ;
- tester une réévaluation qui ne modifie que Rule ;
- tester import, réimport et rapprochement sans écrasement de Manual.

### JSON, SQLite, AQL et migration

- rejeter clés manquantes ou supplémentaires, période invalide, `ruleId` vide
  et sérialisation non canonique ;
- vérifier lecture, écriture, filtre, tri et agrégation AQL de la projection ;
- ouvrir puis rouvrir une base antérieure à la migration ;
- vérifier vues, backup, restauration et synchronisation après migration ;
- mesurer avant de décider un index d'expression.

### Splits et transferts

- exercer les vrais workflows de création, édition et suppression de splits ;
- exercer la création et la mise à jour des deux côtés d'un transfert ;
- vérifier les livraisons concurrentes et les états partiels ;
- conserver l'exclusion des transferts du résultat consolidé.

## Gates

### ADR-0006

**ACCEPTÉE** — la décision de persistance en deux cellules indépendantes, le
composite Rule indivisible, la source dérivée et la projection effective
normative remplacent la décision de persistance à trois colonnes et toutes les
sémantiques d'affectation dépendantes d'ADR-0002.

### Architecture option D

**READY FOR EXPERIMENTAL / TEST-FIRST IMPLEMENTATION** — les POC démontrent les
propriétés CRDT nécessaires et la faisabilité SQLite/AQL pour les plans testés.

L'implémentation expérimentale autorisée peut inclure :

- des tests de production écrits d'abord ;
- la projection effective centralisée ;
- le validateur et l'encodeur JSON ;
- des prototypes de migration sur fixtures ;
- le traitement expérimental des messages invalides ;
- les tests réels des splits et transferts ;
- les tests de compatibilité.

Elle n'autorise pas :

- la migration de données utilisateur ;
- l'activation de la feature ;
- la diffusion à des clients ;
- le déploiement en production.

### Migration, activation et livraison en production

**NOT READY FOR PRODUCTION MIGRATION OR RELEASE** — la migration, l'activation
et la livraison en production restent bloquées par :

- la validation et la récupération des JSON synchronisés invalides ;
- la matrice CRDT élargie et l'égalité HULC départagée par `node` ;
- le contrat centralisé `effectiveBudgetPeriod` et les tests de consommateurs ;
- la stratégie de compatibilité des clients de versions différentes ;
- la conception et la validation de la migration réelle ;
- les splits et transferts multi-lignes ;
- le réalignement d'`architecture.md` et de `functional-spec.md` avec cette
  décision.

Ces documents de cadrage ne sont pas modifiés par cette ADR. Leur réalignement
est obligatoire avant l'implémentation fonctionnelle. Il ne fait pas obstacle
aux travaux expérimentaux autorisés ci-dessus.
