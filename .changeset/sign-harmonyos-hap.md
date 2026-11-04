---
'@oniroproject/oniro-app': minor
'@oniroproject/core': minor
---

Features:

- `sign --hap <file>` signs a prebuilt HAP with no project, with the SDK's development certificate and a profile for
  the bundle name in the HAP's `module.json`. `--apl`, `--app-feature`, `--acls` and `--app-privilege-capabilities`
  apply as for a project. It uses the SDK that the HAP's `targetAPIVersion` names, else the newest installed, and
  refuses a HAP built for HarmonyOS.
- `sign --harmonyos --hap <file>` does the same for HarmonyOS, with a certificate and debug profile from AppGallery
  Connect. The ACL permissions are read from the HAP too, and a HAP built for OpenHarmony is refused. The material is
  kept per bundle name and reused while it is still valid.
- Either way, a HAP that is already signed has its signature replaced. The signed copy is written next to the input
  (`<name>-unsigned.hap` → `<name>-signed.hap`, `<name>-signed.hap` → `<name>-resigned.hap`), or to `--out <file>`,
  which may be the input itself. A flag of the other signing mode is refused instead of being ignored.
- Core exports `signOpenHarmonyHap`, `harmonyOsSignHap`, `readHapSigningInfo` and `defaultSignedHapPath`.

Fixes:

- `app apply <file.hap>` reads the bundle name out of a signed HAP, instead of failing with `Could not read the bundle
  name` and asking for `--bundle`, and its asset diff works on signed HAPs. node-stream-zip could not open any HAP signed by hap-sign-tool (`Entries read error`): its read window never
  grows past a default sized to about a thousandth of the file, too small for the ~4 KB of alignment hap-sign-tool
  pads each central-directory record with.
