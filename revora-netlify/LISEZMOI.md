# Revora — mise en ligne sur Netlify avec l'IA

## Contenu du dossier

```text
index.html                     l'application complète
netlify.toml                   configuration Netlify
_headers                       en-têtes de sécurité (protection XSS, iframes…)
netlify/functions/ai.mjs       la fonction serveur qui parle à l'IA et garde la clé secrète
```

L'application appelle `/api/ai`. La fonction ajoute ta clé API côté serveur et renvoie la réponse en direct.
La clé n'apparaît jamais dans la page. Si aucune clé n'est configurée, Revora fonctionne en mode local sans IA.

## Important : pas de glisser-déposer

Le glisser-déposer de Netlify (Netlify Drop) ne publie pas les fonctions serveur. L'IA ne marcherait pas.
Utilise l'une des deux méthodes ci-dessous.

## Méthode A — avec GitHub (recommandée, sans ligne de commande)

1. Crée un compte sur github.com, puis un nouveau dépôt (par exemple `revora`).
2. Clique sur « uploading an existing file » et envoie **tout le contenu du dossier** en gardant les sous-dossiers
   (`netlify/functions/ai.mjs` doit rester dans `netlify/functions/`).
3. Sur app.netlify.com : **Add new project → Import an existing project → GitHub**, choisis le dépôt.
   Laisse la commande de build vide et le dossier de publication à `.` (déjà réglé par `netlify.toml`). Clique sur **Deploy**.

## Méthode B — avec la ligne de commande

```bash
npm install -g netlify-cli
netlify login
cd dossier-revora
netlify deploy --prod
```

## Ajouter la clé API (étape obligatoire pour l'IA)

1. Crée une clé :
   - Claude : console.anthropic.com → API Keys
   - ou OpenAI : platform.openai.com → API keys
2. **Fixe une limite de dépenses mensuelle** dans la console du fournisseur (Billing / Limits). C'est ta meilleure protection.
3. Sur Netlify : **Project configuration → Environment variables → Add a variable**
   - Nom : `ANTHROPIC_API_KEY` (ou `OPENAI_API_KEY`)
   - Valeur : ta clé
   - Coche « Contains secret values » et le scope **Functions**.
4. **Deploys → Trigger deploy → Deploy project** pour que la clé soit prise en compte.

Ne colle jamais ta clé dans `index.html`, dans GitHub ou dans une discussion.

## Vérifier que tout marche

- Ouvre `https://ton-site.netlify.app/api/ai` : tu dois voir `{"ok":true,"provider":"anthropic",…}`.
  Si `"ok":false`, la clé n'est pas configurée ou le site n'a pas été redéployé.
- Ouvre l'application : la pastille en haut indique **« En ligne · IA active »**.
- Importe un cours, puis sur la page du cours clique sur **Analyse IA approfondie → Lancer**.

## Réglages facultatifs (variables d'environnement)

| Variable | Rôle | Par défaut |
|---|---|---|
| `AI_PROVIDER` | forcer `anthropic` ou `openai` si les deux clés existent | Claude en priorité |
| `AI_MODEL` | modèle principal | `claude-haiku-4-5-20251001` / `gpt-5-mini` |
| `AI_MODEL_QUICK` | modèle des corrections rapides | `claude-haiku-4-5-20251001` / `gpt-5-nano` |
| `AI_MODEL_COMPLEX` | modèle des tâches difficiles | `claude-sonnet-5-5` / `gpt-5-mini` |
| `ALLOWED_ORIGINS` | autres domaines autorisés à appeler `/api/ai` | ton site uniquement |

Les modèles par défaut sont choisis pour être rapides et peu chers. Une réponse streamée doit se terminer
en moins de 60 secondes sur Netlify ; un modèle très lent peut couper les analyses longues.
Si un nom de modèle n'existe plus, la fonction renvoie une erreur claire : change `AI_MODEL`.

## Protections intégrées

- La clé reste sur le serveur ; la page n'en contient aucune.
- 20 demandes par minute et par adresse IP (limite Netlify intégrée).
- Seul ton site peut appeler `/api/ai` (vérification de l'origine).
- Taille des demandes limitée (texte et 4 images maximum).
- Les cours et la progression restent dans le navigateur de chaque utilisateur.
  Seuls les extraits utiles à une demande sont envoyés au fournisseur d'IA.
