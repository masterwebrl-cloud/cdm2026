// netlify/functions/chat.js
// Chat supporters CDM 2026 — modération multilingue stricte, rate limit, bans automatiques
import { getStore } from '@netlify/blobs';

// ===== MODÉRATION MULTILINGUE — TOLÉRANCE ZÉRO =====
// Mots interdits dans les 9 langues de la plateforme + variantes courantes
const BANNED = {
  fr: [
    'merde','putain','connard','connasse','salope','salaud','enculé','enculee','encule','pute','batard','bâtard','bite','couille','foutre','niquer','niquer','nique','bordel','con','cons','conne','crétin','débile','imbécile','abruti','clochard','pédé','pede','tapette','gouine','négro','negre','bougnoule','youpin','bicot','sale arabe','sale juif','sale noir','sale blanc'
  ],
  en: [
    'fuck','fucking','fucker','shit','bitch','bitches','cunt','asshole','dick','cock','pussy','whore','slut','bastard','motherfucker','nigger','nigga','faggot','fag','retard','retarded','spic','chink','kike','dyke','tranny','queer'
  ],
  ar: [
    'كس','زب','منيك','منيوك','شرموطة','شرموط','عاهرة','قحبة','خرا','كلب','حمار','ابن الكلب','يا كلب','يا حيوان','نيك','نياك','زبي','كسمك','يا حمار','يا غبي'
  ],
  es: [
    'mierda','joder','puta','puto','cabrón','cabron','coño','cono','pendejo','pendeja','pinche','marica','maricón','maricon','zorra','perra','imbécil','imbecil','idiota','gilipollas','hijo de puta','hdp','culero','verga'
  ],
  nl: [
    'kut','klootzak','lul','pik','tering','tyfus','kanker','hoer','slet','flikker','homo','mongool','debiel','idioot','sukkel','godverdomme','gvd','kankerlijer'
  ],
  ja: [
    'くそ','クソ','ちくしょう','畜生','馬鹿','バカ','あほ','アホ','死ね','殺す','きちがい','キチガイ','ばか野郎','クソ野郎','糞','ちんこ','まんこ','チンコ','マンコ'
  ],
  ko: [
    '씨발','시발','새끼','개새끼','병신','존나','좆','지랄','미친','꺼져','죽어','엿먹어','개자식','쌍놈','쌍년','보지','자지','니애미','니애비','애미','애비'
  ],
  de: [
    'scheisse','scheiße','fotze','arschloch','wichser','hure','schlampe','nutte','schwanz','schwuchtel','fick','ficken','verpiss dich','idiot','vollidiot','depp','spast','spasti','behindert','mongo'
  ],
  pt: [
    'caralho','foda','foder','puta','porra','merda','cu','cuzão','cuzao','filho da puta','fdp','viado','bicha','vagabundo','vagabunda','desgraçado','desgracado','imbecil','idiota','otário','otario','vai se foder','vsf','arrombado','cabrão','cabrao'
  ]
};

// Liste plate (toutes langues) pour scan rapide
const ALL_BANNED = Object.values(BANNED).flat().map(w => w.toLowerCase());

// Normalisation : remplace les substitutions leet courantes + enlève espaces/accents
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // enlève accents
    .replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e').replace(/4/g,'a')
    .replace(/5/g,'s').replace(/7/g,'t').replace(/8/g,'b').replace(/@/g,'a')
    .replace(/\$/g,'s').replace(/!/g,'i').replace(/\*/g,'').replace(/\./g,'')
    .replace(/[\s_\-]+/g,' ');
}

function moderate(text) {
  if (!text) return { clean: true };
  const norm = normalize(text);
  const noSpaces = norm.replace(/\s/g,'');

  // 1) Mots interdits multilingues
  for (const word of ALL_BANNED) {
    const w = word.toLowerCase();
    if (norm.includes(w) || noSpaces.includes(w.replace(/\s/g,''))) {
      return { clean: false, reason: 'profanity' };
    }
  }

  // 2) URLs (anti-spam)
  if (/https?:\/\/|www\.|\.com|\.fr|\.net|\.org|\.io|t\.me|bit\.ly/i.test(text)) {
    return { clean: false, reason: 'url' };
  }

  // 3) Numéros de téléphone (6+ chiffres consécutifs)
  if (/\d{6,}/.test(text.replace(/\s/g,''))) {
    return { clean: false, reason: 'phone' };
  }

  // 4) Spam évident (répétition excessive)
  if (/(.)\1{6,}/.test(text)) {
    return { clean: false, reason: 'spam' };
  }

  // 5) Majuscules excessives (>70% si plus de 10 caractères)
  const letters = text.replace(/[^a-zA-Z]/g,'');
  if (letters.length > 10) {
    const upper = letters.replace(/[^A-Z]/g,'').length;
    if (upper / letters.length > 0.7) return { clean: false, reason: 'caps' };
  }

  return { clean: true };
}

