<<<<<<< HEAD
# Chatbot H-H (WhatsApp + IA)

Assistant WhatsApp avec tableau de bord web, base de connaissance locale (RAG simple) et support multi-fournisseurs IA.

## Fonctionnalites principales

- Bot WhatsApp base sur `whatsapp-web.js`
- API Express pour piloter le bot et l'ingestion
- Dashboard web (fichier statique `public/index.html`)
- Base SQLite locale pour:
  - parametres
  - documents/chunks
  - historique conversations
  - ressources partageables
- Ingestion de contenu:
  - URL unique
  - site web (crawl limite)
  - fichier (`txt`, `md`, `csv`, `json`, `pdf`, `docx`, images OCR)
- Support providers IA: `groq`, `openai`, `gemini`, `openrouter`, `localai`

## Prerequis

- Node.js 18+ recommande
- npm
- WhatsApp mobile pour scanner le QR code

## Installation

```bash
npm install
```

## Configuration `.env`

1. Copier le template:

```bash
copy .env.example .env
```

2. Renseigner les cles API utiles selon le provider choisi.

Variables importantes:

- `AI_PROVIDER` (`groq`, `openai`, `gemini`, `openrouter`, `localai`)
- `GROQ_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`
- `LOCALAI_BASE_URL` (si `localai`)
- `WA_CLIENT_ID` (session WhatsApp)
- `SKIP_WHATSAPP_INIT` (`1` pour lancer uniquement l'API/dashboard, utile pour smoke test CI)
- `WA_COUNTRY_CODE` (préfixe pays utilisé pour notifier un conseiller, ex: `225`)
- `WA_NOTIFY_COUNSELOR` (`1` active la notification automatique du conseiller, `0` la désactive)
- `CHROME_EXECUTABLE_PATH` (chemin explicite vers `chrome.exe` si Puppeteer ne le trouve pas)
- `SESSION_SECRET` (secret de session pour la page login/register, obligatoire en prod)
- `ALLOW_REGISTER` (`1` autorise l’inscription, `0` la désactive)
- `OCR_LANG` (par defaut `fra+eng`)
- Decoupe des reponses WhatsApp (plusieurs bulles, pauses entre les envois):
  - `REPLY_CHUNK_MIN_SENTENCES` / `REPLY_CHUNK_MAX_SENTENCES` (defaut `2` et `3`)
  - `REPLY_CHUNK_DELAY_MIN_MS` / `REPLY_CHUNK_DELAY_MAX_MS` (defaut `5000` et `6000`)

Ces reglages sont aussi modifiables dans le dashboard (Parametres IA). Le modele ne peut pas imposer plusieurs messages WhatsApp : le decoupage est fait cote serveur apres generation.

## Lancement

```bash
npm start
```

Serveur par defaut: `http://localhost:3000`

## Auth dashboard (login/register)

- Le dashboard est maintenant protégé par une page **login/register**.
- Au premier lancement, crée un compte sur `http://localhost:3000/register`.
- Pour désactiver l’inscription (recommandé en prod), mets `ALLOW_REGISTER=0`.
- En production, définis un vrai secret: `SESSION_SECRET=...` (long et aléatoire).

## Docker

Pré-requis: Docker Desktop.

1) Créer `.env` (via `.env.example`) puis lancer:

```bash
docker compose up --build
```

2) Ouvrir:

- Dashboard: `http://localhost:3000`

Notes:
- Les volumes persistent `data/` (SQLite + uploads) et `.wwebjs_auth/` / `.wwebjs_cache/` (session WhatsApp).

Au premier lancement:

- Ouvrir le dashboard dans le navigateur
- Recuperer/actualiser le QR
- Scanner avec WhatsApp (`Appareils connectes`)

## Structure rapide

- `index.js`: backend unique (API, DB, bot WhatsApp, logique IA/RAG)
- `public/index.html`: dashboard admin
- `data/bot.db`: base SQLite runtime
- `data/uploads/`: stockage fichiers ingeres
- `.wwebjs_auth/`, `.wwebjs_cache/`: session/cache WhatsApp

