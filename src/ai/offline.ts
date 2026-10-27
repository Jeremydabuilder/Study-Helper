/**
 * Offline provider: no model, no network. Heuristic concept extraction, template questions and keyword-based
 * grading. It is deliberately modest and labelled as such: keyword grading is ALWAYS reported with low
 * confidence so it never changes mastery on its own (the student confirms or corrects).
 */
import { MATH_SKILLS, MathSkill, generateMathProblem, isMathSkill } from '../core/mathgen';
import { rng } from '../core/mathgen';
import { tokens } from '../core/retrieval';
import { AIProvider, CallOpts, ExtractInput, GenerateInput, GradeInput } from './provider';
import { ConceptExtraction, GeneratedQuestion, GradeResult, QuestionBatch } from './schemas';

const sentences = (t: string) => t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 15);
const top = (s: string, n = 3) => {
  const freq = new Map<string, number>();
  for (const t of tokens(s)) if (t.length > 3) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, n).map(([w]) => w);
};

const MATH_RULES: [RegExp, MathSkill][] = [
  [/compound inequalit/i, 'math.compound_inequality'],
  [/absolute value[^.\n]*(inequalit|less than|greater than|farther|closer)|inequalit[^.\n]*absolute value/i, 'math.abs_inequality'],
  [/absolute value/i, 'math.abs_equation'],
  [/inequalit/i, 'math.linear_inequality'],
  [/(linear|one-step|two-step|multi-step|solving)[^.\n]{0,20}equation/i, 'math.linear_equation'],
  [/\b(union|intersection|subset|venn|sets?\b)/i, 'math.sets'],
];

export class OfflineProvider implements AIProvider {
  readonly live = false;
  readonly name = 'offline';
  readonly label = 'Offline mode (basic templates, no AI)';

