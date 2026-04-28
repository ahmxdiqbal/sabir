(() => {
  // ── Types ──────────────────────────────────────────────────────────────────────
  interface ClientVerse {
    ref: string;
    text: string;
  }

  interface StartResponse {
    sessionId: string;
    verses: ClientVerse[];
  }

  interface Turn {
    role: 'user' | 'tutor';
    text: string;
  }

  interface AnswerResponse {
    action: 'advance' | 'follow_up';
    question?: string;
  }

  interface BucketItem {
    id: string;
    evidence: string;
    source: string;
  }

  interface SnapshotResponse {
    buckets: Record<string, BucketItem[]>;
    totals: Record<string, number>;
  }

  interface QueueItem {
    id: string;
    status: string;
    teaser: string;
    anchor: { ref: string; text: string; highlight: string | null } | null;
    reviewCount: number;
    evidence: string;
    difficulty: number;
  }

  interface QueueResponse {
    items: QueueItem[];
  }

  interface LibrarySkill {
    id: string;
    status: string;
    teaser: string;
    anchor: { ref: string; text: string; highlight: string | null } | null;
    reviewCount: number;
    lastReviewedAt: string | null;
    difficulty: number;
  }

  interface LibraryCategory {
    id: string;
    label: string;
    skills: LibrarySkill[];
  }

  interface LibraryResponse {
    counts: Record<string, number>;
    total: number;
    categories: LibraryCategory[];
  }

  interface SkillExample {
    type: string;
    ref: string;
    text: string;
    translation?: string;
    highlight?: string;
    root?: string;
    note?: string;
  }

  interface SkillDetail {
    user_facing_pattern: string;
    semantic_note: string;
    why_explanation: string;
    examples: SkillExample[];
  }

  interface SkillResponse {
    skill: SkillDetail;
    ledger: { status: string } | null;
  }

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $ = (id: string): HTMLElement => document.getElementById(id)!;

  const boot = $('boot');
  const intro = $('intro');
  const card = $('card');
  const analyzing = $('analyzing');
  const snapshot = $('snapshot');
  const failed = $('failed');
  const dashboard = $('dashboard');
  const lesson = $('lesson');
  const lessonDone = $('lesson-done');

  const ALL_SCREENS = [boot, intro, card, analyzing, snapshot, failed, dashboard, lesson, lessonDone];
  function show(el: HTMLElement): void {
    for (const s of ALL_SCREENS) s.classList.add('hidden');
    el.classList.remove('hidden');
  }

  // ── Shared state ────────────────────────────────────────────────────────────
  const assess: {
    sessionId: string | null;
    verses: ClientVerse[];
    index: number;
    currentTurns: Turn[];
  } = { sessionId: null, verses: [], index: 0, currentTurns: [] };
  let activeSkillId: string | null = null;

  // ── Boot ─────────────────────────────────────────────────────────────────────
  async function boot_(): Promise<void> {
    try {
      const res = await fetch('/api/ledger');
      if (res.ok) {
        await loadDashboard();
      } else {
        show(intro);
      }
    } catch {
      show(intro);
    }
  }

  // ── Assessment flow ──────────────────────────────────────────────────────────
  (document.getElementById('start') as HTMLButtonElement).addEventListener('click', startAssessment);

  async function startAssessment(): Promise<void> {
    (document.getElementById('start') as HTMLButtonElement).disabled = true;
    try {
      const res = await fetch('/api/assessment/start', { method: 'POST' });
      if (!res.ok) throw new Error(`start failed: ${res.status}`);
      const data = (await res.json()) as StartResponse;
      assess.sessionId = data.sessionId;
      assess.verses = data.verses;
      assess.index = 0;
      show(card);
      renderCard();
    } catch {
      (document.getElementById('start') as HTMLButtonElement).disabled = false;
      alert('Could not start. Is the server running?');
    }
  }

  function renderCard(): void {
    const v = assess.verses[assess.index];
    (document.getElementById('card-ref') as HTMLElement).textContent = v.ref;
    (document.getElementById('card-verse') as HTMLElement).textContent = v.text;
    (document.getElementById('answer') as HTMLTextAreaElement).value = '';
    (document.getElementById('follow-up-answer') as HTMLTextAreaElement).value = '';
    (document.getElementById('follow-up-q') as HTMLElement).textContent = '';
    unhide(document.getElementById('answer-area')!);
    forceHide(document.getElementById('follow-up')!);
    forceHide(document.getElementById('thinking')!);
    (document.getElementById('progress') as HTMLElement).textContent = `${assess.index + 1} / ${assess.verses.length}`;
    (document.getElementById('answer') as HTMLTextAreaElement).focus();
    assess.currentTurns = [];
  }

  function setThinking(on: boolean): void {
    if (on) {
      forceHide(document.getElementById('answer-area')!);
      forceHide(document.getElementById('follow-up')!);
      unhide(document.getElementById('thinking')!);
    } else {
      forceHide(document.getElementById('thinking')!);
    }
  }

  async function submitAnswer(text: string, isFollowUp: boolean): Promise<void> {
    if (!text.trim()) return;
    setThinking(true);
    assess.currentTurns.push({ role: 'user', text: text.trim() });
    try {
      const res = await fetch('/api/assessment/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: assess.sessionId,
          verseIndex: assess.index,
          turns: assess.currentTurns,
        }),
      });
      if (!res.ok) throw new Error(`answer failed: ${res.status}`);
      const data = (await res.json()) as AnswerResponse;
      if (data.action === 'follow_up' && !isFollowUp) {
        assess.currentTurns.push({ role: 'tutor', text: data.question! });
        (document.getElementById('follow-up-q') as HTMLElement).textContent = data.question!;
        (document.getElementById('follow-up-answer') as HTMLTextAreaElement).value = '';
        forceHide(document.getElementById('answer-area')!);
        forceHide(document.getElementById('thinking')!);
        unhide(document.getElementById('follow-up')!);
        (document.getElementById('follow-up-answer') as HTMLTextAreaElement).focus();
      } else {
        await advanceCard();
      }
    } catch {
      setThinking(false);
      unhide(document.getElementById('answer-area')!);
      alert('Something went wrong. Try again or check the server logs.');
    }
  }

  async function advanceCard(): Promise<void> {
    assess.index += 1;
    if (assess.index >= assess.verses.length) {
      await finishAndAnalyze();
    } else {
      renderCard();
    }
  }

  async function finishAndAnalyze(): Promise<void> {
    show(analyzing);
    try {
      const fin = await fetch('/api/assessment/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: assess.sessionId }),
      });
      if (!fin.ok) throw new Error(`finish: ${fin.status}`);
      const ana = await fetch('/api/assessment/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: assess.sessionId }),
      });
      if (!ana.ok) {
        const err = (await ana.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `analyze: ${ana.status}`);
      }
      const data = (await ana.json()) as SnapshotResponse;
      renderSnapshot(data);
      show(snapshot);
    } catch (err) {
      (document.getElementById('failed-msg') as HTMLElement).textContent =
        (err as Error).message || 'Check server logs.';
      show(failed);
    }
  }

  function renderSnapshot({ buckets, totals }: SnapshotResponse): void {
    const totalsEl = document.getElementById('snapshot-totals')!;
    const bucketsEl = document.getElementById('snapshot-buckets')!;
    totalsEl.innerHTML = '';
    bucketsEl.innerHTML = '';
    const ORDER: [string, string][] = [
      ['solid', 'Solid'],
      ['shaky', 'Shaky'],
      ['unknown', 'Unknown'],
      ['not_probed', 'Not probed'],
    ];
    for (const [k, label] of ORDER) {
      const pill = Object.assign(document.createElement('span'), {
        className: `pill ${k}`,
        textContent: `${label}: ${totals[k]}`,
      });
      totalsEl.appendChild(pill);
    }
    for (const [k, label] of ORDER) {
      const items = buckets[k] || [];
      if (!items.length) continue;
      const div = document.createElement('div');
      div.className = 'bucket';
      div.appendChild(
        Object.assign(document.createElement('h3'), {
          textContent: `${label} — ${items.length}`,
        }),
      );
      const renderItems = (arr: BucketItem[]): HTMLElement[] =>
        arr.map(({ id, evidence }) => {
          const item = document.createElement('div');
          item.className = 'bucket-item';
          item.appendChild(
            Object.assign(document.createElement('p'), {
              className: 'skill',
              textContent: id,
            }),
          );
          if (evidence)
            item.appendChild(
              Object.assign(document.createElement('p'), {
                className: 'evidence',
                textContent: evidence,
              }),
            );
          return item;
        });
      if (k === 'not_probed' && items.length > 6) {
        renderItems(items.slice(0, 6)).forEach((el) => div.appendChild(el));
        const det = document.createElement('details');
        det.appendChild(
          Object.assign(document.createElement('summary'), {
            textContent: `${items.length - 6} more`,
          }),
        );
        renderItems(items.slice(6)).forEach((el) => det.appendChild(el));
        div.appendChild(det);
      } else {
        renderItems(items).forEach((el) => div.appendChild(el));
      }
      bucketsEl.appendChild(div);
    }
  }

  (document.getElementById('snapshot-continue') as HTMLButtonElement).addEventListener(
    'click',
    () => loadDashboard(),
  );
  (document.getElementById('restart') as HTMLButtonElement).addEventListener('click', () =>
    location.reload(),
  );
  (document.getElementById('restart-fail') as HTMLButtonElement).addEventListener('click', () =>
    location.reload(),
  );

  // ── Dashboard ────────────────────────────────────────────────────────────────
  const STATUS_ORDER: [string, string][] = [
    ['solid', 'Solid'],
    ['learning', 'Learning'],
    ['shaky', 'Shaky'],
    ['unknown', 'Unknown'],
    ['not_probed', 'Not probed'],
  ];

  function buildStatusColumn<T>(
    status: string,
    label: string,
    items: T[],
    renderItem: (item: T) => HTMLElement,
  ): HTMLElement {
    const col = document.createElement('div');
    col.className = 'status-column';
    const header = document.createElement('div');
    header.className = `status-column-header ${status}`;
    header.textContent = `${label} — ${items.length}`;
    col.appendChild(header);
    const list = document.createElement('div');
    list.className = 'status-column-list';
    for (const item of items) {
      list.appendChild(renderItem(item));
    }
    col.appendChild(list);
    return col;
  }

  async function loadDashboard(): Promise<void> {
    show(dashboard);
    const queueEl = document.getElementById('queue')!;
    const emptyEl = document.getElementById('empty-queue')!;
    const libEl = document.getElementById('library')!;
    const countsEl = document.getElementById('library-counts')!;

    queueEl.innerHTML = '<p class="thinking-text">Loading…</p>';
    libEl.innerHTML = '';
    countsEl.innerHTML = '';
    emptyEl.classList.add('hidden');

    try {
      const [qRes, lRes] = await Promise.all([
        fetch('/api/learn/queue'),
        fetch('/api/library'),
      ]);
      if (!qRes.ok) throw new Error(`queue: ${qRes.status}`);
      if (!lRes.ok) throw new Error(`library: ${lRes.status}`);
      const { items } = (await qRes.json()) as QueueResponse;
      const lib = (await lRes.json()) as LibraryResponse;

      queueEl.innerHTML = '';
      if (!items.length) {
        emptyEl.classList.remove('hidden');
      } else {
        const grouped = new Map<string, QueueItem[]>();
        for (const item of items) {
          if (!grouped.has(item.status)) grouped.set(item.status, []);
          grouped.get(item.status)!.push(item);
        }
        queueEl.classList.add('status-grid');
        let queueCols = 0;
        for (const [status, label] of STATUS_ORDER) {
          const group = grouped.get(status);
          if (!group || !group.length) continue;
          queueEl.appendChild(buildStatusColumn(status, label, group, buildQueueCard));
          queueCols++;
        }
        queueEl.style.gridTemplateColumns = `repeat(${queueCols}, 1fr)`;
      }

      renderLibrary(lib, countsEl, libEl);
    } catch (err) {
      queueEl.innerHTML = `<p class="thinking-text">Failed to load: ${(err as Error).message}</p>`;
    }
  }

  function renderLibrary(
    lib: LibraryResponse,
    countsEl: HTMLElement,
    libEl: HTMLElement,
  ): void {
    countsEl.innerHTML = '';
    for (const [k, label] of STATUS_ORDER) {
      const n = lib.counts[k] || 0;
      if (n === 0) continue;
      const pill = document.createElement('span');
      pill.className = `pill ${k}`;
      pill.textContent = `${n} ${label.toLowerCase()}`;
      countsEl.appendChild(pill);
    }

    const grouped = new Map<string, LibrarySkill[]>();
    for (const cat of lib.categories) {
      for (const skill of cat.skills) {
        if (!grouped.has(skill.status)) grouped.set(skill.status, []);
        grouped.get(skill.status)!.push(skill);
      }
    }

    libEl.innerHTML = '';
    libEl.classList.add('status-grid');
    let libCols = 0;
    for (const [status, label] of STATUS_ORDER) {
      const group = grouped.get(status);
      if (!group || !group.length) continue;
      libEl.appendChild(buildStatusColumn(status, label, group, buildLibraryRow));
      libCols++;
    }
    libEl.style.gridTemplateColumns = `repeat(${libCols}, 1fr)`;
  }

  function buildLibraryRow(skill: LibrarySkill): HTMLElement {
    const row = document.createElement('div');
    row.className = `library-row status-${skill.status}`;
    row.dataset.skillId = skill.id;

    const left = document.createElement('div');
    left.className = 'library-row-left';
    if (skill.anchor?.highlight) {
      left.appendChild(
        Object.assign(document.createElement('span'), {
          className: 'library-arabic',
          lang: 'ar',
          dir: 'rtl',
          textContent: skill.anchor.highlight,
        }),
      );
    }
    left.appendChild(
      Object.assign(document.createElement('span'), {
        className: 'library-teaser',
        textContent: skill.teaser,
      }),
    );

    const right = document.createElement('div');
    right.className = 'library-row-right';
    right.appendChild(
      Object.assign(document.createElement('span'), {
        className: `status-pill ${skill.status}`,
        textContent: skill.status === 'not_probed' ? 'not probed' : skill.status,
      }),
    );
    if (skill.reviewCount > 0) {
      right.appendChild(
        Object.assign(document.createElement('span'), {
          className: 'review-count',
          textContent: `×${skill.reviewCount}`,
        }),
      );
    }

    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener('click', () => loadLesson(skill.id));
    return row;
  }

  function buildQueueCard(item: QueueItem): HTMLElement {
    const card_ = document.createElement('div');
    card_.className = 'queue-card';
    card_.dataset.skillId = item.id;

    const top = document.createElement('div');
    top.className = 'queue-card-top';

    if (item.anchor?.highlight) {
      top.appendChild(
        Object.assign(document.createElement('p'), {
          className: 'queue-arabic',
          lang: 'ar',
          dir: 'rtl',
          textContent: item.anchor.highlight,
        }),
      );
    }

    const pill = Object.assign(document.createElement('span'), {
      className: `status-pill ${item.status}`,
      textContent: item.status,
    });
    top.appendChild(pill);
    card_.appendChild(top);
    card_.appendChild(
      Object.assign(document.createElement('p'), {
        className: 'queue-teaser',
        textContent: item.teaser,
      }),
    );
    if (item.evidence) {
      card_.appendChild(
        Object.assign(document.createElement('p'), {
          className: 'queue-evidence',
          textContent: `Your answer: "${item.evidence}"`,
        }),
      );
    }
    card_.addEventListener('click', () => loadLesson(item.id));
    return card_;
  }

  (document.getElementById('redo-assessment') as HTMLAnchorElement).addEventListener('click', (e) => {
    e.preventDefault();
    show(intro);
    (document.getElementById('start') as HTMLButtonElement).disabled = false;
  });

  // ── Lesson ───────────────────────────────────────────────────────────────────
  async function loadLesson(skillId: string): Promise<void> {
    activeSkillId = skillId;
    show(lesson);
    (document.getElementById('lesson-pattern') as HTMLElement).textContent = '';
    (document.getElementById('lesson-meaning') as HTMLElement).textContent = '';
    (document.getElementById('lesson-examples') as HTMLElement).innerHTML = '';
    (document.getElementById('lesson-why') as HTMLElement).textContent = '';
    (document.getElementById('lesson-status') as HTMLElement).textContent = '';
    try {
      const res = await fetch(`/api/skill/${skillId}`);
      if (!res.ok) throw new Error(`skill: ${res.status}`);
      const { skill, ledger: entry } = (await res.json()) as SkillResponse;
      renderLesson(skill, entry);
    } catch (err) {
      (document.getElementById('lesson-pattern') as HTMLElement).textContent = `Failed to load: ${(err as Error).message}`;
    }
  }

  function renderLesson(skill: SkillDetail, entry: { status: string } | null): void {
    if (entry?.status) {
      (document.getElementById('lesson-status') as HTMLElement).textContent = entry.status;
      (document.getElementById('lesson-status') as HTMLElement).className = `status-pill ${entry.status}`;
    }
    (document.getElementById('lesson-pattern') as HTMLElement).textContent =
      skill.user_facing_pattern || '';
    (document.getElementById('lesson-meaning') as HTMLElement).textContent =
      skill.semantic_note || '';
    (document.getElementById('lesson-why') as HTMLElement).textContent =
      skill.why_explanation || '';

    const exEl = document.getElementById('lesson-examples')!;
    exEl.innerHTML = '';
    for (const ex of skill.examples || []) {
      exEl.appendChild(buildExample(ex));
    }
  }

  function buildExample(ex: SkillExample): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'example';

    wrap.appendChild(
      Object.assign(document.createElement('p'), {
        className: 'ref',
        textContent: ex.ref,
      }),
    );

    const verseP = document.createElement('p');
    verseP.className = 'verse example-verse';
    verseP.lang = 'ar';
    verseP.dir = 'rtl';
    if (ex.highlight && ex.text?.includes(ex.highlight)) {
      verseP.innerHTML = ex.text.replace(
        ex.highlight,
        `<span class="highlight">${ex.highlight}</span>`,
      );
    } else {
      verseP.textContent = ex.text || '';
    }
    wrap.appendChild(verseP);

    if (ex.translation) {
      wrap.appendChild(
        Object.assign(document.createElement('p'), {
          className: 'translation',
          textContent: ex.translation,
        }),
      );
    }
    if (ex.highlight) {
      const hw = document.createElement('p');
      hw.className = 'highlight-word';
      hw.lang = 'ar';
      hw.dir = 'rtl';
      hw.textContent = ex.highlight;
      wrap.appendChild(hw);
    }
    if (ex.note) {
      wrap.appendChild(
        Object.assign(document.createElement('p'), {
          className: 'example-note',
          textContent: ex.note,
        }),
      );
    }
    return wrap;
  }

  (document.getElementById('back-to-dashboard') as HTMLAnchorElement).addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      loadDashboard();
    },
  );

  (document.getElementById('result-got-it') as HTMLButtonElement).addEventListener(
    'click',
    () => submitResult('got_it'),
  );
  (document.getElementById('result-fuzzy') as HTMLButtonElement).addEventListener(
    'click',
    () => submitResult('still_fuzzy'),
  );

  async function submitResult(outcome: 'got_it' | 'still_fuzzy'): Promise<void> {
    (document.getElementById('result-got-it') as HTMLButtonElement).disabled = true;
    (document.getElementById('result-fuzzy') as HTMLButtonElement).disabled = true;
    try {
      const res = await fetch('/api/learn/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: activeSkillId, outcome }),
      });
      if (!res.ok) throw new Error(`result: ${res.status}`);
      show(lessonDone);
      if (outcome === 'got_it') {
        (document.getElementById('lesson-done-title') as HTMLElement).textContent = 'Got it.';
        (document.getElementById('lesson-done-lede') as HTMLElement).textContent =
          "Marked as learning. You'll see it again during review.";
      } else {
        (document.getElementById('lesson-done-title') as HTMLElement).textContent = 'OK.';
        (document.getElementById('lesson-done-lede') as HTMLElement).textContent =
          'Still flagged. Come back to it whenever you like.';
      }
    } catch (err) {
      (document.getElementById('result-got-it') as HTMLButtonElement).disabled = false;
      (document.getElementById('result-fuzzy') as HTMLButtonElement).disabled = false;
      alert(`Could not save: ${(err as Error).message}`);
    }
  }

  (document.getElementById('lesson-done-back') as HTMLButtonElement).addEventListener(
    'click',
    () => loadDashboard(),
  );

  // ── Input helpers ────────────────────────────────────────────────────────────
  function unhide(el: HTMLElement): void {
    el.classList.remove('hidden');
  }
  function forceHide(el: HTMLElement): void {
    el.classList.add('hidden');
  }

  function bindCmdEnter(el: HTMLElement, fn: () => void): void {
    el.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        fn();
      }
    });
  }

  bindCmdEnter(document.getElementById('answer')!, () =>
    submitAnswer((document.getElementById('answer') as HTMLTextAreaElement).value, false),
  );
  bindCmdEnter(document.getElementById('follow-up-answer')!, () =>
    submitAnswer(
      (document.getElementById('follow-up-answer') as HTMLTextAreaElement).value,
      true,
    ),
  );
  (document.getElementById('submit') as HTMLButtonElement).addEventListener('click', () =>
    submitAnswer((document.getElementById('answer') as HTMLTextAreaElement).value, false),
  );
  (document.getElementById('follow-up-submit') as HTMLButtonElement).addEventListener(
    'click',
    () =>
      submitAnswer(
        (document.getElementById('follow-up-answer') as HTMLTextAreaElement).value,
        true,
      ),
  );

  // ── Start ────────────────────────────────────────────────────────────────────
  boot_();
})();
