# ADR-0006 — Affectation de période budgétaire en couches

- Statut : Acceptée
- Date : 2026-09-02
- Amendée le : 09/09/2026
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
  [POC de convergence option D](../spikes/budget-period-option-d-convergence.md),
  [spike Rule stockée invalide](../spikes/budget-period-invalid-rule-assignment.md),
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
`messages_crdt`, une table de probe SQLite en mémoire et le compilateur AQL. Il
démontre, pour les plans de livraison testés, la convergence de deux couches
indépendantes, l'indivisibilité du composite Rule et la faisabilité d'une
projection effective `Manual > Rule > Default`.

Le POC de convergence option D ferme ensuite les permutations bornées et le
départage HULC par `node` pour le modèle expérimental mono-ligne. Le spike Rule
stockée invalide démontre que le type AQL `json` confond un JSON syntaxiquement
invalide avec une absence SQL et que `json/fallback` ne préserve pas la forme
lexicale canonique. Le type AQL `string` conserve en revanche la valeur brute.

Ces preuves autorisent une implémentation expérimentale écrite et validée avant
toute diffusion. Elles ne couvrent pas les clients de versions différentes,
les exécuteurs AQL spécialisés, l'intégration applicative, la migration réelle
ni l'atomicité des splits et transferts.

## Amendement du 09/09/2026

La décision initiale d'ADR-0006 prévoyait d'exposer `rule_assignment` avec le
type AQL `json`. Le spike Rule stockée invalide a démontré dynamiquement, par le
chemin AQL générique `execQuery`, que ce type transforme un JSON syntaxiquement
invalide en `null` et le rend indistinguable d'une Rule réellement absente. Le
type `json/fallback` transforme également un JSON valide non canonique et ne
préserve donc pas sa représentation brute.

La décision est amendée : AQL doit exposer `rule_assignment` comme `string`.
Le stockage SQLite `TEXT NULL` et le contenu JSON canonique d'une valeur valide
restent inchangés. Cet amendement ne prétend pas que `string` faisait partie de
la décision initiale ; il la remplace à partir du 09/09/2026.

## Décision

L'affectation de période budgétaire est représentée par deux propriétés
transaction-locales, nullables et synchronisées séparément. La seconde est lue
sous sa forme physique brute avant tout décodage métier :

```text
manual_budget_period: date-month | null
rule_assignment: string | null

decode(rule_assignment):
  absent
  | valid { period: date-month, ruleId: string }
  | invalid { raw, error }
```

Le contenu valide de `rule_assignment` reste le JSON canonique Budget FR. La
source et la période effective sont dérivées uniquement après validation de
`bankDate`, de Manual et de l'état Rule décodé :

```text
bankDate invalide -> erreur
Manual invalide -> erreur
Manual valide -> Manual, avec diagnostic obligatoire si Rule est invalide
Manual absente + Rule valide -> Rule
Manual absente + Rule absente -> Default dérivé de month(date)
Manual absente + Rule invalide -> erreur sans projection
```

La priorité d'erreur est `bankDate > Manual > Rule`. Une valeur Rule brute non
nulle n'est jamais assimilée à une Rule valide du seul fait de sa présence.

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
11. La suppression Manual révèle la dernière Rule persistée si elle est valide ;
    une Rule invalide bloque la projection et une Rule absente révèle Default.
12. Une valeur Default n'est pas matérialisée : elle suit immédiatement
    `month(date)`.
13. Une valeur Rule invalide ne devient jamais `null` ou Default implicitement.
14. La valeur Rule brute ne doit jamais être journalisée automatiquement.

Le spike constate uniquement l'absence de cette journalisation dans le module
de domaine expérimental. Aucun consommateur ou adaptateur applicatif n'est
branché : aucune garantie globale de journalisation n'est donc démontrée. Ce
point devra être vérifié lors de l'intégration applicative.

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

Aucun consommateur ne doit lire ou parser directement `rule_assignment`, ni
utiliser sa propriété `period` sans passer par l'adaptateur discriminé puis par
la priorité Manual. Les tests de production devront empêcher le contournement
de cette abstraction.

## Représentation SQLite et AQL

### SQLite envisagé

| Colonne                | Type SQLite    | Valeur physique                               |
| ---------------------- | -------------- | --------------------------------------------- |
| `manual_budget_period` | `INTEGER NULL` | `YYYYMM` ou `NULL`                            |
| `rule_assignment`      | `TEXT NULL`    | JSON canonique `{ period, ruleId }` ou `NULL` |

`manual_budget_period` réutilise la représentation physique du type AQL
`date-month`. `rule_assignment` est stocké dans une seule colonne `TEXT` afin
de rester une cellule CRDT indivisible.

Aucune colonne de source dérivée n'est ajoutée. Aucun jour fictif, clé
étrangère vers une règle ou journal d'audit n'est introduit par cette décision.

### AQL envisagé

