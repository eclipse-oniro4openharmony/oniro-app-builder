---
"@oniroproject/core": minor
---

Add signing bootstrap and signing option overrides.

- **`project/prepareSigning.ts`**: `prepareSigning()` is a no-op when `signatures/` + signingConfigs already exist (**present**), otherwise generates them via `generateSigningConfigs` (**fresh**). Avoids re-running the full generate flow when signing material is already in place.
- **`generateSigningConfigs`**: new optional `passwords` (`{ store, key }`, default `'123456'` — the SDK keystore's password; override only with a matching custom keystore) and `applicationCertPath` (override the bundled `OpenHarmonyApplication.cer` for application-release signing). Defaults preserve current behavior exactly.
