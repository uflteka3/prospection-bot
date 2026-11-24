import * as baileysNs from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, findProspectByPhone, logMessage } from './db.js';

// Compatible avec les différentes façons dont Baileys expose ses exports en ESM
const root = baileysNs.default && typeof baileysNs.default === 'object' ? baileysNs.default : baileysNs;
const makeWASocket = typeof root.default === 'function' ? root.default
  : (root.makeWASocket ?? (typeof baileysNs.default === 'function' ? baileysNs.default : undefined));
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = root;

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const digits = s => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const list = v => String(v || '').split(',').map(digits).filter(Boolean);

const OWNERS = list(process.env.OWNER_NUMBER);      // ex. 226XXXXXXXX
const OWNER_LIDS = list(process.env.OWNER_LID);     // optionnel : identifiant @lid du patron
const PAIRING_NUMBER = digits(process.env.PAIRING_NUMBER);

const state = { connected: false, qr: null, pairingCode: null, ownerJid: null };
let sock = null;
let queue = Promise.resolve();
let onOwnerMessage = null;

export const getStatus = () => ({ connected: state.connected, qr: state.qr, pairingCode: state.pairingCode });

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.documentWithCaptionMessage?.message || m;
    if (!m.ephemeralMessage && !m.viewOnceMessage && !m.documentWithCaptionMessage) break;
  }
  return m;
}

const textOf = message => {
  const m = unwrap(message) || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
};

async function reply(jid, text) {
  const chunks = String(text).match(/[\s\S]{1,3500}/g) || [];
  for (const chunk of chunks) await sock.sendMessage(jid, { text: chunk });
}

export async function sendToOwner(text) {
  if (!state.connected || !sock) return false;
  const jid = state.ownerJid || `${OWNERS[0]}@s.whatsapp.net`;
  await reply(jid, text);
  return true;
}

async function onMessage(m) {
  const key = m.key || {};
  const jid = key.remoteJid;
  if (!jid || key.fromMe || !m.message) return;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

  const text = textOf(m.message).trim();
  if (!text) return;

  const candidates = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt, key.senderPn].filter(Boolean);
  const isPN = j => j.endsWith('@s.whatsapp.net');
  const isOwner = candidates.some(j =>
    (isPN(j) && OWNERS.includes(digits(j))) || (j.endsWith('@lid') && OWNER_LIDS.includes(digits(j))));

  if (isOwner) {
    state.ownerJid = jid;
    try { await sock.sendPresenceUpdate('composing', jid); } catch { /* sans importance */ }
    const send = t => reply(jid, t);
    const sendImage = (file, caption) => sock.sendMessage(jid, { image: fs.readFileSync(file), caption });
    await onOwnerMessage(text, send, sendImage);
    return;
  }

  // Un prospect connu écrit au robot : on garde la trace et on prévient le patron
  const pn = candidates.find(isPN);
  const prospect = pn ? findProspectByPhone(digits(pn)) : null;
  if (prospect) {
    logMessage(prospect.id, jid, 'in', text);
    await sendToOwner(`📩 ${prospect.name} a répondu :\n${text}`);
    return;
  }

  console.log(`[whatsapp] Message ignoré (expéditeur non autorisé : ${jid})`);
  if (jid.endsWith('@lid')) {
    console.log(`[whatsapp] Si c'est toi, ajoute OWNER_LID=${digits(jid)} dans les variables d'environnement.`);
  }
}

async function connect() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (PAIRING_NUMBER && !auth.creds.registered) {
        try {
          state.pairingCode = await sock.requestPairingCode(PAIRING_NUMBER);
          console.log(`[whatsapp] Code de jumelage : ${state.pairingCode} (WhatsApp > Appareils connectés > Connecter avec le numéro)`);
        } catch (e) { console.log('[whatsapp] Jumelage impossible :', e.message); }
      }
      state.qr = qr;
      console.log('[whatsapp] QR prêt : ouvre /qr?token=... sur ton serveur et scanne-le.');
    }

    if (connection === 'open') {
      state.connected = true; state.qr = null; state.pairingCode = null;
      console.log('[whatsapp] Connecté.');
    }

    if (connection === 'close') {
      state.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('[whatsapp] Session déconnectée depuis le téléphone : nouvelle liaison nécessaire.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        console.log(`[whatsapp] Connexion fermée (${code ?? 'inconnu'}), reconnexion...`);
      }
      setTimeout(() => connect().catch(e => console.log('[whatsapp] Échec de reconnexion :', e.message)), 3000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      // un seul message traité à la fois, dans l'ordre
      queue = queue.then(() => onMessage(m)).catch(e => console.log('[whatsapp] Erreur :', e.message));
    }
  });
}

export async function startWhatsApp(handler) {
  if (!OWNERS.length) throw new Error('OWNER_NUMBER manquant (ex. 226XXXXXXXX)');
  if (typeof makeWASocket !== 'function') throw new Error('Baileys introuvable : vérifie l\'installation de @whiskeysockets/baileys');
  onOwnerMessage = handler;
  await connect();
}