- `manual_budget_period` est exposé en `date-month` ;
- `rule_assignment` est exposé sous sa forme brute en `string` ;
- les types `json` et `json/fallback` sont interdits pour cette cellule ;
- le décodage métier produit obligatoirement `absent`, `valid` ou `invalid` ;
- une vue transaction, un filtre, un tri ou une agrégation ne peut exposer une
  période effective qu'après cette validation complète.

Le chemin générique `execQuery` est le seul chemin AQL validé dynamiquement par
le spike. Les exécuteurs AQL spécialisés des transactions et
`db.selectWithSchema` ont uniquement été inspectés statiquement et restent à
tester avant intégration.

La projection SQL directe utilisant `json_extract`, une expression `COALESCE`
fondée sur la Rule brute ou un index construit sur cette projection est
reportée. Aucune de ces constructions n'est considérée sûre tant que l'état
discriminé et sa politique d'erreur ne sont pas intégrés dans les vrais chemins
de lecture.

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
par le CRDT, ni par SQLite, ni par le type AQL `string`, qui préserve la valeur
brute sans la valider.

Un encodeur et un validateur métier centralisés sont obligatoires avant toute
écriture locale. Une écriture AQL générique ne suffit pas à faire respecter le
contrat.

L'adaptateur discriminé existe dans le module de domaine expérimental. Il n'est
ni réexporté ni branché sur l'application. Une valeur synchronisée invalide est
conservée avec son erreur de décodage : elle n'est ni transformée en `null` ou
Default, ni réparée ou effacée automatiquement. Une Manual valide reste
effective avec un diagnostic obligatoire ; sans Manual, l'erreur bloque toute
projection.

La récupération nécessite une écriture CRDT plus récente contenant soit une
Rule canonique, soit un `null` explicite. La valeur brute ne doit pas être
journalisée automatiquement. La présentation du diagnostic, la quarantaine
éventuelle et la procédure applicative de resynchronisation restent à définir.

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

Le POC de convergence option D démontre dynamiquement les permutations bornées,
les livraisons mixtes et le départage d'horodatages HULC de même temps physique
et compteur par `node`, pour le modèle expérimental mono-ligne couvert. Ces
propriétés doivent rester protégées par des tests de non-régression ; elles ne
démontrent ni la compatibilité entre versions de clients, ni l'atomicité de
plusieurs lignes.

Le spike Rule stockée invalide démontre dynamiquement, avec une table de probe
SQLite en mémoire, `receiveMessages`, `applyMessages` et `messages_crdt` : une
chaîne invalide reçue par synchronisation reste persistée telle quelle dans la
table et dans l'état CRDT. Elle n'est ni réparée ni effacée automatiquement.
Seule une écriture CRDT plus récente contenant une Rule canonique ou un `null`
explicite permet la récupération.

Cette table représente une cellule synchronisée générique ; elle n'est pas la
vraie table `transactions` et ne démontre pas le comportement de la persistance
applicative réelle, des vues, des listeners, des exécuteurs AQL spécialisés ou
de `db.selectWithSchema`. Ces limites ne réduisent pas les observations directes
obtenues par le chemin générique `execQuery`, `receiveMessages`,
`applyMessages` et `messages_crdt`.

`messages_crdt` contient l'état technique nécessaire à la convergence. Il ne
contient pas l'acteur, le motif ou le commentaire exigés d'un journal d'audit
métier et ne doit jamais être présenté comme tel. La valeur brute invalide ne
doit pas non plus être journalisée automatiquement.

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
3. enregistrer `manual_budget_period` en `date-month` et `rule_assignment` en
   `string` dans le schéma AQL ;
4. recréer les vues transaction selon le mécanisme Actual ;
5. laisser toutes les anciennes transactions dans l'état Default dérivé ;
6. vérifier l'ouverture et la réouverture d'une base antérieure ;
7. exiger un backup avant l'ouverture par la nouvelle version.

Aucun index initial, aucune contrainte `NOT NULL` et aucun backfill ne sont
prévus. La validation métier ne doit toutefois pas être confondue avec
l'absence de contrainte SQLite. La projection SQL réelle, les vues qui
l'exposeraient et tout index associé restent reportés jusqu'à l'intégration et
la validation du décodage discriminé.

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
- Une Rule brute invalide reste distinguable d'une Rule absente et ne peut pas
  produire silencieusement un faux Default.

### Coûts et limitations

- Tous les consommateurs doivent adopter une projection centralisée.
- L'encodeur, le décodeur discriminé et la projection existent uniquement dans
  le module de domaine expérimental, non réexporté et non branché sur
  l'application.
- Deux cellules signifient qu'un reset distribué expose des états
  intermédiaires.
- La récupération CRDT d'une Rule invalide est démontrée dans le modèle
  expérimental, mais sa présentation et son traitement applicatifs ne le sont
  pas.
- Les clients de versions différentes n'ont pas de stratégie de compatibilité
  validée.
