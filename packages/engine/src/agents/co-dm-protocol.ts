/** Engine framing only: models supply content, never delivery identifiers. */
export interface CoDmAnnotation { content: string }
export interface CoDmStreamSegment { kind: 'narration' | 'annotation'; payload: string }
export interface CoDmProtocolDiagnostic {
  code: 'malformed-frame' | 'truncated-frame' | 'annotation-too-large';
  offset: number;
}

const OPEN = '<co_dm>';
const CLOSE = '</co_dm>';
const RESERVED = ['<co_dm', '</co_dm'];

/**
 * Exact, case-sensitive framing. Literal reserved tags must be escaped as
 * &lt;co_dm&gt;. Suspect framing is quarantined through EOF, never recovered as
 * prose. Delimiter lookahead is bounded; private payloads have an explicit cap.
 * Call finish even when the provider interrupts before reading annotations.
 */
export class CoDmStreamFilter {
  private mode: 'public' | 'private' | 'quarantine' = 'public';
  private candidate = '';
  private payload = '';
  private offset = 0;
  private ended = false;
  private readonly completed: CoDmAnnotation[] = [];
  private readonly faults: CoDmProtocolDiagnostic[] = [];
  private segments: CoDmStreamSegment[] = [];

  constructor(private readonly maxAnnotationLength = 65_536) {}

  get annotations(): readonly CoDmAnnotation[] { return this.completed; }
  get diagnostics(): readonly CoDmProtocolDiagnostic[] { return this.faults; }
  drainSegments(): CoDmStreamSegment[] { const segments = this.segments; this.segments = []; return segments; }

  private appendPublic(text: string): void {
    const tail = this.segments[this.segments.length - 1];
    if (tail?.kind === 'narration') tail.payload += text;
    else this.segments.push({ kind: 'narration', payload: text });
  }

  private fail(code: CoDmProtocolDiagnostic['code']): void {
    this.faults.push({ code, offset: this.offset });
    this.mode = 'quarantine';
    this.candidate = '';
    this.payload = '';
    this.completed.length = 0;
  }

  push(delta: string): string {
    if (this.ended) throw new Error('Co-DM stream already finished');
    let visible = '';
    for (let index = 0; index < delta.length; index++) {
      const char = delta.charAt(index);
      this.offset++;
      if (this.mode === 'quarantine') continue;
      this.candidate += char;
      while (this.candidate) {
        if (this.candidate === OPEN) {
          if (this.mode === 'private') this.fail('malformed-frame');
          else { this.mode = 'private'; this.candidate = ''; }
          break;
        }
        if (this.candidate === CLOSE) {
          if (this.mode === 'public') this.fail('malformed-frame');
          else {
            this.completed.push({ content: this.payload });
            this.segments.push({ kind: 'annotation', payload: this.payload });
            this.payload = '';
            this.candidate = '';
            this.mode = 'public';
          }
          break;
        }
        if ([OPEN, CLOSE].some(tag => tag.startsWith(this.candidate))) break;
        if (RESERVED.some(prefix => this.candidate.startsWith(prefix))) {
          this.fail('malformed-frame');
          break;
        }
        const first = this.candidate.charAt(0);
        this.candidate = this.candidate.slice(1);
        if (this.mode === 'public') { visible += first; this.appendPublic(first); }
        else {
          this.payload += first;
          if (this.payload.length > this.maxAnnotationLength) {
            this.fail('annotation-too-large');
            break;
          }
        }
      }
    }
    return visible;
  }

  finish(): string {
    if (this.ended) return '';
    this.ended = true;
    // Even a partial opener is suspect at interruption; fail closed.
    if (this.mode !== 'quarantine' && (this.mode === 'private' || this.candidate)) {
      this.fail('truncated-frame');
    }
    return '';
  }
}

/** Apply the identical privacy boundary before public transcript persistence. */
export function stripCoDmAnnotations(text: string): {
  publicText: string; annotations: CoDmAnnotation[];
} {
  const filter = new CoDmStreamFilter();
  const publicText = filter.push(text) + filter.finish();
  return { publicText, annotations: [...filter.annotations] };
}
