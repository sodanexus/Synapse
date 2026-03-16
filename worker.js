/**
 * SYNAPSE — Cloudflare Worker
 * Fichier : worker.js
 *
 * Routes gérées :
 *   GET  /rss?url=<encoded>   → Proxy RSS (résout CORS)
 *   POST /ai                  → Relay Groq API (clé cachée côté worker)
 *   POST /tts                 → Unreal Speech TTS (Élodie, voix française)
 *
 * Variables d'environnement à configurer dans Cloudflare Dashboard :
 *   GROQ_API_KEY          → votre clé API Groq
 *   UNREALSPEECH_API_KEY  → votre clé API Unreal Speech
 *   ALLOWED_ORIGIN        → URL de votre site GitHub Pages (ex: https://sodanexus.github.io)
 */

export default {
  async fetch(request, env) {
    const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || '*';

    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/rss') {
        return await handleRSS(url, corsHeaders);
      }

      if (request.method === 'POST' && url.pathname === '/ai') {
        return await handleAI(request, env, corsHeaders);
      }

      if (request.method === 'GET' && url.pathname === '/scrape') {
        return await handleScrape(url, corsHeaders);
      }

      if (request.method === 'POST' && url.pathname === '/tts') {
        return await handleTTS(request, env, corsHeaders);
      }

      return jsonResponse({ error: 'Route not found' }, 404, corsHeaders);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message || 'Internal server error' }, 500, corsHeaders);
    }
  }
};

/* ================================================================
   HANDLER RSS — Fetch et parse un flux RSS
   ================================================================ */
async function handleRSS(url, corsHeaders) {
  const feedUrl = url.searchParams.get('url');

  if (!feedUrl) {
    return jsonResponse({ error: 'Missing ?url parameter' }, 400, corsHeaders);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(feedUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Protocol not allowed');
    }
  } catch {
    return jsonResponse({ error: 'Invalid URL' }, 400, corsHeaders);
  }

  const response = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': parsedUrl.origin + '/',
    },
    redirect: 'follow',
    cf: { cacheTtl: 300 },
  });

  if (!response.ok) {
    const statusMessages = {
      403: 'Accès refusé par le site source (403) — le site bloque les accès automatiques',
      404: 'Feed introuvable (404) — vérifiez l\'URL',
      429: 'Trop de requêtes (429) — réessayez dans quelques instants',
      500: 'Erreur serveur du site source (500)',
    };
    const msg = statusMessages[response.status] || `Le feed a répondu avec le code ${response.status}`;
    return jsonResponse({ error: msg }, response.status, corsHeaders);
  }

  const xml = await response.text();
  const items = parseRSSXML(xml);

  return jsonResponse({ items, count: items.length }, 200, corsHeaders);
}

function parseRSSXML(xml) {
  const items = [];
  const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');

  if (isAtom) {
    const entryMatches = [...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)];
    for (const match of entryMatches.slice(0, 30)) {
      const entry = match[1];
      const title = extractTag(entry, 'title') || extractAttr(entry, 'title');
      const link = extractAttr(entry, 'link', 'href') || extractTag(entry, 'link');
      const content = extractTag(entry, 'content') || extractTag(entry, 'summary');
      const published = extractTag(entry, 'published') || extractTag(entry, 'updated');
      if (title || link) {
        items.push({
          title: decodeEntities(title || ''),
          link: link || '',
          description: decodeEntities(stripCDATA(content || '')),
          content: decodeEntities(stripCDATA(content || '')),
          pubDate: published || '',
        });
      }
    }
  } else {
    const itemMatches = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)];
    for (const match of itemMatches.slice(0, 30)) {
      const item = match[1];
      const title = extractTag(item, 'title');
      const link = extractTag(item, 'link');
      const description = extractTag(item, 'description') || extractTag(item, 'summary');
      const content = extractTag(item, 'content:encoded') || extractTag(item, 'content') || description;
      const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date') || extractTag(item, 'published');
      if (title || link) {
        items.push({
          title: decodeEntities(stripCDATA(title || '')),
          link: (stripCDATA(link || '')).trim(),
          description: decodeEntities(stripCDATA(description || '')),
          content: decodeEntities(stripCDATA(content || '')),
          pubDate: pubDate || '',
        });
      }
    }
  }

  return items;
}

