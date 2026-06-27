// netlify/functions/news.mjs
// Bandeau d'actualités CDM 2026 — agrégation Google News (multi-sources, sans API key)

// Feeds Google News par langue (queries larges, Google filtre par pertinence + fraîcheur)
const FEEDS = {
  fr: 'https://news.google.com/rss/search?q=%22coupe+du+monde+2026%22+OR+%22mondial+2026%22&hl=fr&gl=FR&ceid=FR:fr',
  en: 'https://news.google.com/rss/search?q=%22world+cup+2026%22&hl=en-US&gl=US&ceid=US:en',
  ar: 'https://news.google.com/rss/search?q=%22%D9%83%D8%A3%D8%B3+%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85+2026%22&hl=ar&gl=SA&ceid=SA:ar',
  es: 'https://news.google.com/rss/search?q=%22copa+del+mundo+2026%22+OR+%22mundial+2026%22&hl=es&gl=ES&ceid=ES:es',
  nl: 'https://news.google.com/rss/search?q=%22WK+2026%22+OR+%22wereldkampioenschap+2026%22&hl=nl&gl=NL&ceid=NL:nl',
  ja: 'https://news.google.com/rss/search?q=%22%E3%83%AF%E3%83%BC%E3%83%AB%E3%83%89%E3%82%AB%E3%83%83%E3%83%972026%22&hl=ja&gl=JP&ceid=JP:ja',
  ko: 'https://news.google.com/rss/search?q=%22%EC%9B%94%EB%93%9C%EC%BB%B5+2026%22&hl=ko&gl=KR&ceid=KR:ko',
  de: 'https://news.google.com/rss/search?q=%22WM+2026%22+OR+%22Weltmeisterschaft+2026%22&hl=de&gl=DE&ceid=DE:de',
  pt: 'https://news.google.com/rss/search?q=%22copa+do+mundo+2026%22&hl=pt-BR&gl=BR&ceid=BR:pt-419'
};

// Mini parseur RSS (pas de dépendance externe)
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&nbsp;/g, ' ');
}

function extractTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? decodeEntities(m[1].trim()) : '';
}

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    let title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const source = extractTag(block, 'source');
    // Google News colle souvent " - <source>" à la fin du titre, on l'enlève si redondant
    if (source && title.endsWith(' - ' + source)) {
      title = title.slice(0, -source.length - 3).trim();
    }
    // Nettoyage HTML résiduel
    title = title.replace(/<[^>]+>/g, '').trim();
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

// Filtrer les news trop anciennes (plus de 7 jours)
function isFresh(item) {
  if (!item.pubDate) return true;
  const d = new Date(item.pubDate);
  if (isNaN(d.getTime())) return true;
  return (Date.now() - d.getTime()) < 7 * 24 * 60 * 60 * 1000;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  // Cache CDN 5 min — réduit les appels à Google News
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });

  const url = new URL(req.url);
  const lang = (url.searchParams.get('lang') || 'fr').toLowerCase();
  const feedUrl = FEEDS[lang] || FEEDS.fr;

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CDM2026Dashboard/1.0)' },
      signal: ctrl.signal
    });
    clearTimeout(to);
    const xml = await r.text();
    const items = parseRSS(xml).filter(isFresh).slice(0, 25);

    return new Response(JSON.stringify({ news: items, lang, count: items.length }), {
      status: 200, headers: cors
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, news: [], lang }), {
      status: 200, headers: cors
    });
  }
};

export const config = { path: '/api/news' };
