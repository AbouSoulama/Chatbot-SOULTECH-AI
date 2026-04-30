# Architecture technique - Chatbot H-H

Ce document sert de référence d'onboarding pour comprendre le projet rapidement avant refactor.

## Vue d'ensemble

- Backend monolithique: `index.js`
- Frontend dashboard statique: `public/index.html`
- Persistance locale: `data/bot.db` (SQLite)
- Intégration canal: WhatsApp (`whatsapp-web.js`)
- Intégration IA: Groq, OpenAI, Gemini, OpenRouter, LocalAI

## Responsabilités fonctionnelles de `index.js`

### 1) Configuration et constantes runtime

- Chargement `.env` et valeurs par défaut (provider IA, modèles, délais, chunking).
- Déclaration des chemins runtime (`data/`, `uploads/`, `bot.db`).
- Feature flag technique: `SKIP_WHATSAPP_INIT` pour démarrer API sans session WhatsApp.

### 2) Etat applicatif en mémoire

- Etat WhatsApp (`whatsappReady`, `whatsappAuthenticated`, `latestQr`).
- Buffer de logs exposé via API.
- Mécanismes anti-duplication et lock par contact.
- Gestion du timer de réinitialisation WhatsApp.

### 3) Couche persistance SQLite

- Initialisation de la DB (`initDb`) et création des tables:
  - `settings`
  - `documents`
  - `chunks`
  - `conversation_messages`
  - `knowledge_assets`
- Fonctions utilitaires CRUD pour settings, conversations, documents et assets.

### 4) Ingestion et indexation de connaissances

- Ingestion URL unique, site (crawl limité), et fichier upload.
- Extraction de texte par type de contenu:
  - HTML: `cheerio`
  - PDF: `pdf-parse`
  - DOCX: `mammoth`
  - Images: OCR `tesseract.js`
- Nettoyage texte, découpe en chunks, insertion DB.

### 5) Retrieval et construction de contexte

- Recherche de contexte par score lexical simple (`retrieveContext`).
- Assemblage du contexte RAG injecté dans le prompt système.
- Récupération des ressources partageables liées aux documents.

### 6) Orchestration providers IA

- Routeur de provider (`generateChatCompletion`) selon réglage courant.
- Appels API unifiés pour providers compatibles OpenAI.
- Appel spécifique Gemini.
- Gestion des erreurs et fallback explicites.

### 7) API Express (contrat dashboard + opérations bot)

- Endpoints `/api/*` centralisés:
  - status/logs
  - QR/restart/disconnect WhatsApp
  - settings
  - ingestion/documents
  - conversations
  - sandbox chat
- Serves static UI (`public/index.html`) et middleware JSON.

### 8) Runtime WhatsApp et cycle de vie

- Construction client (`LocalAuth`) et listeners événementiels.
- Gestion QR/auth/ready/disconnect.
- Traitement message entrant:
  - filtre doublons
  - lock par contact
  - stockage message user
  - génération réponse IA + envoi en chunks
  - stockage message assistant
- Réinitialisation automatique en cas d'échec.

## Frontière logique proposée (avant refactor)

Pour limiter les regressions, conserver les responsabilités mais les déplacer en modules:

- `config/`: env, constantes, validation
- `infra/db/`: init + accès SQLite
- `infra/whatsapp/`: client et événements WhatsApp
- `domain/knowledge/`: ingestion, indexation, retrieval
- `domain/chat/`: orchestration prompt + providers
- `api/`: routes Express par domaine

## Parcours de lecture recommandé (onboarding développeur)

1. `README.md` pour comprendre le scope produit.
2. `index.js`: `start()` -> `initDb()` -> `startServer()` -> init WhatsApp.
3. Routes API `/api/settings`, `/api/ingest/*`, `/api/sandbox/chat`.
4. Traitement `client.on("message")`.
5. Fonctions `generateAssistantResponse` et `retrieveContext`.
