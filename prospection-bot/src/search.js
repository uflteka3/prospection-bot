import { ask, extractJsonArray } from './llm.js';
import { webSearch } from './websearch.js';
import { addProspect, isKnown } from './db.js';

const CITY = process.env.SEARCH_CITY || 'Ouagadougou';

// +226 pour les numéros locaux à 8 chiffres
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 8) return '+226' + digits;
  if (digits.length >= 11) return '+' + digits;
  return String(phone).trim() || null;
}

export async function searchCompanies(request) {
  const queries = [
    `${request} ${CITY} contact téléphone`,
    `${request} ${CITY} annuaire`,
    `${request} ${CITY} facebook page`
  ];
  const settled = await Promise.allSettled(queries.map(q => webSearch(q)));
  const ok = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value);
  if (!ok.length) {
    const err = settled.find(s => s.status === 'rejected');
    throw new Error(err ? err.reason.message : 'Aucun résultat de recherche');
  }
  const raw = ok.map(r => `${r.title} | ${r.link} | ${r.snippet}`).join('\n---\n').slice(0, 40000);

  const text = await ask(`Voici des résultats de recherche web. Extrais les entreprises de ${CITY} qui correspondent à la demande : "${request}".
Pour chacune, donne : name, sector, phone (format international +226...), email, website (null si aucun site propre), facebook, notes (ce qui manque : site, affiche, logo).
Ignore les annuaires eux-mêmes, les administrations et les grandes multinationales.
Réponds UNIQUEMENT avec un tableau JSON valide.
Résultats :
${raw}`, { maxTokens: 3000 });

  const list = extractJsonArray(text);
  if (!list) throw new Error('L\'IA n\'a pas renvoyé de JSON valide. Réessaie ou change de modèle.');

  const fresh = [];
  for (const p of list) {
    if (!p || !p.name) continue;
    p.phone = normalizePhone(p.phone);
    // un lien Facebook placé dans "website" n'est pas un vrai site
    if (p.website && /facebook\.com|instagram\.com/i.test(p.website)) { p.facebook = p.facebook || p.website; p.website = null; }
    if (isKnown(p)) continue;
    addProspect(p);
    fresh.push(p);
  }
  return fresh;
}
