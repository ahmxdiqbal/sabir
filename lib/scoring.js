function buildSessionDigest(session) {
  return session.answers
    .map((a, i) => {
      if (!a) return `[Verse ${i + 1}] no answer recorded`;
      const lines = a.turns.map((t) => `    ${t.role.toUpperCase()}: ${t.text}`).join('\n');
      return `[Verse ${i + 1}] ${a.ref}\n${lines}`;
    })
    .join('\n\n');
}

function buildAnchors(taxonomy, verses) {
  const skillById = new Map(taxonomy.skills.map((s) => [s.id, s]));
  const probedSkills = new Map();

  for (const v of verses) {
    for (const skillId of v.probes || []) {
      const skill = skillById.get(skillId);
      if (!skill) continue;
      if (!probedSkills.has(skillId)) {
        probedSkills.set(skillId, {
          id: skillId,
          label: skill.internal_label,
          summary: skill.semantic_note.replace(/\s+/g, ' ').slice(0, 220),
          probes: [],
        });
      }
      const matchingExample = (skill.examples || []).find((ex) => ex.type === 'quranic' && ex.ref === v.ref);
      probedSkills.get(skillId).probes.push({
        ref: v.ref,
        verseText: v.text,
        word: matchingExample?.highlight || null,
      });
    }
  }
  return probedSkills;
}

const SYSTEM_PROMPT = `You are scoring a learner of Quranic Arabic against a fixed skill taxonomy.

The learner just completed a 10-verse cold-start assessment. They saw each verse with no translation and explained what they understood. For some verses they also answered a follow-up question.

You will be told, for each PROBED skill, which verse(s) exercise it and the specific Arabic word(s) the skill governs. You MUST score every probed skill — "not_probed" is forbidden for these.

Score each probed skill as one of:
- "solid" — the learner's wording shows they recognize the specific word/shape and handle it correctly. Translating the verse correctly counts ONLY when the relevant word's meaning is in their answer in a way that requires recognition (not just a guess from context).
- "shaky" — the learner got the verse's gist but their answer doesn't show recognition of THIS specific word/form, OR they handled it once but inconsistently, OR they paraphrased around it.
- "unknown" — the learner explicitly said "I don't know," "I don't understand," skipped the relevant word, or got it wrong. If a verse exercising this skill stumped them and they said so, this is unknown — not "not_probed."

Hard rules:
1. If the learner literally wrote "don't know" / "I don't understand" / "<I dont understand the rest>" about the verse or the specific word → unknown.
2. If the learner translated the verse generally but never addressed the anchor word and the anchor word is the load-bearing piece → shaky at most. Don't credit recognition the answer doesn't show.
3. If the learner correctly translated a phrase that requires recognizing the anchor word (e.g. translated يَا as "O" or لَا as "not") → solid for that skill.
4. Be specific in your evidence — quote 5–15 words of what the learner wrote and tie it to the anchor word.

Output STRICT JSON only:
{
  "probed": {
    "<skill_id>": { "status": "solid|shaky|unknown", "evidence": "<quote + tie to anchor>" },
    ...
  },
  "incidental": {
    "<skill_id>": { "status": "solid|shaky|unknown", "evidence": "..." }
  }
}

"probed" must contain every probed skill exactly once. "incidental" is optional — use it if you spot clear evidence (positive or negative) for a skill that wasn't explicitly probed.`;

function buildUserPrompt(probedSkills, digest) {
  const skillBlocks = [...probedSkills.values()].map((s) => {
    const probeLines = s.probes
      .map((p) => `    - Verse ${p.ref}: anchor word = ${p.word || '(no anchor identified — use the verse text)'}\n      verse text: ${p.verseText.replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    return `${s.id} — ${s.label}
  what it tests: ${s.summary}
  probes:
${probeLines}`;
  });

  return `PROBED SKILLS (you MUST score every one of these):

${skillBlocks.join('\n\n')}

LEARNER'S ASSESSMENT SESSION:
${digest}

Score every probed skill. Add incidental scores only when there is clear evidence. Output the JSON object now.`;
}

async function callDeepSeek(messages, apiKey) {
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function mergeScores(probed, incidental, allSkillIds, probedIds) {
  const out = {};
  for (const id of allSkillIds) {
    if (probedIds.has(id)) {
      out[id] = probed[id]
        ? { status: probed[id].status, evidence: probed[id].evidence || '', source: 'probed' }
        : { status: 'unknown', evidence: '(model omitted score — defaulted to unknown)', source: 'probed_missing' };
    } else if (incidental && incidental[id]) {
      out[id] = { status: incidental[id].status, evidence: incidental[id].evidence || '', source: 'incidental' };
    } else {
      out[id] = { status: 'not_probed', evidence: '', source: 'not_probed' };
    }
  }
  return out;
}

function bucketize(scores) {
  const buckets = { solid: [], shaky: [], unknown: [], not_probed: [] };
  for (const [id, r] of Object.entries(scores)) {
    buckets[r.status].push({ id, evidence: r.evidence, source: r.source });
  }
  return buckets;
}

async function scoreSession({ session, taxonomy, verses, apiKey }) {
  const probedSkills = buildAnchors(taxonomy, verses);
  const probedIds = new Set(probedSkills.keys());
  const allSkillIds = taxonomy.skills.map((s) => s.id);
  const digest = buildSessionDigest(session);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(probedSkills, digest) },
  ];
  const raw = await callDeepSeek(messages, apiKey);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse model output as JSON: ${raw}`);
  }
  if (!parsed.probed) {
    throw new Error(`Model output missing "probed" key: ${JSON.stringify(parsed)}`);
  }
  const scores = mergeScores(parsed.probed, parsed.incidental || {}, allSkillIds, probedIds);
  return { scores, buckets: bucketize(scores), probedIds: [...probedIds] };
}

module.exports = { scoreSession, bucketize };
