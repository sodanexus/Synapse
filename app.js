/* ================================================================
   SYNAPSE — app.js
   Architecture : Module pattern (IIFE) avec namespaces clairs
   Sections :
     1. CONFIG
     2. STATE
     3. SUPABASE AUTH
     4. RSS / CLOUDFLARE WORKER
     5. GROQ AI (via worker proxy)
     6. DÉDUPLICATION & CLUSTERING
     7. UI — Navigation & Vues
     8. UI — Rendu articles
     9. UI — Reader (mode focus)
    10. UI — Settings / Feeds
    11. UI — Digest HomePage
    12. UI — Toasts & Loader
    13. INIT
   ================================================================ */

(function () {
  'use strict';

  /* ================================================================
     1. CONFIG — à adapter selon votre déploiement
     ================================================================ */
  const CONFIG = {
    // URL de votre Supabase project
    SUPABASE_URL: 'https://xqzgflhieipakfnatziz.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxemdmbGhpZWlwYWtmbmF0eml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1Mzg0MDAsImV4cCI6MjA4OTExNDQwMH0.GMSzpfVmAt5471i5c6bjGlC4Vg0vuagiilbtImlbfKM',

    // URL de votre Cloudflare Worker
    // Le worker gère : /rss?url=... et /ai (relay Groq)
    WORKER_URL: 'https://synapse-worker.pannetier-julien.workers.dev',

    // Modèles Groq — split selon la tâche
    // llama-3.1-8b-instant : 14.4K req/jour → enrichissement articles (rapide, suffisant)
    // llama-3.3-70b-versatile : 1K req/jour  → digest uniquement (complexe, rare)
    GROQ_MODEL_ENRICH: 'llama-3.1-8b-instant',
    GROQ_MODEL_DIGEST: 'llama-3.3-70b-versatile',
    // Nombre d'articles max à charger par fetch
    MAX_ARTICLES_PER_FEED: 20,

    // Seuil de similarité pour déduplication (0-1)
    DEDUP_THRESHOLD: 0.65,

    // Délai entre les requêtes Groq (ms)
    // Groq free tier ≈ 30 req/min → 3s minimum pour rester dans les limites
    GROQ_REQUEST_DELAY: 3000,

    // Délai entre requêtes Groq pour le digest (ms) — modèle différent, limites différentes
    GROQ_DIGEST_DELAY: 1000,
  };

  /* ================================================================
     2. STATE — état global de l'application
     ================================================================ */
  const STATE = {
    user: null,              // Utilisateur Supabase connecté
    feeds: [],               // Liste des feeds RSS de l'utilisateur
    articles: [],            // Tous les articles chargés (enrichis IA)
    bookmarks: new Set(),    // IDs des articles bookmarkés
    readArticles: new Set(), // IDs des articles lus
    currentView: 'feed',     // Vue active
    currentFilter: 'all',    // Filtre actif sur la vue flux
    currentFeedFilter: null, // ID du feed sélectionné dans la sidebar (null = tous)
    currentArticleIndex: 0,  // Index de l'article ouvert dans le reader
    currentArticleList: [],  // Liste courante pour la navigation reader
    searchQuery: '',         // Requête de recherche active
    searchResults: null,     // Résultats de recherche Supabase (null = pas de recherche active)
    articlesPage: 0,         // Page courante pour la pagination
    lastSyncTime: null,      // Timestamp du dernier sync
    isLoading: false,        // Chargement en cours
    isSearching: false,      // Recherche Supabase en cours
  };

  /* ================================================================
     2b. CACHE LOCAL — localStorage pour survie au refresh navigateur
     Utilisé dans le sync pour persister les articles entre sessions.
     ================================================================ */
  const Cache = (() => {
    function key(userId) { return `synapse_articles_${userId}`; }

    function save(userId, articles) {
      try {
        localStorage.setItem(key(userId), JSON.stringify({
          articles: articles.slice(0, 300),
          savedAt: Date.now(),
        }));
      } catch (err) {
        console.warn('Cache write failed (quota?):', err);
      }
    }

    function clear(userId) {
      try { localStorage.removeItem(key(userId)); } catch {}
    }

    return { save, clear };
  })();

  /* ================================================================
     3. SUPABASE AUTH
     ================================================================ */
  const Auth = (() => {
    let supabase = null;

    /** Initialise le client Supabase */
    function init() {
      supabase = window.supabase.createClient(
        CONFIG.SUPABASE_URL,
        CONFIG.SUPABASE_ANON_KEY
      );
      return supabase;
    }

    /** Retourne l'instance Supabase (lazy init) */
    function getClient() {
      if (!supabase) init();
      return supabase;
    }

    /** Connexion email/password */
    async function login(email, password) {
      const { data, error } = await getClient().auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    }

    /** Inscription */
    async function register(email, password) {
      const { data, error } = await getClient().auth.signUp({ email, password });
      if (error) throw error;
      return data.user;
    }

    /** Déconnexion */
    async function logout() {
      await getClient().auth.signOut();
      STATE.user = null;
      STATE.feeds = [];
      STATE.articles = [];
      STATE.bookmarks = new Set();
      STATE.readArticles = new Set();
    }

    /** Récupère la session active */
    async function getSession() {
      const { data } = await getClient().auth.getSession();
      return data.session;
    }

    /** Écoute les changements d'auth (login/logout) */
    function onAuthChange(callback) {
      getClient().auth.onAuthStateChange((event, session) => {
        callback(session?.user ?? null, event);
      });
    }

    return { init, getClient, login, register, logout, getSession, onAuthChange };
  })();

  /* ================================================================
     DB — Opérations Supabase (feeds, articles, digests)
     ================================================================ */
  const DB = (() => {
    function client() { return Auth.getClient(); }

    /* ── FEEDS ── */

    /** Récupère tous les feeds de l'utilisateur */
    async function getFeeds(userId) {
      const { data, error } = await client()
        .from('feeds')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    }

    /** Ajoute un feed */
    async function addFeed(userId, url, name, category) {
      const { data, error } = await client()
        .from('feeds')
        .insert({ user_id: userId, url, name, category, active: true })
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    /** Supprime un feed */
    async function deleteFeed(feedId) {
      const { error } = await client().from('feeds').delete().eq('id', feedId);
      if (error) throw error;
    }

    /** Active/désactive un feed */
    async function toggleFeed(feedId, active) {
      const { error } = await client()
        .from('feeds')
        .update({ active })
        .eq('id', feedId);
      if (error) throw error;
    }

    /* ── ARTICLES ── */

    /** Récupère les articles d'un utilisateur (dernières 48h) */
    async function getArticles(userId, { days = 7, limit = 300, offset = 0 } = {}) {
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const { data, error } = await client()
        .from('articles')
        .select('*, feeds(name, category)')
        .eq('user_id', userId)
        .gte('pub_date', since)
        .order('pub_date', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return data || [];
    }

    /** Recherche full-text dans Supabase — cherche dans titre et ai_content */
    async function searchArticles(userId, query) {
      if (!query || query.trim().length < 2) return [];
      const q = query.trim().toLowerCase();
      const { data, error } = await client()
        .from('articles')
        .select('*, feeds(name, category)')
        .eq('user_id', userId)
        .or(`title.ilike.%${q}%,ai_content.ilike.%${q}%,content.ilike.%${q}%`)
        .order('pub_date', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    }

    /** Upsert un article — retourne l'id Supabase pour que l'appelant puisse l'assigner */
    async function upsertArticle(article) {
      const { data, error } = await client()
        .from('articles')
        .upsert(article, { onConflict: 'user_id,hash', ignoreDuplicates: false })
        .select('id')
        .single();

      if (error && error.code === '42P10') {
        // Contrainte composite absente — fallback sur hash seul
        const { error: error2 } = await client()
          .from('articles').upsert(article, { onConflict: 'hash' });
        if (error2) throw error2;
        return null;
      }
      if (error) throw error;
      return data?.id ?? null;
    }

    /** Met à jour le statut lu/bookmark d'un article */
    async function updateArticleStatus(articleId, { read, bookmarked }) {
      const update = {};
      if (read !== undefined) update.read = read;
      if (bookmarked !== undefined) update.bookmarked = bookmarked;
      const { error } = await client()
        .from('articles')
        .update(update)
        .eq('id', articleId);
      if (error) throw error;
    }

    /** Met à jour l'image d'un article */
    async function updateArticleImage(articleId, image) {
      const { error } = await client()
        .from('articles')
        .update({ image })
        .eq('id', articleId);
      if (error) throw error;
    }

    /* ── DIGEST ── */

    /** Récupère le digest du jour */
    async function getTodayDigest(userId) {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await client()
        .from('digests')
        .select('*')
        .eq('user_id', userId)
        .eq('date', today)
        .single();
      return data || null;
    }

    /** Sauvegarde le digest du jour */
    async function saveDigest(userId, content, heroImage = null) {
      const today = new Date().toISOString().split('T')[0];
      const payload = { user_id: userId, date: today, content, hero_image: heroImage };

      let { error } = await client()
        .from('digests')
        .upsert(payload, { onConflict: 'user_id,date' });

      // Compatibilité si la colonne hero_image n'existe pas encore en base
      if (error && (error.code === 'PGRST204' || error.code === '42703')) {
        ({ error } = await client()
          .from('digests')
          .upsert({ user_id: userId, date: today, content }, { onConflict: 'user_id,date' }));
      }

      if (error) throw error;
    }

    /** Récupère tous les articles bookmarkés (sans limite de date) */
    async function getBookmarks(userId) {
      const { data, error } = await client()
        .from('articles')
        .select('*, feeds(name, category)')
        .eq('user_id', userId)
        .eq('bookmarked', true)
        .order('pub_date', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    }

    /** Récupère les articles lus récemment (30 derniers jours) */
    async function getReadHistory(userId) {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await client()
        .from('articles')
        .select('*, feeds(name, category)')
        .eq('user_id', userId)
        .eq('read', true)
        .gte('pub_date', since)
        .order('pub_date', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    }

    return { getFeeds, addFeed, deleteFeed, toggleFeed, getArticles, searchArticles, getBookmarks, getReadHistory, upsertArticle, updateArticleStatus, updateArticleImage, getTodayDigest, saveDigest };
  })();

  /* ================================================================
     4. RSS — Fetch via Cloudflare Worker (évite le CORS)
     ================================================================ */
  const RSS = (() => {
    /**
     * Récupère et parse un feed RSS via le worker Cloudflare.
     * Le worker reçoit : GET /rss?url=<encoded>
     * Il retourne un JSON : { items: [{title, link, description, pubDate, content}] }
     */
    async function fetchFeed(feedUrl) {
      const url = `${CONFIG.WORKER_URL}/rss?url=${encodeURIComponent(feedUrl)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
      const data = await response.json();
      return data.items || [];
    }

    /**
     * Calcule un hash simple d'une chaîne (pour la déduplication)
     * Utilise un hash FNV-1a 32-bit (performant, sans dépendance)
     */
    function hashString(str) {
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      return hash.toString(16);
    }

    /**
     * Fetch tous les feeds actifs en parallèle (avec limite de concurrence)
     * Retourne un tableau plat d'articles bruts avec leur feed_id
     */
    async function fetchAllFeeds(feeds) {
      const activeFeeds = feeds.filter(f => f.active);
      const results = [];

      // Fetch par lots de 5 pour ne pas surcharger le worker
      for (let i = 0; i < activeFeeds.length; i += 5) {
        const batch = activeFeeds.slice(i, i + 5);
        const batchResults = await Promise.allSettled(
          batch.map(async (feed) => {
            const items = await fetchFeed(feed.url);
            return items.slice(0, CONFIG.MAX_ARTICLES_PER_FEED).map(item => ({
              feed_id: feed.id,
              feed_name: feed.name,
              feed_category: feed.category,
              title: item.title || '',
              link: item.link || '',
              description: stripHtml(item.description || ''),
              content: stripHtml(item.content || item.description || ''),
              pub_date: parseDate(item.pubDate),
              hash: hashString(item.link || item.title || ''),
              image: item.image || '',
              // Champs IA — remplis après
              ai_content: null,
              ai_tags: [],
              read: false,
              bookmarked: false,
            }));
          })
        );

        batchResults.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            results.push(...result.value);
          } else {
            console.warn(`Feed "${batch[idx].name}" failed:`, result.reason);
          }
        });
      }

      return results;
    }

    /** Supprime les balises HTML d'une chaîne */
    function stripHtml(html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      return tmp.textContent || tmp.innerText || '';
    }

    /** Parse une date RSS en ISO string */
    function parseDate(dateStr) {
      if (!dateStr) return new Date().toISOString();
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }

    return { fetchFeed, fetchAllFeeds, hashString };
  })();

  /* ================================================================
     5. GROQ AI — via Cloudflare Worker (clé API jamais exposée)
     ================================================================ */
  const AI = (() => {
    /** Délai utilitaire */
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /**
     * Appel générique au relay IA du worker.
     * Gère automatiquement le retry avec backoff exponentiel sur les erreurs 429.
     * Le worker reçoit : POST /ai { prompt, systemPrompt, model }
     * Il retourne : { text: "..." }
     */
    async function callGroq(systemPrompt, userPrompt, maxTokens = 800, retryCount = 0, model = null) {
      const usedModel = model || CONFIG.GROQ_MODEL_ENRICH;
      const response = await fetch(`${CONFIG.WORKER_URL}/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: usedModel,
          system: systemPrompt,
          prompt: userPrompt,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(30000),
      });

      // Gestion du rate limit : retry avec backoff exponentiel
      if (response.status === 429) {
        if (retryCount >= 3) {
          // Marquer le modèle comme épuisé — centralisé ici pour tous les appelants
          QuotaTracker.markExhausted(usedModel);
          throw new Error('QUOTA_EXHAUSTED');
        }
        // Attendre de plus en plus longtemps : 5s, 10s, 20s
        const waitMs = (5000) * Math.pow(2, retryCount);
        console.warn(`Groq 429 — attente ${waitMs / 1000}s avant retry ${retryCount + 1}/3`);
        await sleep(waitMs);
        return callGroq(systemPrompt, userPrompt, maxTokens, retryCount + 1, model);
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error ${response.status}: ${err}`);
      }

      // Incrémenter uniquement sur succès réel
      QuotaTracker.increment(usedModel);
      const data = await response.json();
      return data.text || '';
    }

    /**
     * Enrichit un article avec l'IA :
     *   - réécriture sans bruit
     *   - tags thématiques
     * Retourne { ai_content, ai_title, ai_tags }
     */
    /** Vérifie si un article a été correctement enrichi par l'IA */
    function isEnriched(article) {
      const ai = (article.ai_content || '').trim();
      const raw = (article.content || article.description || '').trim();
      return (
        ai.length > 80 &&                        // Contenu substantiel
        ai !== raw &&                            // Différent de l'original
        ai !== (article.title || '').trim() &&   // Pas juste le titre
        (article.ai_tags || []).length > 0 &&    // Tags générés
        !!article.ai_title                       // Titre traduit présent
      );
    }

    async function enrichArticle(article) {
      const rssText = [
        article.title || '',
        article.description || '',
        article.content || '',
      ].filter(Boolean).join('\n\n').substring(0, 4000);

      if (rssText.trim().length < 30) {
        return { ai_content: article.content || article.title || '', ai_tags: [] };
      }

      const systemPrompt = `Tu es un éditeur de presse expert. Tu réécris ou résumes les articles RSS en prose claire et fluide. Tu supprimes tout le bruit (publicités, appels à l'action, mentions légales). Tu réécris en 300-400 mots minimum, en plusieurs paragraphes. Si le contenu source est court, ajoute du contexte pertinent sur le sujet. Tu ne copies JAMAIS le texte original mot pour mot. Tu réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks. Langue de sortie : français.`;

      const prompt = `Réécris ou résume cet article et retourne exactement ce JSON (et rien d'autre) :
{"ai_title":"<titre traduit en français, concis et accrocheur, max 12 mots>","ai_content":"<réécriture ou résumé en prose fluide, jamais une copie de l'original, ajoute du contexte si le texte source est trop court>","importance":<1 à 5, 5=breaking news>,"ai_tags":["<thème1>","<thème2>","<thème3>"]}

TITRE : ${article.title}
SOURCE : ${article.feed_name}
TEXTE : ${rssText}`;

      const raw = await callGroq(systemPrompt, prompt, 1200);
      try {
        // Nettoyer les backticks markdown
        let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        // Remplacer les guillemets typographiques par des guillemets droits
        cleaned = cleaned.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "\'");
        // Corriger les sauts de ligne et caractères de contrôle dans les strings JSON
        cleaned = cleaned.replace(/"([^"]*?)"/g, (match) =>
          match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/[\x00-\x1F\x7F]/g, ' ')
        );

        // Tenter d'extraire le JSON — s'il est tronqué, tenter de le réparer
        let jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          // Tentative de réparation : fermer le JSON tronqué
          const partial = cleaned.match(/\{[\s\S]*/);
          if (partial) {
            try { JSON.parse(partial[0] + '"}'); jsonMatch = [partial[0] + '"}']; } catch {}
            if (!jsonMatch) { try { JSON.parse(partial[0] + '"}]}'); jsonMatch = [partial[0] + '"}]}']; } catch {} }
          }
        }
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        const aiText = parsed.ai_content || '';
        const isDistinct = aiText.length > 50 && aiText !== article.content;
        return {
          ai_title:   parsed.ai_title || null,
          ai_content: isDistinct ? aiText : (article.content || article.title),
          importance: Math.min(5, Math.max(1, parseInt(parsed.importance) || 1)),
          ai_tags:    Array.isArray(parsed.ai_tags) ? parsed.ai_tags.slice(0, 5) : [],
        };
      } catch (err) {
        console.warn(`Parsing JSON échoué pour "${article.title}":`, err, '\nRaw:', raw);
        return { ai_title: null, ai_content: article.content, importance: 1, ai_tags: [] };
      }
    }

    function getDigestArticles(articles) {
      const today = new Date().toISOString().split('T')[0];

      let topArticles = articles
        .filter(a => a.pub_date && a.pub_date.startsWith(today) && isEnriched(a))
        .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date))
        .slice(0, 10);

      if (topArticles.length < 3) {
        const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        topArticles = articles
          .filter(a => a.pub_date && a.pub_date >= since && isEnriched(a))
          .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date))
          .slice(0, 10);
      }

      if (topArticles.length === 0) {
        topArticles = articles
          .filter(a => isEnriched(a))
          .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date))
          .slice(0, 10);
      }

      return topArticles;
    }


    /**
     * Génère le digest du jour à partir des articles importants
     * Retourne du texte structuré (HTML simple)
     */
    async function generateDailyDigest(articles) {
      const topArticles = getDigestArticles(articles);

      if (topArticles.length === 0) {
        throw new Error('Aucun article enrichi disponible. Ouvrez quelques articles d\'abord.');
      }

      // Envoyer ai_content si disponible, sinon le titre
      const articlesText = topArticles.map((a, i) => {
        const titre = a.ai_title || a.title || '';
        const contenu = (a.ai_content || '').substring(0, 400);
        return `[${i + 1}] ${titre} (${a.feed_name})\n${contenu}`;
      }).join('\n\n');

      const digest = await callGroq(
        `Tu es un éditeur de presse senior. Tu rédiges des briefings synthétiques.
RÈGLES ABSOLUES :
- Réponds UNIQUEMENT en HTML valide, JAMAIS en markdown
- N'utilise JAMAIS #, ##, ###, **, *, - pour formater
- N'utilise JAMAIS <strong>, <b>, <em>, <i> — aucun texte en gras ou italique
- Utilise UNIQUEMENT ces balises : <h2>, <p>, <ul>, <li>
- Pas d'introduction, pas de conclusion, pas de titre général
- Langue : français
- Cite les sources entre parenthèses dans le texte`,
        `Rédige un briefing très court et dense. 3 thèmes maximum. Pour chaque thème : un <h2> avec le nom du thème, un <p> de synthèse d'1 phrase maximum, et une <ul> avec 2 points clés maximum. Sois concis, va à l'essentiel.\n\n${articlesText}`,
        1500,
        0,
        CONFIG.GROQ_MODEL_DIGEST
      );

      return digest;
    }

    return { enrichArticle, generateDailyDigest, callGroq, isEnriched, getDigestArticles };
  })();

  /* ================================================================
     6. DÉDUPLICATION & CLUSTERING
     ================================================================ */
  const Cluster = (() => {
    /**
     * Calcule la similarité de Jaccard entre deux ensembles de mots.
     * Simple mais efficace pour détecter les doublons de titre.
     */
    function jaccardSimilarity(str1, str2) {
      const words1 = new Set(tokenize(str1));
      const words2 = new Set(tokenize(str2));
      if (words1.size === 0 && words2.size === 0) return 0;
      const intersection = new Set([...words1].filter(w => words2.has(w)));
      const union = new Set([...words1, ...words2]);
      return union.size === 0 ? 0 : intersection.size / union.size;
    }

    /** Tokenise une chaîne en mots (lowercase, sans stop-words) */
    function tokenize(str) {
      const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du',
        'en', 'et', 'est', 'il', 'elle', 'ils', 'elles', 'on', 'au', 'aux', 'avec',
        'the', 'a', 'an', 'is', 'in', 'of', 'to', 'for', 'and', 'or', 'but', 'it']);
      return str.toLowerCase()
        .replace(/[^a-z0-9àâéèêëîïôùûü]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    }

    /**
     * Déduplique un tableau d'articles.
     * Si deux articles ont une similarité de titre > DEDUP_THRESHOLD,
     * on garde le plus récent.
     * Retourne { unique: [], duplicates: [] }
     */
    function deduplicate(articles) {
      const unique = [];
      const duplicates = [];

      for (const article of articles) {
        let isDuplicate = false;
        for (const kept of unique) {
          const sim = jaccardSimilarity(article.title, kept.title);
          if (sim >= CONFIG.DEDUP_THRESHOLD) {
            isDuplicate = true;
            // Si le doublon a une importance plus élevée, mettre à jour le principal


            duplicates.push(article);
            break;
          }
        }
        if (!isDuplicate) unique.push(article);
      }

      return { unique, duplicates };
    }

    return { deduplicate };
  })();

  /* ================================================================
     7. UI — Navigation & Vues
     ================================================================ */
  const Nav = (() => {
    /** Change la vue active */
    function switchView(viewId) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

      const targetView = document.getElementById(`view-${viewId}`);
      const targetNav = document.querySelector(`[data-view="${viewId}"]`);

      if (targetView) targetView.classList.add('active');
      if (targetNav) targetNav.classList.add('active');

      STATE.currentView = viewId;

      // Fermer la sidebar sur mobile
      document.getElementById('sidebar').classList.remove('open');

      // Scroll to top
      document.getElementById('main-content').scrollTop = 0;

      // Charger les vues dynamiques à la demande
      if (viewId === 'bookmarks') Render.renderBookmarks(STATE.articles);
    }

    /** Initialise la navigation */
    function init() {
      // Liens de navigation
      document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          switchView(item.dataset.view);
        });
      });

      // Toggle sidebar mobile
      const toggle = document.getElementById('sidebar-toggle');
      const sidebar = document.getElementById('sidebar');

      const toggleSidebar = () => sidebar.classList.toggle('open');
      if (toggle) toggle.addEventListener('click', toggleSidebar);

      // Hamburger inline (aligné avec FLUX sur mobile)
      const inlineToggle = document.getElementById('sidebar-toggle-inline');
      if (inlineToggle) inlineToggle.addEventListener('click', toggleSidebar);

      // Hamburger dans les autres vues
      const toggleBookmarks = document.getElementById('sidebar-toggle-bookmarks');
      const toggleSettings  = document.getElementById('sidebar-toggle-settings');
      if (toggleBookmarks) toggleBookmarks.addEventListener('click', toggleSidebar);
      if (toggleSettings)  toggleSettings.addEventListener('click', toggleSidebar);

      // Fermer sidebar en cliquant en dehors
      // On exclut tous les boutons hamburger pour éviter le bubbling qui referme immédiatement
      const allToggles = [toggle, inlineToggle, toggleBookmarks, toggleSettings].filter(Boolean);
      document.addEventListener('click', (e) => {
        if (window.innerWidth <= 600 &&
          sidebar.classList.contains('open') &&
          !sidebar.contains(e.target) &&
          !allToggles.some(t => t.contains(e.target))) {
          sidebar.classList.remove('open');
        }
      });

    }

    return { init, switchView };
  })();

  /* ================================================================
     7b. THEME — Mode sombre / clair
     ================================================================ */
  const Theme = (() => {
    const STORAGE_KEY = 'synapse_theme';

    function init() {
      // Restaurer la préférence sauvegardée
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'dark') enable(false);
      // Nettoyer la classe anti-flash
      document.documentElement.classList.remove('dark-init');

      const btn = document.getElementById('btn-theme-toggle');
      if (btn) {
        btn.addEventListener('click', () => {
          document.body.classList.contains('dark') ? disable() : enable();
        });
      }
    }

    function enable(save = true) {
      document.body.classList.add('dark');
      const btn = document.getElementById('btn-theme-toggle');
      if (btn) btn.textContent = '☀';
      if (save) localStorage.setItem(STORAGE_KEY, 'dark');
    }

    function disable() {
      document.body.classList.remove('dark');
      const btn = document.getElementById('btn-theme-toggle');
      if (btn) btn.textContent = '☽';
      localStorage.setItem(STORAGE_KEY, 'light');
    }

    return { init };
  })();

  /* ================================================================
     7c. FONT SIZE — Taille police dans le reader
     ================================================================ */
  const FontSize = (() => {
    const SIZES = ['sm', 'md', 'lg', 'xl'];
    const STORAGE_KEY = 'synapse_fontsize';
    let current = 'md';

    function init() {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SIZES.includes(saved)) set(saved, false);

      document.querySelectorAll('.font-size-btn').forEach(btn => {
        btn.addEventListener('click', () => set(btn.dataset.size));
      });
    }

    function set(size, save = true) {
      current = size;
      const contentEl = document.getElementById('reader-content');
      if (contentEl) {
        SIZES.forEach(s => contentEl.classList.remove(`font-${s}`));
        contentEl.classList.add(`font-${size}`);
      }
      // Mettre à jour l'état actif des boutons (ils sont reader-btn + font-size-btn)
      document.querySelectorAll('.font-size-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.size === size);
      });
      if (save) localStorage.setItem(STORAGE_KEY, size);
    }

    function getCurrent() { return current; }
    return { init, set, getCurrent };
  })();

  /* ================================================================
     7d. OPML — Import / Export
     ================================================================ */
  const OPML = (() => {
    function exportOPML(feeds) {
      const items = feeds.map(f => `    <outline type="rss" text="${escXml(f.name)}" title="${escXml(f.name)}" xmlUrl="${escXml(f.url)}" category="${escXml(f.category || '')}"/>`).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Synapse Feeds</title></head>\n  <body>\n${items}\n  </body>\n</opml>`;
      const blob = new Blob([xml], { type: 'text/xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `synapse-feeds-${new Date().toISOString().split('T')[0]}.opml`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    async function importOPML(file, userId) {
      const text = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/xml');
      const outlines = [...doc.querySelectorAll('outline[xmlUrl]')];
      let added = 0;
      for (const o of outlines) {
        const url = o.getAttribute('xmlUrl');
        const name = o.getAttribute('title') || o.getAttribute('text') || new URL(url).hostname;
        const category = o.getAttribute('category') || 'Général';
        if (!STATE.feeds.find(f => f.url === url)) {
          try {
            const feed = await DB.addFeed(userId, url, name, category);
            STATE.feeds.push(feed);
            added++;
          } catch {}
        }
      }
      return added;
    }

    function escXml(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return { exportOPML, importOPML };
  })();

  /* ================================================================
     7e. RSS AUTO-DETECT — Détecte le flux RSS depuis une URL de site
     ================================================================ */
  const RSSDetect = (() => {
    const COMMON_PATHS = ['/rss', '/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/rss/all', '/feeds/posts/default'];

    async function detect(inputUrl) {
      if (!inputUrl.startsWith('http')) inputUrl = 'https://' + inputUrl;
      let base;
      try { base = new URL(inputUrl); } catch { return []; }

      // Si l'URL ressemble déjà à un feed, la tester directement
      if (inputUrl.match(/\.(rss|xml|atom)$/i) || inputUrl.includes('/rss') || inputUrl.includes('/feed')) {
        try {
          const res = await fetch(`${CONFIG.WORKER_URL}/rss?url=${encodeURIComponent(inputUrl)}`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const data = await res.json();
            if (data.items && data.items.length > 0) {
              return [{ url: inputUrl, label: `✓ Feed valide (${data.items.length} articles)` }];
            }
          }
        } catch {}
        return [];
      }

      // Tester les paths courants en parallèle via le worker
      const results = await Promise.allSettled(
        COMMON_PATHS.map(async path => {
          const url = `${base.origin}${path}`;
          const res = await fetch(`${CONFIG.WORKER_URL}/rss?url=${encodeURIComponent(url)}`, {
            signal: AbortSignal.timeout(5000)
          });
          if (!res.ok) throw new Error('not found');
          const data = await res.json();
          if (!data.items || data.items.length === 0) throw new Error('empty');
          return { url, label: `${path} (${data.items.length} articles)` };
        })
      );

      return results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
    }

    return { detect };
  })();


  const Render = (() => {
    /** Formate une date relative (il y a X heures) */
    function relativeTime(isoDate) {
      const diff = Date.now() - new Date(isoDate).getTime();
      const hours = Math.floor(diff / 3600000);
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `Il y a ${mins} min`;
      if (hours < 24) return `Il y a ${hours}h`;
      return new Date(isoDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    }

    /** Crée une card article (vue grille, home) */
    /** Crée une ligne article (vue liste, flux / bookmarks) */
    function articleRow(article, index, articleList) {
      const isBookmarked = STATE.bookmarks.has(article.id || article.hash);

      const row = document.createElement('div');
      row.dataset.hash = article.hash || '';
      row.style.animationDelay = `${index * 30}ms`;

      row.className = `article-row${article.read ? ' read' : ''}`;
      row.innerHTML = `
        <div class="row-body">
          <div class="row-source">${escapeHtml(article.feed_name || '')} · ${relativeTime(article.pub_date)}</div>
          <div class="row-title">${escapeHtml(article.ai_title || article.title || '')}</div>
          ${(() => {
            const excerpt = article.ai_content || article.description || article.content || '';
            return excerpt ? `<div class="row-excerpt">${escapeHtml(excerpt.substring(0, 120))}…</div>` : '';
          })()}
          <div class="row-meta">${(article.ai_tags || []).slice(0, 3).join(' · ')}</div>
        </div>
        <div class="row-actions">
          <button class="row-action-btn${isBookmarked ? ' bookmarked' : ''}" data-action="bookmark" title="Sauvegarder">◧</button>
        </div>
      `;

      row.addEventListener('click', (e) => {
        if (!e.target.closest('[data-action]')) {
          Reader.open(article, index, articleList);
        }
      });

      const bookmarkBtn = row.querySelector('[data-action="bookmark"]');
      if (bookmarkBtn) {
        bookmarkBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleBookmark(article, bookmarkBtn);
        });
      }

      return row;
    }

    /** Toggle bookmark d'un article */
    async function toggleBookmark(article, btn) {
      const key = article.id || article.hash;
      const isBookmarked = STATE.bookmarks.has(key);
      const hash = article.hash || '';

      if (isBookmarked) {
        STATE.bookmarks.delete(key);
        article.bookmarked = false;
        // Mettre à jour tous les boutons bookmark de cet article dans le DOM
        document.querySelectorAll(`[data-hash="${hash}"] [data-action="bookmark"]`).forEach(b => {
          b.classList.remove('bookmarked');
        });
      } else {
        STATE.bookmarks.add(key);
        article.bookmarked = true;
        document.querySelectorAll(`[data-hash="${hash}"] [data-action="bookmark"]`).forEach(b => {
          b.classList.add('bookmarked');
        });
      }

      // Sauvegarder en DB si l'article a un ID
      if (article.id && STATE.user) {
        try {
          await DB.updateArticleStatus(article.id, { bookmarked: !isBookmarked });
        } catch (err) {
          console.warn('Impossible de sauvegarder le bookmark:', err);
        }
      }
    }

    /** Échappe le HTML pour éviter les XSS */
    function importanceBars(score) {
      return Array.from({ length: 5 }, (_, i) => {
        const active = i < score;
        const color = `var(--imp-${Math.max(1, score)})`;
        return `<div class="imp-bar" style="${active ? `background:${color}` : ''}"></div>`;
      }).join('');
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    /** Rendu vue FLUX — liste filtrée */
    function renderFeedArticles(articles, filter = 'all', query = '') {
      const container = document.getElementById('feed-articles');
      // Mettre à jour les stats d'accueil
      const statsEl = document.getElementById('feed-welcome-stats');
      container.innerHTML = '';

      // Si une recherche Supabase est active, utiliser ses résultats
      const sourceArticles = STATE.searchResults !== null ? STATE.searchResults : articles;

      let filtered = [...sourceArticles];

      // Filtre par feed sélectionné dans la sidebar (sauf si recherche active)
      if (STATE.currentFeedFilter && STATE.searchResults === null) {
        filtered = filtered.filter(a => a.feed_id === STATE.currentFeedFilter);
      }

      // Filtres
      if (filter === 'unread') filtered = filtered.filter(a => !a.read);

      // Recherche locale (si pas de résultats Supabase)
      if (query && STATE.searchResults === null) {
        const q = query.toLowerCase();
        filtered = filtered.filter(a =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.ai_content || a.content || '').toLowerCase().includes(q) ||
          (a.ai_tags || []).some(t => t.toLowerCase().includes(q))
        );
      }

      // Tri intelligent :
      // Si pas de filtre actif et pas de recherche → articles importants non lus en tête
      // Sinon → chronologique pur
      // Tri chronologique pur
      filtered.sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));

      const totalCount = filtered.length;
      const label = STATE.searchResults !== null
        ? `${totalCount} résultat${totalCount !== 1 ? 's' : ''} (base complète)`
        : `${totalCount} article${totalCount !== 1 ? 's' : ''}`;


      // Mettre à jour les stats d'accueil si en mode recherche
      if (statsEl && STATE.searchResults !== null) {
        statsEl.textContent = label;
      }

      if (filtered.length === 0) {
        const msg = STATE.isSearching
          ? 'Recherche en cours...'
          : STATE.searchResults !== null
            ? 'Aucun résultat dans la base de données.'
            : 'Aucun article ne correspond à ce filtre.';
        container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">≡</span><p class="empty-state-text">${msg}</p></div>`;
        return;
      }

      // Infinite scroll — afficher par tranches de 20
      const PAGE_SIZE = 20;
      const page = STATE.articlesPage || 0;
      const paginated = filtered.slice(0, (page + 1) * PAGE_SIZE);

      // Rendu de la page courante
      paginated.forEach((article, i) => {
        container.appendChild(articleRow(article, i, filtered));
      });

      // Infinite scroll — sentinel en bas de liste
      if (paginated.length < filtered.length) {
        const sentinel = document.createElement('div');
        sentinel.className = 'scroll-sentinel';
        sentinel.style.cssText = 'height: 40px; display: flex; align-items: center; justify-content: center;';
        sentinel.innerHTML = '<span style="font-family:var(--font-mono);font-size:0.6rem;color:var(--grey-light);letter-spacing:0.1em;">Chargement...</span>';
        container.appendChild(sentinel);

        // Observer qui déclenche le chargement quand le sentinel est visible
        const observer = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) {
            observer.disconnect();
            STATE.articlesPage = (STATE.articlesPage || 0) + 1;
            renderFeedArticles(articles, filter, query);
          }
        }, { rootMargin: '100px' });

        observer.observe(sentinel);
      }
    }

    /** Rendu vue BOOKMARKS */
    async function renderBookmarks(articles) {
      const container = document.getElementById('bookmarks-articles');
      container.innerHTML = '<div class="content-loading"><div class="spinner"></div><span>Chargement...</span></div>';

      // Charger depuis Supabase pour avoir TOUS les bookmarks sans limite de date
      let bookmarked = [];
      if (STATE.user) {
        try {
          const data = await DB.getBookmarks(STATE.user.id);
          bookmarked = data.map(a => ({
            ...a,
            feed_name: a.feeds?.name || a.feed_name || '',
            feed_category: a.feeds?.category || a.feed_category || '',
          }));
        } catch {
          // Fallback sur les articles en mémoire
          bookmarked = articles.filter(a => STATE.bookmarks.has(a.id || a.hash) || a.bookmarked);
        }
      } else {
        bookmarked = articles.filter(a => STATE.bookmarks.has(a.id || a.hash) || a.bookmarked);
      }

      container.innerHTML = '';

      if (bookmarked.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon">◧</span><p class="empty-state-text">Aucun article sauvegardé. Cliquez sur ◧ dans le lecteur ou la liste.</p></div>';
        return;
      }

      bookmarked.forEach((article, i) => {
        container.appendChild(articleRow(article, i, bookmarked));
      });
    }

    /** Rendu sidebar — liste des feeds */
    function renderSidebarFeeds(feeds) {
      const list = document.getElementById('feeds-list');
      list.innerHTML = '';

      // Item "Tous les feeds"
      const allLi = document.createElement('li');
      allLi.textContent = 'Tous les feeds';
      allLi.className = STATE.currentFeedFilter === null ? 'active' : '';
      allLi.addEventListener('click', () => {
        STATE.currentFeedFilter = null;
        STATE.searchResults = null;
        STATE.articlesPage = 0;
        document.querySelectorAll('#feeds-list li').forEach(l => l.classList.remove('active'));
        allLi.classList.add('active');
        Nav.switchView('feed');
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
      });
      list.appendChild(allLi);

      // Grouper les feeds actifs par catégorie
      const activeFeeds = feeds.filter(f => f.active);
      const groups = {};
      activeFeeds.forEach(feed => {
        const cat = feed.category || 'Général';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(feed);
      });

      // Afficher chaque groupe avec son label
      Object.entries(groups).forEach(([category, groupFeeds]) => {
        // Label de catégorie
        const catLabel = document.createElement('li');
        catLabel.className = 'sidebar-category-label';
        catLabel.textContent = category.toUpperCase();
        list.appendChild(catLabel);

        groupFeeds.forEach(feed => {
          const li = document.createElement('li');
          li.className = STATE.currentFeedFilter === feed.id ? 'active' : '';

          // Compter les articles non lus pour ce feed
          const unreadCount = STATE.articles.filter(a =>
            a.feed_id === feed.id && !STATE.readArticles.has(a.id || a.hash)
          ).length;

          li.innerHTML = `
            <span class="feed-name">${feed.name || feed.url}</span>
            ${unreadCount > 0 ? `<span class="feed-unread-count">${unreadCount}</span>` : ''}
          `;
          li.addEventListener('click', () => {
            STATE.currentFeedFilter = feed.id;
            STATE.searchResults = null;
            STATE.articlesPage = 0;
            document.querySelectorAll('#feeds-list li').forEach(l => l.classList.remove('active'));
            li.classList.add('active');
            Nav.switchView('feed');
            Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
          });
          list.appendChild(li);
        });
      });
    }

    /** Rendu de l'en-tête d'accueil — date, stats, sujets */
    function renderWelcome() {
      const dateEl = document.getElementById('feed-welcome-date');
      const statsEl = document.getElementById('feed-welcome-stats');
      const topicsEl = document.getElementById('feed-topics');

      const dateStr = new Date().toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
      if (dateEl) dateEl.textContent = dateStr;

      const unread = STATE.articles.filter(a => !a.read).length;
      const total = STATE.articles.length;
            let statsText = dateStr;
      if (total > 0) statsText += ` · ${total} article${total > 1 ? 's' : ''}`;
      if (unread > 0) statsText += ` · ${unread} non lu${unread > 1 ? 's' : ''}`;
      if (statsEl) statsEl.textContent = statsText;

      if (topicsEl) {
        const tagCount = {};
        STATE.articles.forEach(a => (a.ai_tags || []).forEach(t => {
          const k = t.toLowerCase().trim();
          tagCount[k] = (tagCount[k] || 0) + 1;
        }));
        const topTags = Object.entries(tagCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([tag]) => tag);

        topicsEl.innerHTML = topTags.length
          ? topTags.map(t => `<button class="topic-chip" data-topic="${t}">${t}</button>`).join('')
          : '';

        topicsEl.querySelectorAll('.topic-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const q = btn.dataset.topic;
            const searchBar = document.getElementById('search-bar');
            const searchInput = document.getElementById('search-input');
            if (searchBar) searchBar.classList.remove('hidden');
            if (searchInput) {
              searchInput.value = q;
              searchInput.dispatchEvent(new Event('input'));
              searchInput.focus();
            }
          });
        });
      }
    }

    return {
      articleRow, renderFeedArticles,
      renderBookmarks, renderSidebarFeeds,
      renderWelcome, escapeHtml, relativeTime, importanceBars,    };
  })();

  /* ================================================================
     9. UI — READER (Mode Focus)
     ================================================================ */
  const Reader = (() => {

    /** Ouvre le reader pour un article */
    function open(article, index, articleList) {
      STATE.currentArticleIndex = index;
      STATE.currentArticleList = articleList;

      markRead(article);
      populate(article);
      updateNavLabels();

      const overlay = document.getElementById('reader-overlay');
      const modal = document.getElementById('reader-modal');
      modal.classList.add('reader-opening');
      overlay.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      scheduleReaderReveal();
      document.getElementById('btn-close-reader').focus();

      const articleRef = STATE.currentArticleList[STATE.currentArticleIndex] || article;

      if (!AI.isEnriched(articleRef)) {
        // Masquer titre, chapô, contenu brut — afficher shimmer
        _showContentLoader();
        enrichOnOpen(articleRef);
      } else {
        // Article déjà enrichi — fade in élégant de tout
        _revealContent();
      }
    }

    /** Masque le contenu et affiche un shimmer pendant l'enrichissement */
    function _showContentLoader() {
      const titleEl   = document.getElementById('reader-title');
      const chapoEl   = document.getElementById('reader-chapo');
      const contentEl = document.getElementById('reader-content');
      const tagsEl    = document.getElementById('reader-tags');
      const impEl     = document.getElementById('reader-imp-bars');

      // Masquer instantanément le contenu brut
      [titleEl, chapoEl, tagsEl, impEl].forEach(el => {
        if (el) { el.style.opacity = '0'; el.style.transition = 'none'; }
      });

      // Contenu vide pendant le chargement
      if (contentEl) {
        contentEl.innerHTML = '';
        contentEl.style.opacity = '1';
        contentEl.style.transition = 'none';
      }
    }

    /** Révèle le contenu enrichi avec une animation fluide et gracieuse */
    function _revealContent(delay = 0) {
      const modal     = document.getElementById('reader-modal');
      const titleEl   = document.getElementById('reader-title');
      const chapoEl   = document.getElementById('reader-chapo');
      const contentEl = document.getElementById('reader-content');
      const tagsEl    = document.getElementById('reader-tags');
      const impEl     = document.getElementById('reader-imp-bars');

      const elements = [
        { el: titleEl,   d: 0   },
        { el: chapoEl,   d: 80  },
        { el: impEl,     d: 120 },
        { el: tagsEl,    d: 160 },
        { el: contentEl, d: 200 },
      ];

      elements.forEach(({ el, d }) => {
        if (!el) return;
        el.style.opacity = '0';
        el.style.transform = 'translateY(12px)';
        el.style.transition = 'none';
        setTimeout(() => {
          el.style.transition = 'opacity 0.5s ease, transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
          setTimeout(() => {
            el.style.transition = '';
            el.style.transform = '';
          }, 550);
        }, delay + d);
      });
    }

    /**
     * Enrichit un article avec l'IA au moment de son ouverture.
     * Affiche un indicateur de chargement dans le reader pendant le traitement.
     */
    async function enrichOnOpen(article) {
      // Vérifier le quota avant tout appel
      if (QuotaTracker.isExhausted(CONFIG.GROQ_MODEL_ENRICH)) {
        _showQuotaWarning();
        return;
      }

      // Désactiver le bouton TTS pendant l'enrichissement
      const ttsBtn = document.getElementById('btn-listen');
      if (ttsBtn) ttsBtn.disabled = true;

      try {
        const result = await AI.enrichArticle(article);

        // Nettoyer ai_content — remplacer les vrais sauts de ligne par des espaces
        const cleanAiContent = (result.ai_content || '').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        article.ai_content = cleanAiContent;
        article.ai_title = result.ai_title || null;
        article.importance = result.importance || 1;
        article.ai_tags = result.ai_tags;

        // Sync avec STATE.articles — même hash, même objet mis à jour
        const stateRef = STATE.articles.find(a => a.hash === article.hash);
        if (stateRef && stateRef !== article) {
          stateRef.ai_content = cleanAiContent;
          stateRef.ai_title = result.ai_title || null;
          stateRef.importance = result.importance || 1;
            stateRef.ai_tags = result.ai_tags;
        }

        if (STATE.user) {
          DB.upsertArticle({
            feed_id:    article.feed_id    || null,
            user_id:    STATE.user.id,
            hash:       article.hash,
            title:      article.title      || '',
            link:       article.link       || '',
            content:    article.content    || '',
            ai_title:   result.ai_title    || null,
            ai_content: cleanAiContent     || '',
            ai_tags:    result.ai_tags     || [],
            pub_date:   article.pub_date   || new Date().toISOString(),
            read:       article.read       || false,
            bookmarked: article.bookmarked || false,
            image:      article.image      || null,
          }).then(newId => {
            if (newId && !article.id) {
              article.id = newId;
              const stateRef2 = STATE.articles.find(a => a.hash === article.hash);
              if (stateRef2) stateRef2.id = newId;
            }
          }).catch(err => console.warn('Sauvegarde Supabase échouée:', err));
        }

        // Réactiver le bouton TTS
        const ttsBtnAfter = document.getElementById('btn-listen');
        if (ttsBtnAfter) ttsBtnAfter.disabled = false;

        const currentArticle = STATE.currentArticleList[STATE.currentArticleIndex];
        if (currentArticle && currentArticle.hash === article.hash) {
          const modal = document.getElementById('reader-modal');

          // 1. Mesurer la hauteur AVANT populate (modal encore petite)
          const fromH = modal ? modal.scrollHeight : 0;

          // 2. Fixer la hauteur actuelle pour bloquer le saut
          if (modal) {
            modal.style.transition = 'none';
            modal.style.height = fromH + 'px';
            modal.style.overflow = 'hidden';
          }

          // 3. Populate remplit le DOM (invisible car éléments à opacity 0)
          populate(article, false);

          // 4. Après deux frames — DOM rendu, mesurer la nouvelle hauteur
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (modal) {
                const toH = modal.scrollHeight;
                modal.style.transition = 'height 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
                modal.style.height = toH + 'px';
                setTimeout(() => {
                  modal.style.height = '';
                  modal.style.overflow = '';
                  modal.style.transition = '';
                }, 580);
              }
              // 5. Reveal les éléments en stagger
              _revealContent(30);
            });
          });
        }

        // Mettre à jour la row dans le feed sans re-render complet
        _updateFeedRow(article);

      } catch (err) {
        // Réactiver le bouton TTS même en cas d'erreur
        const ttsBtnErr = document.getElementById('btn-listen');
        if (ttsBtnErr) ttsBtnErr.disabled = false;
        if (err.message === 'QUOTA_EXHAUSTED') {
          _showQuotaWarning();
        } else {
          console.warn('Enrichissement IA échoué:', err);
          Toast.show('IA indisponible — réessayez plus tard', 'info');
        }
      } finally {
        if (titleEl) titleEl.style.opacity = '';
      }
    }

    /**
     * Met à jour chirurgicalement la row d'un article dans le feed
     * après enrichissement IA — sans re-render tout le feed.
     */
    function _updateFeedRow(article) {
      const hash = article.hash || '';
      const rows = document.querySelectorAll(`[data-hash="${hash}"]`);
      if (!rows.length) return;


      rows.forEach(row => {
        // ── Row ──
        if (row.classList.contains('article-row')) {
          const titleEl   = row.querySelector('.row-title');
          const excerptEl = row.querySelector('.row-excerpt');
          const metaEl    = row.querySelector('.row-meta');
          if (titleEl) titleEl.textContent = article.ai_title || article.title || '';
          if (metaEl)  metaEl.textContent  = (article.ai_tags || []).slice(0, 3).join(' · ');
          if (article.ai_content) {
            if (excerptEl) {
              excerptEl.textContent = article.ai_content.substring(0, 120) + '…';
            } else {
              // Créer l'excerpt s'il n'existait pas (article sans résumé au départ)
              const rowBody = row.querySelector('.row-body');
              if (rowBody) {
                const div = document.createElement('div');
                div.className = 'row-excerpt';
                div.textContent = article.ai_content.substring(0, 120) + '…';
                // Insérer après le titre
                const titleInBody = rowBody.querySelector('.row-title');
                if (titleInBody && titleInBody.nextSibling) {
                  rowBody.insertBefore(div, titleInBody.nextSibling);
                } else {
                  rowBody.appendChild(div);
                }
              }
            }
          }
        }
      });
    }

    /** Affiche un avertissement quota dans le reader */
    function _showQuotaWarning() {
      const contentEl = document.getElementById('reader-content');
      if (!contentEl) return;
      // Ne pas écraser un contenu déjà présent
      if (contentEl.querySelector('.quota-warning')) return;
      const warn = document.createElement('div');
      warn.className = 'quota-warning';
      warn.innerHTML = `
        <div class="quota-warning-icon">⊘</div>
        <div class="quota-warning-text">
          Quota IA atteint pour aujourd'hui.<br>
          L'article s'affiche en version originale.<br>
          <span class="quota-warning-sub">Remise à zéro à minuit UTC</span>
        </div>
      `;
      contentEl.prepend(warn);
      Toast.show('Quota IA atteint — remise à zéro à minuit', 'info', 5000);
    }

    /** Applique l'image hero en fond de la zone titre */
    function _setHeroImage(article) {
      const titleArea = document.getElementById('reader-title-area');
      const modal = document.getElementById('reader-modal');
      if (!titleArea) return;

      // Reset — supprimer le hero-bg précédent
      const oldBg = titleArea.querySelector('.hero-bg');
      if (oldBg) oldBg.remove();
      titleArea.classList.remove('has-hero');
      if (modal) modal.classList.remove('hero-ready');

      const img = article.image || '';
      if (img) {
        // Appliquer border:none immédiatement, avant le chargement de l'image
        if (modal) modal.classList.add('hero-ready');
        _applyHero(titleArea, img);
        return;
      }

      // Pas d'image RSS → tenter OG scrape en arrière-plan (silencieux)
      if (article.link) {
        fetch(`${CONFIG.WORKER_URL}/scrape?url=${encodeURIComponent(article.link)}`, {
          signal: AbortSignal.timeout(8000),
        })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (!data?.ogImage) return;
            const current = STATE.currentArticleList[STATE.currentArticleIndex];
            if (current?.hash !== article.hash) return;
            _persistArticleImage(article, data.ogImage);
            if (modal) modal.classList.add('hero-ready');
            _applyHero(titleArea, data.ogImage);
          })
          .catch(() => {});
      }
    }

    /** Persiste l'image d'un article en mémoire + Supabase */
    function _persistArticleImage(article, imageUrl) {
      if (!imageUrl) return;

      article.image = imageUrl;

      // Sync avec STATE.articles
      const stateRef = STATE.articles.find(a => a.hash === article.hash);
      if (stateRef && stateRef !== article) {
        stateRef.image = imageUrl;
      }

      // Persister le cache local pour éviter la perte au refresh
      if (STATE.user) Cache.save(STATE.user.id, STATE.articles);

      // Sauvegarder en base si l'article existe déjà, sinon upsert complet
      if (STATE.user) {
        if (article.id) {
          DB.updateArticleImage(article.id, imageUrl).catch(err =>
            console.warn('Sauvegarde image (update) échouée:', err)
          );
        } else {
          DB.upsertArticle({
            feed_id:    article.feed_id || null,
            user_id:    STATE.user.id,
            hash:       article.hash,
            title:      article.title      || '',
            link:       article.link       || '',
            content:    article.content    || '',
            ai_title:   article.ai_title   || null,
            ai_content: article.ai_content || '',
            ai_tags:    article.ai_tags    || [],
            pub_date:   article.pub_date   || new Date().toISOString(),
            read:       article.read       || false,
            bookmarked: article.bookmarked || false,
            image:      imageUrl,
          }).catch(err => console.warn('Sauvegarde image (upsert) échouée:', err));
        }
      }
    }

    /** Injecte un div.hero-bg avec fade-in — le contenu reste visible en permanence */
    function _applyHero(titleArea, url) {
      const img = new Image();
      img.onload = () => {
        // Créer le div image
        const bg = document.createElement('div');
        bg.className = 'hero-bg';
        bg.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
        titleArea.insertBefore(bg, titleArea.firstChild);
        titleArea.classList.add('has-hero');
        // Forcer reflow puis fade-in
        void bg.offsetHeight;
        bg.classList.add('hero-visible');
      };
      img.onerror = () => {};
      img.src = url;
    }

    /** Ferme le reader avec animation */
    function close() {
      TTS.stop();
      const overlay = document.getElementById('reader-overlay');
      const modal = document.getElementById('reader-modal');

      // Animer la sortie : modal descend + fade out
      modal.style.transition = 'transform 0.28s cubic-bezier(0.4, 0.0, 1, 1), opacity 0.22s ease';
      modal.style.transform = 'translateY(20px)';
      modal.style.opacity = '0';

      // Overlay fade out
      overlay.style.transition = 'opacity 0.28s ease';
      overlay.style.opacity = '0';

      // Masquer après la fin de l'animation
      setTimeout(() => {
        overlay.classList.add('hidden');
        // Reset les styles inline pour ne pas interférer avec la prochaine ouverture
        modal.style.transition = '';
        modal.style.transform = '';
        modal.style.opacity = '';
        overlay.style.transition = '';
        overlay.style.opacity = '';
        document.body.style.overflow = '';
      }, 280);
    }

    /** Remplit le reader avec les données d'un article */
    function populate(article, animate = false) {
      const isEnriched = AI.isEnriched(article);

      document.getElementById('reader-source').textContent = article.feed_name || '';

      // Date — toujours visible
      const wordCount = ((article.ai_content || article.content || '')).split(/\s+/).filter(Boolean).length;
      const readMin = Math.max(1, Math.round(wordCount / 200));
      document.getElementById('reader-date').textContent =
        new Date(article.pub_date).toLocaleDateString('fr-FR', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }) + ` · ${readMin} min`;

      // Titre — masqué si pas encore enrichi
      const titleEl = document.getElementById('reader-title');
      if (titleEl) {
        titleEl.textContent = isEnriched ? (article.ai_title || article.title || '') : '';
        titleEl.style.opacity = '';
      }

      // Image hero — ne recharger que si c'est un article différent
      const titleArea = document.getElementById('reader-title-area');
      if (!titleArea || titleArea.dataset.heroHash !== article.hash) {
        _setHeroImage(article);
        if (titleArea) titleArea.dataset.heroHash = article.hash;
      }

      // Mettre à jour l'icône bookmark — toujours visible
      const bookmarkBtn = document.getElementById('btn-bookmark');
      if (bookmarkBtn) {
        const isBookmarked = STATE.bookmarks.has(article.id || article.hash) || article.bookmarked;
        bookmarkBtn.classList.toggle('active', isBookmarked);
        bookmarkBtn.textContent = isBookmarked ? '◨' : '◧';
      }

      if (!isEnriched) {
        // Pas encore enrichi — masquer tout le contenu, afficher loader discret
        const impBarsEl = document.getElementById('reader-imp-bars');
        if (impBarsEl) impBarsEl.innerHTML = '';
        const tagsEl = document.getElementById('reader-tags');
        if (tagsEl) tagsEl.innerHTML = '';
        const chapoEl = document.getElementById('reader-chapo');
        if (chapoEl) { chapoEl.textContent = ''; chapoEl.style.display = 'none'; }
        const contentEl = document.getElementById('reader-content');
        if (contentEl) {
          contentEl.innerHTML = '<div class="reader-loading-indicator"></div>';
          contentEl.style.opacity = '1';
        }
        const relatedZone = document.getElementById('reader-related');
        if (relatedZone) relatedZone.style.display = 'none';
        const metaBottom = document.getElementById('reader-meta-bottom') || document.querySelector('.reader-meta-bottom');
        if (metaBottom) metaBottom.style.display = 'none';
        return;
      }

      // Enrichi — afficher tout avec animation si demandée
      const impBarsEl = document.getElementById('reader-imp-bars');
      if (impBarsEl) impBarsEl.innerHTML = Render.importanceBars(article.importance || 1);

      const tagsEl = document.getElementById('reader-tags');
      const allTags = article.ai_tags || [];
      const visibleTags = allTags.slice(0, 3);
      const extraCount = allTags.length - visibleTags.length;
      tagsEl.innerHTML = visibleTags.map(t =>
        `<span class="tag">${Render.escapeHtml(t)}</span>`
      ).join('') + (extraCount > 0 ? `<span class="tag tag-more">+${extraCount}</span>` : '');

      const metaBottom = document.getElementById('reader-meta-bottom') || document.querySelector('.reader-meta-bottom');
      if (metaBottom) metaBottom.style.display = '';

      const relatedZone = document.getElementById('reader-related');
      if (relatedZone) relatedZone.style.display = '';

      // Chapô — première phrase, corps commence après
      const chapoEl = document.getElementById('reader-chapo');
      let chapoText = '';
      if (chapoEl) {
        const fullText = (article.ai_content || '').trim();
        if (fullText.length > 100) {
          const match = fullText.match(/^.{40,200}?[.!?](?=\s|$)/);
          if (match) {
            chapoText = match[0].trim();
            chapoEl.textContent = chapoText;
            if (animate) {
              chapoEl.style.opacity = '0';
              chapoEl.style.display = '';
              chapoEl.style.transform = 'translateY(8px)';
              setTimeout(() => {
                chapoEl.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                chapoEl.style.opacity = '1';
                chapoEl.style.transform = 'translateY(0)';
              }, 50);
            } else {
              chapoEl.style.display = '';
              chapoEl.style.opacity = '';
              chapoEl.style.transform = '';
            }
          } else {
            chapoEl.textContent = '';
            chapoEl.style.display = 'none';
          }
        } else {
          chapoEl.textContent = '';
          chapoEl.style.display = 'none';
        }
      }

      // Contenu
      setContent(article, animate, chapoText);

      FontSize.set(FontSize.getCurrent(), false);
      renderRelated(article);
    }

    /** Affiche les articles similaires dans le reader */
    function renderRelated(article) {
      const relatedZone = document.getElementById('reader-related');
      const relatedList = document.getElementById('reader-related-list');
      if (!relatedZone || !relatedList) return;

      const tags = (article.ai_tags || []).map(t => t.toLowerCase().trim());
      const titleWords = new Set((article.ai_title || article.title || '').toLowerCase()
        .replace(/[^a-z0-9àâéèêëîïôùûü]/g, ' ')
        .split(/\s+/).filter(w => w.length > 3));

      const scored = STATE.articles
        .filter(a => a.hash !== article.hash && a.ai_tags?.length > 0) // enrichis uniquement
        .map(a => {
          let score = 0;
          const aTags = (a.ai_tags || []).map(t => t.toLowerCase().trim());
          score += aTags.filter(t => tags.includes(t)).length * 2;
          const aWords = new Set((a.ai_title || a.title || '').toLowerCase()
            .replace(/[^a-z0-9àâéèêëîïôùûü]/g, ' ')
            .split(/\s+/).filter(w => w.length > 3));
          const common = [...titleWords].filter(w => aWords.has(w)).length;
          score += common;
          return { article: a, score };
        })
        .filter(({ score }) => score >= 2) // seuil plus strict
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map(({ article }) => article);

      if (scored.length === 0) { relatedZone.style.display = 'none'; return; }

      relatedZone.style.display = 'block';
      relatedList.innerHTML = '';
      scored.forEach((rel) => {
        const div = document.createElement('div');
        div.className = 'reader-related-item';
        div.innerHTML = `
          <div class="reader-related-source">${Render.escapeHtml(rel.feed_name || '')} · ${Render.relativeTime(rel.pub_date)}</div>
          <div class="reader-related-headline">${Render.escapeHtml(rel.ai_title || rel.title || '')}</div>
        `;
        div.addEventListener('click', () => {
          const idx = STATE.currentArticleList.findIndex(a => a.hash === rel.hash);
          if (idx !== -1) {
            Reader.open(rel, idx, STATE.currentArticleList);
          } else {
            Reader.open(rel, 0, [rel]);
          }
        });
        relatedList.appendChild(div);
      });
    }

    /** Affiche le contenu de l'article (toujours la version IA) */
    function setContent(article, animate = false, chapoText = '') {
      const contentEl = document.getElementById('reader-content');
      let text = article.ai_content || article.content || article.description || '';
      // Si chapô affiché, retirer le chapô du début du corps
      if (chapoText && text.length > chapoText.length) {
        const rest = text.slice(chapoText.length).trim();
        if (rest.length > 50) text = rest;
      }

      // Conversion texte → paragraphes HTML
      const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());

      if (!animate) {
        contentEl.innerHTML = paragraphs.map(p =>
          `<p>${Render.escapeHtml(p.trim())}</p>`
        ).join('');
        return;
      }

      // Brider l'animation aux articles courts — évite le freeze sur mobile
      const totalWords = text.split(/\s+/).filter(Boolean).length;
      if (totalWords > 300) {
        contentEl.innerHTML = paragraphs.map(p =>
          `<p>${Render.escapeHtml(p.trim())}</p>`
        ).join('');
        return;
      }

      // FIX: un seul render initial, puis animation par-dessus
      contentEl.innerHTML = paragraphs.map(p =>
        `<p>${Render.escapeHtml(p.trim())}</p>`
      ).join('');

      // Récupérer tous les noeuds texte et animer mot par mot
      const allWords = [];
      contentEl.querySelectorAll('p').forEach(p => {
        const words = p.textContent.split(' ');
        p.innerHTML = '';
        words.forEach((word, i) => {
          const span = document.createElement('span');
          span.textContent = word + (i < words.length - 1 ? ' ' : '');
          span.style.opacity = '0';
          span.style.transition = 'opacity 0.15s ease';
          p.appendChild(span);
          allWords.push(span);
        });
      });

      // Révéler les mots progressivement par petits groupes
      const GROUP = 5; // mots révélés en même temps
      const DELAY = 25; // ms entre chaque groupe
      allWords.forEach((span, i) => {
        setTimeout(() => {
          span.style.opacity = '1';
        }, Math.floor(i / GROUP) * DELAY);
      });
    }

    /** Marque un article comme lu */
    async function markRead(article) {
      const key = article.id || article.hash;
      if (STATE.readArticles.has(key)) return;
      STATE.readArticles.add(key);
      article.read = true;

      // Mettre à jour le DOM immédiatement sans re-render
      const hash = article.hash || '';
      document.querySelectorAll(`[data-hash="${hash}"]`).forEach(el => {
        el.classList.add('read');
        el.classList.remove('unread');
      });

      // Mettre à jour le badge et les compteurs sidebar en temps réel
      Sync.updateBadge();
      Render.renderSidebarFeeds(STATE.feeds);

      if (article.id && STATE.user) {
        try {
          await DB.updateArticleStatus(article.id, { read: true });
        } catch {}
      }
    }

    /** Navigation dans le reader */
    /** Met à jour les labels de navigation prev/next */
    function updateNavLabels() {
      const list = STATE.currentArticleList;
      const idx = STATE.currentArticleIndex;
      const prevEl = document.getElementById('prev-article-title');
      const nextEl = document.getElementById('next-article-title');
      const prevBtn = document.getElementById('btn-prev-article');
      const nextBtn = document.getElementById('btn-next-article');

      if (prevEl && prevBtn) {
        const hasPrev = idx > 0;
        prevBtn.disabled = !hasPrev;
        prevBtn.style.opacity = hasPrev ? '1' : '0.3';
        prevEl.textContent = hasPrev
          ? (list[idx - 1].ai_title || list[idx - 1].title || 'PRÉCÉDENT').substring(0, 40)
          : 'PRÉCÉDENT';
      }
      if (nextEl && nextBtn) {
        const hasNext = idx < list.length - 1;
        nextBtn.disabled = !hasNext;
        nextBtn.style.opacity = hasNext ? '1' : '0.3';
        nextEl.textContent = hasNext
          ? (list[idx + 1].ai_title || list[idx + 1].title || 'SUIVANT').substring(0, 40)
          : 'SUIVANT';
      }
    }

    function scheduleReaderReveal() {
      const modal = document.getElementById('reader-modal');
      if (!modal) return;
      clearTimeout(scheduleReaderReveal._timer);

      const revealWhenReady = () => {
        const hasSkeleton =
          modal.querySelector('.content-loading, .reader-loading-indicator, [class*="skeleton"]');
        if (hasSkeleton) {
          scheduleReaderReveal._timer = setTimeout(revealWhenReady, 120);
          return;
        }
        modal.classList.remove('reader-opening');
      };

      scheduleReaderReveal._timer = setTimeout(revealWhenReady, 360);
    }

    /**
     * Animation de transition entre articles.
     * dir = 1  → sortie à gauche (article suivant)
     * dir = -1 → sortie à droite (article précédent)
     */
    function _animateTransition(dir, callback) {
      const modal = document.getElementById('reader-modal');
      if (!modal) { callback(); return; }
      // Si le swipe gère déjà l'animation, on exécute juste le callback
      if (Reader._swipeInProgress) { callback(); return; }
      // Stopper le TTS au changement d'article
      if (TTS.isActive()) TTS.stop();

      const EASE = 'cubic-bezier(0.4, 0.0, 0.2, 1)';

      // Phase 1 — sortie
      modal.classList.add('reader-opening');
      modal.style.transition = `transform 0.18s ${EASE}, opacity 0.18s ease`;
      modal.style.transform  = `translateX(${dir * -60}px)`;
      modal.style.opacity    = '0';

      setTimeout(() => {
        // Phase 2 — reset de l'autre côté, sans transition
        modal.style.transition = 'none';
        modal.style.transform  = `translateX(${dir * 60}px)`;
        modal.style.opacity    = '0';

        // Charger le nouvel article
        callback();
        modal.scrollTop = 0;

        // Phase 3 — entrée
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            modal.style.transition = `transform 0.22s ${EASE}, opacity 0.2s ease`;
            modal.style.transform  = 'translateX(0)';
            modal.style.opacity    = '1';
            scheduleReaderReveal();
            setTimeout(() => { modal.style.transition = ''; }, 220);
          });
        });
      }, 180);
    }

    function goNext() {
      const list = STATE.currentArticleList;
      if (STATE.currentArticleIndex >= list.length - 1) return;
      _animateTransition(1, () => {
        STATE.currentArticleIndex++;
        const article = list[STATE.currentArticleIndex];
        markRead(article);
        populate(article);
        updateNavLabels();
        if (!AI.isEnriched(article)) enrichOnOpen(article);
      });
    }

    function goPrev() {
      const list = STATE.currentArticleList;
      if (STATE.currentArticleIndex <= 0) return;
      _animateTransition(-1, () => {
        STATE.currentArticleIndex--;
        const article = list[STATE.currentArticleIndex];
        markRead(article);
        populate(article);
        updateNavLabels();
        if (!AI.isEnriched(article)) enrichOnOpen(article);
      });
    }



    /** Initialise les événements du reader */
    function init() {
      document.getElementById('btn-close-reader').addEventListener('click', close);

      // Bouton écouter — TTS
      const listenBtn = document.getElementById('btn-listen');
      if (listenBtn) {
        listenBtn.addEventListener('click', () => {
          const article = STATE.currentArticleList[STATE.currentArticleIndex];
          if (!article) return;
          const text = article.ai_content || article.content || article.title || '';
          if (!text) return;
          TTS.toggle(text);
        });
      }

      // Fermer en cliquant sur l'overlay
      document.getElementById('reader-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) close();
      });

      // Touche Escape
      document.addEventListener('keydown', (e) => {
        // Ne pas intercepter les touches dans les champs de saisie
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowRight') goNext();
        if (e.key === 'ArrowLeft') goPrev();
        // Raccourcis actifs uniquement quand le reader est ouvert
        const readerOpen = !document.getElementById('reader-overlay')?.classList.contains('hidden');
        if (!readerOpen) return;
        if (e.key === 'b' || e.key === 'B') {
          document.getElementById('btn-bookmark')?.click();
        }
        if (e.key === 'o' || e.key === 'O') {
          const article = STATE.currentArticleList[STATE.currentArticleIndex];
          if (article?.link) window.open(article.link, '_blank', 'noopener');
        }
      });

      // Navigation
      document.getElementById('btn-next-article').addEventListener('click', goNext);
      document.getElementById('btn-prev-article').addEventListener('click', goPrev);

      // Bookmark depuis reader
      document.getElementById('btn-bookmark').addEventListener('click', () => {
        const article = STATE.currentArticleList[STATE.currentArticleIndex];
        if (!article) return;
        const key = article.id || article.hash;
        const isBookmarked = STATE.bookmarks.has(key);
        const btn = document.getElementById('btn-bookmark');

        if (isBookmarked) {
          STATE.bookmarks.delete(key);
          article.bookmarked = false;
          btn.classList.remove('active');
          btn.textContent = '◧';
          Toast.show('Retiré des sauvegardes', 'info');
        } else {
          STATE.bookmarks.add(key);
          article.bookmarked = true;
          btn.classList.add('active');
          btn.textContent = '◨'; // rempli = sauvegardé
          Toast.show('Sauvegardé ✓', 'success');
        }

        if (article.id && STATE.user) {
          DB.updateArticleStatus(article.id, { bookmarked: !isBookmarked }).catch(() => {});
        }
      });

      // Ré-enrichir avec l'IA
      document.getElementById('btn-reenrich').addEventListener('click', () => {
        const articleRef = STATE.currentArticleList[STATE.currentArticleIndex];
        if (!articleRef) return;
        // Vider uniquement les champs IA sans re-render l'article
        articleRef.ai_content = '';
        articleRef.ai_title = null;
        articleRef.ai_tags = [];
        // Aussi mettre à jour l'objet dans STATE.articles (même hash)
        const stateArticle = STATE.articles.find(a => a.hash === articleRef.hash);
        if (stateArticle) {
          stateArticle.ai_content = '';
          stateArticle.ai_title = null;
          stateArticle.ai_tags = [];
        }
        enrichOnOpen(articleRef);
        Toast.show('Ré-enrichissement en cours…', 'info');
      });

      // Partager
      document.getElementById('btn-share-menu').addEventListener('click', async () => {
        const article = STATE.currentArticleList[STATE.currentArticleIndex];
        if (!article) return;
        const title = article.ai_title || article.title || '';
        const text = (article.ai_content || '').substring(0, 300) + '...';
        const url = article.link || '';
        if (navigator.share) {
          try { await navigator.share({ title, text, url }); }
          catch (err) { if (err.name !== 'AbortError') Toast.show('Erreur partage', 'error'); }
        } else {
          try {
            await navigator.clipboard.writeText(`${title}\n\n${text}\n\n${url}`);
            Toast.show('Copié ✓', 'success');
          } catch { Toast.show('Impossible de copier', 'error'); }
        }
      });

      // Ouvrir l'article — bouton direct dans la toolbar
      const openSourceDirect = document.getElementById('btn-open-source-direct');
      if (openSourceDirect) {
        openSourceDirect.addEventListener('click', () => {
          const article = STATE.currentArticleList[STATE.currentArticleIndex];
          if (!article?.link) return;
          window.open(article.link, '_blank', 'noopener');
        });
      }



    }

    return { open, close, init, goNext, goPrev, _updateFeedRow, _swipeInProgress: false };
  })();

  /* ================================================================
     10. UI — Settings / Gestion des Feeds
     ================================================================ */
  const Settings = (() => {
    /** Rendu de la liste des feeds dans les settings */
    function renderFeedsManager(feeds) {
      const container = document.getElementById('feeds-manager');
      container.innerHTML = '';

      if (feeds.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon">⊙</span><p class="empty-state-text">Aucun feed ajouté. Utilisez le formulaire ci-dessus pour ajouter vos sources RSS.</p></div>';
        return;
      }

      feeds.forEach((feed, i) => {
        const row = document.createElement('div');
        row.className = 'feed-row';
        row.style.animationDelay = `${i * 30}ms`;

        // Calculer les stats du feed
        const feedArticles = STATE.articles.filter(a => a.feed_id === feed.id);
        const readCount = feedArticles.filter(a => a.read).length;
        row.innerHTML = `
          <div>
            <div class="feed-row-name">${Render.escapeHtml(feed.name || feed.url)}</div>
            <div class="feed-row-url">${Render.escapeHtml(feed.url)}</div>
            <div class="feed-row-stats">${feedArticles.length} articles · ${readCount} lus</div>
          </div>
          <div class="feed-row-category">${Render.escapeHtml(feed.category || '—')}</div>
          <button class="feed-toggle${feed.active ? ' active' : ''}" data-id="${feed.id}" title="${feed.active ? 'Désactiver' : 'Activer'}"></button>
          <button class="feed-delete" data-id="${feed.id}" title="Supprimer">✕</button>
        `;

        // Toggle actif/inactif
        row.querySelector('.feed-toggle').addEventListener('click', async () => {
          const btn = row.querySelector('.feed-toggle');
          const newActive = !feed.active;
          try {
            await DB.toggleFeed(feed.id, newActive);
            feed.active = newActive;
            btn.classList.toggle('active', newActive);
            Sync.refreshUI();
            Toast.show(newActive ? `${feed.name} activé` : `${feed.name} désactivé`, 'info');
          } catch (err) {
            Toast.show('Erreur lors de la mise à jour', 'error');
          }
        });

        // Supprimer feed
        row.querySelector('.feed-delete').addEventListener('click', async () => {
          if (!confirm(`Supprimer "${feed.name || feed.url}" ? Les articles associés seront aussi supprimés.`)) return;
          try {
            // Supprimer les articles du feed dans Supabase
            await Auth.getClient()
              .from('articles')
              .delete()
              .eq('user_id', STATE.user.id)
              .eq('feed_id', feed.id);

            // Supprimer le feed
            await DB.deleteFeed(feed.id);

            // Mettre à jour le state en mémoire
            STATE.feeds = STATE.feeds.filter(f => f.id !== feed.id);
            STATE.articles = STATE.articles.filter(a => a.feed_id !== feed.id);

            row.remove();
            Sync.refreshUI();
            Toast.show('Feed et articles supprimés', 'info');
          } catch (err) {
            Toast.show('Erreur lors de la suppression', 'error');
          }
        });

        container.appendChild(row);
      });
    }

    /** Initialise le formulaire d'ajout */
    function init() {
      document.getElementById('btn-add-feed').addEventListener('click', async () => {
        const url = document.getElementById('feed-url').value.trim();
        const name = document.getElementById('feed-name').value.trim();
        const category = document.getElementById('feed-category').value.trim();
        const errorEl = document.getElementById('feed-error');

        errorEl.classList.add('hidden');

        if (!url) {
          errorEl.textContent = 'L\'URL du feed est requise.';
          errorEl.classList.remove('hidden');
          return;
        }

        if (!url.startsWith('http')) {
          errorEl.textContent = 'L\'URL doit commencer par http:// ou https://';
          errorEl.classList.remove('hidden');
          return;
        }

        const btn = document.getElementById('btn-add-feed');
        btn.disabled = true;
        btn.textContent = 'VALIDATION...';

        try {
          // Tester la validité du feed via le worker
          await RSS.fetchFeed(url);

          // Ajouter en base
          const feed = await DB.addFeed(
            STATE.user.id,
            url,
            name || new URL(url).hostname,
            category || 'Général'
          );

          STATE.feeds.push(feed);
          Render.renderSidebarFeeds(STATE.feeds);
          renderFeedsManager(STATE.feeds);

          // Réinitialiser le formulaire
          document.getElementById('feed-url').value = '';
          document.getElementById('feed-name').value = '';
          document.getElementById('feed-category').value = '';

          Toast.show('Feed ajouté avec succès !', 'success');
        } catch (err) {
          errorEl.textContent = `Erreur : ${err.message || 'Feed inaccessible ou invalide.'}`;
          errorEl.classList.remove('hidden');
        } finally {
          btn.disabled = false;
          btn.textContent = '+ AJOUTER';
        }
      });

      // Bouton vider le cache articles
      const clearBtn = document.getElementById('btn-clear-cache');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (!confirm('Vider tous les articles en cache ? Un nouveau sync sera lancé automatiquement.')) return;
          clearBtn.disabled = true;
          clearBtn.textContent = 'VIDAGE...';
          try {
            // Supprimer par lots pour contourner les limites RLS
            const { error } = await Auth.getClient()
              .from('articles')
              .delete()
              .eq('user_id', STATE.user.id)
              .not('id', 'is', null); // Force le filtre pour que RLS accepte

            if (error) throw error;

            // Vider localStorage
            Cache.clear(STATE.user.id);

            // Réinitialiser le state
            STATE.articles = [];
            STATE.bookmarks = new Set();
            STATE.readArticles = new Set();

            Sync.refreshUI();
            Toast.show('Cache vidé — sync en cours...', 'success');

            // Relancer le sync automatiquement
            setTimeout(() => Sync.run(), 500);

          } catch (err) {
            console.error('Erreur vidage cache:', err);
            // Même si Supabase échoue, vider le state local
            Cache.clear(STATE.user.id);
            STATE.articles = [];
            Sync.refreshUI();
            Toast.show('Cache local vidé — sync en cours...', 'info');
            setTimeout(() => Sync.run(), 500);
          } finally {
            clearBtn.disabled = false;
            clearBtn.textContent = 'VIDER LE CACHE';
          }
        });
      }

      // Détection RSS automatique au changement d'URL
      const urlInput = document.getElementById('feed-url');
      const suggestionsEl = document.getElementById('rss-suggestions');
      let detectTimeout;
      urlInput.addEventListener('input', () => {
        clearTimeout(detectTimeout);
        suggestionsEl.classList.add('hidden');
        suggestionsEl.innerHTML = '';
        const val = urlInput.value.trim();
        if (val.length < 5) return;
        detectTimeout = setTimeout(async () => {
          suggestionsEl.classList.remove('hidden');
          suggestionsEl.innerHTML = '<span style="font-family:var(--font-mono);font-size:0.65rem;color:var(--grey-light);">Recherche de feeds...</span>';
          const candidates = await RSSDetect.detect(val);
          suggestionsEl.innerHTML = '';
          if (candidates.length === 0) {
            suggestionsEl.classList.add('hidden');
            return;
          }
          candidates.forEach(c => {
            const btn = document.createElement('button');
            btn.className = 'rss-suggestion-btn';
            btn.textContent = c.label;
            btn.addEventListener('click', () => {
              urlInput.value = c.url;
              suggestionsEl.classList.add('hidden');
            });
            suggestionsEl.appendChild(btn);
          });
        }, 600);
      });

      // OPML — supprimé

      // Bouton raccourcis clavier
      const shortcutsBtn = document.getElementById('btn-shortcuts-help');
      if (shortcutsBtn) {
        shortcutsBtn.addEventListener('click', () => {
          const existing = document.getElementById('shortcuts-modal');
          if (existing) { existing.remove(); return; }

          const modal = document.createElement('div');
          modal.id = 'shortcuts-modal';
          modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: var(--white); border: var(--border); border-radius: 4px;
            padding: 28px 32px; z-index: 9999; min-width: 320px;
            box-shadow: var(--shadow-lift);
          `;
          const shortcuts = [
            ['← →', 'Article précédent / suivant'],
            ['Échap', 'Fermer le reader'],
            ['B', 'Bookmark l\'article ouvert'],
            ['O', 'Ouvrir la source dans un onglet'],
            ['R', 'Rafraîchir les feeds'],
          ];
          modal.innerHTML = `
            <div style="font-family:var(--font-mono);font-size:0.6rem;letter-spacing:0.15em;color:var(--grey-light);margin-bottom:16px;">RACCOURCIS CLAVIER</div>
            ${shortcuts.map(([key, desc]) => `
              <div style="display:flex;justify-content:space-between;gap:24px;padding:6px 0;border-bottom:1px solid var(--grey-wash);">
                <kbd style="font-family:var(--font-mono);font-size:0.72rem;background:var(--grey-wash);padding:2px 8px;border-radius:2px;">${key}</kbd>
                <span style="font-size:0.8rem;color:var(--grey-deep)">${desc}</span>
              </div>
            `).join('')}
            <button style="margin-top:16px;font-family:var(--font-mono);font-size:0.6rem;color:var(--grey-mid);cursor:pointer;" id="close-shortcuts">FERMER</button>
          `;
          document.body.appendChild(modal);
          document.getElementById('close-shortcuts').addEventListener('click', () => modal.remove());
          setTimeout(() => {
            document.addEventListener('click', function handler(e) {
              if (!modal.contains(e.target) && e.target !== shortcutsBtn) {
                modal.remove();
                document.removeEventListener('click', handler);
              }
            });
          }, 100);
        });
      }
    }

    return { renderFeedsManager, init };
  })();

  /* ================================================================
     TTS — Unreal Speech Text-to-Speech (via Cloudflare Worker proxy)
     Voix : Élodie — française, féminine (Unreal Speech)
     État : idle | loading | playing | paused
     ================================================================ */
  const TTS = (() => {
    let _audio    = null;   // HTMLAudioElement courant
    let _blobUrl  = null;   // URL blob à révoquer au stop
    let _state    = 'idle'; // idle | loading | playing | paused
    let _abortCtrl = null;  // AbortController pour annuler le fetch en cours

    /** Lance, met en pause ou stoppe selon l'état
     *  btnOverride : bouton externe optionnel (ex: bouton digest) à synchroniser
     */
    async function toggle(text, btnOverride = null) {
      // Si en lecture → pause
      if (_state === 'playing' && _audio) {
        _audio.pause();
        _setState('paused', btnOverride);
        return;
      }

      // Si en pause → reprendre
      if (_state === 'paused' && _audio) {
        _audio.play();
        _setState('playing', btnOverride);
        return;
      }

      // Si loading → annuler le fetch en cours
      if (_state === 'loading') {
        _abortCtrl?.abort();
        _setState('idle', btnOverride);
        return;
      }

      // Nouvelle lecture
      if (!text || text.trim().length === 0) return;
      _setState('loading', btnOverride);
      _abortCtrl = new AbortController();

      try {
        const res = await fetch(`${CONFIG.WORKER_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: _abortCtrl.signal,
        });

        if (!res.ok) throw new Error(`TTS error ${res.status}`);

        const data = await res.json();
        if (!data.audioBase64) throw new Error('No audio data');

        const binary = atob(data.audioBase64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/mpeg' });

        _cleanup();
        _blobUrl = URL.createObjectURL(blob);
        _audio   = new Audio(_blobUrl);

        _audio.onended = () => { _cleanup(); _setState('idle', btnOverride); _updateProgress(0); };
        _audio.onerror = () => { _cleanup(); _setState('idle', btnOverride); _updateProgress(0); Toast.show('Erreur audio', 'error'); };
        _audio.ontimeupdate = () => {
          if (_audio && _audio.duration) {
            _updateProgress(_audio.currentTime / _audio.duration);
          }
        };

        await _audio.play();
        _setState('playing', btnOverride);

      } catch (err) {
        if (err.name === 'AbortError') {
          _setState('idle', btnOverride);
          return;
        }
        console.warn('TTS échoué:', err);
        Toast.show('Audio indisponible — réessayez', 'error');
        _setState('idle', btnOverride);
      }
    }

    /** Nettoie l'audio courant sans changer l'état */
    function _cleanup() {
      if (_audio) { _audio.pause(); _audio.src = ''; _audio = null; }
      if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
    }

    /** Met à jour la progress bar TTS (0-1) sur tous les boutons actifs */
    function _updateProgress(ratio) {
      // Bouton reader
      const readerBar = document.getElementById('tts-progress-bar');
      if (readerBar) readerBar.style.width = `${ratio * 100}%`;
      // Bouton digest
      const digestBar = document.getElementById('tts-progress-bar-digest');
      if (digestBar) digestBar.style.width = `${ratio * 100}%`;
    }

    /** Arrête complètement */
    function stop() {
      _abortCtrl?.abort();
      _cleanup();
      _setState('idle');
      _updateProgress(0);
    }

    /** Met à jour l'état sur le bouton reader ET sur un bouton override éventuel */
    function _setState(state, btnOverride = null) {
      _state = state;

      const icons  = { idle: '▶', loading: '···', playing: '■', paused: '▶' };
      const titles = {
        idle:    "Écouter l'article",
        loading: 'Chargement...',
        playing: 'Pause',
        paused:  'Reprendre',
      };

      // Bouton reader standard
      const btn = document.getElementById('btn-listen');
      if (btn) {
        btn.textContent = icons[state] || '▶';
        btn.title       = titles[state] || '';
        btn.classList.toggle('active',      state === 'playing');
        btn.classList.toggle('tts-loading', state === 'loading');
      }

      // Bouton externe (digest, etc.)
      if (btnOverride) {
        btnOverride.textContent = icons[state] || '▶';
        btnOverride.title       = titles[state] || '';
        btnOverride.classList.toggle('active',      state === 'playing');
        btnOverride.classList.toggle('tts-loading', state === 'loading');
      }
    }

    function isActive() { return _state !== 'idle'; }

    return { toggle, stop, isActive };
  })();

  /* ================================================================
     11. UI — Digest IA
     ================================================================ */
  const Digest = (() => {
    /** Nettoie et normalise le HTML du digest — convertit markdown → HTML */
    function cleanDigestHtml(raw) {
      // Retirer uniquement les balises HTML incomplètes en fin de string (pas de texte)
      let html = raw.replace(/<[a-z]+[^>]*$/i, '').trim();

      if (!html.includes('<h') && !html.includes('<p') && !html.includes('<ul')) {
        html = html
          .replace(/^###\s+(.+)$/gm, '<h2>$1</h2>')
          .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
          .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
          .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
          .replace(/(<li>.*<\/li>\n?)+/gs, '<ul>$&</ul>')
          .replace(/^(?!<[hul]|$)(.+)$/gm, '<p>$1</p>');
      }

      html = html
        .replace(/<\/?(strong|b|em|i)(\s[^>]*)?>([^<]*)<\/\1>/gi, '$3')
        .replace(/<\/?(strong|b|em|i)(\s[^>]*)?>/gi, '')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/^###?\s*/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return html;
    }

    /** Génère la timeline chronologique des articles du jour */
    function renderTimeline(fsBody) {
      const today = new Date().toISOString().split('T')[0];
      const todayArticles = STATE.articles
        .filter(a => a.pub_date && a.pub_date.startsWith(today) && (a.ai_title || a.title))
        .sort((a, b) => new Date(a.pub_date) - new Date(b.pub_date))
        .slice(0, 12);

      if (todayArticles.length === 0) return;

      // Supprimer une timeline existante
      const existing = fsBody.querySelector('.digest-timeline');
      if (existing) existing.remove();

      const timeline = document.createElement('div');
      timeline.className = 'digest-timeline';
      timeline.innerHTML = `<div class="digest-timeline-header">CHRONOLOGIE DU JOUR</div>`;

      todayArticles.forEach(a => {
        const time = new Date(a.pub_date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                const item = document.createElement('div');
        item.className = 'digest-timeline-item';
        const isRead = a.read || STATE.readArticles.has(a.id || a.hash);
        item.innerHTML = `
          <div class="digest-timeline-time${isRead ? ' timeline-read' : ''}">${time}</div>
          <div class="digest-timeline-dot${isRead ? ' timeline-dot-read' : ''}"></div>
          <div class="digest-timeline-content">
            <div class="digest-timeline-source">${a.feed_name || ''}</div>
            <div class="digest-timeline-title${isRead ? ' timeline-title-read' : ''}">${a.ai_title || a.title || ''}</div>
          </div>
        `;
        item.addEventListener('click', () => {
          // Fermer digest et ouvrir l'article
          document.getElementById('digest-fullscreen-overlay').classList.add('hidden');
          document.body.style.overflow = '';
          TTS.stop();
          const idx = STATE.articles.findIndex(art => art.hash === a.hash);
          if (idx !== -1) Reader.open(a, idx, STATE.articles);
        });
        timeline.appendChild(item);
      });

      fsBody.appendChild(timeline);
    }

    /** Extrait le texte brut du digest pour le TTS */
    function extractTextForTTS(html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      // Ajouter des pauses naturelles entre sections
      tmp.querySelectorAll('h2').forEach(h => {
        h.textContent = h.textContent + '. ';
      });
      return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /** Anime les étapes de chargement */
    function animateLoadingSteps() {
      const steps = ['digest-step-1', 'digest-step-2', 'digest-step-3'];
      let current = 0;

      // Activer la première étape immédiatement
      const activate = () => {
        steps.forEach((id, i) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.classList.remove('active', 'done');
          if (i < current) el.classList.add('done');
          if (i === current) el.classList.add('active');
        });
      };

      activate();
      const interval = setInterval(() => {
        current = Math.min(current + 1, steps.length - 1);
        activate();
        if (current === steps.length - 1) clearInterval(interval);
      }, 2500);

      return () => clearInterval(interval);
    }

    /** Met à jour la date dans le header */
    function updateHeaderDate() {
      const el = document.getElementById('digest-header-date');
      if (!el) return;
      el.textContent = new Date().toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
    }

    /** Met à jour le footer avec les méta-infos */
    function updateFooter(articleCount, generatedAt) {
      const footer = document.getElementById('digest-footer');
      const meta = document.getElementById('digest-footer-meta');
      if (!footer || !meta) return;
      const time = generatedAt
        ? new Date(generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      meta.textContent = `${articleCount} article${articleCount > 1 ? 's' : ''} analysé${articleCount > 1 ? 's' : ''} · Généré à ${time}`;
      footer.style.display = 'block';
    }

    /** Génère le digest et met à jour l'interface */
    async function generateAndRender(btnEl) {
      const fsBody = document.getElementById('digest-fullscreen-body');
      const listenBtn = document.getElementById('btn-digest-listen');

      btnEl.disabled = true;
      const origLabel = btnEl.innerHTML;
      btnEl.innerHTML = '<span class="spinner digest-spinner"></span>';

      // Cacher le bouton TTS pendant la génération
      if (listenBtn) { listenBtn.style.display = 'none'; }

      // Afficher l'état de chargement animé
      fsBody.innerHTML = `
        <div class="digest-empty-state" id="digest-empty-state">
          <div class="digest-empty-glyph">⬡</div>
          <div class="digest-empty-label">BRIEFING DU JOUR</div>
          <p class="digest-empty-desc">Votre synthèse IA est en cours de génération.<br>Les articles importants sont analysés et regroupés par thème.</p>
          <div class="digest-loading-steps" id="digest-loading-steps">
            <div class="digest-step" id="digest-step-1">Analyse des articles...</div>
            <div class="digest-step" id="digest-step-2">Regroupement par thèmes...</div>
            <div class="digest-step" id="digest-step-3">Rédaction du briefing...</div>
          </div>
        </div>
      `;
      const stopAnimation = animateLoadingSteps();

      try {
        // Pré-enrichir les articles manquants
        const enrichedCount = STATE.articles.filter(a => AI.isEnriched(a)).length;
        const quotaRemaining = QuotaTracker.remaining(CONFIG.GROQ_MODEL_ENRICH);
        const maxPreEnrich = Math.min(
          Math.max(0, 10 - enrichedCount),
          quotaRemaining,
          5
        );

        const toEnrich = maxPreEnrich > 0
          ? STATE.articles
              .filter(a => !AI.isEnriched(a))
              .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date))
              .slice(0, maxPreEnrich)
          : [];

        if (toEnrich.length === 0 && enrichedCount === 0) {
          throw new Error('Aucun article enrichi disponible et quota insuffisant. Ouvrez quelques articles d\'abord.');
        }

        for (let i = 0; i < toEnrich.length; i++) {
          try {
            const result = await AI.enrichArticle(toEnrich[i]);
            toEnrich[i].ai_content = result.ai_content;
            toEnrich[i].ai_title = result.ai_title || null;
              toEnrich[i].ai_tags = result.ai_tags;
          } catch {}
          if (i < toEnrich.length - 1) await new Promise(r => setTimeout(r, CONFIG.GROQ_DIGEST_DELAY));
        }

        STATE.digestArticles = AI.getDigestArticles(STATE.articles);
        const heroArticle = _getDigestHeroSource();
        const html = await AI.generateDailyDigest(STATE.digestArticles);
        const heroImage = await _resolveDigestHeroImage(heroArticle);
        stopAnimation();

        const cleanedHtml = cleanDigestHtml(html);
        const rendered = `<div class="feed-digest-text">${cleanedHtml}</div>`;
        fsBody.innerHTML = rendered;

        // Méta-infos footer
        const analyzedCount = STATE.articles.filter(a => AI.isEnriched(a)).length;
        updateFooter(analyzedCount, new Date());

        // Réactiver le bouton TTS avec le texte extrait
        if (listenBtn) {
          listenBtn.style.display = '';
          listenBtn._digestText = extractTextForTTS(cleanedHtml);
        }

        if (STATE.user) DB.saveDigest(STATE.user.id, html, heroImage).catch(() => {});
        _setDigestHeroImage(heroImage);

        // Timeline chronologique en bas
        renderTimeline(fsBody);

        Toast.show('Digest généré ✓', 'success');

      } catch (err) {
        stopAnimation();
        const isQuota = err.message === 'QUOTA_EXHAUSTED' || err.message?.includes('Aucun article enrichi');
        fsBody.innerHTML = `
          <div class="digest-empty-state">
            <div class="digest-empty-glyph" style="animation:none;opacity:0.2">⊘</div>
            <div class="digest-empty-label">${isQuota ? 'QUOTA ATTEINT' : 'ERREUR'}</div>
            <p class="digest-empty-desc">${isQuota
              ? 'Quota IA atteint pour aujourd\'hui.<br>Remise à zéro à minuit UTC.'
              : 'Une erreur est survenue.<br>Réessayez dans quelques instants.'
            }</p>
          </div>
        `;
        if (listenBtn) listenBtn.style.display = 'none';
        document.getElementById('digest-footer').style.display = 'none';
        Toast.show(isQuota ? 'Quota IA atteint — remise à zéro à minuit' : 'Erreur digest IA', isQuota ? 'info' : 'error', 5000);
      } finally {
        btnEl.disabled = false;
        btnEl.innerHTML = origLabel;
      }
    }

    function _getDigestHeroSource() {
      const digestArticles = (STATE.digestArticles && STATE.digestArticles.length)
        ? STATE.digestArticles
        : AI.getDigestArticles(STATE.articles);
      return digestArticles[0] || null;
    }

    async function _resolveDigestHeroImage(article) {
      if (!article) return null;
      if (article.image) return article.image;
      if (!article.link) return null;

      try {
        const r = await fetch(`${CONFIG.WORKER_URL}/scrape?url=${encodeURIComponent(article.link)}`, {
          signal: AbortSignal.timeout(8000),
        });
        const data = r.ok ? await r.json() : null;
        if (!data?.ogImage) return null;
        article.image = data.ogImage;
        return data.ogImage;
      } catch {
        return null;
      }
    }

    /** Applique l'image hero au digest depuis l'article réellement utilisé */
    function _setDigestHeroImage(preferredUrl = null) {
      const titleArea = document.getElementById('digest-title-area');
      const modal = document.getElementById('digest-modal');
      if (!titleArea) return;

      // Reset
      const oldBg = titleArea.querySelector('.hero-bg');
      if (oldBg) oldBg.remove();
      titleArea.classList.remove('has-hero');
      if (modal) modal.classList.remove('hero-ready');

      if (preferredUrl) {
        _applyDigestHero(titleArea, modal, preferredUrl);
        return;
      }

      const topArticle = _getDigestHeroSource();
      if (!topArticle) return;

      // Appliquer image si déjà disponible
      if (topArticle.image) {
        _applyDigestHero(titleArea, modal, topArticle.image);
        return;
      }

      // Sinon scrape OG en arrière-plan
      if (topArticle.link) {
        fetch(`${CONFIG.WORKER_URL}/scrape?url=${encodeURIComponent(topArticle.link)}`, {
          signal: AbortSignal.timeout(8000),
        })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (!data?.ogImage) return;
            topArticle.image = data.ogImage;
            _applyDigestHero(titleArea, modal, data.ogImage);
          })
          .catch(() => {});
      }
    }

    function _applyDigestHero(titleArea, modal, url) {
      if (modal) modal.classList.add('hero-ready');
      const img = new Image();
      img.onload = () => {
        const bg = document.createElement('div');
        bg.className = 'hero-bg';
        bg.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
        titleArea.insertBefore(bg, titleArea.firstChild);
        // Déclencher la transition de hauteur d'abord
        titleArea.classList.add('has-hero');
        // Puis fade in de l'image légèrement après pour que l'expansion soit visible
        void bg.offsetHeight;
        setTimeout(() => bg.classList.add('hero-visible'), 80);
      };
      img.onerror = () => {};
      img.src = url;
    }

    function init() {
      updateHeaderDate();

      const listenBtn = document.getElementById('btn-digest-listen');
      if (listenBtn) {
        listenBtn.style.display = 'none'; // caché jusqu'à génération
        listenBtn.addEventListener('click', () => {
          const text = listenBtn._digestText || '';
          if (!text) return;
          TTS.toggle(text, listenBtn);
        });
      }

      // Bouton ⬡ DIGEST — ouvre le plein écran
      const openBtn = document.getElementById('btn-open-digest');
      if (openBtn) openBtn.addEventListener('click', async () => {
        const overlay = document.getElementById('digest-fullscreen-overlay');
        overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        updateHeaderDate();

        const fsBody = document.getElementById('digest-fullscreen-body');
        const isEmpty = fsBody.querySelector('.digest-empty-state') ||
                        fsBody.querySelector('.feed-digest-placeholder') ||
                        fsBody.innerHTML.trim() === '';

        if (isEmpty) {
          const regenBtn = document.getElementById('btn-digest-fullscreen-regen');

          // Tenter de charger le digest du jour depuis Supabase
          if (STATE.user) {
            try {
              const cached = await DB.getTodayDigest(STATE.user.id);
              if (cached && cached.content) {
                const cleanedHtml = cleanDigestHtml(cached.content);
                fsBody.innerHTML = `<div class="feed-digest-text">${cleanedHtml}</div>`;
                const analyzedCount = STATE.articles.filter(a => AI.isEnriched(a)).length;
                updateFooter(analyzedCount, cached.created_at);
                // Activer le bouton TTS
                if (listenBtn) {
                  listenBtn.style.display = '';
                  listenBtn._digestText = extractTextForTTS(cleanedHtml);
                }
                // Générer la timeline depuis les articles en mémoire
                renderTimeline(fsBody);
                _setDigestHeroImage(cached.hero_image || null);
                return;
              }
            } catch (e) {
              console.warn('Digest cache load failed:', e);
            }
          }

          // Pas de cache — générer
          generateAndRender(regenBtn || openBtn);
        }
      });

      // Fermer plein écran — animation identique au reader
      document.getElementById('btn-digest-fullscreen-close').addEventListener('click', () => {
        TTS.stop();
        if (listenBtn) {
          listenBtn.textContent = '▶';
          listenBtn.classList.remove('active', 'tts-loading');
        }

        const overlay = document.getElementById('digest-fullscreen-overlay');
        const modal = document.getElementById('digest-modal');

        // Même animation que le reader : descend + fade out
        modal.style.transition = 'transform 0.28s cubic-bezier(0.4, 0.0, 1, 1), opacity 0.22s ease';
        modal.style.transform = 'translateY(20px)';
        modal.style.opacity = '0';
        overlay.style.transition = 'opacity 0.28s ease';
        overlay.style.opacity = '0';

        setTimeout(() => {
          overlay.classList.add('hidden');
          modal.style.transition = '';
          modal.style.transform = '';
          modal.style.opacity = '';
          overlay.style.transition = '';
          overlay.style.opacity = '';
          document.body.style.overflow = '';
          // Reset hero
          const titleArea = document.getElementById('digest-title-area');
          if (titleArea) { titleArea.querySelector('.hero-bg')?.remove(); titleArea.classList.remove('has-hero'); }
          if (modal) modal.classList.remove('hero-ready');
        }, 280);
      });

      // ↺ Régénérer
      const regenBtn = document.getElementById('btn-digest-fullscreen-regen');
      if (regenBtn) regenBtn.addEventListener('click', () => {
        TTS.stop();
        if (listenBtn) {
          listenBtn.textContent = '▶';
          listenBtn.classList.remove('active', 'tts-loading');
        }
        generateAndRender(regenBtn);
      });
    }

    return { init, cleanHtml: cleanDigestHtml };
  })();

  /* ================================================================
     12. UI — Toasts & Loader
     ================================================================ */
  const Toast = (() => {
    /** Affiche un toast (success | error | info) */
    function show(message, type = 'info', duration = 3500) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.textContent = message;

      container.appendChild(toast);

      setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }

    return { show };
  })();

  const Loader = (() => {
    let _progress = 0;

    function show(status = 'Chargement...') {
      document.getElementById('global-loader').classList.remove('hidden');
      document.getElementById('loader-status').textContent = status;
      _progress = 0;
      setProgress(0);
    }

    function hide() {
      const loader = document.getElementById('global-loader');
      setProgress(100);
      setTimeout(() => loader.classList.add('hidden'), 400);
    }

    function setProgress(pct) {
      _progress = pct;
      document.getElementById('loader-progress').style.width = `${pct}%`;
    }

    function setStatus(status) {
      document.getElementById('loader-status').textContent = status;
    }

    function setSyncDot(state) {
      // state: 'idle' | 'syncing' | 'done'
      const dot = document.getElementById('sync-dot');
      dot.className = 'sync-dot';
      if (state === 'syncing') dot.classList.add('syncing');
      if (state === 'done') dot.classList.add('done');
    }

    return { show, hide, setProgress, setStatus, setSyncDot };
  })();

  /* ================================================================
     QUOTA TRACKER — Suivi des appels Groq par modèle
     Stocke en localStorage pour persister entre sessions.
     Reset automatique chaque jour à minuit UTC.
     ================================================================ */
  const QuotaTracker = (() => {
    const KEY = 'synapse_quota';

    function _load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return _fresh();
        const data = JSON.parse(raw);
        // Reset si nouveau jour UTC
        const today = new Date().toISOString().split('T')[0];
        if (data.date !== today) return _fresh();
        return data;
      } catch { return _fresh(); }
    }

    function _fresh() {
      return {
        date: new Date().toISOString().split('T')[0],
        counts: {},
        exhausted: {},
      };
    }

    function _save(data) {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
    }

    /** Incrémente le compteur pour un modèle */
    function increment(model) {
      const data = _load();
      data.counts[model] = (data.counts[model] || 0) + 1;
      _save(data);
    }

    /** Marque un modèle comme épuisé (429 reçu) — stocke un timestamp pour expiration auto */
    function markExhausted(model) {
      const data = _load();
      data.exhausted[model] = Date.now();
      _save(data);
    }

    /** Vérifie si un modèle est épuisé — expire après 1 heure */
    function isExhausted(model) {
      const data = _load();
      const ts = data.exhausted[model];
      if (!ts) return false;
      // Migration depuis ancien format boolean
      if (ts === true) return false;
      return (Date.now() - ts) < 60 * 60 * 1000;
    }

    /** Retourne le nb d'appels restants estimés */
    function remaining(model) {
      const data = _load();
      const used = data.counts[model] || 0;
      const limit = model === CONFIG.GROQ_MODEL_DIGEST ? 1000 : 14400;
      return Math.max(0, limit - used);
    }

    /** Retourne le nb d'appels du jour pour un modèle */
    function used(model) {
      return _load().counts[model] || 0;
    }

    /** Initialise l'UI du tracker */
    function init() {
      // Reset check toutes les heures
      setInterval(() => {
        const data = _load();
        const today = new Date().toISOString().split('T')[0];
        if (data.date !== today) {
          _save(_fresh());
            }
      }, 3600000);
    }

    return { increment, markExhausted, isExhausted, remaining, used, init };
  })();

  /* ================================================================
     BACKGROUND ENRICH — Enrichissement silencieux en arrière-plan
     Enrichit les articles non encore traités silencieusement,
     sans bloquer l'UI et en respectant le rate limit Groq.
     ================================================================ */
  const BackgroundEnrich = (() => {
    let running = false;

    async function run() {
      if (running) return;

      // Vérifier si le quota n'est pas épuisé avant de lancer
      if (QuotaTracker.isExhausted(CONFIG.GROQ_MODEL_ENRICH)) {
        console.log('[BG] Quota épuisé — background enrich annulé');
        return;
      }

      // Trouver les articles à enrichir — uniquement ceux jamais traités
      // (pas d'ai_content en base, pas juste non-enrichis en mémoire)
      const toEnrich = STATE.articles
        .filter(a => !AI.isEnriched(a)) // isEnriched() vérifie déjà ai_content
        .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date))
        .slice(0, 3); // max 3 par session bg (bridé pour préserver le quota)

      if (toEnrich.length === 0) return;

      running = true;
      console.log(`[BG] Enrichissement arrière-plan : ${toEnrich.length} articles (quota restant: ${QuotaTracker.remaining(CONFIG.GROQ_MODEL_ENRICH)})`);

      for (const article of toEnrich) {
        // Arrêter si l'utilisateur a ouvert un article (on lui laisse la priorité)
        if (document.getElementById('reader-overlay')?.classList.contains('hidden') === false) {
          console.log('[BG] Pause — reader ouvert');
          break;
        }

        try {
          const result = await AI.enrichArticle(article);
          article.ai_title   = result.ai_title || null;
          article.ai_content = result.ai_content;
          article.ai_tags    = result.ai_tags;

          if (STATE.user) {
            DB.upsertArticle({
              feed_id:    article.feed_id    || null,
              user_id:    STATE.user.id,
              hash:       article.hash,
              title:      article.title      || '',
              link:       article.link       || '',
              content:    article.content    || '',
              ai_title:   result.ai_title    || null,
              ai_content: result.ai_content  || '',
              ai_tags:    result.ai_tags     || [],
              pub_date:   article.pub_date   || new Date().toISOString(),
              read:       article.read       || false,
              bookmarked: article.bookmarked || false,
              image:      article.image      || null,
            }).then(newId => {
              if (newId && !article.id) article.id = newId;
            }).catch(() => {});
          }
          // Mettre à jour la row dans le feed sans re-render complet
          Reader._updateFeedRow(article);
        } catch (err) {
          // Rate limit ou quota épuisé — on s'arrête proprement
          if (err.message === 'QUOTA_EXHAUSTED' || err.message?.includes('Rate limit')) {
            console.log('[BG] Quota atteint, arrêt enrichissement bg');
            break; // markExhausted déjà fait dans callGroq
          }
          console.warn('[BG] Erreur enrichissement:', err.message);
        }

        // Vérifier le quota à chaque itération
        if (QuotaTracker.isExhausted(CONFIG.GROQ_MODEL_ENRICH)) {
          console.log('[BG] Quota atteint en cours de traitement, arrêt');
          break;
        }

        // Délai respectueux entre chaque appel
        await new Promise(r => setTimeout(r, CONFIG.GROQ_REQUEST_DELAY));
      }

      running = false;
    }

    return { run };
  })();

  /* ================================================================
     13. SYNC — Chargement et enrichissement des articles
     ================================================================ */
  const Sync = (() => {
    /**
     * Synchronise tous les feeds :
     *   1. Fetch RSS
     *   2. Déduplication
     *   3. Enrichissement IA (nouveaux articles seulement)
     *   4. Clustering
     *   5. Rendu UI
     */
    async function run() {
      if (STATE.isLoading) return;
      STATE.isLoading = true;
      Loader.setSyncDot('syncing');

      const syncBtn = document.getElementById('btn-refresh');
      syncBtn.disabled = true;

      try {
        // 1. Fetch RSS
        const rawArticles = await RSS.fetchAllFeeds(STATE.feeds);

        // 2. Déduplication
        const { unique } = Cluster.deduplicate(rawArticles);

        // 3. Fusionner avec les articles déjà enrichis en mémoire
        // Le sync ne fait plus d'enrichissement IA — celui-ci se fait à la demande
        // à l'ouverture de chaque article dans le Reader.
        const existingMap = new Map(STATE.articles.map(a => [a.hash, a]));
        const existingHashes = new Set(STATE.articles.map(a => a.hash));

        // Compter les vrais nouveaux articles AVANT de mettre à jour le state
        const newCount = unique.filter(a => !existingHashes.has(a.hash)).length;

        // Fusionner : partir des articles Supabase (base), mettre à jour avec le RSS frais
        // Les articles Supabase qui ne sont plus dans le feed sont conservés (enrichis ou bookmarkés)
        const freshMap = new Map(unique.map(a => [a.hash, a]));

        // 1. Mettre à jour les articles existants avec les données RSS fraîches
        const updatedExisting = STATE.articles.map(a => {
          const fresh = freshMap.get(a.hash);
          if (fresh) {
            // Copier l'image depuis le RSS frais si manquante
            if (!a.image && fresh.image) a.image = fresh.image;
            return a; // Garder la version enrichie en mémoire
          }
          return a; // Article plus dans le feed — conserver quand même
        });

        // 2. Ajouter les nouveaux articles du RSS pas encore en mémoire
        const newArticles = unique.filter(a => !existingHashes.has(a.hash));

        // 4. Mise à jour du state — trier en place sans recréer les objets
        STATE.articles = [...updatedExisting, ...newArticles]
          .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));

        // 5. Clustering + Rendu UI
        refreshUI();

        STATE.lastSyncTime = Date.now();
        localStorage.setItem('synapse_last_sync', STATE.lastSyncTime);
        Loader.setSyncDot('done');
        updateLastSyncLabel();

        // Sauvegarder dans localStorage
        if (STATE.user) Cache.save(STATE.user.id, STATE.articles);

        // Sauvegarder les articles pas encore en base (pas d'id Supabase)
        if (STATE.user) {
          const saveNew = STATE.articles.filter(a => !a.id);
          for (let i = 0; i < saveNew.length; i += 5) {
            const batch = saveNew.slice(i, i + 5);
            const results = await Promise.allSettled(batch.map(a => DB.upsertArticle({
              feed_id:    a.feed_id    || null,
              user_id:    STATE.user.id,
              hash:       a.hash,
              title:      a.title      || '',
              link:       a.link       || '',
              content:    a.content    || '',
              ai_title:   a.ai_title   || null,
              ai_content: a.ai_content || '',
              ai_tags:    a.ai_tags    || [],
              pub_date:   a.pub_date   || new Date().toISOString(),
              read:       a.read       || false,
              bookmarked: a.bookmarked || false,
              image:      a.image      || null,
            })));
            // Assigner les IDs retournés pour éviter les re-upserts au prochain sync
            results.forEach((result, idx) => {
              if (result.status === 'fulfilled' && result.value) {
                batch[idx].id = result.value;
              }
            });
          }
        }

        Toast.show(
          newCount > 0 ? `${newCount} nouveau${newCount > 1 ? 'x' : ''} article${newCount > 1 ? 's' : ''} chargé${newCount > 1 ? 's' : ''}` : 'Flux à jour',
          'success'
        );

        // Enrichissement silencieux en arrière-plan
        setTimeout(() => BackgroundEnrich.run(), 3000);

      } catch (err) {
        console.error('Erreur de sync:', err);
        Toast.show(`Erreur sync : ${err.message}`, 'error');
        Loader.setSyncDot('idle');
      } finally {
        STATE.isLoading = false;
        syncBtn.disabled = false;
      }
    }

    /** Rafraîchit toutes les vues UI avec l'état actuel */
    function refreshUI() {
      // Exclure uniquement les articles dont le feed est explicitement désactivé
      // Ne pas filtrer les articles sans correspondance (feed supprimé/recréé)
      const inactiveFeedIds = new Set(STATE.feeds.filter(f => !f.active).map(f => f.id));
      const visibleArticles = STATE.articles.filter(a => !a.feed_id || !inactiveFeedIds.has(a.feed_id));

      Render.renderFeedArticles(visibleArticles, STATE.currentFilter, STATE.searchQuery);
      // Bookmarks : re-render uniquement si la vue est active (évite un appel Supabase à chaque sync)
      if (STATE.currentView === 'bookmarks') Render.renderBookmarks(visibleArticles);
      // Settings : re-render uniquement si la vue est active (évite de recalculer toute la liste à chaque sync)
      if (STATE.currentView === 'settings') Settings.renderFeedsManager(STATE.feeds);
      Render.renderSidebarFeeds(STATE.feeds);
      updateBadge();
      Render.renderWelcome();
    }

    /** Met à jour le badge "non lus" dans la nav */
    function updateBadge() {
      // Badge numérique supprimé — on garde uniquement le dot breaking news
      const badge = document.getElementById('badge-feed');
      if (badge) badge.classList.add('hidden');

      // Badge breaking news — importance 5 non lus

    }

    function updateLastSyncLabel() {
      const label = document.getElementById('last-sync-label');
      if (!label) return;
      const lastSync = STATE.lastSyncTime || parseInt(localStorage.getItem('synapse_last_sync') || '0');
      if (!lastSync) { label.textContent = ''; return; }
      const diff = Math.floor((Date.now() - lastSync) / 60000);
      if (diff < 1) label.textContent = 'Mis à jour à l\'instant';
      else if (diff === 1) label.textContent = 'Mis à jour il y a 1 min';
      else if (diff < 60) label.textContent = `Mis à jour il y a ${diff} min`;
      else {
        const h = Math.floor(diff / 60);
        label.textContent = `Mis à jour il y a ${h}h`;
      }
    }

    return { run, refreshUI, updateBadge, updateLastSyncLabel };
  })();

  /* ================================================================
     AUTH UI — Gestion de l'interface d'authentification
     ================================================================ */
  const AuthUI = (() => {
    function init() {
      // Tabs login/register
      document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
          document.getElementById(`auth-${tab.dataset.tab}`).classList.remove('hidden');
        });
      });

      // Connexion
      document.getElementById('btn-login').addEventListener('click', async () => {
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('auth-error');

        errorEl.classList.add('hidden');

        if (!email || !password) {
          errorEl.textContent = 'Veuillez remplir tous les champs.';
          errorEl.classList.remove('hidden');
          return;
        }

        const btn = document.getElementById('btn-login');
        btn.disabled = true;
        btn.textContent = 'CONNEXION...';

        try {
          await Auth.login(email, password);
          // onAuthChange s'occupe de la suite
        } catch (err) {
          errorEl.textContent = err.message || 'Erreur de connexion.';
          errorEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'ENTRER';
        }
      });

      // Inscription
      document.getElementById('btn-register').addEventListener('click', async () => {
        const email = document.getElementById('reg-email').value.trim();
        const password = document.getElementById('reg-password').value;
        const errorEl = document.getElementById('auth-error');

        errorEl.classList.add('hidden');

        if (!email || !password) {
          errorEl.textContent = 'Veuillez remplir tous les champs.';
          errorEl.classList.remove('hidden');
          return;
        }

        if (password.length < 6) {
          errorEl.textContent = 'Le mot de passe doit contenir au moins 6 caractères.';
          errorEl.classList.remove('hidden');
          return;
        }

        const btn = document.getElementById('btn-register');
        btn.disabled = true;
        btn.textContent = 'CRÉATION...';

        try {
          await Auth.register(email, password);
          Toast.show('Compte créé ! Vérifiez votre email si la confirmation est activée.', 'success');
        } catch (err) {
          errorEl.textContent = err.message || 'Erreur lors de la création du compte.';
          errorEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'CRÉER UN COMPTE';
        }
      });

      // Déconnexion
      document.getElementById('btn-logout').addEventListener('click', async () => {
        if (STATE.user) Cache.clear(STATE.user.id);
        await Auth.logout();
        showAuthOverlay();
      });
    }

    function showAuthOverlay() {
      document.getElementById('auth-overlay').classList.remove('hidden');
      document.getElementById('app').classList.add('hidden');
    }

    function hideAuthOverlay(user) {
      document.getElementById('auth-overlay').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('user-email').textContent = user.email || '';
    }

    return { init, showAuthOverlay, hideAuthOverlay };
  })();

  /* ================================================================
     13. INIT — Point d'entrée
     ================================================================ */
  async function init() {
    // Détection hors ligne
    const offlineBanner = document.createElement('div');
    offlineBanner.id = 'offline-banner';
    offlineBanner.style.cssText = `
      display: none; position: fixed; top: 0; left: 0; right: 0;
      background: #333; color: #fff; text-align: center;
      font-family: var(--font-mono); font-size: 0.65rem; letter-spacing: 0.1em;
      padding: 8px; z-index: 9999;
    `;
    offlineBanner.textContent = '⚠ HORS LIGNE — Les articles en cache restent disponibles';
    document.body.appendChild(offlineBanner);

    // Afficher le banner immédiatement si déjà hors ligne au démarrage
    if (!navigator.onLine) {
      offlineBanner.style.display = 'block';
    }

    window.addEventListener('offline', () => { offlineBanner.style.display = 'block'; });
    window.addEventListener('online', () => {
      offlineBanner.style.display = 'none';
      Toast.show('Connexion rétablie ✓', 'success');
      Sync.run();
    });
    // Initialiser Supabase
    Auth.init();

    // Écouter les changements d'auth
    Auth.onAuthChange(async (user, event) => {
      // Ignorer les events qui ne changent pas l'état de connexion
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (user) STATE.user = user;
        return;
      }
      // SIGNED_IN sur un user déjà chargé = retour d'onglet, ignorer
      if (event === 'SIGNED_IN' && STATE.user && STATE.articles.length > 0) {
        return;
      }

      if (user) {
        // Première connexion ou retour après déconnexion
        STATE.user = user;
        AuthUI.hideAuthOverlay(user);
        await onUserLogin(user);
      } else {
        // Déconnexion réelle
        Loader.hide();
        AuthUI.showAuthOverlay();
      }
    });

    // Init UI (événements)
    Nav.init();
    Reader.init();
    Settings.init();
    Digest.init();
    AuthUI.init();
    Theme.init();
    FontSize.init();
    QuotaTracker.init();

    // Initialiser le label et le mettre à jour toutes les minutes
    Sync.updateLastSyncLabel();
    setInterval(() => Sync.updateLastSyncLabel(), 60000);



    // Filtres vue flux
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.currentFilter = btn.dataset.filter;
        STATE.articlesPage = 0;
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
      });
    });

    // Marquer tout lu
    const markAllBtn = document.getElementById('btn-mark-all-read');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', async () => {
        const unread = STATE.articles.filter(a => !a.read);
        if (unread.length === 0) { Toast.show('Tout est déjà lu', 'info'); return; }
        unread.forEach(a => {
          a.read = true;
          STATE.readArticles.add(a.id || a.hash);
        });
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
        Sync.updateBadge();
        Toast.show(`${unread.length} article${unread.length > 1 ? 's' : ''} marqué${unread.length > 1 ? 's' : ''} comme lu${unread.length > 1 ? 's' : ''}`, 'success');
        // Sauvegarder en base en arrière-plan
        if (STATE.user) {
          for (const a of unread) {
            if (a.id) DB.updateArticleStatus(a.id, { read: true }).catch(() => {});
          }
        }
      });
    }

    // Toggle de la barre de recherche
    const searchBar = document.getElementById('search-bar');
    const searchToggle = document.getElementById('btn-search-toggle');
    const searchCloseBtn = document.getElementById('btn-search-close');

    if (searchToggle) searchToggle.addEventListener('click', () => {
      searchBar.classList.toggle('hidden');
      if (!searchBar.classList.contains('hidden')) {
        document.getElementById('search-input').focus();
      }
    });

    if (searchCloseBtn) searchCloseBtn.addEventListener('click', () => {
      searchBar.classList.add('hidden');
      const si = document.getElementById('search-input');
      si.value = '';
      STATE.searchQuery = '';
      STATE.searchResults = null;
      STATE.articlesPage = 0;
      Render.renderFeedArticles(STATE.articles, STATE.currentFilter, '');
    });

    // Recherche — locale d'abord, puis Supabase si peu de résultats
    const searchInput = document.getElementById('search-input');
    let searchDebounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      const q = searchInput.value.trim();

      // Reset résultats Supabase et pagination si on efface la recherche
      if (!q) {
        STATE.searchQuery = '';
        STATE.searchResults = null;
        STATE.isSearching = false; // FIX: reset si l'utilisateur efface la query
        STATE.articlesPage = 0;
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, '');
        return;
      }

      STATE.searchQuery = q;
      STATE.articlesPage = 0;

      // Recherche locale immédiate
      Render.renderFeedArticles(STATE.articles, STATE.currentFilter, q);

      // Après 500ms, chercher aussi dans Supabase si l'utilisateur est connecté
      searchDebounce = setTimeout(async () => {
        if (!STATE.user || q.length < 2) return;

        // Compter les résultats locaux
        const localResults = STATE.articles.filter(a =>
          (a.title || '').toLowerCase().includes(q.toLowerCase()) ||
          (a.ai_content || a.content || '').toLowerCase().includes(q.toLowerCase())
        );

        // Si assez de résultats locaux (>= 5), pas besoin de chercher en base
        if (localResults.length >= 10) return;

        STATE.isSearching = true;
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, q);

        try {
          const dbResults = await DB.searchArticles(STATE.user.id, q);
          if (STATE.searchQuery !== q) {
            STATE.isSearching = false; // FIX: toujours reset même si query obsolète
            return;
          }

          // Normaliser les résultats DB
          const normalized = dbResults.map(a => ({
            ...a,
            feed_name: a.feeds?.name || a.feed_name || '',
            feed_category: a.feeds?.category || a.feed_category || '',
          }));

          // Fusionner avec les articles déjà en mémoire (pas de doublons)
          const inMemoryHashes = new Set(STATE.articles.map(a => a.hash));
          const newFromDB = normalized.filter(a => !inMemoryHashes.has(a.hash));

          STATE.searchResults = [...localResults, ...newFromDB];
          STATE.isSearching = false;
          Render.renderFeedArticles(STATE.articles, STATE.currentFilter, q);
        } catch (err) {
          STATE.isSearching = false;
          console.warn('Recherche Supabase échouée:', err);
        }
      }, 500);
    });

    // Bouton refresh manuel
    document.getElementById('btn-refresh').addEventListener('click', () => {
      Sync.run();
    });

    // Raccourci R pour refresh (hors reader et hors champs de saisie)
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const readerOpen = !document.getElementById('reader-overlay')?.classList.contains('hidden');
      if (!readerOpen && (e.key === 'r' || e.key === 'R')) Sync.run();
    });

    // ── RETOUR EN HAUT ──
    const scrollTopBtn = document.getElementById('btn-scroll-top');
    const mainContent = document.getElementById('main-content');
    mainContent.addEventListener('scroll', () => {
      if (mainContent.scrollTop > 400) {
        scrollTopBtn.classList.remove('hidden');
      } else {
        scrollTopBtn.classList.add('hidden');
      }
    });
    scrollTopBtn.addEventListener('click', () => {
      mainContent.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // ── PULL TO REFRESH (mobile) ──
    let pullStartY = 0;
    let pullDist = 0;
    let isPulling = false;
    const PULL_THRESHOLD = 80;

    // Indicateur visuel pull-to-refresh
    const pullIndicator = document.createElement('div');
    pullIndicator.id = 'pull-indicator';
    pullIndicator.innerHTML = '↓ Relâcher pour rafraîchir';
    pullIndicator.style.cssText = `
      position: fixed; top: -50px; left: 50%; transform: translateX(-50%);
      background: var(--ink); color: var(--white);
      font-family: var(--font-mono); font-size: 0.65rem; letter-spacing: 0.1em;
      padding: 8px 16px; border-radius: 20px; z-index: 500;
      transition: top 0.2s ease, opacity 0.2s ease; opacity: 0;
      pointer-events: none;
    `;
    document.body.appendChild(pullIndicator);

    mainContent.addEventListener('touchstart', (e) => {
      if (mainContent.scrollTop === 0) {
        pullStartY = e.touches[0].clientY;
        isPulling = true;
      }
    }, { passive: true });

    mainContent.addEventListener('touchmove', (e) => {
      if (!isPulling) return;
      pullDist = e.touches[0].clientY - pullStartY;
      if (pullDist > 0 && pullDist < 150) {
        const progress = Math.min(pullDist / PULL_THRESHOLD, 1);
        pullIndicator.style.top = `${Math.min(pullDist * 0.4, 20)}px`;
        pullIndicator.style.opacity = progress.toString();
        pullIndicator.innerHTML = pullDist > PULL_THRESHOLD
          ? '↑ Relâcher pour rafraîchir'
          : '↓ Tirer pour rafraîchir';
      }
    }, { passive: true });

    mainContent.addEventListener('touchend', () => {
      if (isPulling && pullDist > PULL_THRESHOLD) {
        Sync.run();
        Toast.show('Rafraîchissement...', 'info');
      }
      pullDist = 0;
      isPulling = false;
      pullIndicator.style.top = '-50px';
      pullIndicator.style.opacity = '0';
    }, { passive: true });

    // ── ANIMATION SWIPE READER (mobile) ──
    // Remplacer le swipe existant par une version avec animation
    // (le listener touchstart/touchend existant dans Reader.init est remplacé)
    const readerModal = document.getElementById('reader-modal');
    let swipeStartX = 0;
    let swipeStartY = 0;
    let isSwiping = false;

    readerModal.addEventListener('touchstart', (e) => {
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
      isSwiping = true;
    }, { passive: true });

    readerModal.addEventListener('touchmove', (e) => {
      if (!isSwiping) return;
      const dx = e.touches[0].clientX - swipeStartX;
      const dy = e.touches[0].clientY - swipeStartY;
      // Uniquement swipe horizontal
      if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 10) {
        const resistance = 0.3;
        readerModal.style.transform = `translateX(${dx * resistance}px)`;
        readerModal.style.opacity = `${1 - Math.abs(dx) / 600}`;
      }
    }, { passive: true });

    readerModal.addEventListener('touchend', (e) => {
      if (!isSwiping) return;
      isSwiping = false;
      const dx = e.changedTouches[0].clientX - swipeStartX;
      const dy = e.changedTouches[0].clientY - swipeStartY;

      readerModal.style.transition = 'transform 0.3s cubic-bezier(0.25,0.1,0.25,1), opacity 0.3s ease';

      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
        // Swipe suffisant — animer vers la sortie puis changer d'article
        const dir = dx < 0 ? 1 : -1;
        readerModal.style.transform = `translateX(${dir * -100}vw)`;
        readerModal.style.opacity = '0';

        setTimeout(() => {
          // Remettre de l'autre côté avant l'entrée
          readerModal.style.transition = 'none';
          readerModal.style.transform = `translateX(${dir * 100}vw)`;
          readerModal.style.opacity = '0';

          // Flag : le swipe gère l'animation — goNext/goPrev ne doivent pas ré-animer
          Reader._swipeInProgress = true;
          if (dx < 0) Reader.goNext();
          else Reader.goPrev();
          Reader._swipeInProgress = false;

          requestAnimationFrame(() => {
            readerModal.style.transition = 'transform 0.3s cubic-bezier(0.25,0.1,0.25,1), opacity 0.3s ease';
            readerModal.style.transform = 'translateX(0)';
            readerModal.style.opacity = '1';
            setTimeout(() => { readerModal.style.transition = ''; }, 300);
          });
        }, 200);
      } else {
        // Swipe annulé — revenir en place
        readerModal.style.transform = 'translateX(0)';
        readerModal.style.opacity = '1';
        setTimeout(() => { readerModal.style.transition = ''; }, 300);
      }
    }, { passive: true });

    // Vérifier la session existante
    const session = await Auth.getSession();
    if (!session) {
      AuthUI.showAuthOverlay();
    }
    // Si session, onAuthChange s'en occupe
  }

  /**
   * Appelé après connexion réussie d'un utilisateur
   */
  async function onUserLogin(user) {
    Loader.show('Chargement de vos données...');
    Loader.setProgress(10);

    try {
      // Charger les feeds
      Loader.setStatus('Chargement des feeds...');
      STATE.feeds = await DB.getFeeds(user.id);
      Render.renderSidebarFeeds(STATE.feeds);
      Settings.renderFeedsManager(STATE.feeds);
      Loader.setProgress(25);

      // Charger les articles en cache (Supabase)
      Loader.setStatus('Chargement des articles...');
      const cachedArticles = await DB.getArticles(user.id);

      if (cachedArticles.length > 0) {
        // Reconstituer le state — réutiliser les objets existants, ne jamais écraser l'enrichissement IA en mémoire
        const existingMap = new Map(STATE.articles.map(a => [a.hash, a]));
        STATE.articles = cachedArticles.map(a => {
          const existing = existingMap.get(a.hash);
          if (existing) {
            // Mettre à jour uniquement les champs non-IA (statut lu, bookmark, image)
            // Ne JAMAIS écraser ai_content/ai_title/ai_tags/importance si déjà enrichi en mémoire
            existing.read = a.read;
            existing.bookmarked = a.bookmarked;
            existing.image = existing.image || a.image || '';
            if (!existing.ai_content && a.ai_content) {
              existing.ai_content = a.ai_content;
              existing.ai_title = a.ai_title;
              existing.ai_tags = a.ai_tags;
                    }
            return existing;
          }
          return {
            ...a,
            feed_name: a.feeds?.name || a.feed_name || '',
            feed_category: a.feeds?.category || a.feed_category || '',
          };
        });

        STATE.bookmarks = new Set(
          cachedArticles.filter(a => a.bookmarked).map(a => a.id)
        );
        STATE.readArticles = new Set(
          cachedArticles.filter(a => a.read).map(a => a.id)
        );

        Sync.refreshUI();
      }

      Loader.setProgress(60);
      Loader.hide();

      // Synchronisation automatique uniquement si nécessaire
      if (STATE.feeds.length > 0) {
        const lastSync = parseInt(localStorage.getItem('synapse_last_sync') || '0');
        const minutesSinceSync = (Date.now() - lastSync) / 60000;
        const SYNC_INTERVAL_MIN = 15; // Ne pas re-syncer si moins de 15 min

        if (minutesSinceSync > SYNC_INTERVAL_MIN) {
          setTimeout(() => Sync.run(), 1000);
        } else {
          Sync.updateLastSyncLabel();
        }

        // Sync auto toutes les 30 minutes — seulement si l'onglet est visible
        // et que l'utilisateur a été actif récemment
        let lastActivity = Date.now();
        ['click', 'scroll', 'keydown'].forEach(evt =>
          document.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true })
        );

        setInterval(() => {
          const idleMs = Date.now() - lastActivity;
          if (!document.hidden && idleMs < 10 * 60 * 1000) Sync.run(); // actif depuis moins de 10 min
        }, 30 * 60 * 1000);

      } else {
        Nav.switchView('settings');
        Toast.show('Bienvenue ! Commencez par ajouter des feeds RSS.', 'info');
      }

    } catch (err) {
      console.error('Erreur initialisation:', err);
      Loader.hide();
      Toast.show(`Erreur de chargement : ${err.message}`, 'error');
    }
  }

  // Démarrage
  document.addEventListener('DOMContentLoaded', init);

})();
