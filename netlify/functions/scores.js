// netlify/functions/scores.js
// Interroge football-data.org (compétition WC = World Cup) côté serveur.
// Inclut les compositions (lineups) quand disponibles (matchs live/terminés).
// Le tier gratuit couvre la Coupe du Monde (10 req/min).
// Variable d'environnement Netlify attendue : FOOTBALL_DATA_TOKEN
// Réponse : { fixtures:[...], updated } ou { error }

const BASE = "https://api.football-data.org/v4";
let CACHE = { ts: 0, data: null };
const CACHE_MS = 60 * 1000; // 60 s, pour rester loin de la limite 10 req/min

exports.handler = async function () {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return json(500, { error: "Token absent. Ajoute FOOTBALL_DATA_TOKEN dans les variables d'environnement Netlify." });
  }

  const now = Date.now();
  if (CACHE.data && now - CACHE.ts < CACHE_MS) {
    return json(200, { ...CACHE.data, cached: true });
  }

  try {
    const res = await fetch(`${BASE}/competitions/WC/matches`, {
      headers: { "X-Auth-Token": token }
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status} — ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const matches = data.matches || [];

    const slim = matches.map(m => {
      const base = {
        id: m.id,
        date: m.utcDate,
        status: m.status,                       // SCHEDULED, TIMED, IN_PLAY, PAUSED, FINISHED
        stage: m.stage,                          // GROUP_STAGE, LAST_16, etc.
        group: m.group || null,                  // "GROUP_A"... ou null
        home: m.homeTeam ? (m.homeTeam.name || m.homeTeam.shortName) : null,
        away: m.awayTeam ? (m.awayTeam.name || m.awayTeam.shortName) : null,
        homeTla: m.homeTeam ? m.homeTeam.tla : null,
        awayTla: m.awayTeam ? m.awayTeam.tla : null,
        homeGoals: m.score && m.score.fullTime ? m.score.fullTime.home : null,
        awayGoals: m.score && m.score.fullTime ? m.score.fullTime.away : null
      };

      // Ajouter les lineups si disponibles (matchs live ou terminés)
      if (m.lineups && m.lineups.length > 0) {
        const homeLineup = m.lineups.find(l => l.team.tla === m.homeTeam.tla);
        const awayLineup = m.lineups.find(l => l.team.tla === m.awayTeam.tla);
        
        if (homeLineup) {
          base.homeFormation = homeLineup.formation || null;
          base.homeLineup = homeLineup.lineup ? homeLineup.lineup.map(p => ({
            number: p.shirtNumber,
            name: p.player.name,
            position: p.position
          })) : [];
          base.homeSubstitutes = homeLineup.bench ? homeLineup.bench.map(p => ({
            number: p.shirtNumber,
            name: p.player.name,
            position: p.position
          })) : [];
          base.homeCoach = homeLineup.coach ? homeLineup.coach.name : null;
        }
        
        if (awayLineup) {
          base.awayFormation = awayLineup.formation || null;
          base.awayLineup = awayLineup.lineup ? awayLineup.lineup.map(p => ({
            number: p.shirtNumber,
            name: p.player.name,
            position: p.position
          })) : [];
          base.awaySubstitutes = awayLineup.bench ? awayLineup.bench.map(p => ({
            number: p.shirtNumber,
            name: p.player.name,
            position: p.position
          })) : [];
          base.awayCoach = awayLineup.coach ? awayLineup.coach.name : null;
        }
      }

      return base;
    });

    const payload = { count: slim.length, fixtures: slim, updated: new Date().toISOString() };
    CACHE = { ts: now, data: payload };
    return json(200, payload);
  } catch (e) {
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
