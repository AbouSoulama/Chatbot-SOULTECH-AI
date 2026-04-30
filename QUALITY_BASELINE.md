# Baseline qualité avant nouvelles features

Objectif: installer un minimum de sécurité de développement sans refactor massif.

## Garde-fous implémentés

- Script syntaxe backend: `npm run lint`
  - Commande: `node --check index.js`
- Smoke test de démarrage API: `npm run smoke:start`
  - Lance l'app avec `SKIP_WHATSAPP_INIT=1`
  - Vérifie `GET /api/status`
- Pipeline local rapide: `npm run check`
  - Exécute `lint` puis `smoke:start`

## Pourquoi ce socle est utile

- Détecte immédiatement les erreurs de syntaxe sur le backend monolithique.
- Vérifie que le serveur démarre et expose son endpoint de santé.
- Permet un contrôle reproductible sans dépendre d'un scan QR WhatsApp.

## Procédure recommandée avant chaque merge

1. `npm run check`
2. Test manuel dashboard:
   - ouvrir `http://localhost:3000`
   - vérifier chargement des paramètres
3. Test manuel fonctionnel (si WhatsApp branché):
   - envoyer un message test
   - vérifier réponse + historique conversation

## Améliorations qualité à enchaîner (prochain incrément)

- Ajouter ESLint + règles de base (imports, erreurs courantes, style cohérent).
- Ajouter test unitaire ciblé pour:
  - découpe en phrases/chunks
  - récupération contexte (`retrieveContext`) sur dataset fixture.
- Ajouter workflow CI minimal:
  - install
  - `npm run check`
