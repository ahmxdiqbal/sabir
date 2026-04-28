const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const TAXONOMY_PATH = path.join(ROOT, 'data', 'taxonomy.json');
const VERSES_PATH = path.join(ROOT, 'data', 'assessment_verses.json');
const EVENTS_PATH = path.join(ROOT, 'data', 'events.jsonl');

const { scoreSession } = require('../lib/scoring');

function latestFinishedSession() {
  const lines = fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = JSON.parse(lines[i]);
    if (ev.type === 'assessment_finish') return ev;
  }
  throw new Error('no completed sessions in events.jsonl');
}

(async () => {
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  const verses = JSON.parse(fs.readFileSync(VERSES_PATH, 'utf8')).verses;
  const session = latestFinishedSession();
  console.log(`Analyzing session ${session.sessionId} from ${session.ts}`);
  console.log('Calling DeepSeek…');
  const { buckets } = await scoreSession({
    session,
    taxonomy,
    verses,
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  const total = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);
  console.log(`\n=== Skill snapshot — ${total} skills ===\n`);
  for (const status of ['solid', 'shaky', 'unknown', 'not_probed']) {
    const arr = buckets[status];
    console.log(`-- ${status.toUpperCase()} (${arr.length}) --`);
    if (status === 'not_probed' && arr.length > 15) {
      arr.slice(0, 15).forEach((e) => console.log(`  ${e.id}`));
      console.log(`  ... and ${arr.length - 15} more`);
    } else {
      arr.forEach((e) => console.log(`  ${e.id}${e.evidence ? '  — ' + e.evidence : ''}`));
    }
    console.log('');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
