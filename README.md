# Sabir

A local Arabic tutor for Qur'anic comprehension. Shows you verses without translation, asks what you understand, and maps your answers against a morphological skill taxonomy. No sign-up, no accounts — runs on your machine.

## Setup

```
npm install
cp .env.example .env   # add your DEEPSEEK_API_KEY
```

## Run

```
npm start     # builds client + starts server
npm run dev   # watch mode (server only)
```

Open `http://localhost:3000`.

## How it works

1. **Assessment** — 10 verses, no translations. You describe what you recognize. DeepSeek may ask a brief follow-up if it spots a gap worth probing.
2. **Snapshot** — your answers are scored against 50 morphological skills (solid / shaky / unknown / not probed).
3. **Lessons** — skills flagged shaky or unknown become a queue. Each lesson shows the pattern, examples from the Qur'an, and an explanation. You mark it "got it" or "still fuzzy."
4. **Ledger** — a running record of your proficiency across all skills, stored locally in `data/ledger.json`.

## Stack

- **Server** — Node.js, Express, TypeScript (run with [tsx](https://github.com/privatenumber/tsx))
- **Client** — vanilla TypeScript, compiled to JS
- **AI** — DeepSeek V4 Pro for follow-up questions and session scoring
- **Data** — JSON files on disk (`data/taxonomy.json`, `data/assessment_verses.json`, `data/ledger.json`)

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key | (required) |
| `DEEPSEEK_MODEL` | Model for tutor and scoring | `deepseek-v4-pro` |
| `PORT` | Server port | `3000` |
