# Robot de prospection DIAO DEV

Robot WhatsApp (SIM dédiée) qui cherche des entreprises à Ouagadougou, rédige les messages de prospection,
suit les conversations, propose des relances et crée flyers, affiches et logos.
Il fonctionne avec **n'importe quelle API d'IA** et **n'importe quelle API de recherche web**.

## Ce que tu peux lui dire (depuis ton numéro)

- « Cherche des restaurants à Ouaga sans site web »
- « Rédige le premier message pour Maquis Le Verdoyant »
- « J'ai envoyé le message à Maquis Le Verdoyant » → statut « contacté » + historique
- « Rédige une relance pour Maquis Le Verdoyant »
- « Fais un flyer portrait pour la pharmacie X, couleurs vert et blanc » / « un logo pour… »
- « Liste les prospects intéressés »
- `/api` : affiche l'IA et la recherche utilisées (sans montrer les clés)

Chaque matin à 8h00, il te rappelle les prospects contactés sans nouvelle depuis 3 jours.
Le robot **n'envoie jamais** de message à un prospect : il te donne un lien `wa.me` prêt à envoyer depuis ton téléphone.
Si un prospect enregistré écrit à la SIM du robot, il garde la trace et te prévient.

## Choisir l'IA (fichier `.env`)

| Fournisseur | `LLM_PROVIDER` | Remarque |
|---|---|---|
| Claude (Anthropic) | `anthropic` | |
| OpenAI | `openai` | |
| Groq, OpenRouter, Mistral, DeepSeek, Together, Gemini, xAI | `groq`, `openrouter`, `mistral`, `deepseek`, `together`, `gemini`, `xai` | adresses déjà connues |
| Ollama / LM Studio (sur ta machine) | `ollama`, `lmstudio` | pas de clé |
| Tout service compatible OpenAI | `custom` + `LLM_BASE_URL` | |
| Toute autre API HTTP | `raw` + `LLM_BASE_URL`, `LLM_REQUEST_TEMPLATE`, `LLM_RESPONSE_PATH` | voir `.env.example` |

`LLM_MODEL` est toujours à renseigner avec le nom exact du modèle chez ton fournisseur.
Si le modèle ne gère pas les outils (tool calling), ajoute `LLM_TOOLS=prompt` : le robot les simule par le texte.

## Choisir la recherche web

`SEARCH_PROVIDER` : `serper`, `brave`, `tavily`, `searxng`, `duckduckgo` (sans clé, moins fiable) ou `custom`
(toute API, décrite avec `SEARCH_URL`, `SEARCH_RESULTS_PATH`, etc.). Voir `.env.example`.

## Lancer en local

```bash
cp .env.example .env     # puis remplis-le
npm install              # git est nécessaire (dépendance de Baileys)
npm start
```

Ouvre `http://localhost:3000/qr?token=TON_ADMIN_TOKEN` et scanne le QR avec la SIM du robot
(WhatsApp > Appareils connectés). Ou renseigne `PAIRING_NUMBER` pour utiliser un code à saisir.

## Déployer sur Render

1. Mets le dossier sur GitHub (le `.gitignore` exclut `.env`, `auth/`, `data.db`).
2. Sur Render : **New > Blueprint**, choisis le dépôt. `render.yaml` crée un service Docker avec un disque `/data`
   (garde la session WhatsApp et la base) : il demande une offre payante, c'est nécessaire pour qu'un robot WhatsApp reste allumé et ne perde rien.
3. Renseigne les variables : `OWNER_NUMBER`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `SEARCH_PROVIDER`, `SEARCH_API_KEY`.
   `ADMIN_TOKEN` est généré automatiquement (visible dans l'onglet Environment).
4. Ouvre `https://ton-service.onrender.com/qr?token=ADMIN_TOKEN` et scanne le QR. À faire une seule fois.

## Bon à savoir

- Baileys est une connexion WhatsApp **non officielle** : utilise une SIM dédiée, n'envoie pas de messages en masse,
  et garde un rythme humain, sinon le numéro peut être bloqué.
- Si le robot ignore tes messages et affiche un « OWNER_LID » dans les logs, copie cette valeur dans tes variables.
- Ne partage jamais ton `.env` ni ton `ADMIN_TOKEN`.
