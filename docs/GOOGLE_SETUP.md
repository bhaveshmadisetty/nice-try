Folder layout: run development commands from NOT_FOR_CHROME (wherever you move it). References to config/sync-config.js refer to the Chrome extension root recorded in extension-root.cjs.

# Google task sync: one-time owner setup

Google sign-in and task sync are implemented but disabled until the app owner fills in Firebase configuration. The developer does this once; users then just sign in with Google. Gemini is independent and unchanged.

## Use phone tasks now

Reload Nice Try, open Settings → Tasks on your phone → **Export tasks**. On your phone, open the companion app, expand **Your account**, and **Import tasks** from that file. This transfer is not automatic sync. Import adds new task IDs and skips existing IDs. Export contains tasks and attached links, never AI keys or browsing logs.

## Firebase

1. Create **Nice Try** in the [Firebase console](https://console.firebase.google.com/). Analytics is unnecessary.
2. Register a **Web app** and copy its public configuration.
3. Enable **Authentication → Google** and choose the support email.
4. Create a **Cloud Firestore** Standard/default database in **production mode**. Choose the region deliberately.
5. Fill `firebase` in `config/sync-config.js`: `apiKey`, `authDomain`, `projectId`, `appId`.
6. Deploy `firebase/firestore.rules` in the console Rules editor, or run `firebase deploy --only firestore:rules --project YOUR_PROJECT_ID` using Firebase CLI.

Rules allow only the owner to access `/users/{their UID}/tasks/*`. Deletion uses a retained record so an offline device cannot resurrect a task.

## Extension OAuth

1. Find Nice Try's extension ID at `chrome://extensions`. Keep it stable for releases.
2. Configure the same Google Cloud project's OAuth consent screen. Add your account as a test user if it is in testing mode.
3. Use the **Web application** OAuth client associated with Firebase's Google provider. Add the exact authorized redirect URI `https://YOUR_EXTENSION_ID.chromiumapp.org/`.
4. Copy its **public client ID** to `googleClientId` in `config/sync-config.js`. Never copy its client secret.
5. Add `YOUR_EXTENSION_ID.chromiumapp.org` to Firebase Authentication's authorized domains, alongside the Firebase Hosting domain that serves the phone app (`nice-try-3174b.web.app`). Keep the default Firebase auth domain; add `localhost` for development.

### The extension ID changes when the Web Store publishes

An unpacked folder and a Web Store release get **different** extension IDs, because the
ID is derived from the signing key. `chrome.identity.getRedirectURL()` embeds that ID, so
a redirect URI registered for the unpacked build is not the URI the published build sends,
and Google refuses the sign-in. Guest mode and the blocker are unaffected; only sign-in is.

Pick one before publishing:

- **Register the published URI after upload.** Upload a draft, read the assigned ID from
  the dashboard (or from *Backup & account* on the extension's account page, which prints
  this install's redirect URI), then add that URI to the OAuth client and its host to
  Firebase authorized domains. Both the unpacked and published URIs can be registered at
  once, so development keeps working.
- **Pin the ID.** Add the public key from the uploaded package as a `key` field in
  `manifest.json` so the unpacked build adopts the published ID and one URI covers both.

A sign-in refused for this reason reports the exact URI to register — see `redirectHelp`
in `src/task-sync.js`.

The extension checks OAuth state and nonce and asks Firebase to verify the Google ID token. Session credentials stay local. References: [Firebase web setup](https://firebase.google.com/docs/web/setup), [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin), [Chrome identity](https://developer.chrome.com/docs/extensions/reference/api/identity), [Firebase REST auth](https://firebase.google.com/docs/reference/rest/auth).

## Apply configuration

Run `node scripts/prepare-mobile.cjs` from the repository root. It copies the shared protocol and public Firebase fields into the phone app. Rebuild and republish `mobile/`, then reload the extension. The phone URL is in `config/sync-config.js`.

In extension Settings, choose whether to **Upload my local tasks when I connect**, then **Sign in with Google**. On the phone, sign in with the same account. The phone has its own upload checkbox. Unchecked means use the account list without uploading guest tasks.

The Firebase web config is public application configuration. Gemini keys, OAuth client secrets, service-account JSON and Google passwords must never go in these files.

## Sync behavior and limits

- Sync runs after edits and every five minutes in the extension. On the phone, it also runs on reconnect/reopening and every two minutes while visible. **Sync now** makes an immediate request.
- Offline tasks remain local. Each project/account has a separate copy. Disconnect restores the guest list and retains account tasks for the next sign-in.
- The original extension task list is backed up at `taskMigrationBackup` before assigning stable IDs.
- Independent tasks merge. A stale editor on one device changes only its edited fields. Competing offline edits to the same task use the latest record timestamp, with a change-ID tie breaker. Device clocks should be accurate.
- Deletion always wins for the same task ID. Recreating a task gives it a new ID. Deletion records are retained.
- Task details and links sync; API keys, browsing logs, stats and mission do not.
- Each sync reads the task collection. Large lists may need incremental queries before scaling. Firestore quotas/pricing apply; billing is not enabled automatically.

## Validation

Run `node --test --test-isolation=none test/*.test.js`; in `mobile/`, run `npm run build`.

Automated tests cover migration, concurrent writers, stale edits, deletion convergence, account changes during sync, request isolation and conditional cloud writes. Live Google OAuth and deployed Firestore rules still require testing after configuration. Test two devices: add/edit/complete/delete; offline reconnect; expired sessions; disconnect during sync; switch accounts; upload checked and unchecked; verify another user's task path is denied and the classifier sees synced tasks.
