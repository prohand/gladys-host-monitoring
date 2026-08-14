# Supervision hôte

Cette intégration crée **un appareil** dans Gladys, qui représente la machine
sur laquelle Gladys tourne, avec cinq capteurs :

| Capteur             | Unité | Source                             |
| ------------------- | ----- | ---------------------------------- |
| Utilisation CPU     | %     | `/proc/stat`                       |
| Utilisation mémoire | %     | `/proc/meminfo` (`MemAvailable`)   |
| Utilisation disque  | %     | `statfs()` sur le chemin surveillé |
| Espace disque libre | Gio   | `statfs()` sur le chemin surveillé |
| Température CPU     | °C    | `/sys/class/thermal` ou `hwmon`    |

Tout est lu **localement**, sur la machine : aucun agent à installer, aucun
service cloud, aucune donnée qui sort de chez vous.

## Installation

1. Installez l'intégration depuis le catalogue Gladys.
2. Ouvrez l'onglet **Configuration** et enregistrez (les valeurs par défaut
   conviennent dans la grande majorité des cas).
3. Allez dans l'onglet **Découverte** : l'appareil « Machine hôte » apparaît,
   cliquez sur **Ajouter**.

Les premières valeurs sont publiées dans les secondes qui suivent, puis toutes
les 5 minutes.

## Fréquence de rafraîchissement et taille de la base

C'est le point important de cette intégration. Gladys **écrit une ligne
d'historique pour chaque valeur publiée** : il n'y a pas de déduplication côté
serveur. Un moniteur système qui publie 5 métriques toutes les 30 secondes
écrit environ **5 millions de lignes par an**, dont l'immense majorité répète la
valeur précédente. Sur un Raspberry Pi avec une carte SD, cela se paie en place
disque et en usure.

Trois garde-fous, réglables dans l'écran de configuration :

- **Intervalle de rafraîchissement** (300 s par défaut, minimum 60 s) — à quelle
  fréquence les métriques sont lues. L'intégration gère son propre minuteur :
  elle n'utilise pas le planificateur de Gladys, qui ne descend pas en dessous
  d'une lecture par minute.
- **Variation minimale** (2 points de % / 1 °C par défaut) — une valeur n'est
  publiée que si elle a bougé d'au moins ce seuil depuis la **dernière valeur
  publiée**. Une dérive lente finit donc toujours par franchir le seuil, mais le
  bruit de fond ne remplit plus la base. Mettez 0 pour tout publier.
- **Intervalle maximum sans point** (60 min par défaut) — même si rien ne bouge,
  chaque capteur est publié au moins une fois par heure, pour que les courbes
  restent continues.

Avec les réglages par défaut, une machine calme écrit typiquement **quelques
dizaines de lignes par jour** au lieu de plusieurs dizaines de milliers.

L'option **Conserver l'historique** permet d'aller plus loin : décochée, les
capteurs affichent toujours leur valeur en direct mais n'écrivent plus aucune
ligne d'historique. Attention, ce réglage est appliqué **à la création de
l'appareil** ; si l'appareil existe déjà, changez l'option directement sur la
fiche de l'appareil dans Gladys (chaque capteur y a sa case « conserver
l'historique »).

## Espace disque : quel disque est mesuré ?

Un conteneur ne voit pas le système de fichiers de l'hôte, il voit le sien. Le
chemin par défaut `/data` est le **volume monté par Gladys depuis l'hôte** :
c'est le système de fichiers qui héberge vos données Gladys, donc celui dont
l'espace libre vous intéresse en pratique.

Pour surveiller un autre point de montage, renseignez son chemin dans
**Chemin du disque à surveiller** — à condition qu'il soit visible depuis le
conteneur.

Le pourcentage est calculé comme celui de la commande `df` : les blocs réservés
à root sont exclus, un disque ext4 fraîchement formaté affiche donc bien 0 % et
non 5 %.

## Température du CPU

La sonde est **détectée automatiquement** parmi celles exposées par le noyau
dans `/sys/class/thermal` (Raspberry Pi et cartes ARM) et `/sys/class/hwmon`
(`coretemp` sur Intel, `k10temp` sur AMD…). Les sondes dont le nom désigne
clairement le CPU sont préférées.

Si votre machine n'expose aucune sonde (machine virtuelle, conteneur LXC, hôte
non Linux), le capteur de température **n'est simplement pas créé** : les quatre
autres fonctionnent normalement.

Si la sonde choisie n'est pas la bonne, utilisez le bouton **Lister les sondes
de température** : il affiche toutes les sondes visibles avec leur valeur
actuelle, et marque d'un `>` celle utilisée. Copiez le chemin qui vous convient
dans **Sonde de température CPU**.

## Actions disponibles

- **Lire les métriques maintenant** — lit tout immédiatement et affiche le
  résultat sous le bouton, sans attendre le prochain rafraîchissement. C'est le
  test à faire en premier si une valeur vous semble fausse.
- **Lister les sondes de température** — voir ci-dessus.

## Dépannage

**Aucune valeur ne remonte.** Vérifiez que l'appareil a bien été ajouté depuis
l'onglet Découverte : tant qu'il n'est pas créé, Gladys ignore silencieusement
les états publiés.

**L'appareil affiche « Pas de valeur récente ».** Ce badge apparaît quand aucun
état n'a été enregistré depuis 48 heures — donc, en pratique, jamais. Utilisez
l'action **Lire les métriques maintenant** : elle termine par « N état(s)
publié(s) ». Si N vaut au moins 1, l'intégration publie bien, et le problème est
l'appariement des fonctionnalités décrit juste en dessous.

**L'appareil a été créé par une version plus ancienne.** Gladys ne met jamais à
jour les fonctionnalités d'un appareil déjà créé : republier l'appareil ne
rafraîchit que la fiche de l'écran Découverte. Un appareil créé avec d'anciens
identifiants garde donc ces identifiants, et les états publiés pour les nouveaux
sont jetés sans erreur visible (le serveur Gladys journalise `DeviceFeature
"..." not found (or not added to Gladys), skipping state update.`).
L'intégration détecte ce cas au démarrage et l'affiche dans l'écran de
configuration. **Le seul remède est de supprimer l'appareil dans Gladys puis de
le rajouter depuis l'écran Découverte.** C'est également la marche à suivre pour
appliquer un changement de l'option **Conserver l'historique**, ou pour faire
apparaître la température sur un appareil créé avant la détection de la sonde.

**La température est absente.** C'est normal sur une VM. Utilisez l'action
**Lister les sondes de température** pour confirmer que le noyau n'en expose
aucune.

**Les courbes sont en escalier.** C'est le comportement attendu : entre deux
points publiés, la valeur n'a pas bougé de plus que le seuil. Baissez la
**variation minimale** si vous voulez plus de détail — au prix d'une base plus
grosse.

**Les valeurs semblent lissées.** L'utilisation CPU publiée est la **moyenne sur
l'intervalle de rafraîchissement**, pas un instantané : un pic de 2 secondes
dans une fenêtre de 5 minutes reste peu visible. Réduisez l'intervalle si vous
chassez des pics courts.

L'intégration journalise chaque lecture. Consultez les logs depuis l'interface
Gladys, avec `LOG_LEVEL=debug` pour le détail complet.
