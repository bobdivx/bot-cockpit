# Bot Cockpit

Projet indépendant. **Bot Cockpit** n’est pas un produit officiel Grok Bot, ni un produit xAI, ni une console de compte. Rien ici ne se connecte à un compte, ne lit de cookie de session, et n’installe quoi que ce soit à votre place.

Interface en français : fiches d’équipes et de bots, bureau isométrique, imports CSV d’usage, et signalements volontaires via MCP.

Le mode réel démarre vide. Aucun usage, aucun coût et aucune économie ne sont inventés. La démonstration est un choix explicite. Tant qu’elle est active, l’interface affiche **Données de démonstration** : ces fiches et ces lignes sont fictives, elles ne décrivent pas un compte, et les retirer n’efface que ces lignes-là.

## Lancer en local

Prérequis : Node.js 22.13 ou plus récent.

```bash
npm install
npm run dev
```

- Interface : http://127.0.0.1:8742
- API : http://127.0.0.1:8741

La première visite crée le propriétaire (mot de passe d’au moins 12 caractères). En développement, cette création est ouverte sur la machine locale. La base est `data/cockpit.sqlite`.

```bash
npm test
npm run typecheck
npm run lint
npm run build
NODE_ENV=production BOT_COCKPIT_ALLOW_OPEN_SETUP=1 npm start
```

`npm start` sert l’interface et l’API sur le port `8741` (ou `PORT`).

## Docker Compose

L’hébergement prévu pour des données persistantes est Docker Compose / DevForge. Une configuration Vercel (`vercel.json`, `api/index.ts`) existe pour une démo en ligne : la base SQLite y est écrite dans `/tmp` et **n’est pas persistante** (réinitialisation aux redémarrages à froid). Rien dans ce dépôt ne déploie ni ne publie tout seul.

```bash
export BOT_COCKPIT_SETUP_TOKEN='remplacez-par-un-secret-long'
docker compose up --build
```

- Santé : `GET /api/health`
- Volume : `cockpit-data` monté sur `/data`
- Fichier : `BOT_COCKPIT_DATA=/data/cockpit.sqlite`
- Le schéma est créé au démarrage (`schema_migrations`). Pas de commande de migration séparée.
- `BOT_COCKPIT_ALLOW_OPEN_SETUP=0` par défaut. Hors boucle locale, le premier propriétaire exige `BOT_COCKPIT_SETUP_TOKEN`.
- Les exemples de secrets sont dans `.env.example`. Ne pas y mettre de vrais jetons.

Le fichier `deploy/devforge.json` ne fait que décrire ce contrat Compose. Il ne déclenche aucun déploiement.


## Vercel (démo, stockage temporaire)

Prérequis : compte Hobby Vercel, Node 22.x.

1. Importez le dépôt ou déployez depuis la CLI.
2. Variables d’environnement recommandées :
   - `BOT_COCKPIT_SETUP_TOKEN` (secret long, obligatoire pour créer le premier propriétaire)
   - `BOT_COCKPIT_COOKIE_SECURE=1`
   - `BOT_COCKPIT_ALLOW_OPEN_SETUP=0`
3. L’interface affiche clairement que le stockage est temporaire.
4. Pour une installation durable, préférez Docker Compose (volume `/data`) ou DevForge.

## Ce que l’atelier fait

