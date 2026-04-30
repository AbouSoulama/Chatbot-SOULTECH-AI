# Plan de modularisation progressive et roadmap priorisée

Ce plan vise à réduire le risque de regression tout en permettant d'ajouter des fonctionnalités.

## Principes de migration

- Ne pas changer le comportement fonctionnel pendant l'extraction des modules.
- Extraire par domaine avec façade stable.
- Garder des commits petits et vérifiables (`npm run check` à chaque étape).

## Découpage progressif backend (sans rupture)

### Etape 1 - Extraire la configuration

- Créer `src/config/runtime.js`
- Déplacer lecture env, constantes et defaults.
- `index.js` consomme ce module sans changer les routes.

### Etape 2 - Extraire persistance SQLite

- Créer `src/infra/db/connection.js` + `src/infra/db/repositories/*.js`
- Migrer `initDb` et fonctions SQL utilitaires.
- Garder les signatures actuelles pour limiter l'impact.

### Etape 3 - Extraire providers IA

- Créer `src/domain/ai/providers/*.js` + routeur provider.
- Déplacer `generateChatCompletion`, appels OpenAI-compatible et Gemini.

### Etape 4 - Extraire connaissance/RAG

- Créer `src/domain/knowledge/ingestion.js`, `src/domain/knowledge/retrieval.js`
- Déplacer extraction texte, chunking, indexation, `retrieveContext`.

### Etape 5 - Extraire runtime WhatsApp

- Créer `src/infra/whatsapp/client.js`, `src/infra/whatsapp/handlers.js`
- Déplacer listeners QR/auth/ready/message/disconnect.

### Etape 6 - Extraire API Express par domaine

- Créer `src/api/routes/{status,settings,ingest,conversations,sandbox,whatsapp}.js`
- `index.js` devient bootstrap léger (DB + server + WhatsApp init).

## Découpage frontend progressif

### Etape 1
- Séparer CSS et JS de `public/index.html` vers `public/assets/`.

### Etape 2
- Découper JS en modules:
  - `api-client.js`
  - `state.js`
  - `views/{settings,ingestion,conversations,sandbox}.js`

### Etape 3
- Introduire un router UI simple (onglets) et une couche de rendering isolée.

## Roadmap priorisée (risque x valeur)

1. **Priorité P0 - Stabiliser la base technique**
   - Ajouter ESLint et CI minimal avec `npm run check`.
   - Sécuriser exposition API (au minimum token simple si déploiement distant).
2. **Priorité P1 - Réduire le couplage backend**
   - Extraire config + DB + providers IA.
3. **Priorité P2 - Fiabiliser l'expérience message**
   - Tests ciblés sur anti-doublons, lock par chat, envoi en chunks.
4. **Priorité P3 - Améliorer le dashboard**
   - Modularisation frontend et meilleure observabilité des erreurs.
5. **Priorité P4 - Evolutions produit**
   - Nouvelles fonctionnalités métier sur architecture plus stable.

## Définition de "done" par lot

- Aucun changement de contrat API existant sans note explicite.
- `npm run check` vert.
- Vérification manuelle de:
  - `GET /api/status`
  - ingestion URL simple
  - message WhatsApp de test (si session active)
