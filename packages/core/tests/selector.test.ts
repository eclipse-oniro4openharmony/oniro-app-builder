import { describe, expect, it } from 'vitest';
import {
  SelectorParseError,
  formatSelector,
  matchSelector,
  parseSelector,
  selectorFor,
  type DslSelector,
  type LayoutNode,
} from '../src/hdc/index.js';
import { layoutFixture } from './_helpers/layoutFixture.js';

const dsl = (s: string): DslSelector => {
  const p = parseSelector(s);
  if (p.kind !== 'dsl') throw new Error('expected a DSL selector');
  return p;
};

const parseError = (s: string): SelectorParseError => {
  try {
    parseSelector(s);
  } catch (err) {
    expect(err).toBeInstanceOf(SelectorParseError);
    return err as SelectorParseError;
  }
  throw new Error(`expected ${JSON.stringify(s)} not to parse`);
};

describe('parseSelector (DSL)', () => {
  it('parses comma-separated clauses with every operator', () => {
    expect(dsl('type=Button,text*=Sign').clauses).toEqual([
      { key: 'type', op: '=', value: 'Button' },
      { key: 'text', op: '*=', value: 'Sign' },
    ]);
    expect(dsl('text^=Sign, desc$=in').clauses.map((c) => c.op)).toEqual(['^=', '$=']);
    expect(dsl('id/=^item.$').clauses).toEqual([{ key: 'id', op: '/=', value: '^item.$' }]);
    // A bare [ starts the index suffix, so a character class needs quotes.
    expect(dsl('id/="^item[A-C]$"').clauses).toEqual([{ key: 'id', op: '/=', value: '^item[A-C]$' }]);
  });

  it('keeps inner spaces of a bare value and trims the edges', () => {
    expect(dsl('  text = Sign in ,type=Button ').clauses).toEqual([
      { key: 'text', op: '=', value: 'Sign in' },
      { key: 'type', op: '=', value: 'Button' },
    ]);
  });

  it('reads quoted values with escapes, so they can hold separators', () => {
    expect(dsl('text="a, b [c]"').clauses[0]!.value).toBe('a, b [c]');
    expect(dsl("text='say \"hi\"'").clauses[0]!.value).toBe('say "hi"');
    expect(dsl('text="back\\\\slash \\"q\\""').clauses[0]!.value).toBe('back\\slash "q"');
    expect(dsl('text=a\\,b').clauses[0]!.value).toBe('a,b');
  });

  it('splits regex flags off a /= value', () => {
    expect(dsl('text/=^sign/i').clauses[0]).toEqual({ key: 'text', op: '/=', value: '^sign', flags: 'i' });
    expect(dsl('text/="a/b"').clauses[0]).toEqual({ key: 'text', op: '/=', value: 'a/b' });
  });

  it('parses the [n] / [-n] / [last] index suffix', () => {
    expect(dsl('type=Button').index).toBeUndefined();
    expect(dsl('type=Button[1]').index).toBe(1);
    expect(dsl('type=Button [ -2 ] ').index).toBe(-2);
    expect(dsl('type=Button[last]').index).toBe(-1);
  });

  it('accepts description as an alias of desc', () => {
    expect(dsl('description=Settings').clauses[0]!.key).toBe('desc');
  });

  it('keeps the source text', () => {
    expect(parseSelector('type=Button[0]').raw).toBe('type=Button[0]');
  });

  it('rejects malformed input with the position', () => {
    expect(parseError('').message).toMatch(/empty selector/);
    expect(parseError('colour=red').message).toMatch(/unknown key "colour"; known keys: text, desc/);
    expect(parseError('colour=red').position).toBe(0);
    expect(parseError('text').message).toMatch(/expected an operator/);
    expect(parseError('text=').message).toMatch(/missing value/);
    expect(parseError('text=a,').message).toMatch(/clause after the comma/);
    expect(parseError('text=a,text=b').message).toMatch(/"text" appears twice/);
    expect(parseError('desc=a,description=b').message).toMatch(/"desc" appears twice/);
    expect(parseError('text="open').message).toMatch(/unterminated/);
    expect(parseError('text/=(').message).toMatch(/invalid regular expression/);
    expect(parseError('type=Button[first]').message).toMatch(/invalid index "first"/);
    expect(parseError('type=Button[1').message).toMatch(/expected '\]'/);
    expect(parseError('type=Button[1] x').message).toMatch(/trailing input/);
    expect(parseError('=Button').message).toMatch(/expected an attribute key/);
  });
});

