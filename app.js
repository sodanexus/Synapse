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

    // Modèle Groq (peut être changé facilement ici)
    GROQ_MODEL: 'llama-3.1-8b-instant',

    // Nombre d'articles max à charger par fetch
    MAX_ARTICLES_PER_FEED: 10,

    // Seuil de similarité pour déduplication (0-1)
    DEDUP_THRESHOLD: 0.65,

    // Délai entre les requêtes Groq (ms)
    // Groq free tier ≈ 30 req/min → 3s minimum pour rester dans les limites
    GROQ_REQUEST_DELAY: 3000,

    // Cache TTL pour les articles (ms) — 30 minutes
    CACHE_TTL: 30 * 60 * 1000,
  };

  /* ================================================================
     2. STATE — état global de l'application
     ================================================================ */
  const STATE = {
    user: null,              // Utilisateur Supabase connecté
    feeds: [],               // Liste des feeds RSS de l'utilisateur
    articles: [],            // Tous les articles chargés (enrichis IA)
    clusters: [],            // Articles regroupés par sujet
    bookmarks: new Set(),    // IDs des articles bookmarkés
    readArticles: new Set(), // IDs des articles lus
    currentView: 'home',     // Vue active
    currentFilter: 'all',    // Filtre actif sur la vue flux
    currentFeedFilter: null, // ID du feed sélectionné dans la sidebar (null = tous)
    currentArticleIndex: 0,  // Index de l'article ouvert dans le reader
    currentArticleList: [],  // Liste courante pour la navigation reader
    searchQuery: '',         // Requête de recherche active
    searchResults: null,     // Résultats de recherche Supabase (null = pas de recherche active)
    articlesPage: 0,         // Page courante pour la pagination
    articlesPerPage: 200,    // Articles par page
    digestGenerated: false,  // Digest déjà généré aujourd'hui ?
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
          articles: articles.slice(0, 100),
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
    }

    /** Récupère la session active */
    async function getSession() {
      const { data } = await getClient().auth.getSession();
      return data.session;
    }

    /** Écoute les changements d'auth (login/logout) */
    function onAuthChange(callback) {
      getClient().auth.onAuthStateChange((_event, session) => {
        callback(session?.user ?? null);
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
    async function getArticles(userId, { days = 7, limit = 200, offset = 0 } = {}) {
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const { data, error } = await client()
        .from('articles')
        .select('*, feeds(name, category)')
        .eq('user_id', userId)
        .gte('pub_date', since)
        .order('importance', { ascending: false })
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
        .order('importance', { ascending: false })
        .order('pub_date', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    }

    /** Upsert un article — insert si nouveau, ignore si hash déjà présent pour ce user */
    async function upsertArticle(article) {
      // On tente d'abord un insert simple
      const { error } = await client()
        .from('articles')
        .upsert(article, {
          onConflict: 'user_id,hash',
          ignoreDuplicates: false,
        });

      // Si la contrainte (user_id,hash) n'existe pas encore en base (400),
      // on retombe sur onConflict: 'hash' en attendant la migration SQL
      if (error && error.code === '42P10') {
        const { error: error2 } = await client()
          .from('articles')
          .upsert(article, { onConflict: 'hash' });
        if (error2) throw error2;
      } else if (error) {
        throw error;
      }
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
    async function saveDigest(userId, content) {
      const today = new Date().toISOString().split('T')[0];
      const { error } = await client()
        .from('digests')
        .upsert({ user_id: userId, date: today, content }, { onConflict: 'user_id,date' });
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

    return { getFeeds, addFeed, deleteFeed, toggleFeed, getArticles, searchArticles, getBookmarks, getReadHistory, upsertArticle, updateArticleStatus, getTodayDigest, saveDigest };
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
              // Champs IA — remplis après
              ai_content: null,
              ai_summary: null,
              ai_tags: [],
              importance: 0,
              cluster_id: null,
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
    async function callGroq(systemPrompt, userPrompt, maxTokens = 800, retryCount = 0) {
      const response = await fetch(`${CONFIG.WORKER_URL}/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.GROQ_MODEL,
          system: systemPrompt,
          prompt: userPrompt,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(30000),
      });

      // Gestion du rate limit : retry avec backoff exponentiel
      if (response.status === 429) {
        if (retryCount >= 3) {
          throw new Error('Rate limit Groq atteint après plusieurs tentatives. Réessayez dans quelques minutes.');
        }
        // Attendre de plus en plus longtemps : 5s, 10s, 20s
        const waitMs = (5000) * Math.pow(2, retryCount);
        console.warn(`Groq 429 — attente ${waitMs / 1000}s avant retry ${retryCount + 1}/3`);
        await sleep(waitMs);
        return callGroq(systemPrompt, userPrompt, maxTokens, retryCount + 1);
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error ${response.status}: ${err}`);
      }

      const data = await response.json();
      return data.text || '';
    }

    /**
     * Enrichit un article avec l'IA :
     *   - réécriture sans bruit
     *   - score d'importance (1-5)
     *   - tags thématiques
     * Retourne { ai_content, importance, ai_tags }
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
      // Construire le texte RSS de base immédiatement
      const rssText = [
        article.title || '',
        article.description || '',
        article.content || '',
      ].filter(Boolean).join('\n\n').substring(0, 2000);

      if (rssText.trim().length < 30) {
        return { ai_content: article.content || article.title || '', importance: 1, ai_tags: [], sentiment: 'neutral' };
      }

      // Lancer scraping et Groq EN PARALLÈLE — timeout scraping réduit à 5s
      const scrapePromise = article.link
        ? fetch(`${CONFIG.WORKER_URL}/scrape?url=${encodeURIComponent(article.link)}`, {
            signal: AbortSignal.timeout(5000)
          })
          .then(r => r.ok ? r.json() : null)
          .then(d => (d?.text?.length > 200) ? d.text : null)
          .catch(() => null)
        : Promise.resolve(null);

      // Groq démarre immédiatement avec le texte RSS
      const systemPrompt = `Tu es un éditeur de presse expert. Tu réécris ou résumes les articles RSS en prose claire et fluide. Tu supprimes tout le bruit (publicités, appels à l'action, mentions légales). Si le contenu est riche, tu réécris en 150-250 mots. Si le contenu est court ou tronqué, tu fais le meilleur résumé possible avec ce que tu as, en ajoutant du contexte général sur le sujet si nécessaire. Tu ne copies JAMAIS le texte original mot pour mot. Tu réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks. Langue de sortie : français.`;

      // On attend les deux en parallèle
      const [scrapedText, raw] = await Promise.all([
        scrapePromise,
        (async () => {
          // Si on a du scraped text, on le préfère — mais Groq part déjà avec le RSS
          // On relancera si le scraping donne mieux (seulement si scraping > 2x le RSS)
          const sourceText = rssText;
          const prompt = `Réécris ou résume cet article et retourne exactement ce JSON (et rien d'autre) :
{"ai_title":"<titre traduit en français, concis et accrocheur, max 12 mots>","ai_content":"<réécriture ou résumé en prose fluide, jamais une copie de l'original, ajoute du contexte si le texte source est trop court>","importance":<1 à 5, 5=breaking news>,"ai_tags":["<thème1>","<thème2>","<thème3>"],"sentiment":"<positive|negative|neutral>"}

TITRE : ${article.title}
SOURCE : ${article.feed_name}
TEXTE : ${sourceText}`;
          return callGroq(systemPrompt, prompt, 800);
        })()
      ]);

      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        const aiText = parsed.ai_content || '';
        const isDistinct = aiText.length > 50 && aiText !== article.content;
        const sentiment = ['positive', 'negative', 'neutral'].includes(parsed.sentiment)
          ? parsed.sentiment : 'neutral';

        return {
          ai_title: parsed.ai_title || null,
          ai_content: isDistinct ? aiText : (article.content || article.title),
          importance: Math.min(5, Math.max(1, parseInt(parsed.importance) || 1)),
          ai_tags: Array.isArray(parsed.ai_tags) ? parsed.ai_tags.slice(0, 5) : [],
          sentiment,
          scraped_content: scrapedText || null,
        };
      } catch (err) {
        console.warn(`Parsing JSON échoué pour "${article.title}":`, err, '\nRaw:', raw);
        return { ai_title: null, ai_content: article.content, importance: 1, ai_tags: [], sentiment: 'neutral', scraped_content: null };
      }
    }

    /**
     * Génère le digest du jour à partir des articles importants
     * Retourne du texte structuré (HTML simple)
     */
    async function generateDailyDigest(articles) {
      // Sélectionner les 15 articles les plus importants du jour
      const today = new Date().toISOString().split('T')[0];
      // Sélectionner les 10 articles les plus importants (au lieu de 15)
      const topArticles = articles
        .filter(a => a.pub_date && a.pub_date.startsWith(today))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 10);

      if (topArticles.length === 0) {
        // Si aucun article du jour, prendre les 10 plus récents
        topArticles.push(
          ...articles.sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date)).slice(0, 10)
        );
      }

      const articlesText = topArticles.map((a, i) =>
        `[${i + 1}] ${a.title} — ${a.feed_name} (importance: ${a.importance}/5)`
      ).join('\n');

      const digest = await callGroq(
        `Tu es un éditeur de presse senior. Tu rédiges des briefings matinaux synthétiques pour un lecteur pressé.
Format de sortie : HTML simple, utilise <h2> pour les sections thématiques, <ul><li> pour les points, <p> pour les paragraphes.
Langue : français. Sois direct, factuel, sans introduction ni conclusion verbeuse.`,
        `Rédige le digest des actualités du jour. Structure par thèmes (max 4 thèmes). Inclus les sujets les plus importants.\n\n${articlesText}`,
        600
      );

      return digest;
    }

    /**
     * Enrichit un lot d'articles en série (avec délai pour éviter le rate-limit)
     * Appelle onProgress(current, total) à chaque article traité
     */
    async function enrichBatch(articles, onProgress) {
      const enriched = [];
      for (let i = 0; i < articles.length; i++) {
        try {
          const result = await enrichArticle(articles[i]);
          enriched.push({ ...articles[i], ...result });
        } catch (err) {
          console.warn(`Enrichissement échoué pour "${articles[i].title}":`, err);
          enriched.push(articles[i]); // Fallback : article brut
        }
        if (onProgress) onProgress(i + 1, articles.length);
        // Délai anti-rate-limit entre chaque appel
        if (i < articles.length - 1) await sleep(CONFIG.GROQ_REQUEST_DELAY);
      }
      return enriched;
    }

    return { enrichArticle, enrichBatch, generateDailyDigest, callGroq, isEnriched };
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
     * on garde celui avec l'importance la plus haute (ou le plus récent).
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
            if ((article.importance || 0) > (kept.importance || 0)) {
              kept.importance = article.importance;
            }
            // Ajouter la source alternative à l'article conservé
            if (!kept.duplicate_sources) kept.duplicate_sources = [];
            kept.duplicate_sources.push({ name: article.feed_name, link: article.link });
            duplicates.push(article);
            break;
          }
        }
        if (!isDuplicate) unique.push(article);
      }

      return { unique, duplicates };
    }

    /**
     * Groupe les articles par thème en utilisant les tags IA.
     * Retourne un tableau de clusters : { topic, articles[], importance }
     */
    function clusterByTopic(articles) {
      const tagMap = new Map(); // tag → [articles]

      // Grouper les articles par tag IA
      for (const article of articles) {
        const tags = article.ai_tags || [];
        for (const tag of tags) {
          const key = tag.toLowerCase().trim();
          if (!tagMap.has(key)) tagMap.set(key, []);
          tagMap.get(key).push(article);
        }
      }

      // Ne garder que les tags avec au moins 2 articles
      const clusters = [];
      const usedArticleIds = new Set();

      // Trier les tags par nombre d'articles (décroissant)
      const sortedTags = [...tagMap.entries()]
        .filter(([, arts]) => arts.length >= 2)
        .sort(([, a], [, b]) => b.length - a.length);

      for (const [topic, arts] of sortedTags) {
        // Éviter qu'un article apparaisse dans plusieurs clusters
        const clusterArticles = arts.filter(a => !usedArticleIds.has(a.hash));
        if (clusterArticles.length < 2) continue;

        clusterArticles.forEach(a => usedArticleIds.add(a.hash));

        const avgImportance = clusterArticles.reduce((s, a) => s + (a.importance || 1), 0) / clusterArticles.length;

        clusters.push({
          id: `cluster-${topic.replace(/\s+/g, '-')}`,
          topic: topic.charAt(0).toUpperCase() + topic.slice(1),
          articles: clusterArticles.sort((a, b) => (b.importance || 0) - (a.importance || 0)),
          importance: Math.round(avgImportance),
        });
      }

      // Trier les clusters par importance décroissante
      return clusters.sort((a, b) => b.importance - a.importance);
    }

    return { deduplicate, clusterByTopic };
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
      if (viewId === 'history')   Render.renderHistory();
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

      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });

      // Fermer sidebar en cliquant en dehors
      document.addEventListener('click', (e) => {
        if (window.innerWidth <= 900 &&
          sidebar.classList.contains('open') &&
          !sidebar.contains(e.target) &&
          !toggle.contains(e.target)) {
          sidebar.classList.remove('open');
        }
      });

      // Date du digest
      const dateEl = document.getElementById('digest-date');
      if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('fr-FR', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }).toUpperCase();
      }
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

    return { init, set };
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

    /** Génère les barres d'importance (1-5) */
    function importanceBars(score) {
      return Array.from({ length: 5 }, (_, i) => {
        const active = i < score;
        const color = `var(--imp-${Math.max(1, score)})`;
        return `<div class="imp-bar" style="${active ? `background:${color}` : ''}"></div>`;
      }).join('');
    }

    /** Crée une card article (vue grille, home) */
    function articleCard(article, index, articleList) {
      const card = document.createElement('div');
      card.className = `article-card${article.read ? '' : ' unread'}`;
      card.style.animationDelay = `${index * 40}ms`;

      const score = article.importance || 1;
      const tags = (article.ai_tags || []).slice(0, 3).map(t =>
        `<span class="tag">${escapeHtml(t)}</span>`
      ).join('');

      card.innerHTML = `
        <div class="card-imp-bar imp-${score}"></div>
        <div class="card-source">${escapeHtml(article.feed_name || '')}</div>
        <h3 class="card-title">${escapeHtml(article.ai_title || article.title || '')}</h3>
        <p class="card-excerpt">${escapeHtml((article.ai_content || article.content || '').substring(0, 200))}</p>
        <div class="card-footer">
          <span class="card-date">${relativeTime(article.pub_date)}</span>
          <div class="card-tags">${tags}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        Reader.open(article, index, articleList);
      });

      return card;
    }

    /** Crée une ligne article (vue liste, flux / bookmarks) */
    function articleRow(article, index, articleList) {
      const row = document.createElement('div');
      row.className = `article-row${article.read ? ' read' : ''}`;
      row.style.animationDelay = `${index * 30}ms`;

      const score = article.importance || 1;
      const isBookmarked = STATE.bookmarks.has(article.id || article.hash);

      row.innerHTML = `
        <div class="row-imp-bar imp-${score}"></div>
        <div class="row-body">
          <div class="row-source">${escapeHtml(article.feed_name || '')} · ${relativeTime(article.pub_date)}</div>
          <div class="row-title">${escapeHtml(article.ai_title || article.title || '')}</div>
          <div class="row-meta">${(article.ai_tags || []).slice(0, 3).join(' · ')}</div>
        </div>
        <div class="row-actions">
          <button class="row-action-btn${isBookmarked ? ' bookmarked' : ''}" data-action="bookmark" title="Sauvegarder">◧</button>
          <a class="row-action-btn" href="${escapeHtml(article.link || '#')}" target="_blank" rel="noopener" title="Article original" data-action="source">↗</a>
        </div>
      `;

      // Clic sur la ligne → ouvrir reader
      row.addEventListener('click', (e) => {
        if (!e.target.closest('[data-action]')) {
          Reader.open(article, index, articleList);
        }
      });

      // Bouton bookmark
      const bookmarkBtn = row.querySelector('[data-action="bookmark"]');
      bookmarkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBookmark(article, bookmarkBtn);
      });

      return row;
    }

    /** Toggle bookmark d'un article */
    async function toggleBookmark(article, btn) {
      const key = article.id || article.hash;
      const isBookmarked = STATE.bookmarks.has(key);

      if (isBookmarked) {
        STATE.bookmarks.delete(key);
        btn.classList.remove('bookmarked');
        article.bookmarked = false;
      } else {
        STATE.bookmarks.add(key);
        btn.classList.add('bookmarked');
        article.bookmarked = true;
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
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    /** Rendu vue HOME — articles importants du jour */
    function renderHomeArticles(articles) {
      const container = document.getElementById('home-articles');
      container.innerHTML = '';

      const topArticles = articles
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 12);

      if (topArticles.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon">⬡</span><p class="empty-state-text">Aucun article chargé. Ajoutez des feeds RSS dans la section FEEDS.</p></div>';
        return;
      }

      topArticles.forEach((article, i) => {
        container.appendChild(articleCard(article, i, topArticles));
      });
    }

    /** Rendu vue FLUX — liste filtrée */
    function renderFeedArticles(articles, filter = 'all', query = '') {
      const container = document.getElementById('feed-articles');
      const countEl = document.getElementById('feed-count');
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
      if (filter === 'important') filtered = filtered.filter(a => (a.importance || 0) >= 3);

      // Recherche locale (si pas de résultats Supabase)
      if (query && STATE.searchResults === null) {
        const q = query.toLowerCase();
        filtered = filtered.filter(a =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.ai_content || a.content || '').toLowerCase().includes(q) ||
          (a.ai_tags || []).some(t => t.toLowerCase().includes(q))
        );
      }

      // Tri : toujours du plus récent au plus ancien
      filtered.sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));

      const totalCount = filtered.length;
      const label = STATE.searchResults !== null
        ? `${totalCount} résultat${totalCount !== 1 ? 's' : ''} (base complète)`
        : `${totalCount} article${totalCount !== 1 ? 's' : ''}`;
      countEl.textContent = label;
      countEl.className = STATE.isSearching ? 'articles-count searching'
        : STATE.searchResults !== null ? 'articles-count db-results'
        : 'articles-count';

      if (filtered.length === 0) {
        const msg = STATE.isSearching
          ? 'Recherche en cours...'
          : STATE.searchResults !== null
            ? 'Aucun résultat dans la base de données.'
            : 'Aucun article ne correspond à ce filtre.';
        container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">≡</span><p class="empty-state-text">${msg}</p></div>`;
        return;
      }

      // Pagination — afficher par tranches de 50
      const PAGE_SIZE = 50;
      const page = STATE.articlesPage || 0;
      const paginated = filtered.slice(0, (page + 1) * PAGE_SIZE);

      paginated.forEach((article, i) => {
        container.appendChild(articleRow(article, i, filtered));
      });

      // Bouton "Charger plus" si besoin
      if (paginated.length < filtered.length) {
        const btn = document.createElement('button');
        btn.className = 'btn-load-more';
        btn.textContent = `Charger plus (${filtered.length - paginated.length} restants)`;
        btn.addEventListener('click', () => {
          STATE.articlesPage = (STATE.articlesPage || 0) + 1;
          renderFeedArticles(articles, filter, query);
        });
        container.appendChild(btn);
      }
    }

    /** Rendu vue CLUSTERS */
    function renderClusters(clusters) {
      const container = document.getElementById('clusters-grid');
      container.innerHTML = '';

      if (clusters.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon">◈</span><p class="empty-state-text">Pas assez d\'articles pour créer des clusters. Rafraîchissez vos feeds.</p></div>';
        return;
      }

      clusters.forEach((cluster, ci) => {
        const card = document.createElement('div');
        card.className = 'cluster-card';
        card.style.animationDelay = `${ci * 60}ms`;

        card.innerHTML = `
          <div class="cluster-header">
            <div class="cluster-topic">
              <span class="cluster-count">${cluster.articles.length}</span>
              ${escapeHtml(cluster.topic)}
            </div>
            <span class="cluster-toggle">▾</span>
          </div>
          <div class="cluster-articles articles-list"></div>
        `;

        // Toggle ouverture
        card.querySelector('.cluster-header').addEventListener('click', () => {
          card.classList.toggle('open');
        });

        // Rendu des articles du cluster
        const artContainer = card.querySelector('.cluster-articles');
        cluster.articles.forEach((article, i) => {
          artContainer.appendChild(articleRow(article, i, cluster.articles));
        });

        container.appendChild(card);
      });
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
          li.textContent = feed.name || feed.url;
          li.className = STATE.currentFeedFilter === feed.id ? 'active' : '';
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

    async function renderHistory() {
      const container = document.getElementById('history-articles');
      if (!container) return;
      container.innerHTML = '<div class="content-loading"><div class="spinner"></div><span>Chargement...</span></div>';

      let articles = [];
      if (STATE.user) {
        try {
          const data = await DB.getReadHistory(STATE.user.id);
          articles = data.map(a => ({
            ...a,
            feed_name: a.feeds?.name || a.feed_name || '',
            feed_category: a.feeds?.category || a.feed_category || '',
          }));
        } catch (err) {
          container.innerHTML = `<div class="empty-state"><p class="empty-state-text">Erreur : ${err.message}</p></div>`;
          return;
        }
      }

      container.innerHTML = '';
      if (articles.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon">◷</span><p class="empty-state-text">Aucun article lu récemment.</p></div>';
        return;
      }

      articles.forEach((article, i) => {
        container.appendChild(articleRow(article, i, articles));
      });
    }

    return {
      articleCard, articleRow, renderHomeArticles, renderFeedArticles,
      renderClusters, renderBookmarks, renderHistory, renderSidebarFeeds,
      escapeHtml, relativeTime, importanceBars
    };
  })();

  /* ================================================================
     9. UI — READER (Mode Focus)
     ================================================================ */
  const Reader = (() => {

    /** Ouvre le reader pour un article */
    function open(article, index, articleList) {
      STATE.currentArticleIndex = index;
      STATE.currentArticleList = articleList;

      // Marquer comme lu
      markRead(article);

      // Remplir le reader avec le contenu disponible immédiatement
      populate(article);

      // Afficher l'overlay
      const overlay = document.getElementById('reader-overlay');
      overlay.classList.remove('hidden');
      document.body.style.overflow = 'hidden';

      // Focus trap (accessibilité)
      document.getElementById('btn-close-reader').focus();

      // Enrichissement IA à la demande — uniquement si pas encore fait correctement
      if (!AI.isEnriched(article)) {
        enrichOnOpen(article);
      }
    }

    /**
     * Enrichit un article avec l'IA au moment de son ouverture.
     * Affiche un indicateur de chargement dans le reader pendant le traitement.
     */
    async function enrichOnOpen(article) {
      // Indicateur de chargement sur le titre du reader
      const titleEl = document.getElementById('reader-title');
      if (titleEl) titleEl.style.opacity = '0.5';

      try {
        const result = await AI.enrichArticle(article);

        article.ai_content = result.ai_content;
        article.ai_title = result.ai_title || null;
        article.importance = result.importance;
        article.ai_tags = result.ai_tags;
        article.sentiment = result.sentiment || 'neutral';

        if (STATE.user) {
          DB.upsertArticle({
            feed_id:    article.feed_id || null,
            user_id:    STATE.user.id,
            hash:       article.hash,
            title:      article.title       || '',
            link:       article.link        || '',
            content:    article.content     || '',
            ai_title:   result.ai_title     || null,
            ai_content: result.ai_content   || '',
            ai_tags:    result.ai_tags      || [],
            importance: result.importance   || 1,
            pub_date:   article.pub_date    || new Date().toISOString(),
            read:       article.read        || false,
            bookmarked: article.bookmarked  || false,
          }).catch(err => console.warn('Sauvegarde Supabase échouée:', err));
        }

        const currentArticle = STATE.currentArticleList[STATE.currentArticleIndex];
        if (currentArticle && currentArticle.hash === article.hash) {
          populate(article, true);
        }

      } catch (err) {
        console.warn('Enrichissement IA échoué:', err);
        Toast.show('IA indisponible — réessayez plus tard', 'info');
      } finally {
        if (titleEl) titleEl.style.opacity = '';
      }
    }

    /** Ferme le reader */
    function close() {
      const overlay = document.getElementById('reader-overlay');
      overlay.classList.add('hidden');
      document.body.style.overflow = '';
      // Réinitialiser le mode focus
      const modal = document.getElementById('reader-modal');
      const btn = document.getElementById('btn-focus-mode');
      modal?.classList.remove('focus-mode');
      if (btn) { btn.classList.remove('active'); btn.textContent = '⊡'; }
    }

    /** Remplit le reader avec les données d'un article */
    function populate(article, animate = false) {
      document.getElementById('reader-source').textContent = article.feed_name || '';
      document.getElementById('reader-date').textContent =
        new Date(article.pub_date).toLocaleDateString('fr-FR', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
      document.getElementById('reader-title').textContent = article.ai_title || article.title || '';
      document.getElementById('reader-link').href = article.link || '#';

      // Barres d'importance
      const score = article.importance || 1;
      document.getElementById('reader-imp-bars').innerHTML = Render.importanceBars(score);

      // Tags
      const tagsEl = document.getElementById('reader-tags');
      const sentimentIcon = { positive: '↑', negative: '↓', neutral: '→' };
      const sentimentLabel = { positive: 'positif', negative: 'négatif', neutral: 'neutre' };
      const s = article.sentiment || 'neutral';
      const sentimentHtml = article.sentiment
        ? `<span class="tag sentiment-${s}">${sentimentIcon[s]} ${sentimentLabel[s]}</span>`
        : '';
      tagsEl.innerHTML = sentimentHtml + (article.ai_tags || []).map(t =>
        `<span class="tag">${Render.escapeHtml(t)}</span>`
      ).join('');

      // Contenu IA
      setContent(article, animate);

      // Restaurer la taille de police préférée
      FontSize.set(localStorage.getItem('synapse_fontsize') || 'md', false);

      // Articles similaires
      renderRelated(article);
    }

    /** Affiche les articles similaires dans le reader */
    function renderRelated(article) {
      const relatedZone = document.getElementById('reader-related');
      const relatedList = document.getElementById('reader-related-list');
      if (!relatedZone || !relatedList) return;

      // Scorer chaque article par pertinence :
      // +2 par tag commun, +1 si similarité de titre > 0.15
      const tags = (article.ai_tags || []).map(t => t.toLowerCase().trim());
      const titleWords = new Set(article.title.toLowerCase()
        .replace(/[^a-z0-9àâéèêëîïôùûü]/g, ' ')
        .split(/\s+/).filter(w => w.length > 3));

      const scored = STATE.articles
        .filter(a => a.hash !== article.hash)
        .map(a => {
          let score = 0;
          // Tags communs
          const aTags = (a.ai_tags || []).map(t => t.toLowerCase().trim());
          score += aTags.filter(t => tags.includes(t)).length * 2;
          // Mots du titre en commun
          const aWords = new Set(a.title.toLowerCase()
            .replace(/[^a-z0-9àâéèêëîïôùûü]/g, ' ')
            .split(/\s+/).filter(w => w.length > 3));
          const common = [...titleWords].filter(w => aWords.has(w)).length;
          score += common;
          return { article: a, score };
        })
        .filter(({ score }) => score > 0)
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
          <div class="reader-related-headline">${Render.escapeHtml(rel.title || '')}</div>
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
    function setContent(article, animate = false) {
      const contentEl = document.getElementById('reader-content');
      const text = article.ai_content || article.content || article.description || '';

      // Conversion texte → paragraphes HTML
      const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());

      if (!animate) {
        contentEl.innerHTML = paragraphs.map(p =>
          `<p>${Render.escapeHtml(p.trim())}</p>`
        ).join('');
        return;
      }

      // Animation streaming : les mots apparaissent un à un
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
      const GROUP = 4; // mots révélés en même temps
      const DELAY = 30; // ms entre chaque groupe
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

      if (article.id && STATE.user) {
        try {
          await DB.updateArticleStatus(article.id, { read: true });
        } catch {}
      }
    }

    /** Navigation dans le reader */
    function goNext() {
      const list = STATE.currentArticleList;
      if (STATE.currentArticleIndex < list.length - 1) {
        STATE.currentArticleIndex++;
        const article = list[STATE.currentArticleIndex];
        markRead(article);
        populate(article);
        document.getElementById('reader-modal').scrollTop = 0;
        if (!AI.isEnriched(article)) enrichOnOpen(article);
      }
    }

    function goPrev() {
      const list = STATE.currentArticleList;
      if (STATE.currentArticleIndex > 0) {
        STATE.currentArticleIndex--;
        const article = list[STATE.currentArticleIndex];
        markRead(article);
        populate(article);
        document.getElementById('reader-modal').scrollTop = 0;
        if (!AI.isEnriched(article)) enrichOnOpen(article);
      }
    }



    /** Initialise les événements du reader */
    function init() {
      document.getElementById('btn-close-reader').addEventListener('click', close);

      // Mode focus — plein écran immersif
      document.getElementById('btn-focus-mode').addEventListener('click', () => {
        const modal = document.getElementById('reader-modal');
        const btn = document.getElementById('btn-focus-mode');
        const isActive = modal.classList.toggle('focus-mode');
        btn.classList.toggle('active', isActive);
        btn.textContent = isActive ? '⊞' : '⊡';
        btn.title = isActive ? 'Quitter le mode lecture' : 'Mode lecture';
      });

      // Raccourci F pour toggle focus mode
      document.addEventListener('keydown', (e) => {
        const readerOpen = !document.getElementById('reader-overlay')?.classList.contains('hidden');
        if (readerOpen && (e.key === 'f' || e.key === 'F') && e.target.tagName !== 'INPUT') {
          document.getElementById('btn-focus-mode')?.click();
        }
      });

      // Fermer en cliquant sur l'overlay
      document.getElementById('reader-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) close();
      });

      // Touche Escape
      document.addEventListener('keydown', (e) => {
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
          Toast.show('Supprimé des sauvegardes', 'info');
        } else {
          STATE.bookmarks.add(key);
          article.bookmarked = true;
          btn.classList.add('active');
          Toast.show('Sauvegardé ✓', 'success');
        }

        if (article.id && STATE.user) {
          DB.updateArticleStatus(article.id, { bookmarked: !isBookmarked }).catch(() => {});
        }
      });

      // Bouton partager
      document.getElementById('btn-share').addEventListener('click', async () => {
        const article = STATE.currentArticleList[STATE.currentArticleIndex];
        if (!article) return;

        const title = article.ai_title || article.title || '';
        const text = (article.ai_content || '').substring(0, 300) + '...';
        const url = article.link || '';

        // Web Share API — natif sur mobile, copie sur desktop
        if (navigator.share) {
          try {
            await navigator.share({ title, text, url });
          } catch (err) {
            if (err.name !== 'AbortError') Toast.show('Erreur partage', 'error');
          }
        } else {
          // Fallback desktop : copier dans le presse-papier
          const shareText = `${title}\n\n${text}\n\n${url}`;
          try {
            await navigator.clipboard.writeText(shareText);
            Toast.show('Copié dans le presse-papier ✓', 'success');
          } catch {
            Toast.show('Impossible de copier', 'error');
          }
        }
      });

      // Swipe mobile gauche/droite
      const modal = document.getElementById('reader-modal');
      let touchStartX = 0;
      let touchStartY = 0;
      modal.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });
      modal.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        // Swipe horizontal uniquement (éviter conflit avec scroll vertical)
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
          if (dx < 0) goNext();
          else goPrev();
        }
      }, { passive: true });
    }

    return { open, close, init };
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
        const avgImportance = feedArticles.length > 0
          ? (feedArticles.reduce((s, a) => s + (a.importance || 1), 0) / feedArticles.length).toFixed(1)
          : '—';

        row.innerHTML = `
          <div>
            <div class="feed-row-name">${Render.escapeHtml(feed.name || feed.url)}</div>
            <div class="feed-row-url">${Render.escapeHtml(feed.url)}</div>
            <div class="feed-row-stats">${feedArticles.length} articles · ${readCount} lus · importance moy. ${avgImportance}</div>
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
          if (!confirm(`Supprimer "${feed.name || feed.url}" ?`)) return;
          try {
            await DB.deleteFeed(feed.id);
            STATE.feeds = STATE.feeds.filter(f => f.id !== feed.id);
            row.remove();
            Render.renderSidebarFeeds(STATE.feeds);
            Toast.show('Feed supprimé', 'info');
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
            STATE.clusters = [];
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
            STATE.clusters = [];
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

      // Export OPML
      const exportBtn = document.getElementById('btn-export-opml');
      if (exportBtn) {
        exportBtn.addEventListener('click', () => {
          if (STATE.feeds.length === 0) { Toast.show('Aucun feed à exporter', 'info'); return; }
          OPML.exportOPML(STATE.feeds);
          Toast.show('OPML exporté ✓', 'success');
        });
      }

      // Import OPML
      const importInput = document.getElementById('opml-import');
      if (importInput) {
        importInput.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          Toast.show('Import en cours...', 'info');
          try {
            const added = await OPML.importOPML(file, STATE.user.id);
            Render.renderSidebarFeeds(STATE.feeds);
            renderFeedsManager(STATE.feeds);
            Toast.show(`${added} feed${added > 1 ? 's' : ''} importé${added > 1 ? 's' : ''} ✓`, 'success');
          } catch (err) {
            Toast.show('Erreur import OPML : ' + err.message, 'error');
          }
          importInput.value = '';
        });
      }

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
            ['F', 'Mode lecture plein écran'],
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
     11. UI — Digest HomePage
     ================================================================ */
  const Digest = (() => {
    /** Génère et affiche le digest du jour */
    async function generate() {
      const btn = document.getElementById('btn-generate-digest');
      const zone = document.getElementById('digest-zone');

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> GÉNÉRATION...';

      zone.innerHTML = '<div class="content-loading"><div class="spinner"></div><span>L\'IA analyse vos actualités...</span></div>';

      try {
        // Vérifier s'il existe déjà un digest du jour
        if (STATE.user) {
          const existing = await DB.getTodayDigest(STATE.user.id);
          if (existing) {
            renderDigest(existing.content);
            STATE.digestGenerated = true;
            Toast.show('Digest chargé depuis la cache', 'info');
            return;
          }
        }

        const html = await AI.generateDailyDigest(STATE.articles);
        renderDigest(html);

        // Sauvegarder en base
        if (STATE.user) {
          await DB.saveDigest(STATE.user.id, html);
        }

        STATE.digestGenerated = true;
        Toast.show('Digest généré ✓', 'success');
      } catch (err) {
        zone.innerHTML = `<div class="digest-placeholder">
          <span class="placeholder-icon">⚠</span>
          <p>Erreur lors de la génération : ${Render.escapeHtml(err.message)}</p>
        </div>`;
        Toast.show('Erreur digest IA', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">⚡</span> RÉGÉNÉRER';
      }
    }

    /** Affiche le contenu HTML du digest dans la zone */
    function renderDigest(html) {
      const zone = document.getElementById('digest-zone');
      const div = document.createElement('div');
      div.className = 'digest-content';
      // On utilise innerHTML ici car le contenu vient de notre propre IA
      // et est construit de manière contrôlée
      div.innerHTML = html;
      zone.innerHTML = '';
      zone.appendChild(div);
    }

    /** Initialise le bouton */
    function init() {
      document.getElementById('btn-generate-digest').addEventListener('click', generate);
    }

    return { init, generate };
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
     BACKGROUND ENRICH — Enrichissement silencieux en arrière-plan
     Enrichit les articles non encore traités par ordre d'importance,
     sans bloquer l'UI et en respectant le rate limit Groq.
     ================================================================ */
  const BackgroundEnrich = (() => {
    let running = false;

    async function run() {
      if (running) return;

      // Trouver les articles à enrichir (pas encore traités, triés par importance desc)
      const toEnrich = STATE.articles
        .filter(a => !AI.isEnriched(a))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 10); // max 10 par session bg

      if (toEnrich.length === 0) return;

      running = true;
      console.log(`[BG] Enrichissement arrière-plan : ${toEnrich.length} articles`);

      for (const article of toEnrich) {
        // Arrêter si l'utilisateur a ouvert un article (on lui laisse la priorité)
        if (document.getElementById('reader-overlay')?.classList.contains('hidden') === false) {
          console.log('[BG] Pause — reader ouvert');
          break;
        }

        try {
          const result = await AI.enrichArticle(article);
          article.ai_content = result.ai_content;
          article.importance = result.importance;
          article.ai_tags    = result.ai_tags;
          article.sentiment  = result.sentiment || 'neutral';

          // Sauvegarder en base
          if (STATE.user) {
            DB.upsertArticle({
              feed_id:    article.feed_id || null,
              user_id:    STATE.user.id,
              hash:       article.hash,
              title:      article.title    || '',
              link:       article.link     || '',
              content:    article.content  || '',
              ai_title:   result.ai_title  || null,
              ai_content: result.ai_content || '',
              ai_tags:    result.ai_tags   || [],
              importance: result.importance || 1,
              pub_date:   article.pub_date || new Date().toISOString(),
              read:       article.read     || false,
              bookmarked: article.bookmarked || false,
            }).catch(() => {});
          }
          // Mettre à jour ai_title en mémoire aussi
          article.ai_title = result.ai_title || null;
        } catch (err) {
          // Rate limit ou erreur — on s'arrête proprement
          if (err.message?.includes('Rate limit')) {
            console.log('[BG] Rate limit atteint, arrêt enrichissement bg');
            break;
          }
          console.warn('[BG] Erreur enrichissement:', err.message);
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
        Loader.setStatus('Récupération des feeds RSS...');
        Loader.setProgress(15);
        const rawArticles = await RSS.fetchAllFeeds(STATE.feeds);

        // 2. Déduplication
        Loader.setStatus('Déduplication...');
        Loader.setProgress(30);
        const { unique } = Cluster.deduplicate(rawArticles);

        // 3. Fusionner avec les articles déjà enrichis en mémoire
        // Le sync ne fait plus d'enrichissement IA — celui-ci se fait à la demande
        // à l'ouverture de chaque article dans le Reader.
        const existingMap = new Map(STATE.articles.map(a => [a.hash, a]));
        const existingHashes = new Set(STATE.articles.map(a => a.hash));

        // Compter les vrais nouveaux articles AVANT de mettre à jour le state
        const newCount = unique.filter(a => !existingHashes.has(a.hash)).length;

        // Pour chaque article frais, on réutilise l'enrichissement IA existant s'il est déjà correct
        let enriched = unique.map(a => {
          const old = existingMap.get(a.hash);
          if (old && AI.isEnriched(old)) {
            return old; // Conserver la version correctement enrichie
          }
          return a; // Nouvel article ou mal enrichi → sera re-traité à l'ouverture
        });

        // 4. Mise à jour du state
        STATE.articles = enriched.sort((a, b) =>
          new Date(b.pub_date) - new Date(a.pub_date)
        );

        // 5. Clustering
        Loader.setStatus('Clustering thématique...');
        Loader.setProgress(85);
        STATE.clusters = Cluster.clusterByTopic(STATE.articles);

        // 6. Rendu UI
        Loader.setStatus('Mise à jour de l\'interface...');
        Loader.setProgress(95);
        refreshUI();

        STATE.lastSyncTime = Date.now();
        // Sauvegarder le timestamp du dernier sync pour éviter les re-fetch inutiles
        localStorage.setItem('synapse_last_sync', STATE.lastSyncTime);
        Loader.setSyncDot('done');

        // Sauvegarder dans localStorage pour survie au refresh de page
        if (STATE.user) Cache.save(STATE.user.id, STATE.articles);

        Toast.show(
          newCount > 0 ? `${newCount} nouveau${newCount > 1 ? 'x' : ''} article${newCount > 1 ? 's' : ''} chargé${newCount > 1 ? 's' : ''}` : 'Flux à jour',
          'success'
        );

        // Enrichissement silencieux en arrière-plan
        // On attend 3s que l'UI soit stable, puis on enrichit par ordre d'importance
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
      // Ne montrer que les articles des feeds actifs
      const activeFeedIds = new Set(STATE.feeds.filter(f => f.active).map(f => f.id));
      const visibleArticles = STATE.articles.filter(a => !a.feed_id || activeFeedIds.has(a.feed_id));

      Render.renderHomeArticles(visibleArticles);
      Render.renderFeedArticles(visibleArticles, STATE.currentFilter, STATE.searchQuery);
      Render.renderClusters(Cluster.clusterByTopic(visibleArticles));
      Render.renderBookmarks(visibleArticles);
      Settings.renderFeedsManager(STATE.feeds);
      Render.renderSidebarFeeds(STATE.feeds);
      updateBadge();
    }

    /** Met à jour le badge "non lus" dans la nav */
    function updateBadge() {
      const unreadCount = STATE.articles.filter(a => !a.read).length;
      const badge = document.getElementById('badge-feed');
      if (!badge) return;
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    return { run, refreshUI, updateBadge };
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
    // Initialiser Supabase
    Auth.init();

    // Écouter les changements d'auth
    Auth.onAuthChange(async (user) => {
      if (user) {
        // Utilisateur connecté
        STATE.user = user;
        AuthUI.hideAuthOverlay(user);
        await onUserLogin(user);
      } else {
        // Pas connecté
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

    // Effacer l'historique
    const clearHistoryBtn = document.getElementById('btn-clear-history');
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', async () => {
        if (!confirm('Effacer tout l\'historique de lecture ?')) return;
        try {
          await Auth.getClient()
            .from('articles')
            .update({ read: false })
            .eq('user_id', STATE.user.id)
            .eq('read', true);
          STATE.readArticles.clear();
          STATE.articles.forEach(a => a.read = false);
          Render.renderHistory();
          Toast.show('Historique effacé', 'info');
        } catch (err) {
          Toast.show('Erreur : ' + err.message, 'error');
        }
      });
    }

    // Bouton SUGGESTIONS — liste de feeds populaires par catégorie
    const suggestBtn = document.getElementById('btn-show-suggestions');
    const suggestZone = document.getElementById('feed-suggestions-zone');
    if (suggestBtn && suggestZone) {
      const SUGGESTED_FEEDS = [
        { name: 'Le Monde', url: 'https://www.lemonde.fr/rss/une.xml', category: 'Actualités' },
        { name: 'France Info', url: 'https://www.francetvinfo.fr/titres.rss', category: 'Actualités' },
        { name: 'Reuters (EN)', url: 'https://feeds.reuters.com/reuters/topNews', category: 'International' },
        { name: 'BBC News (EN)', url: 'http://feeds.bbci.co.uk/news/rss.xml', category: 'International' },
        { name: 'The Verge (EN)', url: 'https://www.theverge.com/rss/index.xml', category: 'Tech' },
        { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', category: 'Tech' },
        { name: 'Numerama', url: 'https://www.numerama.com/feed/', category: 'Tech' },
        { name: 'Arte Info', url: 'https://www.arte.tv/fr/rss/', category: 'Culture' },
        { name: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', category: 'Science' },
        { name: 'Eurosport', url: 'https://www.eurosport.fr/rss.xml', category: 'Sport' },
      ];

      suggestBtn.addEventListener('click', () => {
        if (!suggestZone.classList.contains('hidden')) {
          suggestZone.classList.add('hidden');
          suggestZone.innerHTML = '';
          return;
        }
        suggestZone.classList.remove('hidden');
        suggestZone.innerHTML = SUGGESTED_FEEDS.map(f => `
          <button class="rss-suggestion-btn" data-url="${f.url}" data-name="${f.name}" data-cat="${f.category}">
            <span style="font-weight:500">${f.name}</span>
            <span style="opacity:0.5;margin-left:6px">${f.category}</span>
          </button>
        `).join('');

        suggestZone.querySelectorAll('.rss-suggestion-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.getElementById('feed-url').value = btn.dataset.url;
            document.getElementById('feed-name').value = btn.dataset.name;
            document.getElementById('feed-category').value = btn.dataset.cat;
            suggestZone.classList.add('hidden');
            suggestZone.innerHTML = '';
          });
        });
      });
    }

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
        if (localResults.length >= 5) return;

        STATE.isSearching = true;
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, q);

        try {
          const dbResults = await DB.searchArticles(STATE.user.id, q);
          if (STATE.searchQuery !== q) return; // La query a changé entre temps

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
        // Reconstituer le state depuis la cache
        STATE.articles = cachedArticles.map(a => ({
          ...a,
          feed_name: a.feeds?.name || a.feed_name || '',
          feed_category: a.feeds?.category || a.feed_category || '',
        }));

        STATE.bookmarks = new Set(
          cachedArticles.filter(a => a.bookmarked).map(a => a.id)
        );
        STATE.readArticles = new Set(
          cachedArticles.filter(a => a.read).map(a => a.id)
        );

        STATE.clusters = Cluster.clusterByTopic(STATE.articles);
        Sync.refreshUI();
      }

      Loader.setProgress(60);
      Loader.hide();

      // Vérifier digest du jour
      const existingDigest = await DB.getTodayDigest(user.id);
      if (existingDigest) {
        const div = document.createElement('div');
        div.className = 'digest-content';
        div.innerHTML = existingDigest.content;
        document.getElementById('digest-zone').innerHTML = '';
        document.getElementById('digest-zone').appendChild(div);
        document.getElementById('btn-generate-digest').innerHTML = '<span class="btn-icon">⚡</span> RÉGÉNÉRER';
        STATE.digestGenerated = true;
      }

      // Synchronisation automatique uniquement si nécessaire
      if (STATE.feeds.length > 0) {
        const lastSync = parseInt(localStorage.getItem('synapse_last_sync') || '0');
        const minutesSinceSync = (Date.now() - lastSync) / 60000;
        const SYNC_INTERVAL_MIN = 15; // Ne pas re-syncer si moins de 15 min

        if (minutesSinceSync > SYNC_INTERVAL_MIN) {
          setTimeout(() => Sync.run(), 1000);
        } else {
          const remaining = Math.round(SYNC_INTERVAL_MIN - minutesSinceSync);
          Toast.show(`Flux à jour — prochain sync dans ${remaining} min`, 'info');
        }

        // Sync auto toutes les 30 minutes si l'onglet est actif
        setInterval(() => {
          if (!document.hidden) Sync.run();
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
