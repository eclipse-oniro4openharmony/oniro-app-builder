import * as readline from 'node:readline';
import type { Logger } from '@oniroproject/core';
import { applyDefaults, validateArgs, type JsonSchema } from './schema.js';

/**
 * A Model Context Protocol server over newline-delimited JSON-RPC 2.0 on
 * stdio: `initialize` (with protocol version negotiation),
 * `notifications/initialized`, `ping`, `tools/list` and `tools/call`. That is
 * the whole surface a tools-only server needs, so it is written here instead
 * of pulling in the SDK and its dependency tree.
 */

/** Newest first; the first is offered when the client asks for one we do not speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** `structuredContent` in tool results exists from this protocol version on. */
const STRUCTURED_CONTENT_SINCE = '2025-06-18';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool<Ctx> {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema & { type: 'object' };
  annotations?: ToolAnnotations;
  /** The tool installs, launches or drives the UI on the device; `--read-only` drops it. */
  changesDevice: boolean;
  /** `args` has been validated against `inputSchema` and its defaults filled in. */
  call(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult>;
}

export interface McpServerOptions<Ctx> {
  name: string;
  version: string;
  tools: McpTool<Ctx>[];
  context: Ctx;
  instructions?: string;
  logger: Logger;
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A tool result carrying one error message, for a tool that threw or got bad arguments. */
export function errorResult(message: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    ...(structured ? { structuredContent: structured } : {}),
    isError: true,
  };
}

export class McpServer<Ctx> {
  private readonly tools = new Map<string, McpTool<Ctx>>();
  private protocolVersion: string | undefined;

  constructor(private readonly opts: McpServerOptions<Ctx>) {
    for (const t of opts.tools) this.tools.set(t.name, t);
  }

  /** The version agreed in `initialize`, or undefined before it. */
  get negotiatedVersion(): string | undefined {
    return this.protocolVersion;
  }

  /**
   * Handle one parsed JSON-RPC message (or a batch, which the 2025-03-26
   * revision allows). Returns the response to send, or undefined for a
   * notification.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(message)) {
      if (message.length === 0) return rpcError(null, RPC_INVALID_REQUEST, 'Empty batch.');
      const out = (await Promise.all(message.map((m) => this.handleOne(m)))).filter(
        (r): r is JsonRpcResponse => r !== undefined,
      );
      return out.length ? out : undefined;
    }
    return this.handleOne(message);
  }

  private async handleOne(msg: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(msg) || msg.jsonrpc !== '2.0') {
      return rpcError(isObject(msg) && isId(msg.id) ? msg.id : null, RPC_INVALID_REQUEST, 'Not a JSON-RPC 2.0 message.');
    }
    const hasId = 'id' in msg;
    if (typeof msg.method !== 'string') {
      // A response to a request we never send (we make none), or garbage.
      if (hasId && ('result' in msg || 'error' in msg)) return undefined;
      return rpcError(isId(msg.id) ? msg.id : null, RPC_INVALID_REQUEST, 'Missing method.');
    }
    if (!hasId) {
      this.onNotification(msg.method);
      return undefined;
    }
    if (!isId(msg.id) || msg.id === null) return rpcError(null, RPC_INVALID_REQUEST, 'The id must be a string or a number.');
    const id = msg.id;
    const params = msg.params === undefined ? {} : msg.params;
    if (!isObject(params)) return rpcError(id, RPC_INVALID_PARAMS, 'params must be an object.');
    try {
      return await this.dispatch(id, msg.method, params);
    } catch (err) {
      this.opts.logger.error(`mcp: ${msg.method} failed: ${(err as Error).stack ?? String(err)}`);
      return rpcError(id, RPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    }
  }

  private onNotification(method: string): void {
    if (method === 'notifications/initialized') this.opts.logger.debug('mcp: client initialized');
    // notifications/cancelled and others: nothing to do; a cancelled call's result is simply ignored by the client.
  }

  private async dispatch(id: string | number, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok(this.initialize(params));
    if (method === 'ping') return ok({});
    if (this.protocolVersion === undefined) {
      return rpcError(id, RPC_INVALID_REQUEST, `Received ${method} before initialize.`);
    }
    if (method === 'tools/list') {
      return ok({
        tools: [...this.tools.values()].map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });
    }
    if (method === 'tools/call') {
      const name = params.name;
      if (typeof name !== 'string') return rpcError(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name.');
      const tool = this.tools.get(name);
      if (!tool) return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}. Tools: ${[...this.tools.keys()].join(', ')}.`);
      return ok(this.shape(await this.callTool(tool, params.arguments)));
    }
    return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const version =
      asked && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
    this.protocolVersion = version;
    const client = isObject(params.clientInfo) ? `${params.clientInfo.name ?? '?'} ${params.clientInfo.version ?? ''}` : 'client';
    this.opts.logger.info(`mcp: ${client.trim()} connected (protocol ${version}, asked ${asked ?? 'none'})`);
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.opts.name, version: this.opts.version },
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
    };
  }

  /** Validate, fill defaults, run. A tool that throws or gets bad arguments yields an `isError` result, not an RPC error. */
  private async callTool(tool: McpTool<Ctx>, rawArgs: unknown): Promise<ToolResult> {
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (!isObject(args)) return errorResult(`Invalid arguments for ${tool.name}: arguments must be an object.`);
    const problems = validateArgs(tool.inputSchema, args);
    if (problems.length) return errorResult(`Invalid arguments for ${tool.name}: ${problems.join('; ')}.`);
    const started = Date.now();
    this.opts.logger.info(`mcp: ${tool.name} ${JSON.stringify(args)}`);
    try {
      const result = await tool.call(applyDefaults(tool.inputSchema, args), this.opts.context);
      this.opts.logger.info(`mcp: ${tool.name} ${result.isError ? 'failed' : 'done'} in ${Date.now() - started} ms`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.info(`mcp: ${tool.name} threw in ${Date.now() - started} ms: ${message}`);
      if (process.env.ONIRO_DEBUG === '1' && err instanceof Error && err.stack) this.opts.logger.debug(err.stack);
      return errorResult(message, { error: message });
    }
  }

  /** Clients before 2025-06-18 know no `structuredContent`; the text block carries the same JSON. */
  private shape(result: ToolResult): ToolResult {
    if (result.structuredContent && (this.protocolVersion ?? '') < STRUCTURED_CONTENT_SINCE) {
      const { structuredContent: _dropped, ...rest } = result;
      return rest;
    }
    return result;
  }
}

function isId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || typeof v === 'number' || v === null;
}

export interface StdioOptions {
  input?: NodeJS.ReadableStream;
  /** Where protocol messages go; default the real stdout. */
  write?: (line: string) => void;
}

/**
 * Serve `server` on newline-delimited JSON over stdin/stdout until stdin
 * closes and every call in flight has answered. Requests run concurrently;
 * responses go out as they finish.
 */
export async function serveStdio<Ctx>(server: McpServer<Ctx>, opts: StdioOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const write = opts.write ?? ((line: string) => void process.stdout.write(line));
  const send = (msg: unknown): void => write(`${JSON.stringify(msg)}\n`);
  const pending = new Set<Promise<void>>();
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      send(rpcError(null, RPC_PARSE_ERROR, 'Parse error: each line must be one JSON-RPC message.'));
      continue;
    }
    const p: Promise<void> = server.handle(message).then(
      (response) => {
        if (response !== undefined) send(response);
      },
      () => {},
    );
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