describe('parseSelector (xpath=)', () => {
  it('parses an xpath= expression, prefix and leading space allowed', () => {
    const p = parseSelector('  xpath=//Button[@text="OK"]');
    expect(p.kind).toBe('xpath');
    expect(p.raw).toBe('  xpath=//Button[@text="OK"]');
  });

  it('reports XPath errors as selector parse errors', () => {
    expect(parseError('xpath=Button').message).toMatch(/starts with \/ or \/\//);
  });
});

describe('matchSelector on a recorded layout', () => {
  const tree = layoutFixture('selprobe');
  const ids = (s: string): (string | undefined)[] => matchSelector(tree, parseSelector(s)).map((n) => n.id);

  it('matches every clause, case-sensitively, in paint order', () => {
    expect(ids('type=Button,text*=Sign')).toEqual(['signIn', 'signUp']);
    expect(ids('type=Button,text*=sign')).toEqual([]);
    expect(ids('text^=Item')).toEqual(['itemA', 'itemB', 'itemC']);
    expect(ids('text$=up')).toEqual(['signUp']);
    expect(ids('text/=^sign (in|up)$/i')).toEqual(['signIn', 'signUp']);
    expect(ids('text=Sign in')).toEqual(['signIn']);
  });

  it('reads the boolean keys as "true" / "false"', () => {
    expect(ids('enabled=false')).toEqual(['disabledBtn']);
    expect(ids('type=Button,clickable=true')).toEqual(['signIn', 'signUp', 'toggle']);
    expect(ids('scrollable=true,longClickable=true')).toEqual(['email']);
    expect(ids('type=Text,visible=true').length).toBeGreaterThan(5);
  });

  it('matches hint, key (falling back to id) and structural types kept for their id', () => {
    expect(ids('hint^=you@')).toEqual(['email']);
    expect(ids('key=signIn')).toEqual(['signIn']);
    expect(ids('type=Column')).toEqual(['items']);
    expect(ids('type=Row,id=authRow')).toEqual(['authRow']);
  });

  it('tags matches with their window', () => {
    const [battery] = matchSelector(tree, parseSelector('text=100'));
    expect(battery).toMatchObject({ window: 'com.ohos.sceneboard', windowId: 20 });
    const [title] = matchSelector(tree, parseSelector('id=title'));
    expect(title).toMatchObject({ window: 'com.example.selprobe', windowId: 92 });
  });

  it('does not apply the index suffix (callers pick with it)', () => {
    expect(ids('type=Button,text*=Sign[1]')).toEqual(['signIn', 'signUp']);
  });

  it('never matches a bare container', () => {
    expect(matchSelector({ children: [{ children: [] }] }, parseSelector('visible=true'))).toEqual([]);
  });
});

describe('formatSelector', () => {
  it('quotes values that would not survive bare, and round-trips', () => {
    const cases = ['Sign in', 'a, b', 'x[1]', ' padded ', 'say "hi"', 'back\\slash', "it's", ''];
    for (const value of cases) {
      const text = formatSelector([{ key: 'text', op: '=', value }], 2);
      const back = dsl(text);
      expect(back.clauses[0]!.value).toBe(value);
      expect(back.index).toBe(2);
    }
    expect(formatSelector([{ key: 'type', op: '=', value: 'Button' }, { key: 'text', op: '*=', value: 'Sign' }])).toBe(
      'type=Button,text*=Sign',
    );
    expect(formatSelector([{ key: 'text', op: '/=', value: '^a', flags: 'i' }])).toBe('text/=^a/i');
  });
});

describe('selectorFor', () => {
  const tree = layoutFixture('selprobe');

  it('prefers type plus a unique id', () => {
    expect(selectorFor(tree, { type: 'Button', text: 'Sign up', id: 'signUp' })).toBe('type=Button,id=signUp');
    expect(selectorFor(tree, { type: 'TextInput', hint: 'you@example.com', id: 'email' })).toBe('type=TextInput,id=email');
  });

  it('falls back to an index when nothing stable is unique', () => {
    // Three status-bar clock nodes share id TimeView_Text_timeText: a Text (unique by type) and two TextClocks.
    expect(selectorFor(tree, { type: 'Text', text: ':', id: 'TimeView_Text_timeText' })).toBe('type=Text,id=TimeView_Text_timeText');
    expect(selectorFor(tree, { type: 'TextClock', id: 'TimeView_Text_timeText', c: [0.133, 0.025] })).toBe(
      'type=TextClock,id=TimeView_Text_timeText[1]',
    );
  });

  it('falls back to a label when the id is shared', () => {
    const t: LayoutNode = {
      children: [
        { type: 'Button', id: 'row', text: 'Edit', c: [0.2, 0.1], click: true },
        { type: 'Button', id: 'row', text: 'Delete', c: [0.8, 0.1], click: true },
      ],
    };
    expect(selectorFor(t, { type: 'Button', id: 'row', text: 'Delete' })).toBe('type=Button,text=Delete');
  });

  it('uses the label when the element has no id', () => {
    const t: LayoutNode = {
      children: [
        { type: 'Text', text: 'OK', c: [0.5, 0.1] },
        { type: 'Button', text: 'OK', c: [0.5, 0.9], click: true },
        { type: 'Button', text: 'Cancel', c: [0.2, 0.9], click: true },
      ],
    };
    expect(selectorFor(t, { type: 'Button', text: 'OK' })).toBe('type=Button,text=OK');
    expect(selectorFor(t, { type: 'Text', text: 'OK' })).toBe('type=Text,text=OK');
  });

  it('produces a selector that resolves back to the element', () => {
    for (const n of matchSelector(tree, parseSelector('visible=true'))) {
      if (!n.type && !n.id && !n.text) continue;
      const sel = dsl(selectorFor(tree, n));
      const matches = matchSelector(tree, sel);
      const picked = sel.index === undefined ? matches : [matches.at(sel.index)];
      expect(picked).toHaveLength(1);
      expect(picked[0]).toEqual(n);
    }
  });

  it('throws when the element is not in the layout', () => {
    expect(() => selectorFor(tree, { type: 'Button', text: 'Nope' })).toThrow(/not in this layout/);
  });
});