// Hash simple pour anonymiser IP/email
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 100;
}
function validPseudo(p) {
  return typeof p === 'string' && /^[a-zA-Z0-9_\u00C0-\u017F\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF-]{3,20}$/.test(p);
}

const RATE_LIMIT_MS = 10000;        // 1 message / 10 secondes
const MAX_MESSAGES_STORED = 200;    // Garde 200 derniers messages
const MAX_MESSAGES_RETURNED = 50;   // Renvoie 50 plus récents
const MAX_MSG_LEN = 200;            // 200 caractères max
const BAN_THRESHOLD = 3;            // 3 violations = ban

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });

  const messages = getStore('chat-messages');
  const bans = getStore('chat-bans');
  const strikes = getStore('chat-strikes');
  const rate = getStore('chat-rate');

  const ip = req.headers.get('x-nf-client-connection-ip') 
          || req.headers.get('x-forwarded-for')?.split(',')[0] 
          || 'unknown';
  const ipKey = hash(ip);

  // Check ban
  const banned = await bans.get(ipKey);
  if (banned) {
    return new Response(JSON.stringify({ error: 'banned', message: 'Vous êtes banni du chat.' }),
      { status: 403, headers: cors });
  }

  // ===== GET : Lire les messages =====
  if (req.method === 'GET') {
    const all = await messages.get('list', { type: 'json' }) || [];
    return new Response(JSON.stringify({ messages: all.slice(-MAX_MESSAGES_RETURNED) }),
      { status: 200, headers: cors });
  }

  // ===== POST : Envoyer un message =====
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { 
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: cors });
    }

    const pseudo = (body.pseudo || '').trim();
    const email = (body.email || '').trim();
    const msg = (body.msg || '').trim();

    // Validation format
    if (!validPseudo(pseudo)) {
      return new Response(JSON.stringify({ error: 'invalid_pseudo', message: 'Pseudo invalide (3-20 caractères alphanumériques).' }),
        { status: 400, headers: cors });
    }
    if (!validEmail(email)) {
      return new Response(JSON.stringify({ error: 'invalid_email', message: 'Adresse email invalide.' }),
        { status: 400, headers: cors });
    }
    if (!msg || msg.length > MAX_MSG_LEN) {
      return new Response(JSON.stringify({ error: 'invalid_msg', message: 'Message invalide (1-200 caractères).' }),
        { status: 400, headers: cors });
    }

    // Rate limit
    const last = await rate.get(ipKey);
    if (last && Date.now() - parseInt(last) < RATE_LIMIT_MS) {
      const remaining = Math.ceil((RATE_LIMIT_MS - (Date.now() - parseInt(last))) / 1000);
      return new Response(JSON.stringify({ error: 'rate_limit', message: `Patientez ${remaining}s avant le prochain message.` }),
        { status: 429, headers: cors });
    }

    // Modération
    const modPseudo = moderate(pseudo);
    const modMsg = moderate(msg);
    if (!modPseudo.clean || !modMsg.clean) {
      // Incrémenter strikes et bannir au 3e
      const current = parseInt(await strikes.get(ipKey) || '0') + 1;
      await strikes.set(ipKey, String(current));
      if (current >= BAN_THRESHOLD) {
        await bans.set(ipKey, String(Date.now()));
        return new Response(JSON.stringify({ error: 'banned', message: 'Bannissement automatique après 3 violations.' }),
          { status: 403, headers: cors });
      }
      const reason = (!modPseudo.clean ? modPseudo.reason : modMsg.reason);
      return new Response(JSON.stringify({ 
        error: 'moderation', 
        reason, 
        strikes: current, 
        message: `Contenu inapproprié détecté (${reason}). Avertissement ${current}/${BAN_THRESHOLD}.` 
      }), { status: 400, headers: cors });
    }

    // Ajouter le message
    const all = await messages.get('list', { type: 'json' }) || [];
    all.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      pseudo: pseudo,
      eh: hash(email),               // hash email (anonyme)
      msg: msg,
      date: new Date().toISOString()
    });
    if (all.length > MAX_MESSAGES_STORED) all.splice(0, all.length - MAX_MESSAGES_STORED);
    await messages.set('list', JSON.stringify(all));
    await rate.set(ipKey, String(Date.now()));

    return new Response(JSON.stringify({ ok: true, message: 'Message publié.' }),
      { status: 200, headers: cors });
  }

  return new Response(JSON.stringify({ error: 'method_not_allowed' }),
    { status: 405, headers: cors });
};

export const config = { path: '/api/chat' };
