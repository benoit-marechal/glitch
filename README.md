# GLITCH : billetterie de démonstration

GLITCH est une application pédagogique de billetterie pour un festival fictif. Elle permet de travailler le déploiement, le stockage, les flux réseau et la disponibilité d’une application web. Les paiements sont simulés. Utilisez uniquement des pseudonymes et des données de démonstration.

Le nom technique de l’application et du projet Compose est `billeterie`. Les configurations de TP peuvent réutiliser `app/`, `infra/` et `database/` pour répartir les services sur plusieurs VM. Le fichier `compose.yaml` fourni décrit un banc local complet, pas le déploiement de ressources chez un fournisseur cloud.

## Composants

- Deux frontaux PHP 8.3.30 derrière HAProxy.
- Deux proxies SQL HAProxy pour joindre le primaire PostgreSQL.
- Trois PostgreSQL 16 avec Patroni 4.1.0 et trois membres etcd 3.5.21.
- Un bootstrap pour créer la base, le schéma et les trois pass de démonstration.
- Des réservations idempotentes, un stock limité et un contrôle d’entrée authentifié.

La majorité etcd et la réplication SQL remplissent deux fonctions distinctes. Le mode synchrone exige une réplique pour confirmer une écriture. Trois conteneurs sur le même ordinateur ne constituent pas trois domaines de panne indépendants.

## Démarrage local

Prérequis : Docker Engine avec le plugin Compose v2, un shell POSIX et OpenSSL. Sur macOS, démarrez votre moteur Docker avant ce bloc. Exécutez les commandes depuis la racine du dépôt.

```bash
# Créer les secrets locaux une seule fois et conserver ceux qui existent déjà.
sh scripts/prepare.sh
# Attendu : quatre fichiers privés dans .secrets, aucune valeur affichée.

# Construire les images PHP et PostgreSQL/Patroni à partir des sources de cette révision.
docker compose --env-file /dev/null -p billeterie build
# Attendu : images locales construites. Une erreur de téléchargement ou de compilation arrête cette étape.

# Démarrer le banc puis attendre les contrôles de santé, sans charger de fichier .env.
docker compose --env-file /dev/null -p billeterie up -d --wait --wait-timeout 240
# Attendu : services démarrés et contrôles de santé réussis. Le schéma reste à initialiser ci-dessous.

# Initialiser les données de démonstration après démarrage du primaire et du proxy SQL.
docker compose --env-file /dev/null -p billeterie --profile setup run --rm --no-deps bootstrap </dev/null
# Attendu : base et schéma disponibles. stdin est fermé car ce traitement n’attend aucune saisie.

# Contrôler la chaîne HTTP et SQL par le portail local.
curl --fail --silent --show-error http://127.0.0.1:8088/readyz
curl --fail --silent --show-error http://127.0.0.1:8088/api/events
# Attendu : status ready et trois événements de démonstration.
```

Ouvrez ensuite `http://127.0.0.1:8088`. Le seul port publié par ce banc écoute sur la boucle locale. Les ports SQL, Patroni et etcd restent sur les réseaux Docker internes. Les secrets et les billets ne doivent pas être publiés dans le dépôt ou dans des captures.

## Tests

Avec Node.js 18 ou supérieur et le banc déjà démarré, la suite métier appelle réellement le portail :

```bash
# Vérifier réservations, idempotence, refus de paiement et contrôle des billets.
node --test tests/app.test.mjs
# Attendu : tests réussis. La suite crée des données fictives et consomme des places de démonstration.
```

`tests/ha.test.mjs` est une recette locale spécifique au contexte Docker `orbstack`. Elle provoque des pannes de conteneurs et tente de rétablir les services. Elle exige un banc sain, sans recette ou achat concurrent, et produit un rapport privé dans `reports/`. Elle ne doit pas être lancée sur les VM d’un TP OpenStack. Un test de syntaxe ou de configuration ne remplace pas une nouvelle recette sur la cible réellement déployée.

## Arrêt et conservation des données

```bash
# Retirer les conteneurs et réseaux du banc en conservant les volumes et les secrets.
docker compose --env-file /dev/null -p billeterie down
# Attendu : services arrêtés, données conservées pour un prochain démarrage.
```

Conservez le nom de projet `billeterie` pour retrouver les mêmes volumes. N’effacez pas les volumes pour résoudre un incident sans avoir décidé de perdre les données de démonstration. Après vos tests sur macOS, arrêtez aussi OrbStack si aucune autre activité n’en dépend.

## Visuels

Les trois illustrations du festival sont des SVG originaux et éditables. La [provenance de l’habillage](docs/habillage-festival.md) décrit leurs sources et les paramètres de simulation. Aucune programmation, salle, date de vente ou transaction réelle n’est annoncée par cette application.