Documentation d'onboarding technique:

- `ARCHITECTURE.md`: responsabilités détaillées du backend actuel
- `QUALITY_BASELINE.md`: garde-fous minimum avant nouvelles features
- `MODULARIZATION_ROADMAP.md`: découpage progressif et roadmap priorisée

## Endpoints API principaux

- Sante/etat:
  - `GET /api/status`
  - `GET /api/whatsapp/qr`
  - `POST /api/whatsapp/restart-qr`
  - `POST /api/whatsapp/disconnect`
- Parametrage:
  - `GET /api/settings`
  - `PUT /api/settings`
- Connaissances:
  - `GET /api/documents`
  - `POST /api/ingest/url`
  - `POST /api/ingest/site`
  - `POST /api/ingest/file`
  - `DELETE /api/documents/:id`
- Conversations:
  - `GET /api/conversations`
  - `DELETE /api/conversations`
  - `DELETE /api/conversations/:chatId`
- Sandbox:
  - `GET /api/sandbox/history`
  - `POST /api/sandbox/chat`
  - `DELETE /api/sandbox/history`

## Flux message entrant -> reponse

1. Message recu depuis WhatsApp
2. Filtrage anti-doublon + verrou par contact
3. Sauvegarde message utilisateur en DB (`conversation_messages`)
4. Recuperation contexte:
   - historique conversation
   - chunks pertinents (`retrieveContext`)
   - ressources partageables (`knowledge_assets`)
5. Construction des messages system + user
6. Appel provider IA selectionne
7. Reponse envoyee sur WhatsApp en une ou plusieurs bulles (decoupage par phrases + delai entre bulles), puis delai "humain" optionnel avant la premiere bulle
8. Sauvegarde reponse assistant en DB
9. Optionnel: envoi de ressources (liens/fichiers) si demande explicite

## Base de donnees (SQLite)

Tables creees automatiquement:

- `settings`
- `documents`
- `chunks`
- `conversation_messages`
- `knowledge_assets`

Fichier DB: `data/bot.db`

## Depannage rapide

- **Pas de QR**: utiliser `POST /api/whatsapp/restart-qr` depuis le dashboard.
- **Pas de QR (Chrome introuvable)**:
  - installer le navigateur Puppeteer: `npx puppeteer browsers install chrome`
  - ou définir `CHROME_EXECUTABLE_PATH` vers un Chrome local
  - relancer le bot puis cliquer sur **Actualiser QR**
- **WhatsApp deconnecte**: relancer une connexion via bouton deconnexion puis scan QR.
- **Erreur provider IA**: verifier API key + modele compatible avec le provider.
- **PDF/image sans texte**: verifier qualite du fichier; OCR peut renvoyer un texte insuffisant.
- **Port occupe**: definir `PORT` dans `.env`.

## Securite et hygiene

- `.env`, `data/`, `.wwebjs_auth/`, `.wwebjs_cache/` sont ignores par `.gitignore`.
- Ne jamais versionner de cles API.
- Prevoir sauvegarde reguliere de `data/bot.db` en production.

## Scripts npm

- `npm start` -> demarre `index.js`
- `npm run lint` -> verifie la syntaxe backend (`index.js`)
- `npm run smoke:start` -> démarre l'API en mode `SKIP_WHATSAPP_INIT=1` et vérifie `GET /api/status`
- `npm test` -> alias vers `npm run smoke:start`
- `npm run check` -> enchaîne lint + smoke test

## Comportements métier automatisés

- Si un utilisateur demande explicitement un document/fichier présent dans la base (`pdf`, image, flyer, affiche, etc.), le bot l'envoie directement sur WhatsApp.
- Si le bot transmet le numéro d'un conseiller au client, il envoie aussi un message automatique au conseiller pour l'informer qu'il va probablement être contacté.
=======
# Chatbot-SOULTECH-AI
Nouveau chatbot WhatsApp creer par SOULTECH AI
>>>>>>> 03b4f3d45256e82dab1925f4ac3849618e5a62e2
