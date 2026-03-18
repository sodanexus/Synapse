-- ================================================================
-- SYNAPSE — Supabase SQL Schema
-- Fichier : supabase_schema.sql
-- 
-- Instructions :
--   1. Aller dans votre projet Supabase > SQL Editor
--   2. Coller et exécuter ce fichier complet
--   3. Vérifier dans Table Editor que les 3 tables sont créées
-- ================================================================

-- ── TABLE : feeds ──
-- Stocke les sources RSS de chaque utilisateur
CREATE TABLE IF NOT EXISTS feeds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'Général',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Index pour retrouver rapidement les feeds d'un user
CREATE INDEX IF NOT EXISTS idx_feeds_user_id ON feeds(user_id);

-- RLS : chaque utilisateur ne voit que ses feeds
ALTER TABLE feeds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feeds_user_isolation" ON feeds
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ── TABLE : articles ──
-- Stocke les articles enrichis par l'IA
CREATE TABLE IF NOT EXISTS articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feed_id       UUID REFERENCES feeds(id) ON DELETE SET NULL,
  hash          TEXT NOT NULL,               -- Hash unique (url ou titre)
  title         TEXT NOT NULL DEFAULT '',
  link          TEXT NOT NULL DEFAULT '',
  content       TEXT DEFAULT '',             -- Contenu original
  ai_content    TEXT DEFAULT '',             -- Contenu réécrit par IA
  ai_summary    TEXT DEFAULT '',             -- Résumé IA (généré à la demande)
  ai_tags       TEXT[] DEFAULT '{}',         -- Tags thématiques IA
  importance    SMALLINT DEFAULT 1 CHECK (importance BETWEEN 1 AND 5),
  cluster_id    TEXT DEFAULT NULL,           -- Identifiant du cluster thématique
  pub_date      TIMESTAMPTZ DEFAULT now(),
  read             BOOLEAN NOT NULL DEFAULT false,
  bookmarked       BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now(),
  ai_title         TEXT DEFAULT NULL,           -- Titre traduit/amélioré par IA
  scraped_content  TEXT DEFAULT NULL,           -- Contenu scrappé depuis l'article
  image            TEXT DEFAULT NULL,           -- URL image (RSS ou OG scrape)
  -- Contrainte d'unicité par user + hash (évite les doublons)
  UNIQUE(user_id, hash)
);

-- Index pour les requêtes courantes
CREATE INDEX IF NOT EXISTS idx_articles_user_id    ON articles(user_id);
CREATE INDEX IF NOT EXISTS idx_articles_pub_date   ON articles(user_id, pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_importance ON articles(user_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_articles_hash       ON articles(hash);

-- RLS : isolation par utilisateur
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "articles_user_isolation" ON articles
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ── TABLE : digests ──
-- Stocke le digest IA quotidien de chaque utilisateur
CREATE TABLE IF NOT EXISTS digests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,                 -- Date du digest (YYYY-MM-DD)
  content     TEXT NOT NULL DEFAULT '',      -- HTML du digest généré
  hero_image  TEXT DEFAULT NULL,             -- URL image hero du digest
  created_at  TIMESTAMPTZ DEFAULT now(),
  -- Un seul digest par utilisateur par jour
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_digests_user_date ON digests(user_id, date DESC);

ALTER TABLE digests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "digests_user_isolation" ON digests
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ── NETTOYAGE AUTOMATIQUE ──
-- Supprimer automatiquement les articles de plus de 7 jours
-- (optionnel — décommenter pour activer)
-- CREATE OR REPLACE FUNCTION cleanup_old_articles()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   DELETE FROM articles
--   WHERE created_at < now() - INTERVAL '7 days'
--     AND bookmarked = false;
--   RETURN NULL;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- CREATE OR REPLACE TRIGGER trigger_cleanup_articles
--   AFTER INSERT ON articles
--   EXECUTE FUNCTION cleanup_old_articles();
