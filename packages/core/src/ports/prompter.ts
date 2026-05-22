/**
 * Interactive prompts. Frontends implement these — CLI uses @inquirer/prompts,
 * the extension uses `vscode.window.show*`. Core never assumes a TTY.
 */
export interface Prompter {
  /** Ask the user to confirm an action. */
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  /** Ask the user for a single line of text. */
  input(message: string, defaultValue?: string): Promise<string>;
  /** Ask the user to pick a directory on disk; resolves to an absolute path or null if cancelled. */
  selectDirectory(message: string, defaultPath?: string): Promise<string | null>;
  /** Ask the user to pick a file on disk; resolves to an absolute path or null if cancelled. */
  selectFile(message: string, filters?: { extensions?: string[] }): Promise<string | null>;
}

/**
 * Throws on any prompt — used in non-interactive contexts where all answers must come from flags.
 */
export const nonInteractivePrompter: Prompter = {
  async confirm(message) {
    throw new Error(`Non-interactive mode: cannot confirm "${message}"`);
  },
  async input(message) {
    throw new Error(`Non-interactive mode: cannot ask "${message}"`);
  },
  async selectDirectory(message) {
    throw new Error(`Non-interactive mode: cannot prompt for directory "${message}"`);
  },
  async selectFile(message) {
    throw new Error(`Non-interactive mode: cannot prompt for file "${message}"`);
  },
};
