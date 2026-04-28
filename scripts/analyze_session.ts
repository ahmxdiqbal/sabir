import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { scoreSession } from '../lib/scoring.js';
import type { Taxonomy, Verse, Session } from '../lib/scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const TAXONOMY_PATH = path.join(ROOT, 'data', 'taxonomy.json');
const VERSES_PATH = path.join(ROOT, 'data', 'assessment_verses.json');
const EVENTS_PATH = path.join(ROOT, 'data', 'events.jsonl');

function latestFinishedSession(): Session {
  const lines = fs
    .readFileSync(EVENTS_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = JSON.parse(lines[i]) as Session;
    if (ev.type === 'assessment_finish') return ev;
  }
  throw new Error('no completed sessions in events.jsonl');
}

(async () => {
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8')) as Taxonomy;
  const versesData = JSON.parse(fs.readFileSync(VERSES_PATH, 'utf8')) as {
    version: number;
    verses: Verse[];
  };
  const session = latestFinishedSession();
  console.log(`Analyzing session ${session.sessionId} from ${session.ts}`);
  console.log('Calling DeepSeek…');
  const { buckets } = await scoreSession({
    session,
    taxonomy,
    verses: versesData.verses,
    apiKey: process.env.DEEPSEEK_API_KEY!,
  });
  const total = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);
  console.log(`\n=== Skill snapshot — ${total} skills ===\n`);
  for (const status of ['solid', 'shaky', 'unknown', 'not_probed'] as const) {
    const arr = buckets[status];
    console.log(`-- ${status.toUpperCase()} (${arr.length}) --`);
    if (status === 'not_probed' && arr.length > 15) {
      arr.slice(0, 15).forEach((e) => console.log(`  ${e.id}`));
      console.log(`  ... and ${arr.length - 15} more`);
    } else {
      arr.forEach((e) =>
        console.log(`  ${e.id}${e.evidence ? '  — ' + e.evidence : ''}`),
      );
    }
    console.log('');
  }
})().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
