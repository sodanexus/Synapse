# SYNAPSE — Lecteur RSS augmenté par l'IA

Lecteur RSS personnel, multi-utilisateurs, hébergé sur GitHub Pages. Les articles sont enrichis automatiquement par l'IA (réécriture en français, score d'importance, tags thématiques) via Groq. Données persistées dans Supabase.

## Stack

| Couche | Techno |
|---|---|
| Frontend | HTML + CSS + JS vanilla (3 fichiers, zéro dépendance) |
| Auth & DB | Supabase (Auth + PostgreSQL + RLS) |
| IA enrichissement | Groq — `llama-3.1-8b-instant` |
| IA digest | Groq — `llama-3.3-70b-versatile` |
| TTS | Unreal Speech (voix Élodie, française) |
| Proxy | Cloudflare Worker (CORS + relay Groq + RSS + scraping + TTS) |
| Hébergement | GitHub Pages |

---

## Fichiers

```
synapse/
├── index.html              # Structure de l'app (shell + vues)
├── style.css               # Design complet
├── app.js                  # Logique complète (auth, RSS, IA, UI)
├── worker.js               # Cloudflare Worker (proxy RSS + scraping + relay Groq + TTS)
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
4. Exécuter ce SQL pour les colonnes supplémentaires :
```sql
ALTER TABLE articles ADD COLUMN IF NOT EXISTS ai_title TEXT DEFAULT NULL;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image TEXT DEFAULT NULL;
```
5. Dans **Settings > API**, noter :
   - `Project URL` → `SUPABASE_URL`
   - `anon public key` → `SUPABASE_ANON_KEY`

### 2. Cloudflare Worker

1. Aller sur [dash.cloudflare.com](https://dash.cloudflare.com) > **Workers & Pages**
2. Créer un nouveau Worker nommé `synapse-worker`
3. Coller le contenu de `worker.js` dans l'éditeur
4. Dans **Settings > Variables** du worker, ajouter :
   - `GROQ_API_KEY` — clé depuis [console.groq.com](https://console.groq.com)
   - `UNREALSPEECH_API_KEY` — clé depuis [unrealspeech.com](https://unrealspeech.com)
   - `ALLOWED_ORIGIN` — `https://VOTRE_USERNAME.github.io` (ou `*` en dev)
5. Déployer — noter l'URL du worker

### 3. Configurer app.js

Ouvrir `app.js` et remplir la section `CONFIG` (ligne ~26) :

```js
const CONFIG = {
  SUPABASE_URL:          'https://VOTRE_PROJET.supabase.co',
  SUPABASE_ANON_KEY:     'VOTRE_ANON_KEY',
  WORKER_URL:            'https://synapse-worker.VOTRE_COMPTE.workers.dev',

  GROQ_MODEL_ENRICH:     'llama-3.1-8b-instant',   // enrichissement article
  GROQ_MODEL_DIGEST:     'llama-3.3-70b-versatile', // digest quotidien

  QUOTA_ENRICH_DAILY:    14400,  // req/jour free tier Groq
  QUOTA_DIGEST_DAILY:    1000,

  MAX_ARTICLES_PER_FEED: 20,     // articles fetchés par feed RSS
  DEDUP_THRESHOLD:       0.65,   // seuil de déduplication

  GROQ_REQUEST_DELAY:    3000,   // ms entre chaque enrichissement
  GROQ_DIGEST_DELAY:     1000,   // ms délai digest
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
- **Flux RSS** — fetch via Cloudflare Worker (contourne le CORS), 20 articles par source par défaut
- **Enrichissement IA à l'ouverture** — réécriture en français, score d'importance 1-5, tags thématiques, traduction du titre
- **Image hero** — extraite du flux RSS (`media:content`, `media:thumbnail`, `enclosure`) ou scrapée depuis l'OG tag de la page source en fallback
- **Scraping de la page source** — le worker extrait le contenu complet et l'image OG avant enrichissement
- **Enrichissement en arrière-plan** — les articles sont enrichis silencieusement pendant la lecture, par ordre d'importance décroissante
- **Reader** — mode focus plein écran avec image hero, navigation clavier (← →) et swipe mobile
- **TTS** — lecture audio en français via Unreal Speech (voix Élodie), avec barre de progression

### Organisation
- **Clusters thématiques** — regroupement automatique des articles par sujet via les tags IA
- **Bookmarks** synchronisés dans Supabase
- **Filtres** — tout / non lus / importants + recherche plein texte
- **Feeds par catégorie** — regroupés dans la sidebar

### Digest IA
- Génération à la demande d'un briefing quotidien structuré par thèmes (4 max)
- Modèle dédié plus puissant (`llama-3.3-70b-versatile`)
- Image hero depuis l'article le plus important du jour
- Lecture audio du digest via TTS
- Chronologie du jour en bas (articles triés par heure)
- Mis en cache dans Supabase — régénérable manuellement

### Sync & Performance
- **Sync conditionnel** — pas de re-fetch si moins de 15 min depuis le dernier sync
- **Sauvegarde automatique** — tous les articles fetchés sont sauvegardés dans Supabase
- **Rétention** — 7 jours pour les articles non bookmarkés (trigger Supabase), illimité pour les bookmarks
- **Fusion intelligente** — au sync, les articles Supabase enrichis sont conservés et mis à jour avec les images RSS fraîches
- **Cache localStorage** — affichage instantané au rechargement
- **Limite** — 300 articles en mémoire et en base

### UX
- **Dark mode** — toggle dans la sidebar, contraste optimisé
- **Taille de police** ajustable dans le reader (A- / A / A+)
- **Partage** — Web Share API sur mobile, copie presse-papier sur desktop
- **Pull to refresh** sur mobile
- **Badge breaking news** — point rouge dans la nav si article importance 5 non lu
- **Raccourcis clavier** — ← → (navigation), Escape (fermer), B (bookmark), O (source), R (refresh)
- **PWA** — installable sur iPhone via Safari

---

## Architecture Worker

| Endpoint | Méthode | Description |
|---|---|---|
| `/rss?url=` | GET | Fetch et parse RSS/Atom, extrait images (`media:content`, `media:thumbnail`, `enclosure`) |
| `/scrape?url=` | GET | Extrait contenu texte + `og:image` d'une page article |
| `/ai` | POST | Relay vers API Groq (clé cachée côté worker), max 2000 tokens |
| `/tts` | POST | Relay vers Unreal Speech, voix Élodie (fr-FR), ≤3000 chars |

---

## Notes techniques

**Sécurité**
- Les clés Groq et Unreal Speech ne quittent jamais le Cloudflare Worker (variables d'environnement)
- Les clés Supabase `anon` sont sécurisées par les Row Level Security policies
- Tout le HTML est échappé via `escapeHtml()` — pas de XSS

**Rate limiting Groq**
- `llama-3.1-8b-instant` : 14 400 req/jour, 30 req/min (free tier)
- `llama-3.3-70b-versatile` : 1 000 req/jour (free tier)
- Délai de 3s entre chaque enrichissement d'article
- Retry automatique avec backoff exponentiel sur les erreurs 429

**TTS — Unreal Speech**
- 250 000 caractères/mois sur le free tier
- Voix `Élodie` (fr-FR)
- Endpoint `/stream` pour les textes ≤1000 chars, `/speech` au-delà