- Les exécuteurs AQL spécialisés des transactions et `db.selectWithSchema`
  n'ont été qu'inspectés statiquement.
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

### Exposition AQL `json` ou `json/fallback`

Rejetée par l'amendement du 09/09/2026 : `json` transforme un JSON
syntaxiquement invalide en `null`, tandis que `json/fallback` ne préserve pas
la représentation brute de toute valeur valide non canonique. Le contenu
métier valide reste du JSON canonique, mais son transport AQL doit être une
`string` décodée par l'adaptateur discriminé Budget FR.

## Risques et décisions ouvertes

| Risque ou décision ouverte                        | Niveau   | Gate avant production                              |
| ------------------------------------------------- | -------- | -------------------------------------------------- |
| Adaptateur non branché sur l'application          | Critique | Intégrer sans contournement de l'état discriminé   |
| Exécuteurs AQL spécialisés non testés             | Critique | Tester transactions et `db.selectWithSchema`       |
| Ancien client recevant une colonne inconnue       | Critique | Définir compatibilité et procédure clients mixtes  |
| Consommateur ou agrégation contournant Manual     | Critique | Centraliser et tester `effectiveBudgetPeriod`      |
| Migration, ancienne base ou restauration          | Élevé    | Tester migration, backup et restauration           |
| Vue ou index fondé sur une projection non validée | Élevé    | Concevoir, tester et mesurer les chemins SQL réels |
| Divergence de lignes d'un split ou transfert      | Élevé    | Décider et tester une stratégie multi-lignes       |
| Snapshot lié à une règle supprimée mal expliqué   | Moyen    | Définir le contrat API/UI de provenance            |

La distinction de domaine Rule absente, valide ou invalide, les permutations
CRDT bornées et le départage HULC par `node` sont fermés uniquement dans le
modèle expérimental mono-ligne couvert. L'intégration applicative, les chemins
AQL spécialisés, les clients mixtes, les consommateurs, la migration, les vues
et index réels ainsi que les opérations multi-lignes restent à décider et à
démontrer avant la migration de production.

## Tests obligatoires avant production

### CRDT et synchronisation

- conserver en non-régression les permutations bornées, les livraisons mixtes,
  le départage HULC par `node`, les scénarios Rule/Manual, deux Rule, deux
  Manual, suppressions, resets concurrents et rejeu idempotent ;
- conserver la preuve qu'une Rule synchronisée invalide reste persistée, ne
  devient jamais Default et n'est récupérée que par une écriture plus récente ;
- reproduire un client ancien, sa mise à jour et la reprise de synchronisation.

### Domaine et consommateurs

- conserver les tests Default, Rule, Manual, Rule absente/valide/invalide et la
  suppression Manual révélant Rule ou son erreur ;
- intégrer l'adaptateur discriminé sans le contourner ;
- tester chaque famille de consommateurs contre un contournement de Manual ;
- tester le maintien de `date` pour soldes, trésorerie et forecast journalier ;
- tester la période effective pour budgets et prévisions budgétaires ;
- tester la suppression/désactivation d'une règle sans réécriture rétroactive ;
- tester une réévaluation qui ne modifie que Rule ;
- tester import, réimport et rapprochement sans écrasement de Manual.

### JSON, SQLite, AQL et migration

- conserver les tests de rejet des clés manquantes ou supplémentaires, période
  invalide, `ruleId` vide et sérialisation non canonique ;
- tester dynamiquement les exécuteurs AQL spécialisés des transactions et
  `db.selectWithSchema` avec les trois états discriminés ;
- vérifier lecture, écriture, filtre, tri et agrégation AQL de la projection
  après intégration de la validation ;
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
propriétés CRDT/HULC bornées, la distinction Rule absente/valide/invalide et la
faisabilité du transport AQL brut pour le modèle expérimental mono-ligne. Ils
ne démontrent pas encore l'intégration applicative ni les chemins AQL
spécialisés.

L'implémentation expérimentale autorisée peut inclure :

- des tests de production écrits d'abord ;
- la projection effective centralisée ;
- le validateur et l'encodeur JSON ;
- des prototypes de migration sur fixtures ;
- l'intégration expérimentale de l'adaptateur discriminé ;
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

- l'intégration de l'adaptateur discriminé dans les chemins applicatifs ;
- la validation dynamique des exécuteurs AQL spécialisés des transactions et
  de `db.selectWithSchema` ;
- le contrat centralisé `effectiveBudgetPeriod` et les tests de consommateurs ;
- la stratégie de compatibilité des clients de versions différentes ;
- la conception et la validation de la migration réelle, y compris anciennes
  bases, backup et restauration ;
- la conception et la validation des vues et index réels ;
- les splits et transferts multi-lignes.

La spécification fonctionnelle reste compatible avec cette décision : elle
décrit les résultats métier sans imposer le transport AQL. Le présent
amendement et `architecture.md` portent le changement technique nécessaire.
