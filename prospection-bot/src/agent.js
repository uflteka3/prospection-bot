import { chat, ask, describeLlm } from './llm.js';
import { describeSearch } from './websearch.js';
import { searchCompanies } from './search.js';
import { createFlyer } from './flyer.js';
import { addProspect, findProspect, getHistory, logMessage, setStatus, listByStatus } from './db.js';

const SYSTEM = `Tu es l'assistant de prospection de DIAO DEV, freelance développeur web à Ouagadougou (sites web, flyers, affiches, logos).
Tu aides ton patron par WhatsApp. Ton rôle : chercher des entreprises, rédiger des messages de prospection naturels, humains et courts (jamais copiés-collés, jamais robotiques), proposer des relances selon l'historique, et créer des visuels.
Ton : chaleureux, professionnel, vouvoiement envers les prospects, tutoiement avec ton patron. Pas de formules lourdes.
Un message de prospection : maximum 6 lignes, mentionne un détail précis de l'entreprise, propose une seule chose, finit par une question simple.
Quand ton patron dit avoir envoyé un message ou reçu une réponse, utilise changer_statut et noter_message pour garder l'historique à jour.
Tes réponses sont lues sur WhatsApp : courtes, sans tableaux ni titres markdown.`;

const tools = [
  { name: 'rechercher_entreprises', description: 'Cherche des entreprises à Ouagadougou et les enregistre.',
    input_schema: { type: 'object', properties: { demande: { type: 'string' } }, required: ['demande'] } },
  { name: 'rediger_message', description: 'Rédige un premier message de prospection pour une entreprise enregistrée.',
    input_schema: { type: 'object', properties: { entreprise: { type: 'string' } }, required: ['entreprise'] } },
  { name: 'rediger_relance', description: 'Rédige une relance adaptée à l\'historique de conversation.',
    input_schema: { type: 'object', properties: { entreprise: { type: 'string' } }, required: ['entreprise'] } },
  { name: 'creer_flyer', description: 'Crée une affiche, un flyer, un logo ou un visuel (image PNG).',
    input_schema: { type: 'object', properties: {
      entreprise: { type: 'string' }, demande: { type: 'string' },
      couleurs: { type: 'string' }, style: { type: 'string' },
      format: { type: 'string', enum: ['portrait', 'carre', 'paysage', 'logo'] } },
      required: ['entreprise', 'demande'] } },
  { name: 'changer_statut', description: 'Change le statut d\'un prospect (nouveau, contacte, interesse, refuse, client).',
    input_schema: { type: 'object', properties: { entreprise: { type: 'string' }, statut: { type: 'string' } }, required: ['entreprise', 'statut'] } },
  { name: 'lister', description: 'Liste les prospects par statut (nouveau, contacte, interesse, refuse, client, ou tous).',
    input_schema: { type: 'object', properties: { statut: { type: 'string' } }, required: ['statut'] } },
  { name: 'noter_message', description: 'Enregistre dans l\'historique un message envoyé (direction "out") ou reçu (direction "in") avec un prospect.',
    input_schema: { type: 'object', properties: {
      entreprise: { type: 'string' }, direction: { type: 'string', enum: ['in', 'out'] }, texte: { type: 'string' } },
      required: ['entreprise', 'direction', 'texte'] } },
  { name: 'ajouter_prospect', description: 'Ajoute à la main un prospect dans la base.',
    input_schema: { type: 'object', properties: {
      nom: { type: 'string' }, secteur: { type: 'string' }, telephone: { type: 'string' }, notes: { type: 'string' } },
      required: ['nom'] } }
];

async function draft(kind, name) {
  const p = findProspect(name);
  if (!p) return `Je ne trouve pas "${name}" dans la base.`;
  const history = getHistory(p.id).map(m => `${m.direction === 'in' ? 'Client' : 'Moi'}: ${m.body}`).join('\n');
  const message = await ask(
    `${kind === 'first' ? 'Rédige le premier message' : 'Rédige une relance'} pour ce prospect :\n${JSON.stringify(p)}\nHistorique :\n${history || '(aucun)'}\nDonne uniquement le message prêt à envoyer.`,
    { system: SYSTEM, maxTokens: 600 }
  );
  const link = p.phone ? `https://wa.me/${p.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}` : null;
  return message + (link ? `\n\nLien pour envoyer : ${link}` : '');
}

// Mémoire courte de la conversation avec le patron (texte seulement)
const memory = [];
const remember = (user, assistant) => {
  memory.push({ role: 'user', content: user }, { role: 'assistant', text: assistant });
  while (memory.length > 12) memory.shift();
};

async function runTool(c, send, sendImage) {
  const a = c.input || {};
  switch (c.name) {
    case 'rechercher_entreprises': {
      await send('Je lance la recherche, je reviens vers toi dès que j\'ai les résultats.');
      const found = await searchCompanies(a.demande);
      return found.length
        ? found.map(p => `${p.name} (${p.sector || '?'}) tel: ${p.phone || '?'} site: ${p.website || 'aucun'} - ${p.notes || ''}`).join('\n')
        : 'Aucune nouvelle entreprise trouvée.';
    }
    case 'rediger_message': return draft('first', a.entreprise);
    case 'rediger_relance': return draft('followup', a.entreprise);
    case 'creer_flyer': {
      const file = await createFlyer({ company: a.entreprise, request: a.demande, colors: a.couleurs, style: a.style, format: a.format });
      await sendImage(file, `Voici le visuel pour ${a.entreprise}.`);
      return 'Image envoyée.';
    }
    case 'changer_statut': {
      const p = findProspect(a.entreprise);
      if (p) setStatus(p.id, a.statut);
      return p ? 'Statut mis à jour.' : 'Prospect introuvable.';
    }
    case 'lister':
      return listByStatus(a.statut).map(p => `${p.name} (${p.status}) - ${p.phone || ''}`).join('\n') || 'Aucun.';
    case 'noter_message': {
      const p = findProspect(a.entreprise);
      if (!p) return 'Prospect introuvable.';
      logMessage(p.id, null, a.direction === 'in' ? 'in' : 'out', a.texte);
      return 'Message enregistré.';
    }
    case 'ajouter_prospect': {
      addProspect({ name: a.nom, sector: a.secteur, phone: a.telephone, notes: a.notes });
      return 'Prospect ajouté.';
    }
    default: return `Outil inconnu : ${c.name}`;
  }
}

export async function handleOwnerMessage(text, send, sendImage) {
  if (/^\/api\b/i.test(text.trim())) {
    let llm;
    try { llm = describeLlm(); } catch (e) { llm = 'non configurée (' + e.message + ')'; }
    return send(`IA : ${llm}\nRecherche web : ${describeSearch()}`);
  }

  const messages = [...memory, { role: 'user', content: text }];
  for (let i = 0; i < 6; i++) {
    let res;
    try {
      res = await chat({ system: SYSTEM, tools, messages, maxTokens: 2000 });
    } catch (e) {
      return send('Erreur IA : ' + e.message);
    }
    messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls });
    if (!res.toolCalls.length) {
      remember(text, res.text);
      return send(res.text || 'C\'est noté.');
    }
    const results = [];
    for (const c of res.toolCalls) {
      let out;
      try { out = await runTool(c, send, sendImage); } catch (e) { out = 'Erreur : ' + e.message; }
      results.push({ id: c.id, name: c.name, content: String(out) });
    }
    messages.push({ role: 'tool', results });
  }
  return send('J\'ai atteint la limite d\'étapes pour cette demande. Peux-tu la préciser ou la découper ?');
}
