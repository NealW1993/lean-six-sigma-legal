# Six Sigma Legal Pages

Public Privacy Policy and Terms of Use for the Six Sigma mobile app.

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
