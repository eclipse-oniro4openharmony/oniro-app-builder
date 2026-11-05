import type { Command } from 'commander';
import { formatHapVerification, verifyHap, verifyHapExitCode } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** `app verify <hap>`: what signed a HAP, and whether a device will accept it. */
export function registerAppVerifyCommand(app: Command): void {
  app
    .command('verify <hap>')
    .description(
      "Verify a HAP's signature with the SDK's hap-sign-tool (`verify-app`), then report what signed it: the " +
        'certificate chain and its root, whether it is OpenHarmony development material or a HarmonyOS ' +
        'certificate from AppGallery Connect (root Huawei CBG Root CA G2), and the provisioning profile: type, ' +
        'bundle name, apl, app-feature, devices, validity and days left. Exits 0 when valid, 1 when unsigned, ' +
        'invalid, expired or mismatched, 2 when it could not verify (no java or hap-sign-tool.jar). Needs java.',
    )
    .option('--json', 'Emit the result as JSON.')
    .action(async (hap: string, opts: { json?: boolean }) => {
      const { config, logger } = getRuntime();
      const result = await verifyHap({ hapPath: hap, config, logger });
      process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatHapVerification(result));
      process.exitCode = verifyHapExitCode(result);
    });
}
