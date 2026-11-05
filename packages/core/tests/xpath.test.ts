import { describe, expect, it } from 'vitest';
import { SelectorParseError, evaluateXPath, parseXPath, type LayoutNode } from '../src/hdc/index.js';
import { layoutFixture } from './_helpers/layoutFixture.js';

const tree = layoutFixture('selprobe');
const ids = (expr: string, t: LayoutNode = tree): (string | undefined)[] => evaluateXPath(t, expr).map((n) => n.id ?? n.text);

describe('evaluateXPath on a recorded layout', () => {
  it('selects by element name with //', () => {
    expect(ids('//Button')).toEqual(['signIn', 'signUp', 'toggle', 'disabledBtn']);
    expect(ids('//TextInput')).toEqual(['email']);
    expect(ids('//Nothing')).toEqual([]);
  });

  it('walks child steps from the document with /', () => {
    // document → empty tree root (element "node") → app window root (type "root").
    expect(ids('/node/root/Text')).toEqual(['title', 'status']);
    expect(ids('/node/root/Row/Button')).toEqual(['signIn', 'signUp']);
    expect(ids('/node/root/Button')).toEqual(['toggle', 'disabledBtn']);
    expect(ids('/*/*/Column/*')).toEqual(['itemA', 'itemB', 'itemC']);
  });

  it('mixes / and // and matches any element with *', () => {
    expect(ids('//Row//Button')).toEqual(['signIn', 'signUp']);
    expect(ids('//Column[@id="items"]/*')).toEqual(['itemA', 'itemB', 'itemC']);
    expect(ids('//*[@id="email"]')).toEqual(['email']);
  });

  it('tests attributes with = and !=; a missing attribute never compares', () => {
    expect(ids('//Button[@text="Sign in"]')).toEqual(['signIn']);
    expect(ids("//Button[@text!='Sign in']")).toEqual(['signUp', 'toggle', 'disabledBtn']);
    expect(ids('//TextInput[@text!="x"]')).toEqual([]);
    expect(ids('//Button[@enabled="false"]')).toEqual(['disabledBtn']);
    expect(ids('//*[@hint="you@example.com"]')).toEqual(['email']);
    expect(ids('//*[@description="x"]')).toEqual([]);
  });

  it('treats an attribute alone as an existence test', () => {
    expect(ids('//Column/*[@text]').length).toBe(3);
    expect(ids('//root/*[@hint]')).toEqual(['email']);
  });

  it('supports contains, starts-with, ends-with, not and text()', () => {
    expect(ids('//Button[contains(@text,"Sign")]')).toEqual(['signIn', 'signUp']);
    expect(ids('//Text[starts-with(@text,"Item")]')).toEqual(['itemA', 'itemB', 'itemC']);
    expect(ids('//Button[ends-with(@text,"up")]')).toEqual(['signUp']);
    expect(ids('//Button[not(contains(@text,"Sign"))]')).toEqual(['toggle', 'disabledBtn']);
    expect(ids('//Text[text()="Item B"]')).toEqual(['itemB']);
  });

  it('combines conditions with and / or and parentheses', () => {
    expect(ids('//Button[@clickable="true" and contains(@text,"Sign")]')).toEqual(['signIn', 'signUp']);
    expect(ids('//*[@id="title" or @id="email"]')).toEqual(['title', 'email']);
    expect(ids('//Button[(@id="signIn" or @id="toggle") and @enabled="true"]')).toEqual(['signIn', 'toggle']);
  });

  it('[n] is positional per parent, (path)[n] over the whole result', () => {
    expect(ids('//Column[@id="items"]/Text[2]')).toEqual(['itemB']);
    // //Button[1]: each parent's first Button — one in the Row, one under the window root.
    expect(ids('//Button[1]')).toEqual(['signIn', 'toggle']);
    expect(ids('(//Button)[1]')).toEqual(['signIn']);
    expect(ids('(//Button)[last()]')).toEqual(['disabledBtn']);
    expect(ids('//Column/Text[last()]')).toEqual(['itemC']);
    expect(ids('//Column/Text[position()<3]')).toEqual(['itemA', 'itemB']);
    expect(ids('//Button[contains(@text,"Sign")][2]')).toEqual(['signUp']);
  });

  it('continues a path after a parenthesised group', () => {
    expect(ids('(//Row)[1]/Button[2]')).toEqual(['signUp']);
  });

  it('walks up with .. and stays with .', () => {
    expect(ids('//Text[@id="itemB"]/..')).toEqual(['items']);
    expect(ids('//Column/.')).toEqual(['items']);
  });

  it('returns window-tagged nodes and never the bare tree root', () => {
    expect(evaluateXPath(tree, '//Text[@text="100"]')[0]).toMatchObject({ windowId: 20, window: 'com.ohos.sceneboard' });
    expect(evaluateXPath(tree, '/node')).toEqual([]);
    expect(evaluateXPath(tree, '/*/root')[0]).toMatchObject({ windowId: 92, bundle: 'com.example.selprobe' });
  });

  it('names untyped elements node', () => {
    const t: LayoutNode = { children: [{ id: 'bare', c: [0.5, 0.5] }] };
    expect(ids('//node[@id="bare"]', t)).toEqual(['bare']);
  });

  it('accepts a parsed expression', () => {
    expect(evaluateXPath(tree, parseXPath('//TextInput')).map((n) => n.id)).toEqual(['email']);
  });
});

describe('parseXPath rejects what the subset does not cover', () => {
  const err = (expr: string): string => {
    try {
      parseXPath(expr);
    } catch (e) {
      expect(e).toBeInstanceOf(SelectorParseError);
      return (e as Error).message;
    }
    throw new Error(`expected ${expr} not to parse`);
  };

  it('names the problem', () => {
    expect(err('')).toMatch(/empty XPath/);
    expect(err('Button')).toMatch(/starts with \/ or \/\//);
    expect(err('//')).toMatch(/expected an element name/);
    expect(err('/')).toMatch(/expected an element name/);
    expect(err('//Button | //Text')).toMatch(/unions/);
    expect(err('//child::Button')).toMatch(/axis names/);
    expect(err('//Button/@text')).toMatch(/attribute steps/);
    expect(err('//Button[@colour="red"]')).toMatch(/unknown attribute @colour/);
    expect(err('//Button[Text]')).toMatch(/paths inside predicates/);
    expect(err('//Button[count(@text)]')).toMatch(/unsupported function count\(\)/);
    expect(err('//Button[contains(@text)]')).toMatch(/contains\(\) takes 2/);
    expect(err('//Button[@text="x"')).toMatch(/expected '\]'/);
    expect(err('//Button[@text="x]')).toMatch(/unterminated string/);
    expect(err('//node()')).toMatch(/node tests/);
    expect(err('//Button]')).toMatch(/trailing input/);
    expect(err('//Button[@text=]')).toMatch(/expected an attribute, a string/);
  });
});
