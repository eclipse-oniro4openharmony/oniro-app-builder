import { Command, InvalidArgumentError } from 'commander';
import * as readline from 'node:readline';
import { HUAWEI_SITES, createHarmonyOsSession, type HarmonyOsSession } from '@oniroproject/core';
import { getRuntime } from '../lib/runtime.js';

/** A session bound to the CLI runtime. */
function session(): HarmonyOsSession {
  const { config, logger } = getRuntime();
  return createHarmonyOsSession({ config, logger });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError('expected a port number from 1 to 65535.');
  }
  return port;
}

/** Stderr text for a login that opens the browser here. The URL is repeated for headless hosts. */
function browserInstructions(url: string): string {
  return `Opening the Huawei sign-in page. If no browser opens, visit:\n  ${url}\n`;
}

/** Stderr text for a login whose browser may be on another machine. */
function manualInstructions(url: string, callbackUrl: string, port: number): string {
  return [
    'Open this address in a browser, on this machine or any other, and sign in:',
    `  ${url}`,
    `The browser is then sent to ${callbackUrl}?... If that page does not load (the browser is not on`,
    'this machine), copy the whole address from its address bar, paste it here and press Enter.',
    `(Or forward the port first, from the machine with the browser: ssh -L ${port}:127.0.0.1:${port} <this-host>.)`,
    '',
  ].join('\n');
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
    .description(
      'Sign in through the browser, which redirects back to a loopback port on this machine. ' +
        'With the browser on another machine, either pass --manual and paste the address the browser ' +
        'ends up on, or fix the port with --port and forward it with `ssh -L <port>:127.0.0.1:<port>`.',
    )
    .option('--timeout <seconds>', 'How long to wait for the browser sign-in. Default 600.', (v) => Number(v))
    .option(
      '--port <n>',
      'Loopback port the sign-in page redirects to, instead of a random one, so an ssh tunnel can be set up ' +
        'beforehand: `ssh -L <n>:127.0.0.1:<n> <this-host>` from the machine with the browser (same port both ends).',
      parsePort,
    )
    .option(
      '--no-browser',
      'Do not open a browser. Print the sign-in URL, then finish the sign-in from the callback address ' +
        '(`http://127.0.0.1:<port>/callback?...`, or just its query) pasted on stdin, or from the loopback ' +
        'port itself, whichever comes first.',
    )
    .option('--manual', 'Same as --no-browser.')
    .option('--print-url', 'Also write the sign-in URL to stdout, alone on its line, before waiting.')
    .option(
      '--json',
      'Write JSON lines to stdout: {"loginUrl","port","callbackUrl"} before waiting, then the account ' +
        '({"userId","userName","site","tokenPath"}) once signed in.',
    )
    .action(
      async (opts: {
        timeout?: number;
        port?: number;
        browser: boolean;
        manual?: boolean;
        printUrl?: boolean;
        json?: boolean;
      }) => {
        const { config, logger } = getRuntime();
        const manual = opts.manual || !opts.browser;
        const s = createHarmonyOsSession({
          config,
          logger,
          onLoginUrl: (url, { port }) => {
            const callbackUrl = `http://127.0.0.1:${port}/callback`;
            if (opts.json) process.stdout.write(`${JSON.stringify({ loginUrl: url, port, callbackUrl })}\n`);
            else if (opts.printUrl) process.stdout.write(`${url}\n`);
            process.stderr.write(manual ? manualInstructions(url, callbackUrl, port) : browserInstructions(url));
          },
        });
        // Read pasted callbacks only when asked: a plain login must not hold stdin.
        const stdin = manual ? readline.createInterface({ input: process.stdin, terminal: false }) : undefined;
        let user;
        try {
          user = await s.login({
            timeoutMs: opts.timeout ? Math.max(1, opts.timeout) * 1000 : undefined,
            port: opts.port,
            openBrowser: !manual,
            pastedCallbacks: stdin,
          });
        } finally {
          stdin?.close();
          // A pending read keeps a TTY or pipe open, and with it the process.
          if (stdin) process.stdin.destroy();
        }
        if (opts.json) {
          const status = { userId: user.userId, userName: user.userName, site: user.siteCode, tokenPath: s.tokenPath };
          process.stdout.write(`${JSON.stringify(status)}\n`);
          return;
        }
        process.stdout.write(`${user.userName || user.userId}\n`);
      },
    );

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
