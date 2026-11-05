import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FlowFormatError, formatFlow, parseFlow, readFlowFile } from '../src/flow/flowFile.js';

const valid = {
  version: 1,
  bundle: 'com.example.flowprobe',
  device: { api: 26, display: { width: 1080, height: 2400 } },
  steps: [
    { action: 'inputText', selector: 'type=TextInput,id=nameInput', text: 'bob', note: 'type a name' },
    { action: 'click', selector: 'type=Button,text=Continue', fallback: { fx: 0.5, fy: 0.305 }, expect: 'id=greeting', waitMs: 200 },
    { action: 'swipe', selector: 'id=fruitList', to: { fx: 0.5, fy: 0.3 }, speed: 2000 },
    { action: 'click', fallback: { fx: 0.5, fy: 0.4 } },
    { action: 'wait', selector: 'xpath=//Text[@text="Picked: Cherry"]', timeoutMs: 5000 },
    { action: 'wait', selector: 'id=spinner', gone: true },
    { action: 'keyEvent', key: 'Back', expect: 'id=title' },
  ],
};

const problems = (doc: unknown): string[] => {
  try {
    parseFlow(doc);
  } catch (err) {
    expect(err).toBeInstanceOf(FlowFormatError);
    return (err as FlowFormatError).problems;
  }
  return [];
};

describe('parseFlow', () => {
  it('accepts a flow using every step type and field', () => {
    expect(parseFlow(valid)).toBe(valid);
  });

  it('reports every problem with its field path', () => {
    const p = problems({
      version: 2,
      extra: true,
      steps: [
        { action: 'tap', selector: 'x' },
        { action: 'click' },
        { action: 'click', selector: 'type=Button,text*=', fallback: { fx: 2, fy: 0.5, z: 1 } },
        { action: 'swipe', selector: 'id=list' },
        { action: 'inputText', selector: 'id=f', key: 'Enter' },
        { action: 'keyEvent', key: '' },
        { action: 'wait' },
        { action: 'click', selector: 'id=a', selecter: 'id=b', expect: 'nokey=1', waitMs: -1 },
      ],
    });
    expect(p).toEqual([
      'extra: unknown field',
      'version: expected 1, got 2',
      'steps[0].action: expected one of click, longClick, doubleClick, swipe, inputText, keyEvent, wait',
      'steps[1]: click needs a selector or a fallback point',
      expect.stringMatching(/^steps\[2\]\.selector: Invalid selector .*missing value/),
      'steps[2].fallback.fx: expected a fraction between 0 and 1',
      'steps[2].fallback.z: unknown field',
      'steps[3]: swipe needs "to"',
      'steps[4].text: inputText needs the text to type',
      'steps[4].key: only applies to keyEvent',
      expect.stringMatching(/^steps\[5\]\.key: keyEvent needs a key/),
      'steps[6]: wait needs a selector',
      'steps[7].selecter: unknown field',
      expect.stringMatching(/^steps\[7\]\.expect: Invalid selector .*unknown key "nokey"/),
      'steps[7].waitMs: expected a number of milliseconds >= 0',
    ]);
  });

  it('rejects a document that is not a flow', () => {
    expect(problems([])).toEqual(['expected a JSON object with "version" and "steps"']);
    expect(problems({ version: 1 })).toEqual(['steps: expected an array']);
  });
});

describe('readFlowFile and formatFlow', () => {
  it('round-trips a flow through a file, and names the file in errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
    const file = path.join(dir, 'flow.json');
    fs.writeFileSync(file, formatFlow(valid as never));
    expect(readFlowFile(file)).toEqual(valid);
    fs.writeFileSync(file, '{ "version": 1, ');
    expect(() => readFlowFile(file)).toThrow(/flow\.json: not a valid flow:\n {2}not JSON/);
    expect(() => readFlowFile(path.join(dir, 'missing.json'))).toThrow(/Could not read the flow file/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
