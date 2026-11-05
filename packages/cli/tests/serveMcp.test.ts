import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const core = vi.hoisted(() => ({
  dumpLayout: vi.fn(),
  takeScreenshot: vi.fn(),
  listDevices: vi.fn(),
  checkArkts: vi.fn(),
  buildWithDiagnostics: vi.fn(),
  launchApp: vi.fn(),
  smokeCheck: vi.fn(),
  wakeAndUnlock: vi.fn(),
  latestCrash: vi.fn(),
  performInput: vi.fn(),
}));

vi.mock('@oniroproject/core', async () => {
  const actual = await vi.importActual<typeof import('@oniroproject/core')>('@oniroproject/core');
  return { ...actual, ...core };
});

import { noopLogger, noopProgress, staticConfig } from '@oniroproject/core';
import { setRuntime } from '../src/lib/runtime.js';
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, serveStdio, type ToolResult } from '../src/mcp/protocol.js';
import { applyDefaults, validateArgs } from '../src/mcp/schema.js';
import { ALL_TOOLS, TOOL_NAMES, selectTools, type ToolContext } from '../src/mcp/tools.js';
import { selectorFromArgs } from '../src/mcp/target.js';
import { parseToolList } from '../src/commands/serve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(here, '..', 'templates', 'EmptyAbility');
const CLI_PATH = path.join(here, '..', 'dist', 'oniro-app.js');

type Rpc = { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

function makeServer(tools = selectTools(undefined, false), ctx: ToolContext = { projectDir: templateDir }) {
  return new McpServer({ name: 'oniro-app', version: '9.9.9', tools, context: ctx, logger: noopLogger });
}

async function initialized(server = makeServer(), protocolVersion = '2025-06-18') {
  await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion, capabilities: {} } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return server;
}

async function call(server: McpServer<ToolContext>, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = (await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })) as Rpc;
  expect(r.error).toBeUndefined();
  return r.result as unknown as ToolResult;
}

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockReset();
  setRuntime({ config: staticConfig(), logger: noopLogger, progress: noopProgress });
});

afterEach(() => setRuntime(null));

describe('MCP protocol', () => {
  it('agrees on the version the client asks for, else offers the newest', async () => {
    const server = makeServer();
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })) as Rpc;
    expect(r.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'oniro-app', version: '9.9.9' },
    });
    const later = (await makeServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    })) as Rpc;
    expect(later.result?.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('answers ping, refuses tools before initialize, and does not answer notifications', async () => {
    const server = makeServer();
    expect(await server.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    const early = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as Rpc;
    expect(early.error?.code).toBe(-32600);
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeUndefined();
  });

  it('reports unknown methods, unknown tools and malformed messages as JSON-RPC errors', async () => {
    const server = await initialized();
    expect(((await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })) as Rpc).error?.code).toBe(-32601);
    const unknown = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })) as Rpc;
    expect(unknown.error?.code).toBe(-32602);
    expect(((await server.handle({ id: 3, method: 'ping' })) as Rpc).error?.code).toBe(-32600);
    expect(((await server.handle({ jsonrpc: '2.0', id: 4, method: 'ping', params: [1] })) as Rpc).error?.code).toBe(-32602);
  });

  it('answers a batch with an array of responses', async () => {
    const server = await initialized();
    const r = (await server.handle([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ])) as Rpc[];
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });

  it('lists every tool with an object input schema and annotations', async () => {
    const server = await initialized();
    const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as Rpc;
    const tools = r.result?.tools as Array<{ name: string; inputSchema: { type: string }; annotations: object; description: string }>;
    expect(tools.map((t) => t.name)).toEqual([
      'build', 'check_arkts', 'test', 'apply', 'launch', 'dump_layout', 'input', 'screenshot', 'wait',
      'logs_crash', 'screens', 'api_search', 'api_show', 'doctor', 'devices',
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations).toBeDefined();
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('turns bad arguments and a throwing tool into isError results, not protocol errors', async () => {
    const server = await initialized();
    const bad = await call(server, 'input', { type: 'poke', fx: 2, extra: 1 });
    expect(bad.isError).toBe(true);
    const text = (bad.content[0] as { text: string }).text;
    expect(text).toContain('type must be one of');
    expect(text).toContain('fx must be <= 1');
    expect(text).toContain('unknown property extra');
    expect(await call(server, 'input', {})).toMatchObject({ isError: true });

    core.dumpLayout.mockRejectedValue(new Error('No device connected.'));
    const thrown = await call(server, 'dump_layout', { summary: true });
    expect(thrown).toMatchObject({ isError: true, structuredContent: { error: 'No device connected.' } });
  });

  it('leaves structuredContent out for a client older than 2025-06-18', async () => {
    const server = await initialized(makeServer(), '2025-03-26');
    const r = await call(server, 'screens');
    expect(r.structuredContent).toBeUndefined();
    expect(JSON.parse((r.content[0] as { text: string }).text).pages[0].name).toBe('pages/Index');
  });
});

describe('JSON Schema subset', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      n: { type: 'integer' as const, minimum: 1, default: 5 },
      list: { type: 'array' as const, items: { type: 'string' as const }, minItems: 1 },
      flag: { type: 'boolean' as const, default: true },
    },
    required: ['list'],
    additionalProperties: false,
  };

  it('validates types, bounds, items and required properties', () => {
    expect(validateArgs(schema, { list: ['a'] })).toEqual([]);
    expect(validateArgs(schema, { n: 1.5, list: [] })).toEqual(['n must be an integer', 'list needs at least 1 item']);
    expect(validateArgs(schema, { n: 0, list: ['a', 2] })).toEqual(['n must be >= 1', 'list[1] must be a string']);
    expect(validateArgs(schema, {})).toEqual(['list is required']);
  });

  it('fills defaults and treats null as not given', () => {
    expect(applyDefaults(schema, { list: ['a'], flag: null })).toEqual({ list: ['a'], n: 5, flag: true });
  });
});