1. **Fiches.** Équipes, salles, rôles, statuts, historique, archivage. Le bureau est un plateau isométrique plein cadre. Par-dessus : barre compacte, panneau gauche des salles, liste d’attente, journal d’activité et carte de métriques — uniquement des chiffres importés, sinon « non disponible ». Les formulaires de création sont derrière **Ajouter**. Le mouvement suit le statut observé. Un signal trop ancien fige le personnage. La démonstration peut ajouter un trajet fictif, annoncé à l’écran. Une arborescence montre les mêmes fiches, sans métrique inventée. La liste compacte, l’usage, les liens, les demandes et les réglages utilisent les mêmes cartes claires. Trois consignes originales se copient ou créent des fiches. Une consigne n’installe rien et n’exécute aucun code. Des vidéos publiques ont servi de référence de composition, pas de source : aucun fichier n’en est repris.
2. **CSV.** Dépôt, aperçu, mapping des colonnes (date, jetons entrée/cache/sortie/total, coût, modèle, type, automation ou cloud agent, identifiant de bot). BOM, guillemets, point-virgule, dates FR/US, nombres `1 234` et `1,25`. Les lignes identiques sont dédupliquées. Sans identifiant reconnu, la ligne reste non attribuée ; l’attribution manuelle garde sa provenance. `Included` et `-` sont inconnus, pas zéro. Les graphiques et les règles disent ce qui a été observé, pas une économie. Suppression d’un import, conservation en jours, remise à zéro. Export plafonné, cellules de type formule neutralisées.
3. **MCP.** `POST/GET /mcp` avec `Authorization: Bearer`. Outils `report_status` et `report_event`. Jeton affiché une seule fois, stocké hashé, jamais dans l’URL ni dans les journaux. Les événements sont persistés et poussés au bureau en SSE. Les jetons déclarés dans un événement ne sont pas additionnés aux CSV.
4. **Demandes sortantes, seulement si une allowlist existe.** `BOT_COCKPIT_WEBHOOKS` est un objet nom → URL HTTPS, lu au démarrage. Pas de saisie d’URL dans l’interface. Contrôle d’hôte (SSRF), pas de redirection suivie, secret serveur, délai 8 s, 10 appels par heure, confirmation `DEMANDER`, journal. L’état affiché est **Demandé / en attente** : un HTTP 200 ne veut pas dire qu’une tâche est finie. Aucun arrêt forcé, aucune suppression distante. Sans allowlist, le contrôle est désactivé.

## Limites exactes

- Pas d’API publique documentée pour lister, piloter ou mesurer tous les bots d’un compte. Bot Cockpit ne s’y connecte pas, ne lit pas de cookies de session, et n’extrait aucun secret.
- Un bot peut ajouter un serveur MCP par URL (documentation « Computer and apps »). Le mode d’emploi de la page Liens est un texte à coller plus tard. Rien n’a été installé dans un compte.
- Un webhook de routine qui répond 200 a seulement été accepté. Ce n’est pas une fin de tâche. Voir la documentation « Skills, routines, and automations ».
- Les événements MCP sont des auto-signalements partiels. Ils ne couvrent pas l’usage du compte.
- Les CSV réels varient. L’attribution à un bot manque souvent. Les totaux de jetons ne sont pas un pourcentage de quota. La validation sur un export réel de compte reste à faire : seule une fixture synthétique est fournie (`fixtures/usage-synthetique.csv`).
- Les jours sans fuseau sont conservés tels qu’écrits, en horloge UTC pour le tri.
- Deux lignes strictement identiques n’en font qu’une, y compris d’un import à l’autre. Les effacer permet de les réimporter.
- OpenTelemetry d’entreprise est hors de ce périmètre.
- Le dépôt communautaire `dimpurr/grok-bot-gateway` n’est pas une API officielle et n’est pas utilisé.
- Les packs sont originaux. Les dépôts MIT `cobusgreyling/grok-bot-templates` et `serenakeyitan/agent-org-chart` n’ont pas été copiés.
- Un seul propriétaire, une seule base. Ce n’est pas un service multi-clients.
- `node:sqlite` est encore marqué expérimental dans Node.js 22. Le volume Docker est le moyen de garder les données après redémarrage. Sur Vercel, le fichier va dans `/tmp` et disparaît aux cold starts.
- Les actions dont le nom est `stop`, `delete`, `kill` ou équivalent sont refusées au démarrage.

## Vérification encore nécessaire

1. Déposer un CSV réel du compte et vérifier le mapping, les coûts `Included` et les lignes sans bot.
2. Ajouter l’URL MCP affichée dans Liens à un bot, avec un jeton créé ici, puis contrôler qu’un `report_status` arrive. Ne pas confondre cet essai avec une connexion déjà active : elle ne l’est pas.
3. Si une routine webhook doit être appelée, renseigner son URL dans `BOT_COCKPIT_WEBHOOKS` côté serveur, puis confirmer `DEMANDER`. Le résultat reste « demandé / en attente ».
4. Lancer le Compose avec le volume et un jeton de configuration choisi par vous. Les exemples de `.env.example` ne sont pas des secrets.
