# Firebase sync provider

This HTTPS Cloud Function implements Lean Six Sigma Sync Protocol v1. App
clients authenticate through Firebase Anonymous Authentication; all Firestore
and Storage access is denied to client SDKs and mediated by the function.

## Deploy

1. Create/select a Firebase project and enable **Authentication > Sign-in
   method > Anonymous**.
2. Create Firestore and Cloud Storage in the Firebase console.
3. Install Node.js 22 and Firebase CLI, then run `firebase login`.
4. Copy `.firebaserc.example` to `.firebaserc` and replace the project id.
5. From `functions`, run `npm install` and `npm run check`.
6. Use the Firebase **Web API key** from Project settings > General for
   `SIX_SIGMA_CLIENT_KEY`. Generate a separate random value of at least 32 bytes
   for `SIX_SIGMA_SETUP_TOKEN`. Enter each value at its CLI prompt, then deploy
   from the `firebase` kit directory (not its `functions` directory):

```powershell
firebase functions:secrets:set SIX_SIGMA_CLIENT_KEY
firebase functions:secrets:set SIX_SIGMA_SETUP_TOKEN
firebase deploy --only functions,firestore:rules,storage
```

7. In the app choose **Firebase**. Paste the deployed `sixSigmaApi` URL as the
   endpoint, the Firebase Web API key from Project settings > General as the
   API key, and `SIX_SIGMA_SETUP_TOKEN` only during owner initialization.

Set `SIX_SIGMA_CLIENT_KEY` to the same Firebase Web API key entered in the app.
That key identifies the client but is not authorization; the verified Firebase
ID token and server-side membership checks authorize every data operation.

Attachment links are object- and method-scoped bearer URLs that expire after
five minutes. Treat a copied link as sensitive until it expires. Revoking a
device blocks it from obtaining another URL but cannot cancel a URL that was
already issued by Cloud Storage.

Never put a service-account JSON file, private key, or Admin SDK credential in
the Flutter build. Cloud Functions obtains its service identity from Firebase.

## Before pairing devices

1. In Settings > Connections, configure and test the Personal Connection.
2. Initialize the owner with the setup token. The public Web API key alone
   must never authorize data access.
3. Create the encrypted invitation only after the connection test succeeds.
4. Redeem on a second test device, verify that a saved record synchronizes,
   then revoke that test device and verify that further access is denied.

For an existing deployment, back up Firestore and Storage before upgrading.
Deploy the function and both rule sets together, then repeat these checks in
staging. `npm run check` checks types; it does not prove deployed authorization.
