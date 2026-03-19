# SYNAPSE — Lecteur RSS augmenté par l'IA

> Lecteur RSS personnel et minimaliste, enrichi par l'IA. Les articles sont réécrits en français, scorés par importance et tagués automatiquement. Interface épurée, installable sur iPhone, zéro dépendance frontend.

![GitHub Pages](https://img.shields.io/badge/hébergement-GitHub%20Pages-black) ![Supabase](https://img.shields.io/badge/base%20de%20données-Supabase-3ECF8E) ![Groq](https://img.shields.io/badge/IA-Groq-F55036) ![Cloudflare Workers](https://img.shields.io/badge/proxy-Cloudflare%20Workers-F38020)

---

## Ce que ça fait

- 📰 **Agrège tes feeds RSS** — fetch via Cloudflare Worker, 20 articles par source
- 🤖 **Enrichit chaque article à l'ouverture** — réécriture en français, score d'importance 1–5, tags thématiques, extraction d'image
- 🎙️ **Lit les articles à voix haute** — TTS français via Unreal Speech (voix Élodie)
- 📋 **Génère un digest quotidien** — briefing structuré par thèmes, lu à voix haute
- 🔖 **Synchronise tes bookmarks** — persistés dans Supabase, accessibles partout
- 📱 **Installable sur iPhone** — PWA, fonctionne comme une app native

---

## Stack

| Couche | Techno |
|---|---|
| Frontend | HTML + CSS + JS vanilla — 3 fichiers, zéro dépendance |
| Auth & DB | Supabase (Auth + PostgreSQL + RLS) |
| IA enrichissement | Groq — `llama-3.1-8b-instant` |
| IA digest | Groq — `llama-3.3-70b-versatile` |
| TTS | Unreal Speech — voix Élodie (fr-FR) |
| Proxy | Cloudflare Worker (CORS + relay Groq + RSS + scraping + TTS) |
| Hébergement | GitHub Pages |

---

## Structure du projet

```
synapse/
├── index.html              # Shell de l'app + structure des vues
├── style.css               # Design complet
├── app.js                  # Toute la logique (auth, RSS, IA, UI)
├── worker.js               # Cloudflare Worker — proxy RSS, scraping, Groq, TTS
├── supabase_schema.sql     # Schéma SQL à exécuter dans Supabase
├── manifest.json           # PWA manifest
├── apple-touch-icon.png    # Icône iOS 180×180
└── README.md
```

---

## Déploiement

### 1. Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. **SQL Editor** → coller et exécuter `supabase_schema.sql`
3. Ajouter le trigger de nettoyage automatique (articles > 7 jours) :

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

4. Ajouter les colonnes supplémentaires :

```sql
ALTER TABLE articles ADD COLUMN IF NOT EXISTS ai_title TEXT DEFAULT NULL;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image TEXT DEFAULT NULL;
```

5. **Settings > API** → noter `Project URL` et `anon public key`

---

### 2. Cloudflare Worker

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → créer un Worker `synapse-worker`
2. Coller le contenu de `worker.js`
3. **Settings > Variables** → ajouter :

| Variable | Valeur |
|---|---|
| `GROQ_API_KEY` | Clé depuis [console.groq.com](https://console.groq.com) |
| `UNREALSPEECH_API_KEY` | Clé depuis [unrealspeech.com](https://unrealspeech.com) |
| `ALLOWED_ORIGIN` | `https://VOTRE_USERNAME.github.io` (ou `*` en dev) |

4. Déployer → noter l'URL du worker

---

### 3. Configurer app.js

Remplir la section `CONFIG` en début de fichier :

```js
const CONFIG = {
  SUPABASE_URL:          'https://VOTRE_PROJET.supabase.co',
  SUPABASE_ANON_KEY:     'VOTRE_ANON_KEY',
  WORKER_URL:            'https://synapse-worker.VOTRE_COMPTE.workers.dev',

  GROQ_MODEL_ENRICH:     'llama-3.1-8b-instant',    // enrichissement article
  GROQ_MODEL_DIGEST:     'llama-3.3-70b-versatile',  // digest quotidien

  MAX_ARTICLES_PER_FEED: 20,      // articles fetchés par feed RSS
  DEDUP_THRESHOLD:       0.65,    // seuil de déduplication (0–1)
  GROQ_REQUEST_DELAY:    3000,    // ms entre chaque enrichissement
  GROQ_DIGEST_DELAY:     1000,    // ms entre requêtes digest
};
```

---

### 4. GitHub Pages

1. Créer un repo GitHub et pousser tous les fichiers à la racine
2. **Settings > Pages** → branche `main`, dossier `/`
3. L'app est accessible sur `https://VOTRE_USERNAME.github.io/NOM_DU_REPO`

---

### 5. Installer sur iPhone (PWA)

Safari → ouvrir le site → bouton partage **↑** → **"Sur l'écran d'accueil"**

---

## Fonctionnalités détaillées

### Lecture & enrichissement
- Fetch RSS via le Worker (contourne le CORS), parsing des formats RSS 2.0 et Atom
- À l'ouverture d'un article : scraping de la page source, enrichissement IA (titre FR, résumé, score 1–5, tags), extraction d'image OG
- Enrichissement silencieux en arrière-plan par ordre d'importance décroissante
- Reader plein écran avec image hero, navigation clavier `← →` et swipe mobile

### Digest IA
- Briefing quotidien structuré en 4 thèmes max, généré à la demande
- Modèle dédié plus puissant (`llama-3.3-70b-versatile`)
- Lecture audio complète via TTS
- Chronologie du jour en bas (articles triés par heure)
- Mis en cache dans Supabase — régénérable manuellement

### Sync & performance
- Sync conditionnel — pas de re-fetch si < 15 min depuis le dernier sync
- Fusion intelligente — les articles enrichis en mémoire ne sont jamais écrasés
- Rétention 7 jours (articles non bookmarkés), illimitée pour les bookmarks
- 300 articles max en mémoire et en base

### UX
- Dark mode, taille de police ajustable dans le reader
- Pull-to-refresh sur mobile
- Partage natif (Web Share API) sur mobile, presse-papier sur desktop
- Badge breaking news si article importance 5 non lu
- Raccourcis clavier : `← →` navigation · `Escape` fermer · `B` bookmark · `O` source · `R` refresh

---

## API Worker

| Endpoint | Méthode | Description |
|---|---|---|
| `/rss?url=` | GET | Fetch et parse RSS/Atom, extrait les images |
| `/scrape?url=` | GET | Extrait le contenu texte + `og:image` d'un article |
| `/ai` | POST | Relay vers Groq (clé cachée côté worker) |
| `/tts` | POST | Relay vers Unreal Speech, voix Élodie (fr-FR) |

---

## Notes techniques

**Sécurité**
- Les clés Groq et Unreal Speech ne quittent jamais le Worker (variables d'environnement Cloudflare)
- Les clés Supabase `anon` sont protégées par les policies Row Level Security
- Tout le HTML est échappé via `escapeHtml()` — pas de XSS possible

**Rate limiting Groq (free tier)**
- `llama-3.1-8b-instant` : 14 400 req/jour · 30 req/min
- `llama-3.3-70b-versatile` : 1 000 req/jour
- Délai de 3s entre chaque enrichissement + retry avec backoff exponentiel sur 429

**TTS — Unreal Speech (free tier)**
- 250 000 caractères/mois
- Endpoint `/stream` pour les textes ≤ 1 000 chars, `/speech` au-delà
