"use strict";
(() => {
    // ── DOM refs ────────────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
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
    function show(el) {
        for (const s of ALL_SCREENS)
            s.classList.add('hidden');
        el.classList.remove('hidden');
    }
    // ── Shared state ────────────────────────────────────────────────────────────
    const assess = { sessionId: null, verses: [], index: 0, currentTurns: [] };
    let activeSkillId = null;
    // ── Boot ─────────────────────────────────────────────────────────────────────
    async function boot_() {
        try {
            const res = await fetch('/api/ledger');
            if (res.ok) {
                await loadDashboard();
            }
            else {
                show(intro);
            }
        }
        catch {
            show(intro);
        }
    }
    // ── Assessment flow ──────────────────────────────────────────────────────────
    document.getElementById('start').addEventListener('click', startAssessment);
    async function startAssessment() {
        document.getElementById('start').disabled = true;
        try {
            const res = await fetch('/api/assessment/start', { method: 'POST' });
            if (!res.ok)
                throw new Error(`start failed: ${res.status}`);
            const data = (await res.json());
            assess.sessionId = data.sessionId;
            assess.verses = data.verses;
            assess.index = 0;
            show(card);
            renderCard();
        }
        catch {
            document.getElementById('start').disabled = false;
            alert('Could not start. Is the server running?');
        }
    }
    function renderCard() {
        const v = assess.verses[assess.index];
        document.getElementById('card-ref').textContent = v.ref;
        document.getElementById('card-verse').textContent = v.text;
        document.getElementById('answer').value = '';
        document.getElementById('follow-up-answer').value = '';
        document.getElementById('follow-up-q').textContent = '';
        unhide(document.getElementById('answer-area'));
        forceHide(document.getElementById('follow-up'));
        forceHide(document.getElementById('thinking'));
        document.getElementById('progress').textContent = `${assess.index + 1} / ${assess.verses.length}`;
        document.getElementById('answer').focus();
        assess.currentTurns = [];
    }
    function setThinking(on) {
        if (on) {
            forceHide(document.getElementById('answer-area'));
            forceHide(document.getElementById('follow-up'));
            unhide(document.getElementById('thinking'));
        }
        else {
            forceHide(document.getElementById('thinking'));
        }
    }
    async function submitAnswer(text, isFollowUp) {
        if (!text.trim())
            return;
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
            if (!res.ok)
                throw new Error(`answer failed: ${res.status}`);
            const data = (await res.json());
            if (data.action === 'follow_up' && !isFollowUp) {
                assess.currentTurns.push({ role: 'tutor', text: data.question });
                document.getElementById('follow-up-q').textContent = data.question;
                document.getElementById('follow-up-answer').value = '';
                forceHide(document.getElementById('answer-area'));
                forceHide(document.getElementById('thinking'));
                unhide(document.getElementById('follow-up'));
                document.getElementById('follow-up-answer').focus();
            }
            else {
                await advanceCard();
            }
        }
        catch {
            setThinking(false);
            unhide(document.getElementById('answer-area'));
            alert('Something went wrong. Try again or check the server logs.');
        }
    }
    async function advanceCard() {
        assess.index += 1;
        if (assess.index >= assess.verses.length) {
            await finishAndAnalyze();
        }
        else {
            renderCard();
        }
    }
    async function finishAndAnalyze() {
        show(analyzing);
        try {
            const fin = await fetch('/api/assessment/finish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: assess.sessionId }),
            });
            if (!fin.ok)
                throw new Error(`finish: ${fin.status}`);
            const ana = await fetch('/api/assessment/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: assess.sessionId }),
            });
            if (!ana.ok) {
                const err = (await ana.json().catch(() => ({})));
                throw new Error(err.error || `analyze: ${ana.status}`);
            }
            const data = (await ana.json());
            renderSnapshot(data);
            show(snapshot);
        }
        catch (err) {
            document.getElementById('failed-msg').textContent =
                err.message || 'Check server logs.';
            show(failed);
        }
    }
    function renderSnapshot({ buckets, totals }) {
        const totalsEl = document.getElementById('snapshot-totals');
        const bucketsEl = document.getElementById('snapshot-buckets');
        totalsEl.innerHTML = '';
        bucketsEl.innerHTML = '';
        const ORDER = [
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
            if (!items.length)
                continue;
            const div = document.createElement('div');
            div.className = 'bucket';
            div.appendChild(Object.assign(document.createElement('h3'), {
                textContent: `${label} — ${items.length}`,
            }));
            const renderItems = (arr) => arr.map(({ id, evidence }) => {
                const item = document.createElement('div');
                item.className = 'bucket-item';
                item.appendChild(Object.assign(document.createElement('p'), {
                    className: 'skill',
                    textContent: id,
                }));
                if (evidence)
                    item.appendChild(Object.assign(document.createElement('p'), {
                        className: 'evidence',
                        textContent: evidence,
                    }));
                return item;
            });
            if (k === 'not_probed' && items.length > 6) {
                renderItems(items.slice(0, 6)).forEach((el) => div.appendChild(el));
                const det = document.createElement('details');
                det.appendChild(Object.assign(document.createElement('summary'), {
                    textContent: `${items.length - 6} more`,
                }));
                renderItems(items.slice(6)).forEach((el) => det.appendChild(el));
                div.appendChild(det);
            }
            else {
                renderItems(items).forEach((el) => div.appendChild(el));
            }
            bucketsEl.appendChild(div);
        }
    }
    document.getElementById('snapshot-continue').addEventListener('click', () => loadDashboard());
    document.getElementById('restart').addEventListener('click', () => location.reload());
    document.getElementById('restart-fail').addEventListener('click', () => location.reload());
    // ── Dashboard ────────────────────────────────────────────────────────────────
    const STATUS_ORDER = [
        ['solid', 'Solid'],
        ['learning', 'Learning'],
        ['shaky', 'Shaky'],
        ['unknown', 'Unknown'],
        ['not_probed', 'Not probed'],
    ];
    function buildStatusColumn(status, label, items, renderItem) {
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
    async function loadDashboard() {
        show(dashboard);
        const queueEl = document.getElementById('queue');
        const emptyEl = document.getElementById('empty-queue');
        const libEl = document.getElementById('library');
        const countsEl = document.getElementById('library-counts');
        queueEl.innerHTML = '<p class="thinking-text">Loading…</p>';
        libEl.innerHTML = '';
        countsEl.innerHTML = '';
        emptyEl.classList.add('hidden');
        try {
            const [qRes, lRes] = await Promise.all([
                fetch('/api/learn/queue'),
                fetch('/api/library'),
            ]);
            if (!qRes.ok)
                throw new Error(`queue: ${qRes.status}`);
            if (!lRes.ok)
                throw new Error(`library: ${lRes.status}`);
            const { items } = (await qRes.json());
            const lib = (await lRes.json());
            queueEl.innerHTML = '';
            if (!items.length) {
                emptyEl.classList.remove('hidden');
            }
            else {
                const grouped = new Map();
                for (const item of items) {
                    if (!grouped.has(item.status))
                        grouped.set(item.status, []);
                    grouped.get(item.status).push(item);
                }
                queueEl.classList.add('status-grid');
                let queueCols = 0;
                for (const [status, label] of STATUS_ORDER) {
                    const group = grouped.get(status);
                    if (!group || !group.length)
                        continue;
                    queueEl.appendChild(buildStatusColumn(status, label, group, buildQueueCard));
                    queueCols++;
                }
                queueEl.style.gridTemplateColumns = `repeat(${queueCols}, 1fr)`;
            }
            renderLibrary(lib, countsEl, libEl);
        }
        catch (err) {
            queueEl.innerHTML = `<p class="thinking-text">Failed to load: ${err.message}</p>`;
        }
    }
    function renderLibrary(lib, countsEl, libEl) {
        countsEl.innerHTML = '';
        for (const [k, label] of STATUS_ORDER) {
            const n = lib.counts[k] || 0;
            if (n === 0)
                continue;
            const pill = document.createElement('span');
            pill.className = `pill ${k}`;
            pill.textContent = `${n} ${label.toLowerCase()}`;
            countsEl.appendChild(pill);
        }
        const grouped = new Map();
        for (const cat of lib.categories) {
            for (const skill of cat.skills) {
                if (!grouped.has(skill.status))
                    grouped.set(skill.status, []);
                grouped.get(skill.status).push(skill);
            }
        }
        libEl.innerHTML = '';
        libEl.classList.add('status-grid');
        let libCols = 0;
        for (const [status, label] of STATUS_ORDER) {
            const group = grouped.get(status);
            if (!group || !group.length)
                continue;
            libEl.appendChild(buildStatusColumn(status, label, group, buildLibraryRow));
            libCols++;
        }
        libEl.style.gridTemplateColumns = `repeat(${libCols}, 1fr)`;
    }
    function buildLibraryRow(skill) {
        const row = document.createElement('div');
        row.className = `library-row status-${skill.status}`;
        row.dataset.skillId = skill.id;
        const left = document.createElement('div');
        left.className = 'library-row-left';
        left.appendChild(Object.assign(document.createElement('span'), {
            className: 'library-teaser',
            textContent: skill.teaser,
        }));
        const right = document.createElement('div');
        right.className = 'library-row-right';
        if (skill.reviewCount > 0) {
            right.appendChild(Object.assign(document.createElement('span'), {
                className: 'review-count',
                textContent: `×${skill.reviewCount}`,
            }));
        }
        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', () => loadLesson(skill.id));
        return row;
    }
    function buildQueueCard(item) {
        const card_ = document.createElement('div');
        card_.className = 'queue-card';
        card_.dataset.skillId = item.id;
        const top = document.createElement('div');
        top.className = 'queue-card-top';
        card_.appendChild(top);
        card_.appendChild(Object.assign(document.createElement('p'), {
            className: 'queue-teaser',
            textContent: item.teaser,
        }));
        if (item.evidence) {
            card_.appendChild(Object.assign(document.createElement('p'), {
                className: 'queue-evidence',
                textContent: `Your answer: "${item.evidence}"`,
            }));
        }
        card_.addEventListener('click', () => loadLesson(item.id));
        return card_;
    }
    document.getElementById('redo-assessment').addEventListener('click', (e) => {
        e.preventDefault();
        show(intro);
        document.getElementById('start').disabled = false;
    });
    // ── Lesson ───────────────────────────────────────────────────────────────────
    async function loadLesson(skillId) {
        activeSkillId = skillId;
        show(lesson);
        document.getElementById('lesson-pattern').textContent = '';
        document.getElementById('lesson-meaning').textContent = '';
        document.getElementById('lesson-examples').innerHTML = '';
        document.getElementById('lesson-why').textContent = '';
        document.getElementById('lesson-status').textContent = '';
        try {
            const res = await fetch(`/api/skill/${skillId}`);
            if (!res.ok)
                throw new Error(`skill: ${res.status}`);
            const { skill, ledger: entry } = (await res.json());
            renderLesson(skill, entry);
        }
        catch (err) {
            document.getElementById('lesson-pattern').textContent = `Failed to load: ${err.message}`;
        }
    }
    function renderLesson(skill, entry) {
        if (entry?.status) {
            document.getElementById('lesson-status').textContent = entry.status;
            document.getElementById('lesson-status').className = `status-pill ${entry.status}`;
        }
        document.getElementById('lesson-pattern').textContent =
            skill.user_facing_pattern || '';
        document.getElementById('lesson-meaning').textContent =
            skill.semantic_note || '';
        document.getElementById('lesson-why').textContent =
            skill.why_explanation || '';
        const exEl = document.getElementById('lesson-examples');
        exEl.innerHTML = '';
        for (const ex of skill.examples || []) {
            exEl.appendChild(buildExample(ex));
        }
    }
    function buildExample(ex) {
        const wrap = document.createElement('div');
        wrap.className = 'example';
        wrap.appendChild(Object.assign(document.createElement('p'), {
            className: 'ref',
            textContent: ex.ref,
        }));
        const verseP = document.createElement('p');
        verseP.className = 'verse example-verse';
        verseP.lang = 'ar';
        verseP.dir = 'rtl';
        if (ex.highlight && ex.text?.includes(ex.highlight)) {
            verseP.innerHTML = ex.text.replace(ex.highlight, `<span class="highlight">${ex.highlight}</span>`);
        }
        else {
            verseP.textContent = ex.text || '';
        }
        wrap.appendChild(verseP);
        if (ex.translation) {
            wrap.appendChild(Object.assign(document.createElement('p'), {
                className: 'translation',
                textContent: ex.translation,
            }));
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
            wrap.appendChild(Object.assign(document.createElement('p'), {
                className: 'example-note',
                textContent: ex.note,
            }));
        }
        return wrap;
    }
    document.getElementById('back-to-dashboard').addEventListener('click', (e) => {
        e.preventDefault();
        loadDashboard();
    });
    document.getElementById('result-got-it').addEventListener('click', () => submitResult('got_it'));
    document.getElementById('result-fuzzy').addEventListener('click', () => submitResult('still_fuzzy'));
    async function submitResult(outcome) {
        document.getElementById('result-got-it').disabled = true;
        document.getElementById('result-fuzzy').disabled = true;
        try {
            const res = await fetch('/api/learn/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ skillId: activeSkillId, outcome }),
            });
            if (!res.ok)
                throw new Error(`result: ${res.status}`);
            show(lessonDone);
            if (outcome === 'got_it') {
                document.getElementById('lesson-done-title').textContent = 'Got it.';
                document.getElementById('lesson-done-lede').textContent =
                    "Marked as learning. You'll see it again during review.";
            }
            else {
                document.getElementById('lesson-done-title').textContent = 'OK.';
                document.getElementById('lesson-done-lede').textContent =
                    'Still flagged. Come back to it whenever you like.';
            }
        }
        catch (err) {
            document.getElementById('result-got-it').disabled = false;
            document.getElementById('result-fuzzy').disabled = false;
            alert(`Could not save: ${err.message}`);
        }
    }
    document.getElementById('lesson-done-back').addEventListener('click', () => loadDashboard());
    // ── Input helpers ────────────────────────────────────────────────────────────
    function unhide(el) {
        el.classList.remove('hidden');
    }
    function forceHide(el) {
        el.classList.add('hidden');
    }
    function bindCmdEnter(el, fn) {
        el.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                fn();
            }
        });
    }
    bindCmdEnter(document.getElementById('answer'), () => submitAnswer(document.getElementById('answer').value, false));
    bindCmdEnter(document.getElementById('follow-up-answer'), () => submitAnswer(document.getElementById('follow-up-answer').value, true));
    document.getElementById('submit').addEventListener('click', () => submitAnswer(document.getElementById('answer').value, false));
    document.getElementById('follow-up-submit').addEventListener('click', () => submitAnswer(document.getElementById('follow-up-answer').value, true));
    // ── Start ────────────────────────────────────────────────────────────────────
    boot_();
})();
