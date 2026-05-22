import { Command } from 'commander';
import { listTemplates } from '@oniroproject/core';
import { getBundledTemplateRoot } from '../lib/templateRoot.js';

export function registerTemplatesCommand(program: Command): void {
  const templates = program.command('templates').description('Inspect the templates bundled with this CLI.');

  templates
    .command('list')
    .description('List available project templates.')
    .option('--json', 'Emit machine-readable JSON.')
    .action((opts: { json?: boolean }) => {
      const root = getBundledTemplateRoot();
      const list = listTemplates(root);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
        return;
      }
      if (list.length === 0) {
        process.stdout.write('No templates available.\n');
        return;
      }
      const rows = list.map((t) => `${t.id.padEnd(20)} ${t.label.padEnd(24)} ${t.description}`);
      process.stdout.write(`${rows.join('\n')}\n`);
    });
}
