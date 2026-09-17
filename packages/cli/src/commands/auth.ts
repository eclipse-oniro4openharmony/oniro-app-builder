import { Command } from 'commander';
import { HUAWEI_SITES, createHarmonyOsSession, type HarmonyOsSession } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** A session bound to the CLI runtime. The sign-in URL goes to stderr for headless hosts. */
function session(): HarmonyOsSession {
  const { config, logger } = getRuntime();
  return createHarmonyOsSession({
    config,
    logger,
    onLoginUrl: (url) => process.stderr.write(`Opening the Huawei sign-in page. If no browser opens, visit:\n  ${url}\n`),
  });
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command('auth')
    .description(
      'Sign in to a Huawei developer account, which HarmonyOS signing (`oniro-app sign --harmonyos`) needs. ' +
        'OpenHarmony signing needs no account. The token is stored encrypted under ONIRO_HARMONYOS_AUTH_DIR ' +
        '(default ~/.oniro/harmonyos).',
    );

  auth
    .command('login')
    .description('Sign in through the browser, which redirects back to a loopback port on this machine.')
    .option('--timeout <seconds>', 'How long to wait for the browser sign-in. Default 600.', (v) => Number(v))
    .action(async (opts: { timeout?: number }) => {
      const user = await session().login(opts.timeout ? { timeoutMs: Math.max(1, opts.timeout) * 1000 } : undefined);
      process.stdout.write(`${user.userName || user.userId}\n`);
    });

  auth
    .command('logout')
    .description('Sign out and delete the stored token.')
    .action(async () => {
      const signedOut = await session().logout();
      getRuntime().logger.info(signedOut ? 'Signed out.' : 'Not signed in; nothing to do.');
    });

  auth
    .command('status')
    .description('Show the signed-in account. Exits non-zero when not signed in.')
    .option('--json', 'Emit the account details as JSON.')
    .action(async (opts: { json?: boolean }) => {
      const s = session();
      // Refreshed: a stale access token makes the agreement check fail.
      const user = await s.getUserInfo({ refresh: true });
      if (!user) {
        process.stderr.write('Not signed in. Run `oniro-app auth login`.\n');
        process.exitCode = 1;
        return;
      }
      // Without real-name verification, the developer agreement is what allows signing.
      const agreement = user.isRealName ? null : await s.getDeveloperAgreement(user);
      if (opts.json) {
        const { userId, userName, countryCode, siteCode, isRealName } = user;
        const agcBaseUrl = HUAWEI_SITES[siteCode].agcBaseUrl;
        const status = { userId, userName, countryCode, site: siteCode, agcBaseUrl, isRealName, developerAgreement: agreement, tokenPath: s.tokenPath };
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${user.userName || user.userId} (${user.userId}) [${user.siteCode}]\n`);
      if (agreement && !(agreement.signed && agreement.latest)) {
        process.stderr.write(
          '[warn] This account has neither real-name verification nor the current HUAWEI Developer Basic Service Agreement accepted, so AppGallery Connect will not issue signing material. Accept the agreement in AppGallery Connect or DevEco Studio.\n',
        );
      }
    });

  auth
    .command('team')
    .description('AGC teams this account belongs to.')
    .command('list')
    .description('List the AGC teams this account belongs to, for `oniro-app sign --harmonyos --team-id <id>`.')
    .option('--json', 'Emit the team list as JSON.')
    .action(async (opts: { json?: boolean }) => {
      const teams = await session().listTeams();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(teams, null, 2)}\n`);
        return;
      }
      for (const t of teams) process.stdout.write(`${t.id}\t${t.name}\n`);
    });
}
