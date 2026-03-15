# SYNAPSE — Lecteur RSS augmenté par l'IA

Lecteur RSS personnel, multi-utilisateurs, hébergé sur GitHub Pages. Les articles sont enrichis automatiquement par l'IA (réécriture, importance, tags, sentiment, traduction) via Groq. Données persistées dans Supabase.

## Stack

| Couche | Techno |
|---|---|
| Frontend | HTML + CSS + JS vanilla (3 fichiers, zéro dépendance) |
| Auth & DB | Supabase (Auth + PostgreSQL + RLS) |
| IA | Groq API — `llama-3.1-8b-instant` |
| Proxy | Cloudflare Worker (CORS + relay Groq + scraping) |
| Hébergement | GitHub Pages |

---

## Fichiers

```
synapse/
├── index.html              # Structure de l'app (shell + vues)
├── style.css               # Design complet
├── app.js                  # Logique complète (auth, RSS, IA, UI)
├── worker.js               # Cloudflare Worker (proxy RSS + scraping + relay Groq)
├── supabase_schema.sql     # Schéma SQL à exécuter dans Supabase
├── manifest.json           # PWA manifest (icône écran d'accueil)
├── apple-touch-icon.png    # Icône iOS 180x180
└── README.md
```

---

## Déploiement

### 1. Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Aller dans **SQL Editor** > coller et exécuter `supabase_schema.sql`
3. Exécuter aussi ce SQL pour le nettoyage automatique des vieux articles :
```sql
CREATE OR REPLACE FUNCTION cleanup_old_articles()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM articles
  WHERE created_at < now() - INTERVAL '7 days'
    AND bookmarked = false;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_cleanup_articles
  AFTER INSERT ON articles
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_old_articles();
```
4. Exécuter ce SQL pour la colonne `ai_title` :
```sql
ALTER TABLE articles ADD COLUMN IF NOT EXISTS ai_title TEXT DEFAULT NULL;
```
5. Dans **Settings > API**, noter :
   - `Project URL` → `SUPABASE_URL`
   - `anon public key` → `SUPABASE_ANON_KEY`

### 2. Cloudflare Worker

1. Aller sur [dash.cloudflare.com](https://dash.cloudflare.com) > **Workers & Pages**
2. Créer un nouveau Worker nommé `synapse-worker`
3. Coller le contenu de `worker.js` dans l'éditeur
4. Dans **Settings > Variables** du worker, ajouter :
   - `GROQ_API_KEY` = votre clé depuis [console.groq.com](https://console.groq.com)
   - `ALLOWED_ORIGIN` = `https://VOTRE_USERNAME.github.io` (ou `*` en dev)
5. Déployer — noter l'URL du worker

### 3. Configurer app.js

Ouvrir `app.js` et remplir la section `CONFIG` (ligne ~26) :

```js
const CONFIG = {
  SUPABASE_URL:      'https://VOTRE_PROJET.supabase.co',
  SUPABASE_ANON_KEY: 'VOTRE_ANON_KEY',
  WORKER_URL:        'https://synapse-worker.VOTRE_COMPTE.workers.dev',
  GROQ_MODEL:        'llama-3.1-8b-instant',
  MAX_ARTICLES_PER_FEED: 10,
  GROQ_REQUEST_DELAY: 3000,
};
```

### 4. GitHub Pages

1. Créer un repo GitHub
2. Pousser tous les fichiers à la racine
3. Dans **Settings > Pages**, choisir la branche `main` et le dossier `/`
4. L'app sera accessible sur `https://VOTRE_USERNAME.github.io/NOM_DU_REPO`

### 5. Installer sur iPhone (PWA)

Safari → ouvrir le site → bouton partage ↑ → "Sur l'écran d'accueil"

---

## Fonctionnalités

### Lecture
- **Flux RSS** — fetch via Cloudflare Worker (contourne le CORS), 10 articles par source
- **Enrichissement IA à la demande** — à l'ouverture d'un article : réécriture en français, score d'importance 1-5, tags thématiques, sentiment (positif/négatif/neutre), traduction du titre
- **Scraping de la page source** — le worker tente de récupérer le contenu complet avant d'envoyer à Groq (en parallèle, sans délai)
- **Enrichissement en arrière-plan** — les articles sont enrichis silencieusement pendant la lecture, par ordre d'importance
- **Reader** — mode focus avec navigation clavier (← →) et swipe mobile
- **Infinite scroll** dans la vue flux

### Organisation
- **Clusters thématiques** — regroupement automatique des articles par sujet via les tags IA
- **Bookmarks** synchronisés dans Supabase
- **Historique** — articles lus des 30 derniers jours
- **Filtres** — tout / non lus / importants + recherche plein texte
- **Feeds par catégorie** — regroupés dans la sidebar

### Digest IA
- Génération à la demande d'un briefing quotidien structuré par thèmes
- Enrichit automatiquement les articles avant de générer si nécessaire
- Mis en cache dans Supabase (une fois par jour)

### Sync & Performance
- **Sync conditionnel** — pas de re-fetch si moins de 15 min depuis le dernier sync
- **Sauvegarde automatique** — tous les articles fetchés sont sauvegardés dans Supabase (pas seulement ceux ouverts)
- **Nettoyage automatique** — les articles > 7 jours non bookmarkés sont supprimés (trigger Supabase)
- **Cache localStorage** — affichage instantané au rechargement

### UX
- **Dark mode** — toggle dans la sidebar
- **Taille de police** ajustable dans le reader (A- / A / A+)
- **Partage** — Web Share API sur mobile, copie presse-papier sur desktop
- **Pull to refresh** sur mobile
- **Badge breaking news** — point rouge dans la nav si article importance 5 non lu
- **Retour en haut** — bouton flottant après 400px de scroll
- **Raccourcis clavier** — ← → (navigation), Escape (fermer), B (bookmark), O (source), R (refresh)

---

## Notes techniques

**Sécurité**
- La clé Groq ne quitte jamais le Cloudflare Worker (variable d'environnement)
- Les clés Supabase `anon` sont sécurisées par les Row Level Security policies
- Tout le HTML est échappé via `escapeHtml()` — pas de XSS

**Rate limiting Groq**
- Modèle `llama-3.1-8b-instant` : 14 400 req/jour, 30 req/min (free tier)
- Délai de 3s entre chaque enrichissement
- Retry automatique avec backoff exponentiel sur les erreurs 429

**Architecture Worker**
- `GET /rss?url=` — fetch et parse RSS/Atom, gère le CDATA
- `GET /scrape?url=` — extrait le contenu textuel d'une page article
- `POST /ai` — relay vers l'API Groq (clé cachée côté worker)
