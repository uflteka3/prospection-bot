// Liaison TELEGRAM (remplace l'ancien src/whatsapp.js, mêmes exports : le reste du robot ne change pas)
// Variables nécessaires : TELEGRAM_BOT_TOKEN (donné par @BotFather) et OWNER_TELEGRAM_ID (ton identifiant Telegram)
import fs from 'fs';

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const OWNER_IDS = String(process.env.OWNER_TELEGRAM_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const API = `https://api.telegram.org/bot${TOKEN}`;

const state = { connected: false };
let handler = null;
let ownerChat = null;
let offset = 0;
let queue = Promise.resolve();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Même forme que l'ancienne version (la page /qr affichera « connecté »)
export const getStatus = () => ({ connected: state.connected, qr: null, pairingCode: null });

async function api(method, body, isForm = false) {
  const res = await fetch(`${API}/${method}`, isForm
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${res.status}`);
  return data.result;
}

async function reply(chatId, text) {
  const chunks = String(text).match(/[\s\S]{1,3500}/g) || [];
  for (const chunk of chunks) await api('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true });
}

async function replyImage(chatId, file, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', String(caption).slice(0, 1000));
  form.append('photo', new Blob([fs.readFileSync(file)], { type: 'image/png' }), 'visuel.png');
  await api('sendPhoto', form, true);
}

export async function sendToOwner(text) {
  const chatId = ownerChat || OWNER_IDS[0];
  if (!state.connected || !chatId) return false;
  await reply(chatId, text);
  return true;
}

async function onMessage(m) {
  if (!m?.text || m.chat?.type !== 'private') return;
  const chatId = m.chat.id;
  const fromId = String(m.from?.id || '');

  if (!OWNER_IDS.includes(fromId)) {
    console.log(`[telegram] Message ignoré (expéditeur non autorisé : ${fromId}). Si c'est toi, ajoute OWNER_TELEGRAM_ID=${fromId} dans les variables d'environnement.`);
    await reply(chatId, `Ton identifiant Telegram est : ${fromId}\nAjoute-le dans la variable OWNER_TELEGRAM_ID du service sur Render, puis redémarre-le.`).catch(() => {});
    return;
  }

  ownerChat = chatId;
  const text = m.text.replace(/^\/(\w+)@\w+/, '/$1').trim();
  if (!text) return;

  if (text === '/start') {
    return reply(chatId, 'Robot de prospection DIAO DEV prêt ✅\nExemples : « Cherche des restaurants à Ouaga sans site web », « Rédige le premier message pour … », « Liste les prospects intéressés ». Tape /api pour voir l\'IA utilisée.');
  }

  try { await api('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch { /* sans importance */ }
  const send = t => reply(chatId, t);
  const sendImage = (file, caption) => replyImage(chatId, file, caption);
  await handler(text, send, sendImage);
}

async function poll() {
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      if (!state.connected) console.log('[telegram] Connecté.');
      state.connected = true;
      for (const u of updates) {
        offset = u.update_id + 1;
        queue = queue.then(() => onMessage(u.message)).catch(e => console.log('[telegram] Erreur :', e.message));
      }
    } catch (e) {
      state.connected = false;
      console.log('[telegram] Connexion interrompue :', e.message);
      await sleep(5000);
    }
  }
}

// Le nom startWhatsApp est gardé pour que index.js n'ait pas besoin de changer
export async function startWhatsApp(onOwnerMessage) {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN manquant (à créer avec @BotFather sur Telegram)');
  handler = onOwnerMessage;
  const me = await api('getMe');
  console.log(`[telegram] Robot : @${me.username}`);
  if (!OWNER_IDS.length) console.log('[telegram] OWNER_TELEGRAM_ID absent : envoie /start au robot, il te donnera ton identifiant.');
  await api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  poll();
}
