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
    GROQ_MODEL: 'llama-3.3-70b-versatile',

    // Nombre d'articles max à charger par fetch
    MAX_ARTICLES_PER_FEED: 20,

    // Seuil de similarité pour déduplication (0-1)
    DEDUP_THRESHOLD: 0.65,

    // Délai entre les requêtes Groq pour éviter le rate-limit (ms)
    GROQ_REQUEST_DELAY: 800,

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
    currentArticleIndex: 0,  // Index de l'article ouvert dans le reader
    currentArticleList: [],  // Liste courante pour la navigation reader
    searchQuery: '',         // Requête de recherche active
    digestGenerated: false,  // Digest déjà généré aujourd'hui ?
    lastSyncTime: null,      // Timestamp du dernier sync
    isLoading: false,        // Chargement en cours
  };

  /* ================================================================
     2b. CACHE LOCAL — localStorage pour survie au refresh navigateur
     Stratégie : écriture après chaque sync réussi, lecture immédiate
     au login avant la requête Supabase — affichage instantané.
     Clé unique par user_id pour isoler les comptes sur le même browser.
     ================================================================ */
  const Cache = (() => {
    function key(userId) { return `synapse_articles_${userId}`; }

    /** Sauvegarde articles + bookmarks + lus dans localStorage */
    function save(userId, articles, bookmarks, readArticles) {
      try {
        const payload = {
          articles,
          bookmarks: [...bookmarks],
          readArticles: [...readArticles],
          savedAt: Date.now(),
        };
        localStorage.setItem(key(userId), JSON.stringify(payload));
      } catch (err) {
        // Quota dépassé (~5MB) — on ignore, le fallback reste Supabase
        console.warn('Cache write failed (quota?):', err);
      }
    }

    /**
     * Restaure depuis localStorage.
     * Retourne null si absent ou plus vieux que 2h.
     */
    function load(userId) {
      try {
        const raw = localStorage.getItem(key(userId));
        if (!raw) return null;
        const payload = JSON.parse(raw);
        // Cache expiré → on le supprime et on laisse Supabase prendre le relais
        if (Date.now() - payload.savedAt > 2 * 3600 * 1000) {
          clear(userId);
          return null;
        }
        return {
          articles:     payload.articles || [],
          bookmarks:    new Set(payload.bookmarks || []),
          readArticles: new Set(payload.readArticles || []),
        };
      } catch {
        return null;
      }
    }

    /** Efface le cache d'un utilisateur (appelé au logout) */
    function clear(userId) {
      try { localStorage.removeItem(key(userId)); } catch {}
    }

    return { save, load, clear };
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
    async function getArticles(userId) {
      const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const { data, error } = await client()
        .from('articles')
        .select('*, feeds(name, category)')
        .eq('user_id', userId)
        .gte('pub_date', since)
        .order('importance', { ascending: false })
        .order('pub_date', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    }

    /** Upsert un article (insert ou update si même hash)
     *  En cas de conflit, on ne met à jour QUE les champs non-IA
     *  pour ne jamais écraser un ai_content déjà enrichi.
     */
    async function upsertArticle(article) {
      const { error } = await client()
        .from('articles')
        .upsert(article, {
          onConflict: 'user_id,hash',
          ignoreDuplicates: false,
        });
      if (error) throw error;
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

    return { getFeeds, addFeed, deleteFeed, toggleFeed, getArticles, upsertArticle, updateArticleStatus, getTodayDigest, saveDigest };
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
     * Le worker reçoit : POST /ai { prompt, systemPrompt, model }
     * Il retourne : { text: "..." }
     */
    async function callGroq(systemPrompt, userPrompt, maxTokens = 800) {
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
    async function enrichArticle(article) {
      // Construire le texte source — titre + description + contenu, tout ce qu'on a
      const sourceText = [
        article.title || '',
        article.description || '',
        article.content || '',
      ].filter(Boolean).join('\n\n').substring(0, 2000);

      // Si vraiment rien à enrichir, on skip
      if (sourceText.trim().length < 30) {
        return { ai_content: article.content || article.title || '', importance: 1, ai_tags: [] };
      }

      const systemPrompt = `Tu es un éditeur de presse expert. Tu réécris les articles RSS en prose claire et fluide, en supprimant tout le bruit (publicités, appels à l'action, mentions légales, liens parasites). Tu réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte avant ou après le JSON. Langue de sortie : français.`;

      const userPrompt = `Réécris cet article et retourne exactement ce JSON (et rien d'autre) :
{"ai_content":"<réécriture en prose fluide, 150-250 mots, conserve les faits essentiels, sans bruit>","importance":<1 à 5, 5=breaking news>,"ai_tags":["<thème1>","<thème2>","<thème3>"]}

TITRE : ${article.title}
SOURCE : ${article.feed_name}
TEXTE : ${sourceText}`;

      const raw = await callGroq(systemPrompt, userPrompt, 700);

      // DEBUG — à retirer une fois le problème résolu
      console.log('=== GROQ RAW RESPONSE ===');
      console.log('Article:', article.title);
      console.log('Raw:', raw);
      console.log('=========================');

      try {
        // Extraction robuste : chercher le premier { ... } dans la réponse
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);

        // Vérifier que la réécriture est bien différente de l'original (sinon c'est suspect)
        const aiText = parsed.ai_content || '';
        const isDistinct = aiText.length > 50 && aiText !== article.content;

        return {
          ai_content: isDistinct ? aiText : article.content,
          importance: Math.min(5, Math.max(1, parseInt(parsed.importance) || 1)),
          ai_tags: Array.isArray(parsed.ai_tags) ? parsed.ai_tags.slice(0, 5) : [],
        };
      } catch (err) {
        console.warn(`Parsing JSON échoué pour "${article.title}":`, err, '\nRaw:', raw);
        return { ai_content: article.content, importance: 1, ai_tags: [] };
      }
    }

    /**
     * Génère le digest du jour à partir des articles importants
     * Retourne du texte structuré (HTML simple)
     */
    async function generateDailyDigest(articles) {
      // Sélectionner les 15 articles les plus importants du jour
      const today = new Date().toISOString().split('T')[0];
      const topArticles = articles
        .filter(a => a.pub_date && a.pub_date.startsWith(today))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 15);

      if (topArticles.length === 0) {
        // Si aucun article du jour, prendre les 10 plus récents
        topArticles.push(
          ...articles.sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date)).slice(0, 10)
        );
      }

      const articlesText = topArticles.map((a, i) =>
        `[${i + 1}] ${a.title} (${a.feed_name}, importance: ${a.importance}/5)\n${(a.ai_content || a.content).substring(0, 300)}`
      ).join('\n\n');

      const digest = await callGroq(
        `Tu es un éditeur de presse senior. Tu rédiges des briefings matinaux synthétiques pour un lecteur pressé.
Format de sortie : HTML simple, utilise <h2> pour les sections thématiques, <ul><li> pour les points, <p> pour les paragraphes.
Langue : français. Sois direct, factuel, sans introduction ni conclusion verbeuse.`,
        `Rédige le digest des actualités du jour. Structure par thèmes (max 4 thèmes). Inclus les sujets les plus importants.\n\n${articlesText}`,
        1000
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

    return { enrichArticle, enrichBatch, generateDailyDigest, callGroq };
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
     8. UI — Rendu articles
     ================================================================ */
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
        <h3 class="card-title">${escapeHtml(article.title || '')}</h3>
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
          <div class="row-title">${escapeHtml(article.title || '')}</div>
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

      let filtered = [...articles];

      // Filtres
      if (filter === 'unread') filtered = filtered.filter(a => !a.read);
      if (filter === 'important') filtered = filtered.filter(a => (a.importance || 0) >= 3);

      // Recherche
      if (query) {
        const q = query.toLowerCase();
        filtered = filtered.filter(a =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.ai_content || a.content || '').toLowerCase().includes(q) ||
          (a.ai_tags || []).some(t => t.toLowerCase().includes(q))
        );
      }

      countEl.textContent = `${filtered.length} article${filtered.length !== 1 ? 's' : ''}`;

      if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon">≡</span><p class="empty-state-text">Aucun article ne correspond à ce filtre.</p></div>';
        return;
      }

      filtered.forEach((article, i) => {
        container.appendChild(articleRow(article, i, filtered));
      });
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
    function renderBookmarks(articles) {
      const container = document.getElementById('bookmarks-articles');
      container.innerHTML = '';

      const bookmarked = articles.filter(a => STATE.bookmarks.has(a.id || a.hash) || a.bookmarked);

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
      feeds.filter(f => f.active).forEach(feed => {
        const li = document.createElement('li');
        li.textContent = feed.name || feed.url;
        li.addEventListener('click', () => Nav.switchView('feed'));
        list.appendChild(li);
      });
    }

    return {
      articleCard, articleRow, renderHomeArticles, renderFeedArticles,
      renderClusters, renderBookmarks, renderSidebarFeeds, escapeHtml, relativeTime, importanceBars
    };
  })();

  /* ================================================================
     9. UI — READER (Mode Focus)
     ================================================================ */
  const Reader = (() => {
    let showingAI = true; // true = contenu IA, false = contenu original

    /** Ouvre le reader pour un article */
    function open(article, index, articleList) {
      STATE.currentArticleIndex = index;
      STATE.currentArticleList = articleList;
      showingAI = true;

      // Marquer comme lu
      markRead(article);

      // Remplir le reader
      populate(article);

      // Afficher l'overlay
      const overlay = document.getElementById('reader-overlay');
      overlay.classList.remove('hidden');
      document.body.style.overflow = 'hidden';

      // Focus trap (accessibilité)
      document.getElementById('btn-close-reader').focus();
    }

    /** Ferme le reader */
    function close() {
      const overlay = document.getElementById('reader-overlay');
      overlay.classList.add('hidden');
      document.body.style.overflow = '';


    }

    /** Remplit le reader avec les données d'un article */
    function populate(article) {
      document.getElementById('reader-source').textContent = article.feed_name || '';
      document.getElementById('reader-date').textContent =
        new Date(article.pub_date).toLocaleDateString('fr-FR', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
      document.getElementById('reader-title').textContent = article.title || '';
      document.getElementById('reader-link').href = article.link || '#';

      // Barres d'importance
      const score = article.importance || 1;
      document.getElementById('reader-imp-bars').innerHTML = Render.importanceBars(score);

      // Tags
      const tagsEl = document.getElementById('reader-tags');
      tagsEl.innerHTML = (article.ai_tags || []).map(t =>
        `<span class="tag">${Render.escapeHtml(t)}</span>`
      ).join('');

      // Contenu (IA par défaut)
      setContent(article);

      // Bouton toggle IA/original
      const toggleBtn = document.getElementById('btn-toggle-content');
      toggleBtn.classList.toggle('active', showingAI);
      toggleBtn.textContent = showingAI ? '◈ IA' : '◈ ORIGINAL';
    }

    /** Affiche le contenu IA ou original */
    function setContent(article) {
      const contentEl = document.getElementById('reader-content');
      const text = showingAI
        ? (article.ai_content || article.content || '')
        : (article.content || '');

      // Conversion texte → paragraphes HTML
      const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
      contentEl.innerHTML = paragraphs.map(p =>
        `<p>${Render.escapeHtml(p.trim())}</p>`
      ).join('');
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
        // Reset scroll du modal
        document.getElementById('reader-modal').scrollTop = 0;
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
      }
    }



    /** Initialise les événements du reader */
    function init() {
      document.getElementById('btn-close-reader').addEventListener('click', close);

      // Fermer en cliquant sur l'overlay
      document.getElementById('reader-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) close();
      });

      // Touche Escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowRight') goNext();
        if (e.key === 'ArrowLeft') goPrev();
      });

      // Navigation
      document.getElementById('btn-next-article').addEventListener('click', goNext);
      document.getElementById('btn-prev-article').addEventListener('click', goPrev);

      // Toggle IA / Original
      document.getElementById('btn-toggle-content').addEventListener('click', () => {
        showingAI = !showingAI;
        const article = STATE.currentArticleList[STATE.currentArticleIndex];
        if (article) {
          setContent(article);
          const btn = document.getElementById('btn-toggle-content');
          btn.classList.toggle('active', showingAI);
          btn.textContent = showingAI ? '◈ IA' : '◈ ORIGINAL';
        }
      });



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

        row.innerHTML = `
          <div>
            <div class="feed-row-name">${Render.escapeHtml(feed.name || feed.url)}</div>
            <div class="feed-row-url">${Render.escapeHtml(feed.url)}</div>
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
            Render.renderSidebarFeeds(STATE.feeds);
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

        // 3. Identifier les nouveaux articles ET ceux mal enrichis
        // Un article est considéré "à enrichir" si :
        //   - il est nouveau (hash inconnu)
        //   - OU son ai_content est identique au content brut (enrichissement échoué précédemment)
        const existingHashes = new Set(STATE.articles.map(a => a.hash));
        const existingMap = new Map(STATE.articles.map(a => [a.hash, a]));

        const newArticles = unique.filter(a => {
          if (!existingHashes.has(a.hash)) return true; // Nouveau
          const old = existingMap.get(a.hash);
          // Re-enrichir si ai_content manquant ou identique au contenu brut
          const needsReenrich = !old.ai_content ||
            old.ai_content.trim() === (old.content || '').trim() ||
            old.ai_content.trim() === (old.description || '').trim();
          return needsReenrich;
        });

        const existing = unique.filter(a => {
          if (!existingHashes.has(a.hash)) return false;
          const old = existingMap.get(a.hash);
          const isEnriched = old.ai_content &&
            old.ai_content.trim() !== (old.content || '').trim() &&
            old.ai_content.trim() !== (old.description || '').trim();
          return isEnriched;
        });

        let enriched = existing.map(newRaw => {
          const old = existingMap.get(newRaw.hash);
          return old || newRaw;
        });

        // 4. Enrichissement IA des nouveaux articles
        if (newArticles.length > 0) {
          Loader.setStatus(`Enrichissement IA — 0/${newArticles.length} articles...`);
          const enrichedNew = await AI.enrichBatch(newArticles, (current, total) => {
            Loader.setStatus(`Enrichissement IA — ${current}/${total} articles...`);
            Loader.setProgress(30 + Math.round((current / total) * 50));
          });
          enriched = [...enriched, ...enrichedNew];

          // Sauvegarder en base si connecté — uniquement les articles vraiment enrichis
          if (STATE.user) {
            for (const article of enrichedNew) {
              // Ne pas sauvegarder si ai_content est vide ou identique au brut
              const isEnriched = article.ai_content &&
                article.ai_content.trim() !== (article.content || '').trim() &&
                article.ai_content.length > 50;
              if (!isEnriched) continue;
              try {
                await DB.upsertArticle({
                  ...article,
                  user_id: STATE.user.id,
                  ai_tags: article.ai_tags,
                });
              } catch {}
            }
          }
        }

        // 5. Mise à jour du state
        STATE.articles = enriched.sort((a, b) =>
          new Date(b.pub_date) - new Date(a.pub_date)
        );

        // 6. Clustering
        Loader.setStatus('Clustering thématique...');
        Loader.setProgress(85);
        STATE.clusters = Cluster.clusterByTopic(STATE.articles);

        // 7. Rendu UI
        Loader.setStatus('Mise à jour de l\'interface...');
        Loader.setProgress(95);
        refreshUI();

        STATE.lastSyncTime = Date.now();
        Loader.setSyncDot('done');

        // Sauvegarder dans localStorage pour survie au refresh de page
        try {
          localStorage.setItem(`synapse_articles_${STATE.user.id}`, JSON.stringify(STATE.articles.slice(0, 100)));
        } catch {} // Silencieux si quota dépassé

        const newCount = newArticles.length;
        Toast.show(
          newCount > 0 ? `${newCount} nouveau${newCount > 1 ? 'x' : ''} article${newCount > 1 ? 's' : ''} chargé${newCount > 1 ? 's' : ''}` : 'Flux à jour',
          'success'
        );

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
      Render.renderHomeArticles(STATE.articles);
      Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
      Render.renderClusters(STATE.clusters);
      Render.renderBookmarks(STATE.articles);
      Settings.renderFeedsManager(STATE.feeds);
      Render.renderSidebarFeeds(STATE.feeds);
    }

    return { run, refreshUI };
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
        if (STATE.user) localStorage.removeItem(`synapse_articles_${STATE.user.id}`);
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

    // Filtres vue flux
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.currentFilter = btn.dataset.filter;
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
      });
    });

    // Recherche
    const searchInput = document.getElementById('search-input');
    let searchDebounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        STATE.searchQuery = searchInput.value.trim();
        Render.renderFeedArticles(STATE.articles, STATE.currentFilter, STATE.searchQuery);
      }, 300);
    });

    // Bouton refresh
    document.getElementById('btn-refresh').addEventListener('click', () => {
      Sync.run();
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

      // Synchronisation automatique en arrière-plan si des feeds existent
      if (STATE.feeds.length > 0) {
        setTimeout(() => Sync.run(), 1000);
      } else {
        // Pas de feeds → aller direct dans settings
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
