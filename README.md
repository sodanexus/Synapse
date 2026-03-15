# SYNAPSE — Lecteur RSS IA Brutaliste

Lecteur RSS augmenté par l'IA (Groq), multi-utilisateurs (Supabase), hébergé sur GitHub Pages avec un proxy Cloudflare Worker.

## Stack

| Couche | Techno |
|---|---|
| Frontend | HTML + CSS + JS vanilla (3 fichiers) |
| Auth & DB | Supabase (Auth + PostgreSQL) |
| IA | Groq API — `llama-3.3-70b-versatile` |
| Proxy | Cloudflare Worker (CORS + relay API) |
| Hébergement | GitHub Pages |

---

## Fichiers

```
synapse/
├── index.html          # Structure de l'app (shell + vues)
├── style.css           # Design brutaliste complet
├── app.js              # Logique complète (auth, RSS, IA, UI)
├── worker.js           # Cloudflare Worker (proxy RSS + relay Groq)
├── supabase_schema.sql # Schéma SQL à exécuter dans Supabase
└── README.md
```

---

## Déploiement — étape par étape

### 1. Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Aller dans **SQL Editor** > coller et exécuter `supabase_schema.sql`
3. Dans **Settings > API**, noter :
   - `Project URL` → `SUPABASE_URL`
   - `anon public key` → `SUPABASE_ANON_KEY`

### 2. Cloudflare Worker

1. Aller sur [dash.cloudflare.com](https://dash.cloudflare.com) > **Workers & Pages**
2. Créer un nouveau Worker nommé `synapse-worker`
3. Coller le contenu de `worker.js` dans l'éditeur
4. Dans **Settings > Variables** du worker, ajouter :
   - `GROQ_API_KEY` = votre clé depuis [console.groq.com](https://console.groq.com)
   - `ALLOWED_ORIGIN` = `https://VOTRE_USERNAME.github.io` (ou `*` en dev)
5. Déployer — noter l'URL du worker (format : `https://synapse-worker.VOTRE_COMPTE.workers.dev`)

### 3. Configurer app.js

Ouvrir `app.js` et remplir la section `CONFIG` (ligne ~20) :

```js
const CONFIG = {
  SUPABASE_URL:    'https://VOTRE_PROJET.supabase.co',
  SUPABASE_ANON_KEY: 'VOTRE_ANON_KEY',
  WORKER_URL:      'https://synapse-worker.VOTRE_COMPTE.workers.dev',
  // ...
};
```

### 4. GitHub Pages

1. Créer un repo GitHub (ex: `synapse`)
2. Pousser les 3 fichiers (`index.html`, `style.css`, `app.js`)
3. Dans **Settings > Pages**, choisir la branche `main` et le dossier `/` (root)
4. L'app sera accessible sur `https://VOTRE_USERNAME.github.io/synapse`

---

## Fonctionnalités v1

- **Auth multi-utilisateurs** via Supabase (login / inscription)
- **Ajout / suppression de feeds RSS** par URL
- **Fetch RSS** via Cloudflare Worker (évite les problèmes CORS)
- **Enrichissement IA** automatique à chaque sync (réécriture, importance 1-5, tags)
- **Déduplication** des articles similaires (algorithme Jaccard)
- **Clustering thématique** des articles par tag IA
- **Digest du jour** généré par Groq, mis en cache dans Supabase
- **Mode Focus** (reader plein écran) avec navigation clavier (←/→/Escape)
- **Résumé IA à la demande** dans le reader
- **Bookmarks** synchronisés en base
- **Filtres** (tout / non lus / importants) + recherche plein texte
- **Design responsive** mobile + desktop

---

## Roadmap / Idées futures

- [ ] Notifications PWA pour les articles haute importance
- [ ] Recherche sémantique (embeddings Supabase pgvector)
- [ ] Export digest en PDF / email
- [ ] Feed auto-découverte (scraper pour trouver le RSS d'un site)
- [ ] TTS (lecture audio des articles, Web Speech API)
- [ ] Thème clair (toggle dark/light)
- [ ] Stats (nombre d'articles lus, sources préférées, topics tendance)

---

## Notes techniques

**Sécurité**
- La clé Groq ne quitte jamais le Cloudflare Worker (variable d'environnement serveur)
- Les clés Supabase `anon` sont publiques par design — la sécurité est assurée par les Row Level Security policies
- Toutes les insertions HTML utilisent `textContent` / `escapeHtml()` — pas de XSS

**Performance**
- Les articles enrichis sont mis en cache dans Supabase (pas de re-call Groq au rechargement)
- Le Cloudflare Worker met en cache les feeds RSS 5 minutes côté CDN
- Le digest quotidien est généré une seule fois par jour et mis en cache

**Rate limiting Groq**
- Un délai de 800ms est appliqué entre chaque enrichissement d'article (configurable via `GROQ_REQUEST_DELAY`)
- En production, envisager de grouper les enrichissements par batch de 5 articles
