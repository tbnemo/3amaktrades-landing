/**
 * Discord Interactions endpoint — self-service language switcher.
 *
 * Discord's native onboarding only ever ADDS roles, so a member who re-answers
 * the language prompt ends up holding both language roles at once and sees both
 * category sets. This endpoint backs a persistent two-button message that swaps
 * a member's language role cleanly, carrying VIP status across the switch.
 *
 * Env vars (Vercel project settings — never commit these):
 *   DISCORD_BOT_TOKEN   bot token, used for the role REST calls
 *   DISCORD_PUBLIC_KEY  application verify_key, used to check request signatures
 *
 * NOTE: this file is .mjs on purpose. Vercel's Node runtime only reliably picks
 * up `config.api.bodyParser = false` as a static ESM export, and signature
 * verification needs the exact raw request bytes — a re-serialized `req.body`
 * would not byte-match what Discord signed.
 */

import { createPublicKey, verify as ed25519Verify } from 'node:crypto';

const API = 'https://discord.com/api/v10';

const GUILD_ID = '1542907691792343113';

const ROLE = {
  en: '1547823680409575504', // 🇬🇧 English
  ar: '1547823683131674664', // 🇸🇦 عربي
  vipEn: '1547823685761634336', // VIP English
  vipAr: '1547823688349393006', // VIP Arabic
};

// Discord interaction / response type constants
const PING = 1;
const MESSAGE_COMPONENT = 3;
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL = 64;

/* ---------------------------------------------------------------- signature */

let cachedKey = null;

// Discord publishes the application's Ed25519 public key as 32 raw bytes in hex.
// Node's crypto needs a KeyObject, so wrap those bytes in the fixed SPKI/DER
// header for Ed25519 (RFC 8410) rather than pulling in tweetnacl.
function publicKey() {
  if (cachedKey) return cachedKey;
  const hex = (process.env.DISCORD_PUBLIC_KEY || '').trim();
  if (!hex) throw new Error('DISCORD_PUBLIC_KEY is not set');
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('DISCORD_PUBLIC_KEY must be 32 bytes of hex');
  cachedKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
  return cachedKey;
}

function isValidSignature(rawBody, signatureHex, timestamp) {
  if (!signatureHex || !timestamp) return false;
  const signature = Buffer.from(String(signatureHex), 'hex');
  // Buffer.from(..., 'hex') truncates on invalid input instead of throwing,
  // so the length check doubles as the malformed-input guard.
  if (signature.length !== 64) return false;
  const message = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), rawBody]);
  try {
    return ed25519Verify(null, message, publicKey(), signature);
  } catch {
    return false;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------- discord api */

async function roleCall(method, userId, roleId, reason) {
  const res = await fetch(
    `${API}/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`,
    {
      method,
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        'X-Audit-Log-Reason': reason,
      },
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} role ${roleId} -> ${res.status} ${detail.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ replies */

function ephemeral(content) {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  };
}

const COPY = {
  en: {
    already: "✅ You're already set to **English** — nothing to change.",
    switched: '✅ Language switched to **English**. The English channels are now visible.',
    vip: '\n⭐ Your **VIP** access carried over to the English VIP channels.',
    hint: '\n\n_If the channel list looks stale, fully close and reopen Discord._',
    error:
      "⚠️ Something went wrong while changing your language, so nothing was changed. Please try again, or ping an admin if it keeps failing.",
  },
  ar: {
    already: '✅ لغتك مضبوطة على **العربية** بالفعل — لا يوجد أي تغيير.',
    switched: '✅ تم تغيير لغتك إلى **العربية**. القنوات العربية ظاهرة لك الآن.',
    vip: '\n⭐ تم نقل اشتراك **VIP** الخاص بك إلى قنوات VIP العربية.',
    hint: '\n\n_إذا لم تتحدّث قائمة القنوات، أغلق تطبيق ديسكورد وأعد فتحه._',
    error: '⚠️ حدث خطأ أثناء تغيير اللغة ولم يتم تعديل أي شيء. حاول مرة أخرى أو تواصل مع الإدارة.',
  },
};

/* ------------------------------------------------------------------ handler */

async function handleLanguageSwitch(interaction, lang) {
  const member = interaction.member;
  const copy = COPY[lang];

  if (!member || !member.user || interaction.guild_id !== GUILD_ID) {
    return ephemeral(copy.error);
  }

  const held = new Set(member.roles || []);
  const isVip = held.has(ROLE.vipEn) || held.has(ROLE.vipAr);

  const keep = lang === 'en' ? ROLE.en : ROLE.ar;
  const drop = lang === 'en' ? ROLE.ar : ROLE.en;
  const vipKeep = lang === 'en' ? ROLE.vipEn : ROLE.vipAr;
  const vipDrop = lang === 'en' ? ROLE.vipAr : ROLE.vipEn;

  const toAdd = [];
  const toRemove = [];
  if (!held.has(keep)) toAdd.push(keep);
  if (held.has(drop)) toRemove.push(drop);
  if (isVip) {
    if (!held.has(vipKeep)) toAdd.push(vipKeep);
    if (held.has(vipDrop)) toRemove.push(vipDrop);
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    return ephemeral(copy.already);
  }

  const userId = member.user.id;
  const reason = `Self-service language switch -> ${lang}`;

  try {
    // Add before removing. If a call fails midway the member may briefly hold
    // both languages (the already-known broken state) instead of being left
    // with no language role at all, which would lock them out of every channel.
    await Promise.all(toAdd.map((r) => roleCall('PUT', userId, r, reason)));
    await Promise.all(toRemove.map((r) => roleCall('DELETE', userId, r, reason)));
  } catch (err) {
    console.error('[discord-interactions] role update failed', {
      userId,
      lang,
      toAdd,
      toRemove,
      message: err && err.message,
    });
    return ephemeral(copy.error);
  }

  let content = copy.switched;
  if (isVip) content += copy.vip;
  content += copy.hint;
  return ephemeral(content);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).send('Could not read request body');
  }

  // `config.api.bodyParser` is false below, so the stream should reach us
  // untouched. If a platform change ever breaks that, the raw bytes would be
  // gone and every signature check would fail as a confusing 401 — surface that
  // specific cause in the logs instead of leaving it to guesswork.
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (rawBody.length === 0 && declaredLength > 0) {
    console.error(
      `[discord-interactions] raw body empty despite content-length ${declaredLength} — ` +
        'the platform body parser likely consumed the stream; signature verification cannot succeed.'
    );
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!isValidSignature(rawBody, signature, timestamp)) {
    return res.status(401).send('invalid request signature');
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  if (interaction.type === PING) {
    return res.status(200).json({ type: PONG });
  }

  if (interaction.type === MESSAGE_COMPONENT) {
    const customId = interaction.data && interaction.data.custom_id;
    if (customId === 'lang_en') {
      return res.status(200).json(await handleLanguageSwitch(interaction, 'en'));
    }
    if (customId === 'lang_ar') {
      return res.status(200).json(await handleLanguageSwitch(interaction, 'ar'));
    }
  }

  // Anything else is signed and genuine but not ours to handle.
  return res.status(200).json({ type: PONG });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
