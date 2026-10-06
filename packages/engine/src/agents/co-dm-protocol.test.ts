import { CoDmStreamFilter, stripCoDmAnnotations, projectPublicNarration } from './co-dm-protocol.js';

function parse(chunks: string[]) {
  const parser = new CoDmStreamFilter();
  let publicText = '';
  for (const chunk of chunks) publicText += parser.push(chunk);
  publicText += parser.finish();
  return { publicText, annotations: [...parser.annotations], diagnostics: [...parser.diagnostics] };
}

describe('private co-DM streaming framing', () => {
  const source = 'Before 🦉.<co_dm>SECRET 雪 🕵️</co_dm> After.<co_dm>identity bind</co_dm> Done.';
  const expected = { publicText: 'Before 🦉. After. Done.', annotations: [
    { content: 'SECRET 雪 🕵️' }, { content: 'identity bind' },
  ], diagnostics: [] };

  it('preserves public prose and ordered private annotations at every UTF-16 boundary', () => {
    for (let index = 0; index <= source.length; index++) {
      expect(parse([source.slice(0, index), source.slice(index)])).toEqual(expected);
    }
    expect(parse(source.split(''))).toEqual(expected);
  });

  it('handles every UTF-8 transport boundary after incremental decoding', () => {
    const bytes = new TextEncoder().encode(source);
    for (let index = 0; index <= bytes.length; index++) {
      const decoder = new TextDecoder();
      expect(parse([
        decoder.decode(bytes.slice(0, index), { stream: true }),
        decoder.decode(bytes.slice(index), { stream: true }), decoder.decode(),
      ])).toEqual(expected);
    }
    const decoder = new TextDecoder();
    expect(parse([...bytes].map(byte => decoder.decode(new Uint8Array([byte]), { stream: true }))
      .concat(decoder.decode()))).toEqual(expected);
  });

  it.each([
    '<co_dm>SECRET without closing tag',
    '<co_dm>SECRET<co_dm>nested</co_dm> tail',
    '<co_dm attribute="x">SECRET</co_dm>',
    '<co_dm>SECRET</co_d',
    '<co_dm>SECRET</co_dm></co_dm>',
    '<co_dm/>SECRET',
    '</co_dm>SECRET',
  ])('quarantines malformed framing at all boundaries: %s', (malformed) => {
    const text = `Public.${malformed}`;
    for (let index = 0; index <= text.length; index++) {
      const result = parse([text.slice(0, index), text.slice(index)]);
      expect(result.publicText).toBe('Public.');
      expect(result.annotations).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET');
    }
    expect(parse(text.split('')).publicText).toBe('Public.');
    expect(stripCoDmAnnotations(text)).toEqual({ publicText: 'Public.', annotations: [] });
  });

  it('holds each unfinished opener prefix on interruption', () => {
    for (let size = 1; size < '<co_dm>'.length; size++) {
      expect(parse(['Public.' + '<co_dm>'.slice(0, size)]).publicText).toBe('Public.');
    }
  });

  it('streams ordinary prose promptly and accepts escaped literal tags', () => {
    const parser = new CoDmStreamFilter();
    expect(parser.push('Hello ')).toBe('Hello ');
    expect(parser.push('<co')).toBe('');
    expect(parser.push('ffee> and &lt;co_dm&gt;')).toBe('<coffee> and &lt;co_dm&gt;');
    expect(parser.finish()).toBe('');
    expect(parser.annotations).toEqual([]);
  });

  it('bounds annotation memory and never returns over-limit secrets', () => {
    const parser = new CoDmStreamFilter(4);
    expect(parser.push('Public.<co_dm>12345</co_dm> tail')).toBe('Public.');
    expect(parser.finish()).toBe('');
    expect(parser.annotations).toEqual([]);
    expect(parser.diagnostics[0]?.code).toBe('annotation-too-large');
  });

  it('uses the same privacy boundary for complete persisted responses', () => {
    expect(stripCoDmAnnotations(source)).toEqual({ publicText: expected.publicText, annotations: expected.annotations });
  });

  it('retains causal public/private order within a single provider delta', () => {
    const filter = new CoDmStreamFilter();
    expect(filter.push('Before<co_dm>bind</co_dm>After')).toBe('BeforeAfter');
    filter.finish();
    expect(filter.drainSegments()).toEqual([
      { kind: 'narration', payload: 'Before' }, { kind: 'annotation', payload: 'bind' },
      { kind: 'narration', payload: 'After' },
    ]);
    expect(filter.drainSegments()).toEqual([]);
  });
});


it('projects block-array public narration without private frames or tool data', () => {
  expect(projectPublicNarration([{ role: 'assistant', content: [{ type: 'text', text: 'Seen.<co_' }, { type: 'text', text: 'dm>private plan</co_dm>Next.' }, { type: 'tool_use', id: 'secret', name: 'dm_notes', input: { notes: 'private tool data' } }] }])).toBe('Seen.Next.');
});