function extractTag(xml, tag) {
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
  if (cdataMatch) return cdataMatch[1].trim();
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function extractAttr(xml, tag, attr = 'href') {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i'));
  return match ? match[1].trim() : '';
}

function stripCDATA(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/* ================================================================
   HANDLER AI — Relay vers l'API Groq
   ================================================================ */
async function handleAI(request, env, corsHeaders) {
  if (!env.GROQ_API_KEY) {
    return jsonResponse({ error: 'GROQ_API_KEY not configured' }, 500, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const { model, system, prompt, max_tokens = 800 } = body;

  if (!prompt) {
    return jsonResponse({ error: 'Missing prompt' }, 400, corsHeaders);
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      messages,
      max_tokens: Math.min(max_tokens, 2000),
      temperature: 0.7,
    }),
  });

  if (!groqResponse.ok) {
    const errText = await groqResponse.text();
    console.error('Groq API error:', groqResponse.status, errText);
    return jsonResponse({ error: `Groq API error: ${groqResponse.status}` }, groqResponse.status, corsHeaders);
  }

  const groqData = await groqResponse.json();
  const text = groqData.choices?.[0]?.message?.content || '';

  return jsonResponse({ text }, 200, corsHeaders);
}

/* ================================================================
   HANDLER SCRAPE — Extrait le contenu textuel d'une page article
   ================================================================ */
async function handleScrape(url, corsHeaders) {
  const articleUrl = url.searchParams.get('url');

  if (!articleUrl) {
    return jsonResponse({ error: 'Missing ?url parameter' }, 400, corsHeaders);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(articleUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Protocol not allowed');
  } catch {
    return jsonResponse({ error: 'Invalid URL' }, 400, corsHeaders);
  }

  const response = await fetch(articleUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    cf: { cacheTtl: 3600 },
  });

  if (!response.ok) {
    return jsonResponse({ error: `Page responded with ${response.status}` }, response.status, corsHeaders);
  }

  const html = await response.text();
  const text = extractArticleText(html);

  if (!text || text.length < 100) {
    return jsonResponse({ error: 'Could not extract article content' }, 422, corsHeaders);
  }

  return jsonResponse({ text, length: text.length }, 200, corsHeaders);
}

function extractArticleText(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<[^>]*class="[^"]*article[^"]*body[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*class="[^"]*article[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*class="[^"]*story[^"]*body[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*class="[^"]*post[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/[^>]+>/i,
  ];

  let articleHtml = '';
  for (const pattern of contentPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1] && match[1].length > 200) {
      articleHtml = match[1];
      break;
    }
  }

  if (!articleHtml) {
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    articleHtml = bodyMatch ? bodyMatch[1] : cleaned;
  }

  const paragraphs = [];
  const pMatches = [...articleHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];

  for (const match of pMatches) {
    const text = match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 40) {
      paragraphs.push(text);
    }
  }

  return paragraphs.join('\n\n').substring(0, 8000);
}

/* ================================================================
   HANDLER TTS — Unreal Speech Text-to-Speech
   Voix    : Élodie (française, féminine)
   /stream : ≤1000 chars, instantané (~300ms), MP3 brut
   /speech : ≤3000 chars, ~1s/700 chars, retourne une URL MP3
   Variable requise : UNREALSPEECH_API_KEY dans les secrets Worker
   ================================================================ */
async function handleTTS(request, env, corsHeaders) {
  if (!env.UNREALSPEECH_API_KEY) {
    return jsonResponse({ error: 'UNREALSPEECH_API_KEY not configured' }, 500, corsHeaders);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

  const { text, voiceId = 'Élodie' } = body;

  if (!text || text.trim().length === 0) {
    return jsonResponse({ error: 'Missing text' }, 400, corsHeaders);
  }

  const truncated = text.trim().slice(0, 3000);
  const useStream = truncated.length <= 1000;

  if (useStream) {
    // ── /stream — MP3 brut, réponse instantanée ──
    const res = await fetch('https://api.v8.unrealspeech.com/stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.UNREALSPEECH_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Text: truncated,
        VoiceId: voiceId,
        Bitrate: '192k',
        Speed: '0',
        Pitch: '1',
        Codec: 'libmp3lame',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Unreal Speech stream error:', res.status, err);
      return jsonResponse({ error: `Unreal Speech error: ${res.status}`, detail: err }, res.status, corsHeaders);
    }

    const audioBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(audioBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return new Response(JSON.stringify({ audioBase64: base64 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });

  } else {
    // ── /speech — retourne un JSON avec OutputUri (URL MP3) ──
    const res = await fetch('https://api.v8.unrealspeech.com/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.UNREALSPEECH_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Text: truncated,
        VoiceId: voiceId,
        Bitrate: '192k',
        Speed: '0',
        Pitch: '1',
        TimestampType: 'sentence',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Unreal Speech speech error:', res.status, err);
      return jsonResponse({ error: `Unreal Speech error: ${res.status}`, detail: err }, res.status, corsHeaders);
    }

    const data = await res.json();
    const mp3Url = data?.OutputUri;

    if (!mp3Url) {
      return jsonResponse({ error: 'No OutputUri in response' }, 500, corsHeaders);
    }

    // Télécharger le MP3 et l'encoder en base64
    const mp3Res = await fetch(mp3Url);
    if (!mp3Res.ok) {
      return jsonResponse({ error: 'Failed to fetch MP3 from OutputUri' }, 500, corsHeaders);
    }

    const audioBuffer = await mp3Res.arrayBuffer();
    const bytes = new Uint8Array(audioBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return new Response(JSON.stringify({ audioBase64: base64 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

/* ================================================================
   UTILITAIRE — Réponse JSON
   ================================================================ */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
