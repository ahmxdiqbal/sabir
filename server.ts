import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { scoreSession } from './lib/scoring.js';
import type { Taxonomy, Verse, Turn, Buckets } from './lib/scoring.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_PATH = path.join(DATA_DIR, 'events.jsonl');
const VERSES_PATH = path.join(DATA_DIR, 'assessment_verses.json');
const TAXONOMY_PATH = path.join(DATA_DIR, 'taxonomy.json');
const LEDGER_PATH = path.join(DATA_DIR, 'ledger.json');

const versesData = JSON.parse(fs.readFileSync(VERSES_PATH, 'utf8')) as { version: number; verses: Verse[] };
const VERSES = versesData.verses;
const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8')) as Taxonomy;

interface Session {
  startedAt: number;
  answers: { ref: string; turns: Turn[] }[];
}

const sessions = new Map<string, Session>();

interface LogEvent {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

function logEvent(event: LogEvent): void {
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n';
  fs.appendFile(EVENTS_PATH, line, (err) => {
    if (err) console.error('events write failed:', err);
  });
}

function newSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

interface FinishedSession {
  type: 'assessment_finish';
  sessionId: string;
  ts: string;
  answers: { ref: string; turns: Turn[] }[];
  [key: string]: unknown;
}

function findFinishedSession(sessionId: string): FinishedSession | null {
  if (!fs.existsSync(EVENTS_PATH)) return null;
  const lines = fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = JSON.parse(lines[i]) as FinishedSession;
    if (ev.type === 'assessment_finish' && ev.sessionId === sessionId) return ev;
  }
  return null;
}

interface LedgerEntry {
  status: string;
  evidence: string;
  source: string;
  lastReviewedAt: string | null;
  reviewCount: number;
}

interface Ledger {
  version: number;
  lastAssessmentAt?: string;
  lastAssessmentSessionId?: string;
  skills: Record<string, LedgerEntry>;
}

function readLedger(): Ledger | null {
  if (!fs.existsSync(LEDGER_PATH)) return null;
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) as Ledger;
}

function writeLedger(ledger: Ledger): void {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

interface ScoreResult {
  status: string;
  evidence: string;
  source: string;
}

function applySnapshotToLedger(scores: Record<string, ScoreResult>, sessionId: string): Ledger {
  const existing = readLedger();
  const skills: Record<string, LedgerEntry> = existing?.skills || {};
  for (const [id, r] of Object.entries(scores)) {
    const prev = skills[id] || { reviewCount: 0, lastReviewedAt: null };
    skills[id] = {
      status: r.status,
      evidence: r.evidence,
      source: r.source,
      lastReviewedAt: prev.lastReviewedAt,
      reviewCount: prev.reviewCount,
    };
  }
  const ledger: Ledger = {
    version: 1,
    lastAssessmentAt: new Date().toISOString(),
    lastAssessmentSessionId: sessionId,
    skills,
  };
  writeLedger(ledger);
  return ledger;
}

async function callDeepSeek(messages: { role: string; content: string }[]): Promise<string | null> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { choices: [{ message: { content: string } }] };
  return data.choices[0].message.content;
}

const ASSESS_SYSTEM = `You are an Arabic comprehension tutor giving a brief, low-stakes assessment. The learner is shown a Quranic verse with no translation and asked to explain what they understand. They are studying Arabic to read the Qur'an and have informal exposure: comfortable with common particles, prefixes, suffixes, and frequent vocabulary; weak on verb forms, broken plurals, and complex constructions.

Your job: decide whether the learner's answer reveals a specific, probeable gap that ONE concrete follow-up question could clarify — or whether their answer is solid enough, or too vague to probe productively, in which case advance.

Output STRICT JSON with no other text:
{"action":"advance"}
OR
{"action":"follow_up","question":"<one concrete question>"}

The follow-up question must:
- Reference one specific word, ending, or prefix in the verse the learner did not address or got wrong
- Be answerable in one or two sentences
- Use plain English. Never use grammatical jargon (no "verb form," "tense," "case," "particle," "noun," "subject," "object," "passive," "active," "imperfective," "perfective," "participle," "masdar," "definite," "indefinite," "vocative")
- Probe gently — not "what does X mean," but rather "what do you make of <specific word/shape>?" or "this word starts with X — what do you think that's doing here?"
- Never reveal the translation
- Never lecture

Theological care: many verses describe actions ultimately caused by Allah. If asking about a verb in such a verse, do not phrase the question as if the verse subject acts autonomously. Be neutral about agency, or let the verse's surrounding meaning carry the cause.

Only ask a follow-up if a focused, useful question exists. If the learner caught the gist and the major moves of the verse, advance. If they wrote almost nothing or wrote vague vibes-level commentary, advance — there is nothing concrete to probe yet.

After the learner answers a follow-up, always advance — no chained follow-ups.`;

