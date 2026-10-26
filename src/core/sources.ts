/** Source chunking with location tracking, and verification that quoted text really appears in a source. */
export interface Chunk { idx: number; text: string; page: number | null; para: number; start: number; end: number; label: string; uncertain: boolean }

const PAGE_LINE = /^[ \t]*(?:-{2,}\s*)?(?:\[\[\s*)?(?:page|p\.?)\s*(\d{1,4})(?:\s*\]\])?(?:\s*-{2,})?[ \t]*$/i;
const MAX_CHUNK = 1200;

/** Heuristic only: flags text where OCR commonly corrupts math (replacement chars, stray bars, glued digits/letters). */
export function suspiciousMath(text: string): boolean {
  return /�/.test(text) || /[0-9][lI][0-9]/.test(text) || /[=<>]\s*[=<>]{2,}/.test(text) || /\bx\s?[0-9]\s?x\b/.test(text);
}

export function chunkText(text: string, opts: { ocr?: boolean } = {}): Chunk[] {
  const chunks: Chunk[] = [];
  let page: number | null = null;
  let para = 0;
  // Walk line by line to keep exact character offsets.
  let curStart = -1, curEnd = -1;
  const flush = () => {
    if (curStart < 0) return;
    pushParagraph(curStart, curEnd);
    curStart = -1;
  };
  const pushParagraph = (s: number, e: number) => {
    // trim
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e <= s) return;
    para++;
    const pieces: [number, number][] = [];
    if (e - s <= MAX_CHUNK) pieces.push([s, e]);
    else {
      let ps = s;
      const re = /[.!?]["')\]]?\s+/g;
      re.lastIndex = s;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) && m.index < e) {
        const pe = m.index + m[0].length;
        if (pe - ps >= MAX_CHUNK * 0.6) { pieces.push([ps, pe]); ps = pe; }
      }
      if (ps < e) pieces.push([ps, e]);
    }
    for (const [ps, pe] of pieces) {
      const t = text.slice(ps, pe).trim();
      if (!t) continue;
      chunks.push({
        idx: chunks.length, text: text.slice(ps, pe), page, para, start: ps, end: pe,
        label: `${page !== null ? `p. ${page}, ` : ''}¶${para}${pieces.length > 1 ? ` (part ${pieces.findIndex((x) => x[0] === ps) + 1})` : ''}`,
        uncertain: !!opts.ocr && suspiciousMath(t),
      });
    }
  };
  const segments = text.split('\f');
  let segBase = 0;
  segments.forEach((seg, si) => {
    if (segments.length > 1) { flush(); page = si + 1; para = 0; }
    let off = segBase;
    for (const line of seg.split(/(?<=\n)/)) {
      const start = off; off += line.length;
      const bare = line.replace(/\r?\n$/, '');
      const pm = PAGE_LINE.exec(bare);
      if (pm) { flush(); page = Number(pm[1]); para = 0; continue; }
      if (bare.trim() === '') { flush(); continue; }
      if (curStart < 0) curStart = start;
      curEnd = start + bare.length;
    }
    segBase += seg.length + 1;
  });
  flush();
  return chunks;
}

const fold = (s: string) => s.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').toLowerCase();

/** Locate `quote` in `text` ignoring case, curly quotes and whitespace differences. Returns original offsets or null. */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = fold(quote).replace(/\s+/g, ' ').trim();
  if (q.length < 6) return null;
  let norm = '';
  const map: number[] = []; // norm index -> original index
  let prevSpace = false;
  const f = fold(text);
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (/\s/.test(ch)) { if (prevSpace) continue; prevSpace = true; norm += ' '; } else { prevSpace = false; norm += ch; }
    map.push(i);
  }
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return { start: map[at], end: map[at + q.length - 1] + 1 };
}

export function chunkAt(chunks: Chunk[], offset: number): Chunk | null {
  return chunks.find((c) => offset >= c.start && offset < c.end) ?? null;
}

export type Support = 'source' | 'ai' | 'unverified';
export const SUPPORT_LABEL: Record<Support, string> = {
  source: 'Supported by your material',
  ai: 'Added by AI (not in your material)',
  unverified: 'Needs verification',
};

export interface VerifiedRef { quote: string; start: number; end: number; chunkIdx: number | null; label: string }

/** Keep only quotes that genuinely occur in the source; everything else is discarded, never "repaired". */
export function verifyQuotes(text: string, chunks: Chunk[], quotes: string[]): { verified: VerifiedRef[]; rejected: string[] } {
  const verified: VerifiedRef[] = [], rejected: string[] = [];
  for (const quote of quotes) {
    const hit = findQuote(text, quote);
    if (!hit) { rejected.push(quote); continue; }
    const c = chunkAt(chunks, hit.start);
    verified.push({ quote: text.slice(hit.start, hit.end), start: hit.start, end: hit.end, chunkIdx: c?.idx ?? null, label: c?.label ?? 'location unknown' });
  }
  return { verified, rejected };
}

/* ---- instruction-like text inside uploaded material (prompt-injection defence in depth) ---- */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(the\s+|all\s+)?(rubric|instructions?|rules?)/i,
  /\bsystem\s+(instruction|prompt|message|override)/i,
  /\byou\s+are\s+now\b/i,
  /\b(note|message|instruction)s?\s+to\s+(the\s+)?(grader|grading\s+system|ai|assistant|model|llm)\b/i,
  /\baward\s+(full|maximum)\s+(marks|credit|points)\b/i,
  /\bdo\s+not\s+(mention|reveal|tell)\s+this\b/i,
  /\boutput\s+(no\s+other|only)\b/i,
  /\bnew\s+instructions?\s*:/i,
];
export const isInstructionLike = (s: string) => INSTRUCTION_PATTERNS.some((re) => re.test(s));

/** Character ranges of lines that read like instructions to an AI rather than study material. */
export function instructionRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let off = 0;
  for (const line of text.split('\n')) {
    if (isInstructionLike(line)) out.push({ start: off, end: off + line.length });
    off += line.length + 1;
  }
  return out;
}
/** Remove instruction-like lines before text is shown to a model or turned into concepts. */
export const stripInstructionLines = (text: string) => text.split('\n').filter((l) => !isInstructionLike(l)).join('\n');
