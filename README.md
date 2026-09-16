# Lean Six Sigma Toolbox legal and provider setup

Public legal documents and provider setup resources for the mobile and Windows
apps. You do not need collaborator access to read or download this repository.
Visitors cannot push changes to it; a fork or pull request is a separate copy
or proposed change, not permission to publish here.

## Provider setup

- [Supabase](provider_servers/supabase/README.md): app-supplied SQL + RLS;
  no separate gateway deployment.
- [Firebase](provider_servers/firebase/README.md): Cloud Function and rules.
- [MySQL](provider_servers/mysql/README.md): HTTPS gateway and private database.
- [Custom HTTPS](provider_servers/custom/README.md): implement the protocol.

Start with the [provider setup guide](https://nealw1993.github.io/lean-six-sigma-legal/provider-setup.html).

## Publish with GitHub Pages

1. Push these files to the repository's `main` branch.
2. Open **Settings > Pages** in GitHub.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the `main` branch and `/ (root)`, then save.
5. Wait for the Pages deployment to finish.

Expected public URLs:

- `https://nealw1993.github.io/lean-six-sigma-legal/`
- `https://nealw1993.github.io/lean-six-sigma-legal/privacy.html`
- `https://nealw1993.github.io/lean-six-sigma-legal/terms.html`

Use the Privacy Policy URL in Google Play Console. Supply both document URLs
to Flutter release builds:

```powershell
flutter build appbundle --release `
  --dart-define=REVENUECAT_ANDROID_API_KEY=goog_YOUR_PUBLIC_KEY `
  --dart-define=PRIVACY_POLICY_URL=https://nealw1993.github.io/lean-six-sigma-legal/privacy.html `
  --dart-define=TERMS_OF_USE_URL=https://nealw1993.github.io/lean-six-sigma-legal/terms.html
```

The source pages are templates based on the app's documented behavior. Review
them whenever the app, its SDKs, connected services, or publisher details
change. Legal review is recommended before production publication.
