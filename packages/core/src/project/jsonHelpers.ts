import * as fs from 'node:fs';
import JSON5 from 'json5';

export function readJson5File<T>(filePath: string): T {
  return JSON5.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/**
 * Write strict JSON content (quoted keys) to a `.json5` file. Keeps the file
 * compatible with VS Code's JSON parser while remaining valid JSON5.
 */
export function writeJson5File(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