  async extractConcepts(i: ExtractInput, _o?: CallOpts): Promise<ConceptExtraction> {
    const out: ConceptExtraction['concepts'] = [];
    const seen = new Set<string>();
    const add = (name: string, summary: string, quote: string, tag?: string) => {
      const key = name.toLowerCase().trim();
      if (seen.has(key) || name.length < 2 || out.length >= i.maxConcepts) return;
      if (/^(examples?|practice|notes?|answers?|page\s*\d*|unit\s*\d+\b.*|review|problems?)\b[:\s\d]*$/i.test(name.trim()) || /^page\s*\d+/i.test(name.trim())) return; // page furniture, not a concept
      seen.add(key);
      out.push({ name: name.slice(0, 90), summary: summary.slice(0, 480), quotes: [quote.slice(0, 380)], prerequisites: [], skill_tag: tag ?? null });
    };
    const text = i.chunks.map((c) => c.text).join('\n'); // chunks arrive already masked by the app
    // math skills first so they get generators. Prefer a "Term: definition" line over any other mention (headings mention everything).
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const defLine = /^[-*•]?\s*\**([A-Za-z][^:]{2,60}):\s+(.{15,})$/;
    const usedLines = new Set<string>();
    for (const [re, tag] of MATH_RULES) {
      if (out.some((c) => c.skill_tag === tag)) continue;
      // a line already used for a more specific skill is not reused (e.g. an absolute-value line is not also 'linear inequalities')
      const cands = lines.filter((l) => !usedLines.has(l) && re.test(l));
      const def = cands.find((l) => { const m = l.match(defLine); return !!m && re.test(m[1]); });
      const best = def ?? cands[0];
      if (!best) continue;
      if (!def && !(cands.length >= 2 && !lines.some((l) => defLine.test(l)))) continue; // incidental mentions only count in notes with no definition lines at all
      usedLines.add(best);
      const m = best.match(defLine);
      add(MATH_SKILLS[tag], (m ? m[2] : best).trim(), best, tag);
    }
    for (const c of i.chunks) for (const raw of c.text.split('\n')) {
      const line = raw.trim().replace(/^[-*•]\s*/, '');
      const m = line.match(/^\**([A-Za-z][A-Za-z0-9 ,'()/-]{1,60}?)\**\s*(?::|\s[–—-]\s)\s+(.{15,})$/);
      if (m && m[1].split(' ').length <= 6) { add(m[1].replace(/\*/g, '').trim(), m[2].trim(), line); continue; }
      const h = line.match(/^#{1,4}\s+(.{3,70})$/);
      if (h) { const idx = c.text.indexOf(raw); const next = sentences(c.text.slice(idx + raw.length))[0]; if (next) add(h[1], next, next); }
    }
    if (out.length === 0) {
      // fallback: key sentences as candidate "ideas"; student can rename/remove
      for (const c of i.chunks) { const s = sentences(c.text)[0]; if (s) add(top(s, 3).join(' ') || s.slice(0, 40), s, s); if (out.length >= Math.min(6, i.maxConcepts)) break; }
    }
    if (!out.length) throw new Error('no concepts found');
    // keep document order so a check starts with the foundations the author introduced first
    const pos = (c: (typeof out)[number]) => { const k = text.indexOf(c.quotes[0] ?? c.name); return k < 0 ? Number.MAX_SAFE_INTEGER : k; };
    out.sort((a, b) => pos(a) - pos(b));
    // well-known prerequisite structure between math skills (app knowledge, not a claim about the student's material)
    const byTag = new Map(out.filter((c) => c.skill_tag).map((c) => [c.skill_tag!, c]));
    const PRE: Record<string, string[]> = { 'math.linear_inequality': ['math.linear_equation'], 'math.compound_inequality': ['math.linear_inequality'], 'math.abs_equation': ['math.linear_equation'], 'math.abs_inequality': ['math.abs_equation', 'math.linear_inequality'] };
    for (const [tag, pres] of Object.entries(PRE)) { const c = byTag.get(tag); if (c) c.prerequisites = pres.map((t) => byTag.get(t)?.name).filter((n): n is string => !!n); }
    return { concepts: out };
  }

  async generateQuestions(i: GenerateInput, _o?: CallOpts): Promise<QuestionBatch> {
    const total = i.practice + i.heldout;
    const qs: GeneratedQuestion[] = [];
    const avoid = new Set(i.avoidPrompts);
    if (isMathSkill(i.concept.skillTag)) {
      for (let k = 0; qs.length < total && k < 60; k++) {
        const p = generateMathProblem(i.concept.skillTag, i.seed * 131 + k * 17 + 1, (i.focus === 'diagnostic' ? 1 + (k % 2) : 2 + (k % 2)) as 1 | 2 | 3);
        if (avoid.has(p.prompt) || qs.some((q) => q.prompt === p.prompt)) continue;
        qs.push({
          kind: 'math', prompt: p.prompt, answer: p.spec.answer, math_type: 'set', relation: p.spec.relation, hints: [...p.hints],
          worked_example: p.workedExample, explanation: p.explanation, difficulty: p.difficulty,
        });
      }
      return { questions: qs };
    }
    const name = i.concept.name, summary = i.concept.summary;
    const excerptSents = i.excerpts.flatMap((e) => sentences(e.text).map((s) => ({ s, label: e.label })));
    const label = i.excerpts[0]?.label ?? 'your notes';
    const keyPoints = sentences(summary).slice(0, 3).map((s) => ({ point: s, keywords: top(s, 4) }));
    if (!keyPoints.length) keyPoints.push({ point: summary, keywords: top(summary, 4) });
    const hints = [`Look back at ${label}. What does it say about “${name}”?`, `Key idea to include: ${summary.split(/\s+/).slice(0, 10).join(' ')}…`];
    const common = { hints, worked_example: `Here is how your material puts it (${label}): ${summary}`, explanation: `${summary} (from ${label}; this is the material's wording, not new facts).`, difficulty: 2 };
    const templates: (() => GeneratedQuestion | null)[] = [
      () => ({ kind: 'explain', prompt: `In your own words, explain “${name}”. What does it mean, and why does it matter?`, rubric: { key_points: keyPoints, sample_answer: summary }, ...common }),
      () => {
        const hit = excerptSents.find((x) => x.s.toLowerCase().includes(name.toLowerCase()));
        if (!hit) return null;
        const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return { kind: 'short_answer', prompt: `Fill in the blank (${hit.label}): “${hit.s.replace(re, '_____')}”`, answer: name, rubric: { key_points: [{ point: name, keywords: [name.toLowerCase()] }] }, ...common, difficulty: 1 };
      },
      () => {
        if (i.otherConcepts.length < 2) return null;
        const r = rng(i.seed + 7);
        const others = [...i.otherConcepts].sort(() => r() - 0.5).slice(0, 3);
        const choices = [{ text: summary.slice(0, 220) }, ...others.map((o) => ({ text: o.summary.slice(0, 220), misconception: `Mixed up with “${o.name}”` }))];
        const order = choices.map((_, k) => k).sort(() => r() - 0.5);
        return { kind: 'multiple_choice', prompt: `Which statement best describes “${name}”?`, choices: order.map((k) => choices[k]), correct_choice: order.indexOf(0), ...common, difficulty: 1 };
      },
      () => ({ kind: 'explain', prompt: `Give a specific example or situation that shows “${name}” in action, and explain why it fits.`, rubric: { key_points: [{ point: `Example connects clearly to: ${keyPoints[0].point}`, keywords: keyPoints[0].keywords }] }, ...common, difficulty: 3 }),
    ];
    const start = i.seed % templates.length;
    for (let k = 0; k < templates.length && qs.length < total; k++) {
      const q = templates[(start + k) % templates.length]();
      if (q && !avoid.has(q.prompt)) qs.push(q);
    }
    return { questions: qs };
  }

  async gradeAnswer(i: GradeInput, _o?: CallOpts): Promise<GradeResult> {
    const a = `${i.answer} ${i.reasoning}`.toLowerCase();
    const pts = i.question.rubric.map((r) => {
      const kws = r.keywords.length ? r.keywords : top(r.point, 3);
      const hit = kws.filter((k) => a.includes(k.toLowerCase()));
      return { point: r.point, met: kws.length > 0 && hit.length >= Math.max(1, Math.ceil(kws.length / 2)) };
    });
    const met = pts.filter((p) => p.met).length;
    const exactTerm = i.question.rubric.length === 1 && i.question.kind === 'short_answer' && a.trim().replace(/[^a-z0-9 ]/g, '') === i.question.rubric[0].point.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const correctness = exactTerm ? 1 : met / Math.max(1, pts.length);
    return {
      correctness, confidence: exactTerm ? 'high' : 'low', points: pts,
      feedback: exactTerm ? 'That matches the term exactly.' :
        `Offline keyword check: you touched ${met} of ${pts.length} key idea${pts.length === 1 ? '' : 's'}. This check only looks for words, not understanding — compare with the key points below and mark how you did.`,
    };
  }
}
