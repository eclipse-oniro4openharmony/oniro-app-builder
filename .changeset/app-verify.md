---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- New `app verify <hap> [--json]` (#24): runs the SDK's `hap-sign-tool verify-app`, then reports whether the
  signature is valid, the certificate chain (leaf first) and its root, whether the HAP carries OpenHarmony
  development material or a HarmonyOS certificate from AppGallery Connect (`Huawei CBG Root CA G2`), and the
  profile's type, bundle name, apl, app-feature, device count, validity and days left. A HAP is invalid when it is
  unsigned, its signature is rejected, a certificate or AGC profile has expired, the profile names another
  certificate or bundle, or a HarmonyOS HAP carries OpenHarmony development material. Exits 0 valid, 1 invalid,
  2 could not verify (no java or hap-sign-tool.jar).
- `sign --harmonyos` names the profile's type and expiry (#24):
  `Signing configs ready for … (profile names 6 device(s), debug, valid until 2026-10-01 11:50 UTC)`. The
  OpenHarmony `sign` and `sign --hap` name the profile type, apl and certificate expiry.
- Core exports `verifyHap`, `verifyHapExitCode`, `formatHapVerification`, `findHapSignTool`,
  `parseProvisionProfile`, `describeProfileValidity`, `formatUtc` and `describeSigningMaterial`;
  `readProvisionProfile` also returns the type, issuer, apl, app-feature, `notBefore` and the distribution
  certificate; `generateSigningConfigs` returns a summary of the material instead of nothing;
  `harmonyOsAutoSign`/`harmonyOsSignHap` return `profileType` and `notAfter`, and `signOpenHarmonyHap` `material`.