describe('tool selection', () => {
  it('--read-only drops the tools that change the device', () => {
    const names = selectTools(undefined, true).map((t) => t.name);
    for (const t of ['apply', 'launch', 'input', 'test']) expect(names).not.toContain(t);
    expect(names).toContain('screenshot');
    expect(names).toHaveLength(TOOL_NAMES.length - 4);
  });

  it('--tools restricts the set and rejects unknown names', () => {
    expect(selectTools(['screens', 'apply'], true).map((t) => t.name)).toEqual(['screens']);
    expect(() => selectTools(['screens', 'bogus'], false)).toThrow(/Unknown tool bogus/);
    expect(parseToolList(' screens, api_show ,')).toEqual(['screens', 'api_show']);
    expect(() => parseToolList(',')).toThrow();
  });

  it('every tool takes the same target inputs where it takes one', () => {
    for (const name of ['input', 'screenshot', 'wait']) {
      const props = ALL_TOOLS.find((t) => t.name === name)!.inputSchema.properties!;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(['target', 'targetId', 'targetType']));
    }
    expect(selectorFromArgs({ target: 'OK' })).toEqual({ text: 'OK', id: undefined, type: undefined });
    expect(selectorFromArgs({})).toBeUndefined();
  });
});

describe('tools over mocked core', () => {
  const layout = {
    display: { width: 1000, height: 2000 },
    tree: {
      type: 'root',
      children: [
        { bundle: 'com.example.app', type: 'Window', b: [0, 0, 1, 1], children: [{ type: 'Button', text: 'OK', click: true, b: [0.1, 0.1, 0.3, 0.2] }] },
      ],
    },
  };

  it('dump_layout returns the summary JSON, the flat text, and writes a baseline that diff reads back', async () => {
    core.dumpLayout.mockResolvedValue(layout);
    const server = await initialized();
    const summary = await call(server, 'dump_layout', { summary: true, device: 'SER' });
    expect(summary.isError).toBeUndefined();
    expect(summary.structuredContent).toHaveProperty('windows');
    expect(JSON.parse((summary.content[0] as { text: string }).text)).toEqual(summary.structuredContent);
    expect(core.dumpLayout).toHaveBeenCalledWith(expect.objectContaining({ prune: true, deviceSerial: 'SER' }));

    const flat = await call(server, 'dump_layout', { flat: true });
    expect(flat.structuredContent).toBeUndefined();
    expect((flat.content[0] as { text: string }).text).toContain('Button "OK"');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dump-'));
    const baseline = path.join(tmp, 'base.json');
    await call(server, 'dump_layout', { output: baseline });
    const diff = await call(server, 'dump_layout', { diff: baseline });
    expect(diff.structuredContent).toMatchObject({ similarity: 1 });
    expect(await call(server, 'dump_layout', { flat: true, summary: true })).toMatchObject({ isError: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('screenshot returns a JPEG downscaled to maxDim, and a diff against a baseline', async () => {
    const full = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg()
      .toBuffer();
    core.takeScreenshot.mockResolvedValue({ pixels: full, width: 1080, height: 2400 });
    const server = await initialized(makeServer(undefined, { projectDir: templateDir, deviceSerial: 'SRV' }));
    const r = await call(server, 'screenshot', { maxDim: 512, grid: true });
    expect(core.takeScreenshot).toHaveBeenCalledWith(expect.objectContaining({ deviceSerial: 'SRV' }));
    const image = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
    expect(image.mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(image.data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([230, 512]);
    expect(r.structuredContent).toMatchObject({ width: 230, height: 512, originalWidth: 1080, originalHeight: 2400, grid: true });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shot-'));
    fs.writeFileSync(path.join(tmp, 'base.jpeg'), full);
    const diff = await call(server, 'screenshot', { diff: 'base.jpeg', output: 'now.jpeg', project: tmp });
    expect(diff.structuredContent).toMatchObject({ baseline: path.join(tmp, 'base.jpeg'), current: path.join(tmp, 'now.jpeg'), same: true });
    expect(fs.readFileSync(path.join(tmp, 'now.jpeg'))).toEqual(full);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('devices wraps the --json array in an object', async () => {
    core.listDevices.mockResolvedValue([{ serial: 'A', connection: 'USB', status: 'Connected' }]);
    const r = await call(await initialized(), 'devices');
    expect(r.structuredContent).toEqual({ devices: [{ serial: 'A', connection: 'USB', status: 'Connected' }] });
  });

  it('check_arkts returns the could-not-start object as an error', async () => {
    core.checkArkts.mockRejectedValue(new Error('SDK 20 is not installed.'));
    const r = await call(await initialized(), 'check_arkts', { files: ['entry/src/main/ets/pages/Index.ets'] });
    expect(r).toMatchObject({
      isError: true,
      structuredContent: { ok: false, completed: false, error: 'SDK 20 is not installed.', diagnostics: [] },
    });
    expect(core.checkArkts).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: templateDir, files: ['entry/src/main/ets/pages/Index.ets'], fix: false }),
    );
  });

  it('build passes the CLI defaults and flags a failed build as an error', async () => {
    core.buildWithDiagnostics.mockResolvedValue({ ok: false, exitCode: 1, diagnostics: [], warnings: [], error: 'boom' });
    const r = await call(await initialized(), 'build', { project: '.' });
    expect(r).toMatchObject({ isError: true, structuredContent: { ok: false, error: 'boom' } });
    expect(core.buildWithDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: templateDir, product: 'default', task: 'assembleHap', autoInstallDeps: true, parallel: true }),
    );
  });

  it('launch with smoke returns {bundle, smoke} and is an error when the smoke check fails', async () => {
    core.wakeAndUnlock.mockResolvedValue({ locked: false });
    core.launchApp.mockResolvedValue(undefined);
    core.smokeCheck.mockResolvedValue({ passed: false, failures: ['the process died'], pid: 1, alive: false, blankScreen: null, blankScore: null });
    const r = await call(await initialized(), 'launch', { bundle: 'com.example.app', smoke: true, smokeDelay: 10 });
    expect(r).toMatchObject({ isError: true, structuredContent: { bundle: 'com.example.app', smoke: { passed: false } } });
    expect(core.smokeCheck).toHaveBeenCalledWith(expect.objectContaining({ bundle: 'com.example.app', delayMs: 10 }));
  });

  it('input forwards the target and returns what it resolved', async () => {
    core.performInput.mockResolvedValue({ x: 200, y: 300, keyboardHidden: false });
    const r = await call(await initialized(), 'input', { type: 'click', target: 'OK', targetIndex: 1 });
    expect(r.structuredContent).toEqual({ x: 200, y: 300, keyboardHidden: false });
    expect(core.performInput).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'click', target: { text: 'OK', id: undefined, type: undefined }, targetIndex: 1, clear: false }),
    );
  });

  it('logs_crash reports no crash as a result, not an error', async () => {
    core.latestCrash.mockResolvedValue(null);
    const r = await call(await initialized(), 'logs_crash', { bundle: 'com.example.app' });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ crashed: false, kind: null, bundle: 'com.example.app', since: null });
  });
});