function buildAssessMessages(
  verse: Verse,
  turns: Turn[],
): { role: string; content: string }[] {
  const transcript = turns
    .map((t) => `${t.role === 'user' ? 'LEARNER' : 'TUTOR'}: ${t.text}`)
    .join('\n');
  return [
    { role: 'system', content: ASSESS_SYSTEM },
    {
      role: 'user',
      content: `VERSE (${verse.ref}):
${verse.text}

TRANSLATION (your reference only, never share):
${verse.translation}

CONVERSATION SO FAR:
${transcript}

${turns.length === 1 ? "This is the learner's first answer. Decide: advance or follow_up." : 'The learner has just answered your follow-up. Always output {"action":"advance"} now.'}`,
    },
  ];
}

interface AssessResult {
  action: 'advance' | 'follow_up';
  question?: string;
}

function parseAssessResponse(raw: string): AssessResult {
  try {
    const obj = JSON.parse(raw) as AssessResult;
    if (obj.action === 'follow_up' && typeof obj.question === 'string' && obj.question.trim()) {
      return { action: 'follow_up', question: obj.question.trim() };
    }
    return { action: 'advance' };
  } catch {
    return { action: 'advance' };
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/assessment/start', (_req, res) => {
  const sessionId = newSessionId();
  const clientVerses = VERSES.map((v) => ({ ref: v.ref, text: v.text }));
  sessions.set(sessionId, { startedAt: Date.now(), answers: [] });
  logEvent({ type: 'assessment_start', sessionId });
  res.json({ sessionId, verses: clientVerses });
});

interface AnswerBody {
  sessionId?: string;
  verseIndex?: number;
  turns?: Turn[];
}

app.post('/api/assessment/answer', async (req, res) => {
  const { sessionId, verseIndex, turns } = (req.body || {}) as AnswerBody;
  const session = sessions.get(sessionId!);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  if (typeof verseIndex !== 'number' || verseIndex < 0 || verseIndex >= VERSES.length) {
    return res.status(400).json({ error: 'bad verseIndex' });
  }
  if (!Array.isArray(turns) || turns!.length === 0) {
    return res.status(400).json({ error: 'no turns' });
  }

  const verse = VERSES[verseIndex];
  const userTurns = turns!.filter((t) => t.role === 'user');

  let result: AssessResult;
  try {
    if (userTurns.length >= 2) {
      result = { action: 'advance' };
    } else {
      const raw = await callDeepSeek(buildAssessMessages(verse, turns!));
      result = raw ? parseAssessResponse(raw) : { action: 'advance' };
    }
  } catch (err) {
    console.error('assess error:', (err as Error).message);
    result = { action: 'advance' };
  }

  if (result.action === 'advance') {
    session.answers[verseIndex] = { ref: verse.ref, turns: turns! };
  }
  logEvent({ type: 'assessment_turn', sessionId: sessionId!, verseIndex, ref: verse.ref, turns: turns!, result });
  res.json(result);
});

app.post('/api/assessment/finish', (req, res) => {
  const { sessionId } = (req.body || {}) as { sessionId?: string };
  const session = sessions.get(sessionId!);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  logEvent({ type: 'assessment_finish', sessionId: sessionId!, answers: session.answers });
  res.json({ ok: true });
});

