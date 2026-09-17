# Third-party attribution — HarmonyOS support

Parts of this directory are **adapted from
[`openharmony-sig/deveco-cli`](https://gitcode.com/openharmony-sig/deveco-cli)**,
Copyright (c) 2026 Huawei Device Co., Ltd., licensed under the **MIT License**.

The rest of `@oniroproject/core` is Apache-2.0. MIT is compatible with Apache-2.0,
so the combined work ships under Apache-2.0 with this notice preserved; the MIT
copyright and permission notice is reproduced in full at the bottom of this file
and in the repository-root `NOTICE`.

## Why this code was adapted rather than written from scratch

HarmonyOS apps cannot be signed offline. Unlike OpenHarmony — where the SDK ships
a development certificate and `oniro-app sign` works with no account at all — a
HarmonyOS app needs a certificate and a provisioning profile issued by AppGallery
Connect against a Huawei developer account.

The APIs that issue them (`connect-api.cloud.huawei.com/api/cps/...`) and the
browser login flow that authenticates to them are **private and undocumented**.
The `deveco-cli` project is Huawei's own MIT-licensed client for those APIs, so
adapting it is both the accurate reference and the one that can be diffed against
upstream when the endpoints change.

## Which files are adapted

Each file carries a header naming the upstream file it came from. In summary:

| This package | Upstream |
| --- | --- |
| `http.ts` | `src/utils/http-client.ts` |
| `auth/types.ts` | `src/auth/types/auth-types.ts` |
| `auth/endpoints.ts` | `src/auth/auth-config.ts` |
| `auth/tokenStore.ts` | `src/auth/utils/local-crypto.ts`, `src/auth/utils/token-storage.ts` |
| `auth/callbackServer.ts` | `src/auth/login/local-auth-server.ts` |
| `auth/browser.ts` | `src/auth/login/browser.ts` |
| `auth/session.ts` | `src/auth/login/login-service.ts`, `src/auth/utils/token-checker.ts`, `src/auth/login/user-info-fetcher.ts`, `src/auth/team/team-service.ts` |
| `signing/errors.ts` | `src/config/signature.ts`, `src/signature/cert-api.ts`, `src/signature/device-manager.ts`, `src/signature/generate-profile.ts` |
| `signing/agc.ts` | `src/signature/cert-api.ts`, `src/signature/device-manager.ts`, `src/signature/generate-profile.ts`, `src/signature/download.ts` |
| `signing/devices.ts` | `src/signature/device-manager.ts` |
| `signing/paths.ts`, `signing/keystore.ts` | `src/signature/signature-tool.ts` |
| `signing/profile.ts` | `src/signature/generate-profile.ts` |
| `signing/autoSign.ts` | `src/commands/signature.ts`, `src/signature/generate-certificate.ts`, `src/signature/re-generate-sign.ts` |
| `signing/aclPermissionList.ts` | `src/resources/aclPermission/aclPermissionsInfo.json` (data) |

Not adapted — written for this package: `target.ts`, `sdk.ts`, `java.ts`,
`signing/project.ts`.

Password encryption for `build-profile.json5` reuses this package's existing
`sign/encryptKey.ts` rather than upstream's `src/signature/key-manager.ts`: the
two are independent implementations of the same DevEco Studio on-disk format.

## Notable deviations from upstream

- Singletons are replaced by explicit factories taking a `ConfigProvider` and
  `Logger`, so core stays frontend-agnostic and testable.
- `axios` + `proxy-from-env` are replaced by `undici`'s `fetch` and
  `EnvHttpProxyAgent`, which honours `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.
- The stored token is encrypted directly with a key kept outside the auth
  directory, with no separately wrapped data key: every key lives on the same
  disk, so a second layer would protect nothing the first does not.
- Device enumeration reuses this package's `hdc` layer instead of shelling out
  through `execa`.
- Telemetry is not ported. oniro-app does not report usage.
- Error messages are reworded to name `oniro-app` commands.
- **Every region is supported.** Upstream hardcodes the Chinese-mainland hosts and
  throws `Non-China accounts are not supported.` on any other `siteId`. This port
  resolves the region from the login callback and sends every call to that
  region's hosts. The host table and the `siteId` → `site` mapping (note `7` →
  `DE`) come from DevEco Studio — its login plugin and the answers of Huawei's
  Global Routing Service — not from upstream; see the comment on `HUAWEI_SITES`.
- **The AGC certificate has its own name**, `oniro_debug_<teamId>.cer` instead of
  upstream's `auto_debug_<teamId>.cer`. Upstream shares DevEco Studio's name, and
  regenerating deletes the certificate by name, so using both tools on one team
  would keep revoking each other's signing material.
- **Signing material is verified with Node's X.509 parser.** node-forge, which
  reads the PKCS#12 keystore, parses only RSA certificates, while hap-sign-tool
  generates ECC keys.
- **Real-name verification is not required.** Following DevEco Studio, an account
  without it may sign once it has accepted the HUAWEI Developer Basic Service
  Agreement (checked via `authrouter/unrealname/agreement`). Studio accepts the
  agreement from a dialog; this port never accepts it on the user's behalf, and
  only reports how to.

## MIT License

```
MIT License

Copyright (c) 2026 Huawei Device Co., Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
