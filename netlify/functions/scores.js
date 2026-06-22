// netlify/functions/scores.js
// Interroge api-sports.io (API-Football) côté serveur, en gardant la clé secrète.
// La clé est lue depuis la variable d'environnement Netlify : API_FOOTBALL_KEY
// Réponse : { fixtures: [...], season, league, updated } ou { error }

const API_HOST = "v3.football.api-sports.io";
const LEAGUE_NAME = "World Cup";      // nom de la compétition à détecter
const SEASON = 2026;                  // saison CDM 2026

// Petit cache en mémoire (par instance) pour limiter les appels à l'API.
let CACHE = { ts: 0, data: null };
const CACHE_MS = 60 * 1000; // 60 s : largement sous le quota gratuit

async function apiGet(path, key) {
  const res = await fetch(`https://${API_HOST}/${path}`, {
    headers: { "x-apisports-key": key }
  });
  if (!res.ok) throw new Error(`API ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error("API errors: " + JSON.stringify(json.errors));
  }
  return json.response;
}

// Trouve l'ID de la Coupe du Monde 2026 (évite de coder un ID en dur qui pourrait être faux)
async function findWorldCupLeagueId(key) {
  const leagues = await apiGet(`leagues?search=${encodeURIComponent(LEAGUE_NAME)}`, key);
  // On cherche une compétition de type "Cup" au niveau "World", saison 2026 disponible
  const wc = leagues.find(l =>
    l.league && /world cup/i.test(l.league.name) &&
    l.country && /world/i.test(l.country.name) &&
    (l.seasons || []).some(s => s.year === SEASON)
  ) || leagues.find(l => /world cup/i.test(l.league?.name || ""));
  if (!wc) throw new Error("Coupe du Monde 2026 introuvable dans l'API");
  return wc.league.id;
}

exports.handler = async function () {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    return json(500, { error: "Clé API absente. Ajoute API_FOOTBALL_KEY dans les variables d'environnement Netlify." });
  }

  // Cache
  const now = Date.now();
  if (CACHE.data && now - CACHE.ts < CACHE_MS) {
    return json(200, { ...CACHE.data, cached: true });
  }

  try {
    const leagueId = await findWorldCupLeagueId(key);
    const fixtures = await apiGet(`fixtures?league=${leagueId}&season=${SEASON}`, key);

    // On ne renvoie que l'essentiel (allège la réponse)
    const slim = fixtures.map(f => ({
      id: f.fixture.id,
      date: f.fixture.date,
      status: f.fixture.status.short,        // NS, 1H, HT, 2H, FT, etc.
      round: f.league.round,                 // "Group Stage - 1", "Round of 32", etc.
      home: f.teams.home.name,
      homeCode: f.teams.home.id,
      away: f.teams.away.name,
      awayCode: f.teams.away.id,
      homeGoals: f.goals.home,
      awayGoals: f.goals.away,
      homeLogo: f.teams.home.logo,
      awayLogo: f.teams.away.logo
    }));

    const payload = { league: leagueId, season: SEASON, count: slim.length, fixtures: slim, updated: new Date().toISOString() };
    CACHE = { ts: now, data: payload };
    return json(200, payload);
  } catch (e) {
    // En cas d'échec API, renvoyer l'erreur (la page basculera sur ses données de secours)
    return json(502, { error: String(e.message || e) });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}