app.post('/api/assessment/analyze', async (req, res) => {
  const { sessionId } = (req.body || {}) as { sessionId?: string };
  const session = findFinishedSession(sessionId!);
  if (!session) return res.status(404).json({ error: 'no finished session with that id' });
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(503).json({ error: 'DEEPSEEK_API_KEY not set on the server' });
  }
  try {
    const { scores, buckets } = await scoreSession({
      session,
      taxonomy,
      verses: VERSES,
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    applySnapshotToLedger(scores, sessionId!);
    sessions.delete(sessionId!);
    logEvent({
      type: 'assessment_snapshot',
      sessionId: sessionId!,
      counts: {
        solid: buckets.solid.length,
        shaky: buckets.shaky.length,
        unknown: buckets.unknown.length,
        not_probed: buckets.not_probed.length,
      },
    });
    res.json({
      buckets,
      totals: {
        solid: buckets.solid.length,
        shaky: buckets.shaky.length,
        unknown: buckets.unknown.length,
        not_probed: buckets.not_probed.length,
        total: 50,
      },
    });
  } catch (err) {
    console.error('analyze error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/ledger', (_req, res) => {
  const ledger = readLedger();
  if (!ledger) return res.status(404).json({ error: 'no ledger yet — complete an assessment first' });
  res.json(ledger);
});

interface SkillFromTaxonomy {
  id: string;
  category: string;
  subcategory?: string;
  internal_label: string;
  user_facing_pattern: string;
  semantic_note: string;
  why_explanation: string;
  prerequisites: string[];
  difficulty: number;
  examples: {
    type: string;
    ref: string;
    text: string;
    translation?: string;
    highlight?: string;
    root?: string;
    note?: string;
  }[];
}

const skillById = new Map(taxonomy.skills.map((s) => [s.id, s as SkillFromTaxonomy]));

interface PublicSkill {
  id: string;
  category: string;
  subcategory?: string;
  user_facing_pattern: string;
  semantic_note: string;
  why_explanation: string;
  prerequisites: string[];
  difficulty: number;
  examples: SkillFromTaxonomy['examples'];
}

function publicSkill(skill: SkillFromTaxonomy | undefined): PublicSkill | null {
  if (!skill) return null;
  const { internal_label: _internal_label, ...rest } = skill;
  return rest;
}

interface Anchor {
  ref: string;
  text: string;
  highlight: string | null;
}

function leadAnchor(skill: SkillFromTaxonomy): Anchor | null {
  const ex =
    (skill.examples || []).find((e) => e.type === 'quranic') || skill.examples?.[0] || null;
  return ex ? { ref: ex.ref, text: ex.text, highlight: ex.highlight || null } : null;
}

function patternTeaser(skill: SkillFromTaxonomy, max = 100): string {
  const s = (skill.user_facing_pattern || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return cut.slice(0, lastSpace > 60 ? lastSpace : max) + '…';
}

const STATUS_PRIORITY: Record<string, number> = {
  unknown: 0,
  shaky: 1,
  learning: 2,
  solid: 3,
  not_probed: 4,
};
const STATUS_RANK: Record<string, number> = {
  not_probed: 0,
  unknown: 1,
  shaky: 2,
  learning: 3,
  solid: 4,
};

const CATEGORY_LABELS: Record<string, string> = {
  verbal_morphology: 'Verbs',
  nominal_morphology: 'Nouns and plurals',
  syntax: 'Sentence structure',
};

app.get('/api/learn/queue', (_req, res) => {
  const ledger = readLedger();
  if (!ledger) return res.status(404).json({ error: 'no ledger yet — complete an assessment first' });
  const items: {
    id: string;
    status: string;
    teaser: string;
    anchor: Anchor | null;
    reviewCount: number;
    evidence: string;
    difficulty: number;
  }[] = [];
  for (const [id, entry] of Object.entries(ledger.skills)) {
    if (entry.status !== 'unknown' && entry.status !== 'shaky') continue;
    const skill = skillById.get(id);
    if (!skill) continue;
    items.push({
      id,
      status: entry.status,
      teaser: patternTeaser(skill),
      anchor: leadAnchor(skill),
      reviewCount: entry.reviewCount || 0,
      evidence: entry.evidence || '',
      difficulty: skill.difficulty || 3,
    });
  }
  items.sort((a, b) => {
    const ps = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (ps !== 0) return ps;
    if (a.reviewCount !== b.reviewCount) return a.reviewCount - b.reviewCount;
    if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
    return a.id.localeCompare(b.id);
  });
  res.json({ items });
});

interface LibraryItem {
  id: string;
  status: string;
  teaser: string;
  anchor: Anchor | null;
  reviewCount: number;
  lastReviewedAt: string | null;
  difficulty: number;
}

interface LibraryCategory {
  id: string;
  label: string;
  skills: LibraryItem[];
}

app.get('/api/library', (_req, res) => {
  const ledger = readLedger();
  if (!ledger) return res.status(404).json({ error: 'no ledger yet — complete an assessment first' });

  const counts: Record<string, number> = {
    solid: 0,
    learning: 0,
    shaky: 0,
    unknown: 0,
    not_probed: 0,
  };
  const byCategory = new Map<string, LibraryItem[]>();

  for (const skill of taxonomy.skills) {
    const entry = ledger.skills[skill.id] || {
      status: 'not_probed',
      reviewCount: 0,
      lastReviewedAt: null,
    };
    counts[entry.status] = (counts[entry.status] || 0) + 1;

    const item: LibraryItem = {
      id: skill.id,
      status: entry.status,
      teaser: patternTeaser(skill as SkillFromTaxonomy, 90),
      anchor: leadAnchor(skill as SkillFromTaxonomy),
      reviewCount: entry.reviewCount || 0,
      lastReviewedAt: entry.lastReviewedAt || null,
      difficulty: skill.difficulty || 3,
    };

    if (!byCategory.has(skill.category)) byCategory.set(skill.category, []);
    byCategory.get(skill.category)!.push(item);
  }

  for (const arr of byCategory.values()) {
    arr.sort((a, b) => {
      const r = STATUS_RANK[b.status] - STATUS_RANK[a.status];
      if (r !== 0) return r;
      if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
      return a.id.localeCompare(b.id);
    });
  }

  const categoryOrder = ['verbal_morphology', 'nominal_morphology', 'syntax'];
  const categories: LibraryCategory[] = categoryOrder
    .filter((c) => byCategory.has(c))
    .map((c) => ({ id: c, label: CATEGORY_LABELS[c] || c, skills: byCategory.get(c)! }));

  res.json({ counts, total: taxonomy.skills.length, categories });
});

app.get('/api/skill/:id', (req, res) => {
  const skill = skillById.get(req.params.id);
  if (!skill) return res.status(404).json({ error: 'unknown skill id' });
  const ledger = readLedger();
  const entry = ledger?.skills?.[req.params.id] || null;
  res.json({ skill: publicSkill(skill), ledger: entry });
});

app.post('/api/learn/result', (req, res) => {
  const { skillId, outcome } = (req.body || {}) as {
    skillId?: string;
    outcome?: 'got_it' | 'still_fuzzy';
  };
  if (!skillId || !skillById.has(skillId)) {
    return res.status(400).json({ error: 'unknown skillId' });
  }
  if (outcome !== 'got_it' && outcome !== 'still_fuzzy') {
    return res.status(400).json({ error: 'outcome must be "got_it" or "still_fuzzy"' });
  }
  const ledger = readLedger() || { version: 1, skills: {} };
  const prev = ledger.skills[skillId] || {
    status: 'unknown',
    evidence: '',
    source: 'manual',
    reviewCount: 0,
  };
  const nextStatus =
    outcome === 'got_it'
      ? STATUS_RANK[prev.status] >= STATUS_RANK.learning
        ? prev.status
        : 'learning'
      : prev.status;
  ledger.skills[skillId] = {
    ...prev,
    status: nextStatus,
    lastReviewedAt: new Date().toISOString(),
    reviewCount: (prev.reviewCount || 0) + 1,
  };
  writeLedger(ledger);
  logEvent({
    type: 'lesson_result',
    skillId,
    outcome,
    prevStatus: prev.status,
    newStatus: nextStatus,
  });
  res.json({ ok: true, status: nextStatus });
});

app.listen(PORT, () => {
  console.log(`Sabir running at http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log(
      '  (DEEPSEEK_API_KEY not set — assessments run in stub mode: no follow-ups, no analysis)',
    );
  }
});
