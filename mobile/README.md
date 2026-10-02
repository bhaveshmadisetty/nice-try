# Nice Try Tasks

Standalone React web app. No ChatGPT login, Sites runtime, or server-side renderer is needed.

From this directory:
- npm ci
- npm run dev
- npm run build

The dist directory is the entire deployable site. Firebase Hosting is configured in firebase.json. After authenticating Firebase CLI, deploy with firebase deploy --only hosting --project YOUR_PROJECT_ID.

Google task sync still needs public Firebase configuration in lib/sync-config.json, Authentication with Google enabled, and deployed owner-only Firestore rules. Run ../scripts/prepare-mobile.cjs after updating the extension configuration. Existing local tasks stay on their original website origin until transferred or synced; deploying on a new domain does not move browser storage.

Previous hosting configuration is preserved in ../previous-hosting. The old .openai metadata is unused by the standalone build.