describe('stdio transport', () => {
  it('reads newline-delimited messages and answers each, reporting parse errors', async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serveStdio(makeServer(), { input, write: (l) => lines.push(l) });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n');
    input.write('not json\n\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"screens"}}\n');
    await done;
    const msgs = lines.map((l) => JSON.parse(l) as Rpc);
    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    expect(msgs.find((m) => m.id === 1)?.result?.protocolVersion).toBe('2025-11-25');
    expect(msgs.find((m) => m.id === null)?.error?.code).toBe(-32700);
    expect(msgs.find((m) => m.id === 2)?.result?.structuredContent).toHaveProperty('pages');
  });
});

describe('oniro-app serve mcp', () => {
  it('speaks MCP on stdout only, with the read-only tool set', async () => {
    const child = spawn('node', [CLI_PATH, 'serve', 'mcp', '--project', templateDir, '--read-only'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const send = (m: object): boolean => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screens', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screens', arguments: { project: 'does-not-exist' } } });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    const msgs = stdout.trim().split('\n').map((l) => JSON.parse(l) as Rpc);
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const names = (byId.get(2)?.result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('screenshot');
    for (const t of ['apply', 'launch', 'input', 'test']) expect(names).not.toContain(t);
    expect((byId.get(3)?.result?.structuredContent as { pages: unknown[] }).pages).toHaveLength(1);
    expect(byId.get(4)?.result).toMatchObject({ isError: true });
    expect(stderr).toContain('MCP server on stdio');
  }, 30_000);

  it('rejects an unknown --tools name before serving', () => {
    return new Promise<void>((resolve) => {
      const child = spawn('node', [CLI_PATH, 'serve', 'mcp', '--tools', 'screens,bogus'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => {
        expect(code).toBe(1);
        expect(stderr).toContain('Unknown tool bogus');
        resolve();
      });
    });
  });
});
