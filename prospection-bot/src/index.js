import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cron from 'node-cron';
import QRCode from 'qrcode';
import { startWhatsApp, getStatus, sendToOwner } from './whatsapp.js';
import { handleOwnerMessage } from './agent.js';
import { dueFollowups } from './db.js';
import { describeLlm } from './llm.js';
import { describeSearch } from './websearch.js';

process.on('unhandledRejection', e => console.log('[erreur]', e?.message || e));
process.on('uncaughtException', e => console.log('[erreur]', e?.message || e));

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const sameToken = t => {
  const a = Buffer.from(String(t || '')), b = Buffer.from(ADMIN_TOKEN);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Santé (Render vérifie cette adresse)
app.get('/', (_req, res) => res.json({ service: 'DIAO DEV prospection-bot', whatsapp: getStatus().connected ? 'connecté' : 'non connecté' }));

// Page pour lier WhatsApp : /qr?token=ADMIN_TOKEN
app.get('/qr', async (req, res) => {
  if (!ADMIN_TOKEN) return res.status(403).send('Définis ADMIN_TOKEN dans les variables d\'environnement pour utiliser cette page.');
  if (!sameToken(req.query.token)) return res.status(403).send('Accès refusé.');
  const s = getStatus();
  let body;
  if (s.connected) body = '<h2>WhatsApp est connecté ✅</h2>';
  else if (s.pairingCode) body = `<h2>Code de jumelage</h2><p style="font-size:2rem;letter-spacing:.2em"><b>${s.pairingCode}</b></p><p>WhatsApp &gt; Appareils connectés &gt; Connecter avec le numéro de téléphone.</p>`;
  else if (s.qr) body = `<h2>Scanne ce QR avec la SIM du robot</h2><img alt="QR" width="320" src="${await QRCode.toDataURL(s.qr, { margin: 2, width: 320 })}">`;
  else body = '<h2>En attente du QR...</h2>';
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><body style="font-family:system-ui;text-align:center;padding:2rem">${body}</body>`);
});

app.listen(PORT, () => console.log(`[serveur] Port ${PORT}`));

for (const [label, fn] of [['IA', describeLlm], ['Recherche', describeSearch]]) {
  try { console.log(`[config] ${label} : ${fn()}`); } catch (e) { console.log(`[config] ${label} : ${e.message}`); }
}

startWhatsApp(handleOwnerMessage).catch(e => console.log('[whatsapp] Démarrage impossible :', e.message));

// Rappel quotidien des relances à faire (08h00 à Ouagadougou)
if (process.env.FOLLOWUP_CRON !== 'off') {
  cron.schedule(process.env.FOLLOWUP_CRON || '0 8 * * *', async () => {
    const days = Number(process.env.FOLLOWUP_DAYS || 3);
    const due = dueFollowups(days);
    if (!due.length) return;
    const lines = due.map(p => `• ${p.name}${p.phone ? ' (' + p.phone + ')' : ''}`).join('\n');
    await sendToOwner(`⏰ ${due.length} prospect(s) sans nouvelle depuis ${days} jours ou plus :\n${lines}\n\nDis-moi « rédige une relance pour … » et je m'en occupe.`);
  }, { timezone: 'Africa/Ouagadougou' });
}
