import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { ask } from './llm.js';
import { DATA_DIR } from './db.js';

const OUTPUT_DIR = path.join(DATA_DIR, 'output');

function extractHtml(text) {
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('<'), b = body.lastIndexOf('>');
  if (a === -1 || b <= a) throw new Error('L\'IA n\'a pas renvoyé de HTML exploitable');
  return body.slice(a, b + 1);
}

export async function createFlyer({ company, request, colors, style, format = 'portrait' }) {
  const isLogo = format === 'logo';
  const size = format === 'carre' || isLogo ? [1080, 1080] : format === 'paysage' ? [1920, 1080] : [1080, 1350];

  const prompt = isLogo
    ? `Crée un logo professionnel en HTML/CSS/SVG pur (une seule page, ${size[0]}x${size[1]} px, centré, aucune image externe, fond transparent : ne mets aucune couleur de fond sur body ou html).
Entreprise : ${company}
Demande : ${request}
Couleurs de marque : ${colors || 'à choisir selon le secteur'}
Style : ${style || 'simple, mémorable, lisible en petit'}
Texte en français, sans faute. Réponds UNIQUEMENT avec le code HTML complet.`
    : `Crée un flyer publicitaire professionnel en HTML/CSS pur (une seule page, ${size[0]}x${size[1]} px, aucune image externe, polices système ou Google Fonts via @import).
Entreprise : ${company}
Demande : ${request}
Couleurs de marque : ${colors || 'à choisir selon le secteur'}
Style : ${style || 'moderne, lisible, adapté au marché ouest-africain'}
Texte en français, sans faute. Hiérarchie claire : titre fort, offre, coordonnées bien visibles.
Réponds UNIQUEMENT avec le code HTML complet.`;

  const html = extractHtml(await ask(prompt, { maxTokens: 4000 }));

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${isLogo ? 'logo' : 'flyer'}-${Date.now()}.png`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: size[0], height: size[1] });
    try {
      await page.setContent(html, { waitUntil: 'networkidle2', timeout: 20000 });
    } catch { /* une police en retard ne doit pas bloquer l'image */ }
    await page.screenshot({ path: file, omitBackground: isLogo });
  } finally {
    await browser.close();
  }
  return file;
}
