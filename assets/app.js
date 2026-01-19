(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    index: [],
    filter: "ALL",
    categoryFilter: "ALL", // cat-01..cat-10 or ALL
    chunkCache: new Map(),
    terms: { common: [], synonyms: {} }, // legacy suggestions; kept for UI chips
    categories: [],
    categoriesById: {},
    concepts: [],
    conceptsById: {},
    // Precomputed lookup
    allTerms: [], // [{termNorm, termRaw, conceptId}]
    profile: null,
    expandedGroups: new Set(),
    lastQuery: "",
    lastActiveTopics: [],
    lastQueryConceptTerms: [],

    // View + pagination (mobile/offline safe)
    view: 'browse',
    search: { pageSize: 50, visible: 50, renderCap: 500, key: '', results: [] },
    reader: { active: false, pageSize: 30, visible: 30, chunk: null, file: '', label: '', fromView: 'search', fromScrollY: 0 },
  };

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\/_]+/g, " ")
      .replace(/[-]+/g, " ")
      .replace(/[^a-z0-9\s\.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setStatus(msg){ $("status").textContent = msg; }

  function normalizeFilePath(file) {
    const f = String(file || "");
    const base = f.split("/").pop();
    if (f.startsWith("dcs_json/")) return `./data/dcs/${base}`;
    if (f.startsWith("brc_json/")) return `./data/brc/${base}`;
    if (f.startsWith("title9_json/")) return `./data/title9/${base}`;
    if (f.startsWith("./")) return f;
    if (f.startsWith("data/")) return `./${f}`;
    return `./${f}`;
  }

  function getDcsChapterFromPath(filePath) {
    const fp = String(filePath || '');
    // Expected: ./data/dcs/dcs_ch05.json (be tolerant)
    const m = fp.match(/\bdcs[_-]?ch(\d{1,2})\b/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  // Detect a structured BRC-style section reference like "8-5-12" or "Section 8-5-12".
  // This is distinct from chapter intent and should hard-prefer the actual section record
  // (anchor match) over secondary mentions in other documents.
  function detectSectionQuery(qRaw) {
    const q = String(qRaw || '').trim();
    if (!q) return null;
    // Match common patterns: 8-5-12, 8-5-12., Section 8-5-12, Sec. 8-5-12
    const m = q.match(/\b(?:sec(?:tion)?\.?\s*)?(\d{1,2})-(\d{1,2})-(\d{1,3})\b/i);
    if (!m) return null;
    const section = `${parseInt(m[1],10)}-${parseInt(m[2],10)}-${parseInt(m[3],10)}`;
    return { section, raw: q };
  }

  function sectionAnchorMatch(rec, sectionIntent) {
    if (!sectionIntent) return 0;
    const a = String(rec.anchor || '').trim();
    if (!a) return 0;
    return a === sectionIntent.section ? 1 : 0;
  }

  // Tier contract from user:
  // Tier A: DCS 4, 9
  // Tier B: DCS 5, 6, 7, 8
  // Tier C: DCS 1, 2, 3, 10
  // Tier D: all BRC and all Title 9 (weighted the same)
  function getTierWeight(rec) {
    const corpus = String(rec.corpus || '').toUpperCase();
    if (corpus === 'DCS') {
      const ch = getDcsChapterFromPath(rec.file || rec.chunk || rec.path);
      if (ch === 4 || ch === 9) return 0;
      if (ch === 5 || ch === 6 || ch === 7 || ch === 8) return 1;
      if (ch === 1 || ch === 2 || ch === 3 || ch === 10) return 2;
      // Unknown chapter: still DCS, but lowest DCS tier
      return 2;
    }
    // Tier D: BRC + Title 9, treated equally
    if (corpus === 'BRC' || corpus === 'TITLE9' || corpus === 'TITLE 9') return 3;
    return 3;
  }

  async function loadIndex() {
    const res = await fetch("./data/cross_corpus_index.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load cross_corpus_index.json");
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.records)) throw new Error("Index format unexpected");
    state.index = payload.records;
    setStatus(`Index loaded (${state.index.length.toLocaleString()} records)`);
  }

  async function loadInspectorTerms() {
    try {
      const res = await fetch("./data/inspector_terms.json", { cache: "no-store" });
      if (!res.ok) return;
      const t = await res.json();
      if (t && typeof t === "object") {
        state.terms.common = Array.isArray(t.common) ? t.common : [];
        state.terms.synonyms = (t.synonyms && typeof t.synonyms === "object") ? t.synonyms : {};
      }
    } catch (_) {}
  }

  async function loadCategories() {
    const res = await fetch("./data/categories.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load categories.json");
    const payload = await res.json();
    const cats = Array.isArray(payload?.categories) ? payload.categories : [];
    state.categories = cats;
    state.categoriesById = Object.fromEntries(cats.map(c => [c.id, c]));
  }

  function buildConceptTermIndex() {
    const all = [];
    for (const c of state.concepts) {
      const terms = Array.isArray(c.terms) ? c.terms : [];
      const normed = [];
      for (const t of terms) {
        const raw = String(t || "").trim();
        if (!raw) continue;
        const tn = norm(raw);
        if (!tn) continue;
        normed.push(tn);
        all.push({ termNorm: tn, termRaw: raw, conceptId: c.conceptId });
      }
      // longest-first helps phrase matching
      c._termNorms = Array.from(new Set(normed)).sort((a,b)=>b.length-a.length);
    }
    // longest-first global term scan
    state.allTerms = all.sort((a,b)=>b.termNorm.length-a.termNorm.length);

    // Maps for concept-term coverage
    state.conceptTermsNormById = {};
    state.termNormToConceptIds = {};
    for (const c of state.concepts) {
      state.conceptTermsNormById[c.conceptId] = new Set(c._termNorms || []);
    }
    for (const t of state.allTerms) {
      if (!t || !t.termNorm) continue;
      if (!state.termNormToConceptIds[t.termNorm]) state.termNormToConceptIds[t.termNorm] = new Set();
      state.termNormToConceptIds[t.termNorm].add(t.conceptId);
    }
  }

  async function loadConcepts() {
    const res = await fetch("./data/concepts.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load concepts.json");
    const payload = await res.json();
    const concepts = Array.isArray(payload?.concepts) ? payload.concepts : [];
    state.concepts = concepts;
    state.conceptsById = Object.fromEntries(concepts.map(c => [c.conceptId, c]));
    buildConceptTermIndex();
  }

  function matchConceptsForRecord(rec) {
    const heading = String(rec.heading || "");
    const hayRaw = `${rec.anchor || ""} ${heading} ${rec.text || rec.snippet || ""}`;
    const hay = norm(hayRaw);
    const head = norm(heading);

    let best = null; // {conceptId, score}
    const hits = new Set();

    // Scan concepts with their own term lists (bounded; fast enough for ~2.6k records)
    for (const c of state.concepts) {
      const termNorms = c._termNorms || [];
      let localBestLen = 0;
      let inHeading = false;
      for (const tn of termNorms) {
        if (!tn) continue;
        if (head && head.includes(tn)) {
          inHeading = true;
          localBestLen = max(localBestLen, tn.length);
          break;
        }
        if (hay.includes(tn)) {
          localBestLen = max(localBestLen, tn.length);
          // keep scanning in case a longer term exists
        }
      }
      if (localBestLen > 0) {
        hits.add(c.conceptId);
        const score = (inHeading ? 1000 : 0) + localBestLen;
        if (!best || score > best.score) best = { conceptId: c.conceptId, score };
      }
    }

    rec._concepts = Array.from(hits);
    const bestConcept = best ? state.conceptsById[best.conceptId] : null;
    rec._primaryCategoryId = bestConcept?.primaryCategoryId || "";
  }

  function max(a,b){ return a>b?a:b; }

  function annotateIndex() {
    for (const rec of state.index) matchConceptsForRecord(rec);
  }

  async function loadInspectorProfile() {
    try {
      const res = await fetch("./data/inspector_profile.json", { cache: "no-store" });
      if (!res.ok) return;
      const p = await res.json();
      if (p && typeof p === "object") state.profile = p;
    } catch (_) {}
  }

  function buildSuggestionsUI() {
    const dl = document.getElementById("suggestions");
    if (dl) {
      dl.innerHTML = "";
      const seen = new Set();
      for (const s of state.terms.common) {
        const v = String(s || "").trim();
        if (!v) continue;
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const opt = document.createElement("option");
        opt.value = v;
        dl.appendChild(opt);
      }
    }

    const chips = document.getElementById("chips");
    if (chips) {
      chips.innerHTML = "";
      for (const s of state.terms.common.slice(0, 12)) {
        const v = String(s || "").trim();
        if (!v) continue;
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.textContent = v;
        b.addEventListener("click", () => {
          $("q").value = v;
          runSearch();
          $("q").focus();
        });
        chips.appendChild(b);
      }
    }
  }

  function setActiveFilter(corpus) {
    state.filter = corpus;
    document.querySelectorAll(".filter").forEach(b => {
      b.classList.toggle("active", b.dataset.corpus === corpus);
    });
    runSearch();
  }

  function getQuery() {
    return $("q").value.trim().toLowerCase();
  }

  function detectChapterQuery(q){
    const raw = String(q||'').trim().toLowerCase();
    // Accept: 'chapter 5', 'ch 5', 'ch05', 'chapter05'
    const m = raw.match(/\bch(?:apter)?\s*0?(\d{1,2})\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) return null;
    if (n < 1 || n > 99) return null;
    return n;
  }

  function chapterMatch(rec, n){
    if (!n) return false;
    const corpus = String(rec.corpus||'').toUpperCase();
    if (corpus === 'DCS') return Number(rec.path?.chapter) === n;
    if (corpus === 'TITLE9' || corpus === 'TITLE 9') return Number(rec.path?.chapter) === n;
    return false;
  }

  function readerContextLabel(rec){
    const corpus = String(rec.corpus||'');
    if (corpus === 'DCS') return `DCS — Chapter ${rec.path?.chapter ?? ''}`;
    if (corpus === 'BRC') return `BRC — Title ${String(rec.path?.title ?? '').padStart(2,'0')}`;
    if (corpus === 'TITLE9') return `Title 9 — Chapter ${rec.path?.chapter ?? ''}`;
    return corpus || 'Reader';
  }

  function setView(v){
    state.view = v;
  }

  function detectQueryConcepts(q) {
    const qn = norm(q);
    const bestByConcept = new Map(); // conceptId -> {len, termRaw, termNorm}
    if (!qn) return { concepts: [], matches: [] };

    // longest-first scan; stop early when term is longer than remaining? (keep simple)
    for (const t of state.allTerms) {
      if (!t?.termNorm) continue;
      if (!qn.includes(t.termNorm)) continue;
      const prev = bestByConcept.get(t.conceptId);
      if (!prev || t.termNorm.length > prev.len) {
        bestByConcept.set(t.conceptId, { len: t.termNorm.length, termRaw: t.termRaw, termNorm: t.termNorm });
      }
    }

    const matches = Array.from(bestByConcept.entries()).map(([conceptId, info]) => ({ conceptId, ...info }));
    matches.sort((a,b)=>b.len-a.len);
    return { concepts: matches.map(m=>m.conceptId), matches };
  }

  function tokensFromQuery(q) {
    const raw = String(q || "").toLowerCase();
    const stop = new Set((state.profile?.stopwords || []).map(s => String(s).toLowerCase()));
    return raw
      .split(/\s+/)
      .map(t => t.replace(/[^a-z0-9\-\.\(\)]+/g, "").trim())
      .filter(t => t && !stop.has(t));
  }

  function detectIntents(q) {
    const raw = String(q || "").toLowerCase();
    const ik = state.profile?.intent_keywords || {};
    const topics = [];
    for (const [topic, kws] of Object.entries(ik)) {
      if (!Array.isArray(kws)) continue;
      if (kws.some(k => k && raw.includes(String(k).toLowerCase()))) topics.push(topic);
    }
    return { topics };
  }

  function classifySurface(hay) {
    const sk = state.profile?.surface_keywords || {};
    const h = String(hay || "").toLowerCase();
    for (const [label, arr] of Object.entries(sk)) {
      for (const k of (arr || [])) {
        if (k && h.includes(String(k).toLowerCase())) return label;
      }
    }
    return "";
  }

  function classifyPhase(hay) {
    const pk = state.profile?.phase_keywords || {};
    const h = String(hay || "").toLowerCase();
    for (const [label, arr] of Object.entries(pk)) {
      for (const k of (arr || [])) {
        if (k && h.includes(String(k).toLowerCase())) return label;
      }
    }
    return "";
  }

  function tagRecord(rec) {
    const hay = `${rec.heading || ""} ${rec.text || ""} ${rec.snippet || ""} ${rec.anchor || ""}`.toLowerCase();
    const tags = [];

    // Core ROW buckets
    if (/(restore|restoration|patch|patching|repair|replac|sawcut|backfill|compaction)/.test(hay)) tags.push("Restoration");
    if (/(traffic control|tcmp|mutcd|barricade|cone|detour|flagger|lane closure)/.test(hay)) tags.push("Traffic Control");
    if (/(permit|right-of-way|\brow\b|license|authorization)/.test(hay)) tags.push("Permitting");

    // Utilities (use conservative cues; boosts happen via intent gates)
    if (/(telecommunication|telecommunications|\btelecom\b|communications|fiber optic|conduit|duct|handhole|pull box|vault|splice)/.test(hay)) tags.push("Utilities — Telecom/Fiber");
    if (/(\belectric\b|electrical|power|transformer|pedestal)/.test(hay)) tags.push("Utilities — Electric");
    if (/(\bgas\b|gas main|gas service|meter|regulator)/.test(hay)) tags.push("Utilities — Gas");
    if (/(\bwater\b|water main|hydrant|valve|service line|backflow)/.test(hay)) tags.push("Utilities — Water");
    if (/(\bsewer\b|sanitary|manhole|lateral)/.test(hay)) tags.push("Utilities — Sewer");
    if (/(stormwater|\bstorm\b|inlet|catch basin|culvert|drain|outfall)/.test(hay)) tags.push("Utilities — Storm");

    // Bikes
    if (/(\bbike\b|bicycle|bike lane|bikeway|pavement marking|striping)/.test(hay)) tags.push("Bikes");

    // CRM-ish maintenance
    if (/(encroachment|obstruction|overgrown|vegetation|hedge|sight distance|visibility|sidewalk obstruction)/.test(hay)) tags.push("Maintenance/CRM");

    const surface = classifySurface(hay);
    if (surface) tags.push(surface);

    const phase = classifyPhase(hay);
    if (phase) tags.push(phase);

    return tags;
  }


  function scoreRecord(rec, q, intents, qConcept) {
    // Inspector-first scoring with a hard guarantee: if a record contains the query
    // (phrase or tokens), it can be returned. We do not suppress matches; we rank them.
    if (state.filter !== "ALL" && rec.corpus !== state.filter) return null;
    if (!q) return null;

    const headingRaw = String(rec.heading || "");
    const textRaw = String(rec.text || rec.snippet || "");
    const phrase = String(q || "").toLowerCase();
    const heading = headingRaw.toLowerCase();
    const text = textRaw.toLowerCase();
    const hay = `${String(rec.anchor || "").toLowerCase()} ${heading} ${text}`;

    // Exact-phrase intent: if the user's query appears verbatim (after normalization),
    // it should outrank tier/hierarchy for search results.
    const phraseNorm = norm(q);
    const hayNorm = norm(hay);
    const isExactPhrase = (phraseNorm.length >= 3) && hayNorm.includes(phraseNorm);

    const weights = state.profile?.weights || {};
    const wHeadingPhrase = weights.heading_phrase ?? 50;
    const wTextPhrase = weights.text_phrase ?? 25;
    const wConcept = weights.concept_match ?? 12;
    const wProx = weights.proximity ?? 15;

    const tokens = tokensFromQuery(q);

    const qConceptIds = Array.isArray(qConcept?.concepts) ? qConcept.concepts : [];





    // Minimum evidence requirement (anti-false-positive):
    //  - phrase hit qualifies, OR
    //  - all "salient" tokens must hit.
    //
    // This prevents queries like "utility markings" from matching anything that
    // only contains "utility".
    const softStop = new Set([
      'utility','utilities','system','systems','standard','standards','requirement','requirements',
      'spec','specs','specification','specifications','general','section','chapter','title','code'
    ]);
    const salient = tokens.filter(t => t && !softStop.has(t));

    // Locates / markings hard intent detection
    const locatesAliases = ['811','one call','one-call','locate','locates','marking','markings','markout','paint','flags','flag','white paint','blue paint','red paint','orange paint','green paint','purple paint'];
    const isLocatesQuery = locatesAliases.some(k => phrase.includes(k));

    let minHit = false;
    if (phrase && phrase.length >= 3 && (heading.includes(phrase) || text.includes(phrase))) {
      minHit = true;
    } else if (salient.length) {
      if (isLocatesQuery) {
        // For locates queries, accept any locate/marking alias as evidence
        minHit = locatesAliases.some(k => k && hay.includes(String(k).toLowerCase()));
      } else {
        // Require ALL salient tokens (1+)
        minHit = salient.every(t => {
          if (hay.includes(t)) return true;
          // If the token is a known concept term in the query, allow any term from that concept as evidence
          const cids = state.termNormToConceptIds?.[t];
          if (!cids) return false;
          for (const cid of cids) {
            if (!qConceptIds.includes(cid)) continue;
            const termsSet = state.conceptTermsNormById?.[cid];
            if (!termsSet) continue;
            for (const tn of termsSet) {
              if (tn && hay.includes(tn)) return true;
            }
          }
          return false;
        });
      }
    } else {
      // If query is only soft-stop tokens, fall back to requiring any token.
      minHit = tokens.some(t => t && hay.includes(t));
    }
    if (!minHit) return null;

    let score = 0;
    const rationaleBits = [];

    // Corpus priority (DCS first)
    score += (state.profile?.corpus_boost?.[rec.corpus] ?? 0);

    // Exact phrase outranks hierarchy: strong boost plus a flag for sorting.
    rec._exact = isExactPhrase ? 1 : 0;
    if (isExactPhrase) {
      score += 50000;
      rationaleBits.push('Exact phrase');
    }

    // Hard-boost exact phrase matches so they rise above the tier contract.
    // (Tiering still applies when there is no exact phrase match.)
    if (isExactPhrase) {
      score += 50000;
      rationaleBits.push('Exact phrase');
    }

    // Phrase boosts
    if (phrase.length >= 4 && heading.includes(phrase)) { score += wHeadingPhrase; rationaleBits.push("Phrase in heading"); }
    else if (phrase.length >= 4 && text.includes(phrase)) { score += wTextPhrase; rationaleBits.push("Phrase in text"); }

    // Token boosts
    let tokHits = 0;
    for (const t of tokens) {
      if (t && hay.includes(t)) tokHits += 1;
    }
    if (tokHits) score += Math.min(40, tokHits * 6);

    // Concept/category boosts (rank only; never suppress)
    const recConcepts = Array.isArray(rec._concepts) ? rec._concepts : [];
    if (qConceptIds.length) {
      let conceptHits = 0;
      for (const cid of qConceptIds) {
        if (recConcepts.includes(cid)) conceptHits += 1;
      }
      if (conceptHits) {
        score += conceptHits * (wConcept * 2);
        rationaleBits.push(`Concept hits: ${conceptHits}`);
      } else {
        score -= wConcept; // slight penalty, but keep it in results if it matched text/tokens
      }
    }

    // Locates / markings hard intent: if the query is clearly about locates, strongly
    // prefer cat-02 and penalize anything that isn't actually about markings/locates.
    if (isLocatesQuery) {
      if ((rec._primaryCategoryId || '') === 'cat-02') {
        score += 60;
        rationaleBits.push('Locates priority');
      } else {
        score -= 35;
      }
    }

    // Intent boosts/penalties (rank only)
    if (Array.isArray(intents.topics) && intents.topics.length) {
      const gates = state.profile?.topic_gates || {};
      let onTopic = false;
      for (const t of intents.topics) {
        const gate = gates[t] || [];
        const hit = Array.isArray(gate) && gate.some(k => k && hay.includes(String(k).toLowerCase()));
        if (hit) {
          onTopic = true;
          score += (state.profile?.topic_boost?.[t] ?? 0);
        }
      }
      if (!onTopic) {
        score -= (state.profile?.off_topic_penalty ?? 18);
        rationaleBits.push("Off-topic");
      } else {
        rationaleBits.push("ROW intent match");
      }
    }

    // Surface + phase boosts when user signals them
    const userSurface = classifySurface(phrase);
    const recSurface = classifySurface(hay);
    if (userSurface && recSurface && userSurface === recSurface) {
      score += 20;
      rationaleBits.push(`Surface: ${recSurface}`);
    }

    const userPhase = classifyPhase(phrase);
    const recPhase = classifyPhase(hay);
    if (userPhase && recPhase && userPhase === recPhase) {
      score += 15;
      rationaleBits.push(`Phase: ${recPhase}`);
    }

    // Proximity boost using tokens (works for both concept and non-concept queries)
    if (tokens.length >= 2) {
      const words = text.split(/\s+/);
      const pos = [];
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        for (const t of tokens) {
          if (t && w.includes(t)) pos.push(i);
        }
      }
      if (pos.length >= 2) {
        pos.sort((a,b)=>a-b);
        const span = pos[pos.length-1] - pos[0];
        if (span <= 40) {
          score += wProx;
          rationaleBits.push("Proximity boost");
        }
      }
    }

    rec._score = score;
    rec._exact = isExactPhrase ? 1 : 0;
    rec._rationale = rationaleBits.join("; ");
    rec._tags = tagRecord(rec);
    return rec;
  }

  function groupKey(rec, activeTopics) {
    const catId = rec._primaryCategoryId || "";
    const catLabel = (state.categoriesById[catId]?.label) || "Other";
    // UI contract: display categories by label only (no IDs like cat-01).
    let lead = `${catLabel}`;

    if (rec.corpus === "DCS") {
      const ch = rec.path?.chapter ?? "";
      return `${lead} • DCS — Chapter ${ch}`;
    }
    if (rec.corpus === "BRC") {
      const t = rec.path?.title ?? "";
      return `${lead} • BRC — Title ${String(t).padStart(2,"0")}`;
    }
    if (rec.corpus === "TITLE9") {
      const ch = rec.path?.chapter ?? "";
      return `${lead} • Title 9 — Chapter ${ch}`;
    }
    return `${lead} • ${rec.corpus}`;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"]/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  }

  function escapeRegExp(s){
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightSnippetHtml(snippet, query){
    const snip = String(snippet || "");
    const qRaw = String(query || "").trim();
    if (!snip || !qRaw) return escapeHtml(snip);

    // Terms: full query (if meaningful) + tokens (>=3 chars). Longest-first.
    const terms = [];
    const qNorm = qRaw.toLowerCase();
    if (qNorm.length >= 3) terms.push(qNorm);
    for (const t of qNorm.split(/\s+/)) {
      const v = t.replace(/[^a-z0-9\-]+/g, "").trim();
      if (v && v.length >= 3) terms.push(v);
    }
    const uniq = Array.from(new Set(terms)).sort((a,b)=>b.length-a.length);
    if (!uniq.length) return escapeHtml(snip);

    const pattern = uniq.map(escapeRegExp).join("|");
    const re = new RegExp(`(${pattern})`, "gi");

    // Sentinel wrapping prevents HTML injection issues.
    const OPEN = "\u0000HIT_OPEN\u0000";
    const CLOSE = "\u0000HIT_CLOSE\u0000";
    const marked = snip.replace(re, `${OPEN}$1${CLOSE}`);
    const escaped = escapeHtml(marked);
    return escaped
      .replaceAll(OPEN, '<span class="hit">')
      .replaceAll(CLOSE, '</span>');
  }

  function buildSnippet(fullText, query, matchTerms) {
    const MAX = 375;
    const HALF = Math.floor(MAX / 2);

    const text = String(fullText || "");
    if (!text) return "";

    const lower = text.toLowerCase();
    const q = String(query || "").toLowerCase().trim();

    const candidates = [];
    // Prefer matched concept phrases (multiword) first
    if (Array.isArray(matchTerms)) {
      for (const t of matchTerms) {
        const v = String(t || "").toLowerCase().trim();
        if (v && v.length >= 4) candidates.push(v);
      }
    }
    if (q && q.length >= 4) {
      candidates.push(q);
      candidates.push(q.replace(/-/g, " "));
    }

    // Fall back to tokens
    for (const tok of q.split(/\s+/)) {
      const t = tok.replace(/[^a-z0-9\-]+/g, "").trim();
      if (t && t.length >= 3) candidates.push(t);
    }

    let idx = -1;
    let hitLen = 0;
    for (const c of candidates) {
      const pos = lower.indexOf(c);
      if (pos >= 0) { idx = pos; hitLen = c.length; break; }
    }

    if (idx < 0) {
      // No hit found; return leading snippet capped.
      return text.replace(/\s+/g, " ").trim().slice(0, MAX);
    }

    const center = idx + Math.floor(hitLen / 2);
    let start = Math.max(0, center - HALF);
    let end = Math.min(text.length, start + MAX);
    start = Math.max(0, end - MAX);

    let snip = text.slice(start, end).replace(/\s+/g, " ").trim();

    if (start > 0) snip = "…" + snip;
    if (end < text.length) snip = snip + "…";
    return snip;
  }


  function renderResults(list, opts = {}) {
    if (!opts.skipCount) $("count").textContent = list.length.toLocaleString();
    const container = $("results");
    container.innerHTML = "";

    if (!list.length) {
      container.innerHTML = '<div class="card"><div class="snip">No results.</div></div>';
      return;
    }

    // Build category buckets (collapsed by default) for scroll navigation.
    const buckets = new Map(); // catId -> recs[]
    for (const rec of list) {
      const catId = (rec._primaryCategoryId && state.categoriesById[rec._primaryCategoryId])
        ? rec._primaryCategoryId
        : 'OTHER';
      if (!buckets.has(catId)) buckets.set(catId, []);
      buckets.get(catId).push(rec);
    }

    // Order categories:
    //  - Browse mode (no query): workflow order (categories.json)
    //  - Search mode (query present): relevance order (highest relevance category first)
    //    and hide empty categories entirely.
    let orderedCatIds = [];
    const queryActive = Boolean((state.lastQuery || '').trim());

    if (queryActive) {
      // Derive per-category relevance from the full scored result set when available.
      // This avoids category-window ordering being dominated by the default workflow list.
      const full = Array.isArray(state.search?.results) && state.search.results.length
        ? state.search.results
        : list;
      orderedCatIds = computeCategoryOrderFromResults(full, { hideEmpty: true });
      // Preserve OTHER at the end if it exists and has results.
      if (buckets.has('OTHER') && !orderedCatIds.includes('OTHER')) orderedCatIds.push('OTHER');
    } else {
      for (const c of state.categories) orderedCatIds.push(c.id);
      if (buckets.has('OTHER')) orderedCatIds.push('OTHER');
    }

    const perCatDefault = (opts.perCatDefault ?? 20);

    for (const catId of orderedCatIds) {
      const recs = buckets.get(catId);
      if (!recs || !recs.length) continue;

      // Respect dropdown selection by hiding non-matching buckets in UI
      if (state.categoryFilter && state.categoryFilter !== 'ALL' && catId !== state.categoryFilter) continue;

      // Within-category ordering during search should respect exactness first.
      // (Exact phrase/anchor matches must surface above hierarchy.)
      recs.sort((a,b)=>{
        const ea = (a._exact || 0);
        const eb = (b._exact || 0);
        if (ea !== eb) return eb - ea;
        const sa = (a._score || 0);
        const sb = (b._score || 0);
        if (sa !== sb) return sb - sa;
        const ta = (a._tier ?? getTierWeight(a));
        const tb = (b._tier ?? getTierWeight(b));
        if (ta !== tb) return ta - tb;
        return 0;
      });

      const label = (catId === 'OTHER')
        ? 'Other'
        : (state.categoriesById[catId]?.label || 'Other');

      const details = document.createElement('details');
      details.className = 'catgroup';
      // collapsed on landing; if user selected a specific category, open it.
      if (state.categoryFilter && state.categoryFilter !== 'ALL') details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'catgroup-summary';
      summary.innerHTML = `<span class="catgroup-title">${escapeHtml(label)}</span><span class="catgroup-count">${recs.length}</span>`;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'catgroup-body';

      const expandedKey = `cat:${catId}`;
      const expanded = state.expandedGroups.has(expandedKey);
      const showN = expanded ? recs.length : Math.min(perCatDefault, recs.length);

      for (const rec of recs.slice(0, showN)) {
        const card = document.createElement('div');
        card.className = 'card';

        const top = document.createElement('div');
        top.className = 'card-top';

        const left = document.createElement('div');
        const badges = document.createElement('div');
        badges.className = 'badges';

      const catBadge = `<span class="badge badge-soft">${escapeHtml(label)}</span>`;

        const location = (() => {
          if (rec.corpus === 'DCS') {
            const ch = rec.path?.chapter ?? '';
            return `DCS Ch ${ch}`;
          }
          if (rec.corpus === 'BRC') {
            const t = rec.path?.title ?? '';
            return `BRC Title ${String(t).padStart(2,'0')}`;
          }
          if (rec.corpus === 'TITLE9') {
            const ch = rec.path?.chapter ?? '';
            return `Title 9 Ch ${ch}`;
          }
          return rec.corpus;
        })();

        badges.innerHTML = `${catBadge}
          <span class="badge"><strong>${escapeHtml(rec.corpus)}</strong></span>
          <span class="badge">${escapeHtml(location)}</span>
          <span class="badge">Anchor: <strong>${escapeHtml(rec.anchor)}</strong></span>`;
        left.appendChild(badges);

        const heading = document.createElement('div');
        heading.className = 'heading';
        heading.textContent = rec.heading || '(No heading)';
        left.appendChild(heading);

        const snip = document.createElement('p');
        snip.className = 'snip';
        const snippetText = buildSnippet(rec.text || rec.snippet || '', state.lastQuery, state.lastQueryConceptTerms);
        snip.innerHTML = highlightSnippetHtml(snippetText, state.lastQuery);
        left.appendChild(snip);

        top.appendChild(left);
        card.appendChild(top);

        const actions = document.createElement('div');
        actions.className = 'actions';
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Show code';
        btn.addEventListener('click', () => toggleVerbatim(card, rec, btn));
        actions.appendChild(btn);

        // Read-through mode (per chapter/title)
        const readLabel = (rec.corpus === 'BRC') ? 'Read title' : 'Read chapter';
        const readBtn = document.createElement('button');
        readBtn.className = 'btn';
        readBtn.type = 'button';
        readBtn.textContent = readLabel;
        readBtn.addEventListener('click', () => openReaderForRecord(rec));
        actions.appendChild(readBtn);

        card.appendChild(actions);

        body.appendChild(card);
      }

      if (recs.length > perCatDefault) {
        const moreWrap = document.createElement('div');
        moreWrap.className = 'actions';
        const more = document.createElement('button');
        more.className = 'btn';
        more.textContent = expanded ? 'Show fewer' : `Show more (${recs.length - perCatDefault})`;
        more.addEventListener('click', () => {
          if (state.expandedGroups.has(expandedKey)) state.expandedGroups.delete(expandedKey);
          else state.expandedGroups.add(expandedKey);
          renderResults(list);
        });
        moreWrap.appendChild(more);
        body.appendChild(moreWrap);
      }

      details.appendChild(body);
      container.appendChild(details);
    }
  }

  async function fetchJsonWithFallbacks(path) {
    // GitHub Pages + SW caching can be finicky when repos are served from a subpath.
    // Try a small set of safe fallbacks before failing.
    const candidates = [];
    const p = String(path || "");
    if (p) candidates.push(p);
    if (p.startsWith("./")) candidates.push(p.slice(2));
    else candidates.push(`./${p}`);

    // Also try resolving relative to the current directory explicitly
    try {
      const url = new URL(p, window.location.href).toString();
      candidates.push(url);
    } catch (_) {}

    const seen = new Set();
    for (const c of candidates) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      const res = await fetch(c, { cache: "no-store" });
      if (res.ok) return { url: c, data: await res.json() };
      // Keep going on 404/500 to try other candidates
    }
    throw new Error(`Failed to load chunk: ${path}`);
  }



  function renderBrowse() {
    const container = $("results");
    container.innerHTML = "";

    const buckets = new Map(); // catId -> recs
    for (const rec of state.index) {
      if (state.filter !== 'ALL' && rec.corpus !== state.filter) continue;
      const catId = (rec._primaryCategoryId && state.categoriesById[rec._primaryCategoryId]) ? rec._primaryCategoryId : 'OTHER';
      if (!buckets.has(catId)) buckets.set(catId, []);
      buckets.get(catId).push(rec);
    }

    const orderedCatIds = [];
    for (const c of state.categories) orderedCatIds.push(c.id);
    if (buckets.has('OTHER')) orderedCatIds.push('OTHER');

    const perCatDefault = 25;
    let total = 0;

    for (const catId of orderedCatIds) {
      if (state.categoryFilter && state.categoryFilter !== 'ALL' && catId !== state.categoryFilter) continue;
      const recs = buckets.get(catId);
      if (!recs || !recs.length) continue;

      const corpusRank = (c) => {
        const cc = String(c || '').toUpperCase();
        if (cc === 'DCS') return 0;
        if (cc === 'TITLE9' || cc === 'TITLE 9') return 1;
        if (cc === 'BRC') return 2;
        return 3;
      };

      // Browse mode should not look "BRC-only" due to alphabetical truncation.
      // Sort by tier/corpus/location first, then heading.
      recs.sort((a,b) => {
        const ta = getTierWeight(a);
        const tb = getTierWeight(b);
        if (ta !== tb) return ta - tb;
        const ra = corpusRank(a.corpus);
        const rb = corpusRank(b.corpus);
        if (ra !== rb) return ra - rb;
        const la = String(a.corpus||'') + ' ' + String(a.path?.chapter ?? a.path?.title ?? '');
        const lb = String(b.corpus||'') + ' ' + String(b.path?.chapter ?? b.path?.title ?? '');
        if (la !== lb) return la.localeCompare(lb);
        return String(a.heading||'').localeCompare(String(b.heading||''));
      });

      const label = (catId === 'OTHER') ? 'Other' : (state.categoriesById[catId]?.label || 'Other');

      const details = document.createElement('details');
      details.className = 'catgroup';

      const summary = document.createElement('summary');
      summary.className = 'catgroup-summary';
      summary.innerHTML = `<span class="catgroup-title">${escapeHtml(label)}</span><span class="catgroup-count">${recs.length}</span>`;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'catgroup-body';

      const showN = Math.min(perCatDefault, recs.length);
      total += showN;

      for (const rec of recs.slice(0, showN)) {
        const card = document.createElement('div');
        card.className = 'card';

        const top = document.createElement('div');
        top.className = 'card-top';

        const left = document.createElement('div');
        const badges = document.createElement('div');
        badges.className = 'badges';

        const catBadge = `<span class="badge badge-soft">${escapeHtml(label)}</span>`;

        const location = (() => {
          if (rec.corpus === 'DCS') return `DCS Ch ${escapeHtml(rec.path?.chapter ?? '')}`;
          if (rec.corpus === 'BRC') return `BRC Title ${escapeHtml(String(rec.path?.title ?? '').padStart(2,'0'))}`;
          if (rec.corpus === 'TITLE9') return `Title 9 Ch ${escapeHtml(rec.path?.chapter ?? '')}`;
          return escapeHtml(rec.corpus || '');
        })();

        badges.innerHTML = `${catBadge}
          <span class="badge"><strong>${escapeHtml(rec.corpus)}</strong></span>
          <span class="badge">${location}</span>
          <span class="badge">Anchor: <strong>${escapeHtml(rec.anchor)}</strong></span>`;
        left.appendChild(badges);

        const heading = document.createElement('div');
        heading.className = 'heading';
        heading.textContent = rec.heading || '(No heading)';
        left.appendChild(heading);

        const snip = document.createElement('p');
        snip.className = 'snip';
        const snippetText = buildSnippet(rec.text || rec.snippet || '', state.lastQuery, state.lastQueryConceptTerms);
        snip.innerHTML = highlightSnippetHtml(snippetText, state.lastQuery);
        left.appendChild(snip);

        top.appendChild(left);
        card.appendChild(top);

        const actions = document.createElement('div');
        actions.className = 'actions';
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Show code';
        btn.addEventListener('click', () => toggleVerbatim(card, rec, btn));
        actions.appendChild(btn);

        // Read-through mode (per chapter/title)
        const readLabel = (rec.corpus === 'BRC') ? 'Read title' : 'Read chapter';
        const readBtn = document.createElement('button');
        readBtn.className = 'btn';
        readBtn.type = 'button';
        readBtn.textContent = readLabel;
        readBtn.addEventListener('click', () => openReaderForRecord(rec));
        actions.appendChild(readBtn);

        card.appendChild(actions);

        body.appendChild(card);
      }

      details.appendChild(body);
      container.appendChild(details);
    }

    $("count").textContent = total.toLocaleString();
    if (!container.children.length) {
      container.innerHTML = '<div class="card"><div class="snip">No items for the selected filters.</div></div>';
    }
  }
  async function loadChunk(path) {
    if (state.chunkCache.has(path)) return state.chunkCache.get(path);
    const { data } = await fetchJsonWithFallbacks(path);
    if (!Array.isArray(data)) throw new Error("Chunk format unexpected (expected array)");
    state.chunkCache.set(path, data);
    return data;
  }

  async function toggleVerbatim(card, rec, btnEl) {
    // Inline expansion (no <dialog> dependency; iOS-friendly)
    let block = card.querySelector('.verbatim-block');
    if (block) {
      const isHidden = block.classList.toggle('hidden');
      if (btnEl) btnEl.textContent = isHidden ? 'Show code' : 'Hide code';
      return;
    }

    block = document.createElement('div');
    block.className = 'verbatim-block';

    // Source/context header (critical for field use)
    const meta = document.createElement('div');
    meta.className = 'verbatim-meta';
    const loc = (() => {
      if (rec.corpus === 'DCS') {
        const ch = rec.path?.chapter ?? '';
        return `DCS — Chapter ${ch}`;
      }
      if (rec.corpus === 'BRC') {
        const t = rec.path?.title ?? '';
        return `BRC — Title ${String(t).padStart(2,'0')}`;
      }
      if (rec.corpus === 'TITLE9') {
        const ch = rec.path?.chapter ?? '';
        return `Title 9 — Chapter ${ch}`;
      }
      return rec.corpus || '';
    })();
    const anchor = rec.anchor ? `Anchor: ${rec.anchor}` : '';
    meta.innerHTML = `<div><strong>${escapeHtml(loc)}</strong></div>` +
      (anchor ? `<div class="muted">${escapeHtml(anchor)}</div>` : '') +
      (rec.heading ? `<div class="muted">${escapeHtml(rec.heading)}</div>` : '');
    block.appendChild(meta);

    const pre = document.createElement('pre');
    pre.className = 'verbatim-text';
    pre.textContent = 'Loading code...';

    block.appendChild(pre);
    card.appendChild(block);
    if (btnEl) btnEl.textContent = 'Hide code';

    try {
      setStatus('Loading code...');
      const chunkPath = normalizeFilePath(rec.file);
      const chunk = await loadChunk(chunkPath);
      const full = chunk[rec.rec_index];
      if (!full) throw new Error('Record index not found in chunk');
      pre.textContent = full.verbatim || full.text || '(No verbatim text found in chunk)';
      setStatus('Ready');
    } catch (e) {
      console.error(e);
      pre.textContent = 'Error loading code: ' + (e.message || String(e));
      setStatus('Error: ' + (e.message || String(e)));
    }
  }


  async function openReaderForRecord(rec){
    try {
      state.reader.fromView = state.view || 'search';
      state.reader.fromScrollY = window.scrollY || 0;
      state.reader.file = normalizeFilePath(rec.file);
      state.reader.label = readerContextLabel(rec);
      state.reader.visible = state.reader.pageSize;
      state.reader.active = true;
      setView('reader');
      setStatus('Loading chapter…');
      state.reader.chunk = await loadChunk(state.reader.file);
      renderReader();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
      setStatus('Ready');
    } catch (e) {
      console.error(e);
      setStatus('Error: ' + (e.message || String(e)));
    }
  }

  function closeReader(){
    state.reader.active = false;
    state.reader.chunk = null;
    const backTo = state.reader.fromView || 'search';
    setView(backTo);
    if (backTo === 'browse') renderBrowse();
    else renderSearchResults();
    try { window.scrollTo(0, state.reader.fromScrollY || 0); } catch (_) {}
  }

  function renderReader(){
    const container = $('results');
    container.innerHTML = '';

    if (!state.reader.active || !Array.isArray(state.reader.chunk)) {
      container.innerHTML = '<div class="card"><div class="snip">Reader unavailable.</div></div>';
      return;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'reader-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'reader-titlewrap';
    const title = document.createElement('div');
    title.className = 'reader-title';
    title.textContent = state.reader.label || 'Reader';
    const subtitle = document.createElement('div');
    subtitle.className = 'reader-sub';
    subtitle.textContent = 'Read-through mode (offline-safe)';
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const controls = document.createElement('div');
    controls.className = 'reader-controls';

    const jump = document.createElement('select');
    jump.className = 'select';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = 'Jump to section…';
    jump.appendChild(opt0);

    const visibleN = Math.min(state.reader.visible, state.reader.chunk.length);
    for (let i=0;i<visibleN;i++){
      const r = state.reader.chunk[i] || {};
      const heading = String(r.heading || '').trim();
      if (!heading) continue;
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = heading.length > 90 ? heading.slice(0, 90) + '…' : heading;
      jump.appendChild(o);
    }
    jump.addEventListener('change', () => {
      const i = parseInt(jump.value, 10);
      if (!Number.isFinite(i)) return;
      const el = document.getElementById('sec-' + i);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const back = document.createElement('button');
    back.className = 'btn';
    back.type = 'button';
    back.textContent = 'Back to results';
    back.addEventListener('click', closeReader);

    controls.appendChild(jump);
    controls.appendChild(back);

    header.appendChild(titleWrap);
    header.appendChild(controls);
    container.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'reader-body';

    const q = state.lastQuery || '';

    for (let i=0;i<visibleN;i++){
      const r = state.reader.chunk[i] || {};
      const sec = document.createElement('div');
      sec.className = 'reader-section';
      sec.id = 'sec-' + i;

      const h = document.createElement('div');
      h.className = 'reader-section-heading';
      h.textContent = r.heading || r.anchor || `Section ${i+1}`;
      sec.appendChild(h);

      const pre = document.createElement('pre');
      pre.className = 'reader-section-text';
      const verb = String(r.verbatim || r.text || '');
      if (q) pre.innerHTML = highlightSnippetHtml(verb, q);
      else pre.textContent = verb;
      sec.appendChild(pre);

      body.appendChild(sec);
    }

    container.appendChild(body);

    // Load more
    if (state.reader.chunk.length > visibleN){
      const actions = document.createElement('div');
      actions.className = 'actions';
      const more = document.createElement('button');
      more.className = 'btn';
      more.type = 'button';
      const addN = Math.min(state.reader.pageSize, state.reader.chunk.length - visibleN);
      more.textContent = `Load more (${addN})`;
      more.addEventListener('click', () => {
        state.reader.visible = Math.min(state.reader.chunk.length, state.reader.visible + state.reader.pageSize);
        renderReader();
      });
      actions.appendChild(more);
      container.appendChild(actions);
    }
  }

  function renderSearchResults(){
    const results = Array.isArray(state.search.results) ? state.search.results : [];
    const total = results.length;
    const cap = state.search.renderCap || 500;
    const shown = Math.min(total, state.search.visible || state.search.pageSize || 50, cap);

    // Update meta count (showing X of Y)
    if (!total) {
      $('count').textContent = '0';
    } else if (shown < total) {
      $('count').textContent = `${shown} of ${total}`;
    } else {
      $('count').textContent = String(total);
    }

    // Render only the visible slice to protect iOS Safari
    const slice = results.slice(0, shown);
    renderResults(slice, { perCatDefault: 9999, skipCount: true });

    const container = $('results');

    // Load more controls
    if (total > shown) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const more = document.createElement('button');
      more.className = 'btn';
      more.type = 'button';
      const addN = Math.min(state.search.pageSize || 50, cap - shown, total - shown);
      more.textContent = `Load more (${addN})`;
      more.addEventListener('click', () => {
        state.search.visible = Math.min(cap, total, (state.search.visible || 0) + (state.search.pageSize || 50));
        renderSearchResults();
      });
      actions.appendChild(more);
      container.appendChild(actions);

      if (total > cap) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.style.marginTop = '6px';
        note.textContent = `Showing up to ${cap} results max. Refine your search to narrow further.`;
        container.appendChild(note);
      }
    }
  }

  function runSearch() {
    const q = getQuery();

    // Track key changes (query + filters) to reset pagination and expansions
    const key = `${q}|${state.filter||'ALL'}|${state.categoryFilter||'ALL'}`;
    if (key !== state.search.key) {
      state.search.key = key;
      state.search.visible = state.search.pageSize || 50;
      state.expandedGroups.clear();
    }

    state.lastQuery = q;

    if (!q) {
      $('count').textContent = '0';
      state.search.results = [];
      // Reset quick category tiles to default ordering when not searching.
      renderCategoryBoxes();
      setView('browse');
      renderBrowse();
      return;
    }

    const chapterIntent = detectChapterQuery(q);
    const sectionIntent = detectSectionQuery(q);

    const intents = detectIntents(q);
    const qConcept = detectQueryConcepts(q);
    state.lastQueryConceptTerms = (qConcept.matches || []).map(m => m.termRaw);
    state.lastActiveTopics = intents.topics;

    const scored = [];

    for (const rec of state.index) {
      // Respect filters early (speed + predictable behavior)
      if (state.filter && state.filter !== 'ALL' && rec.corpus !== state.filter) continue;
      if (state.categoryFilter && state.categoryFilter !== 'ALL' && (rec._primaryCategoryId||'') !== state.categoryFilter) continue;

      // If the user asked for a specific BRC-style section (e.g. "Section 8-5-12"),
      // hard-prefer the actual section record (anchor match) over secondary mentions.
      if (sectionIntent && sectionAnchorMatch(rec, sectionIntent)) {
        rec._tier = getTierWeight(rec);
        rec._score = 200000; // Above chapter intent
        rec._rationale = 'Section intent';
        rec._tags = tagRecord(rec);
        rec._section = 1;
        scored.push(rec);
        continue;
      }

      // If the user asked for a specific chapter (e.g. 'Chapter 5'), include that chapter
      // even if the text doesn't literally contain the number.
      if (chapterIntent && chapterMatch(rec, chapterIntent)) {
        // Respect corpus filter if set
        if (state.filter && state.filter !== 'ALL' && rec.corpus !== state.filter) continue;
        // Respect category filter if set
        if (state.categoryFilter && state.categoryFilter !== 'ALL' && (rec._primaryCategoryId||'') !== state.categoryFilter) continue;
        rec._tier = getTierWeight(rec);
        rec._score = 100000; // Force chapter-targeted items to the top
        rec._rationale = 'Chapter intent';
        rec._tags = tagRecord(rec);
        rec._section = 0;
        scored.push(rec);
        continue;
      }

      // If the user asked for a specific code section (e.g. "Section 8-5-12"),
      // hard-prefer the actual section record (anchor match) over secondary references.
      if (sectionIntent && sectionAnchorMatch(rec, sectionIntent)) {
        rec._tier = getTierWeight(rec);
        rec._score = 200000; // Above chapter intent; section lookups must land on the section
        rec._rationale = 'Section intent';
        rec._tags = tagRecord(rec);
        rec._sectionExact = 1;
        scored.push(rec);
        continue;
      }

      const r = scoreRecord(rec, q, intents, qConcept);
      if (r) {
        r._tier = getTierWeight(r);
        scored.push(r);
      }
    }

    // Sort rules:
    //  - If chapter intent exists, hard-prefer the requested chapter before tiering
    //  - Otherwise use tier contract then relevance score
    scored.sort((a,b)=>{
      // Section intent is the strongest: always show the actual section first.
      if (sectionIntent) {
        const am = sectionAnchorMatch(a, sectionIntent);
        const bm = sectionAnchorMatch(b, sectionIntent);
        if (am !== bm) return bm - am;
      }

      if (chapterIntent) {
        const am = chapterMatch(a, chapterIntent);
        const bm = chapterMatch(b, chapterIntent);
        if (am !== bm) return bm - am;
      }

      // Exact phrase beats hierarchy/tier.
      const ea = (a._exact || 0);
      const eb = (b._exact || 0);
      if (ea !== eb) return eb - ea;

      const sa = (a._score || 0);
      const sb = (b._score || 0);

      // When both are exact phrase matches, rank by score first, then tier.
      if (ea === 1 && eb === 1) {
        if (sa !== sb) return sb - sa;
        const ta = (a._tier ?? 99);
        const tb = (b._tier ?? 99);
        if (ta !== tb) return ta - tb;
      } else {
        // Otherwise use tier contract first, then relevance.
        const ta = (a._tier ?? 99);
        const tb = (b._tier ?? 99);
        if (ta !== tb) return ta - tb;
        if (sa !== sb) return sb - sa;
      }
      const ca = String(a.corpus || '');
      const cb = String(b.corpus || '');
      if (ca !== cb) return ca.localeCompare(cb);
      const ha = String(a.heading || '');
      const hb = String(b.heading || '');
      if (ha !== hb) return ha.localeCompare(hb);
      return 0;
    });

    // Save + render
    state.search.results = scored;
    // Re-order quick category tiles by relevance for the active query.
    renderCategoryBoxes(computeCategoryOrderFromResults(scored));
    setView('search');
    renderSearchResults();
  }

  function populateCategorySelect() {
    const sel = document.getElementById('catSelect');
    if (!sel) return;
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'ALL';
    optAll.textContent = 'All categories';
    sel.appendChild(optAll);
    for (const c of state.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.label}`;
      sel.appendChild(o);
    }
    sel.value = state.categoryFilter || 'ALL';
  }

  function renderCategoryBoxes(orderIds) {
    const wrap = document.getElementById('catBoxes');
    if (!wrap) return;
    wrap.innerHTML = '';

    const makeBtn = (id, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'catbox';
      b.dataset.cat = id;
      b.textContent = label;
      b.addEventListener('click', () => {
        state.categoryFilter = id;
        const sel = document.getElementById('catSelect');
        if (sel) sel.value = id;
        updateCategoryBoxActive();
        runSearch();
        document.getElementById('q')?.focus?.();
      });
      wrap.appendChild(b);
    };

    makeBtn('ALL', 'All');

    const byId = state.categoriesById || {};
    const ids = Array.isArray(orderIds) && orderIds.length
      ? orderIds.filter(id => id !== 'ALL' && byId[id])
      : state.categories.map(c => c.id);

    for (const id of ids) {
      const c = byId[id];
      if (!c) continue;
      makeBtn(c.id, c.label);
    }
    updateCategoryBoxActive();
  }

  function computeCategoryOrderFromResults(results, opts = {}) {
    const rows = Array.isArray(results) ? results : [];
    const stats = new Map(); // id -> {count, best}
    for (const r of rows) {
      const id = String(r._primaryCategoryId || '');
      if (!id) continue;
      const base = (r._score || 0);
      const bonus = (r._exact ? 50000 : 0) + (r._section ? 100000 : 0) + (r._rationale === 'Chapter intent' ? 20000 : 0);
      const s = base + bonus;
      const cur = stats.get(id) || { count: 0, best: -Infinity };
      cur.count += 1;
      if (s > cur.best) cur.best = s;
      stats.set(id, cur);
    }
    let ids = state.categories.map(c => c.id);
    if (opts.hideEmpty) {
      ids = ids.filter(id => (stats.get(id)?.count || 0) > 0);
    }
    ids.sort((a,b) => {
      const sa = stats.get(a) || {count:0,best:-Infinity};
      const sb = stats.get(b) || {count:0,best:-Infinity};
      if (sa.best !== sb.best) return sb.best - sa.best;
      if (sa.count !== sb.count) return sb.count - sa.count;
      // Stable tie-breaker: default workflow order from categories.json
      const ia = state.categories.findIndex(c => c.id === a);
      const ib = state.categories.findIndex(c => c.id === b);
      if (ia !== ib) return ia - ib;
      const la = (state.categoriesById[a]?.label || a);
      const lb = (state.categoriesById[b]?.label || b);
      return String(la).localeCompare(String(lb));
    });
    return ids;
  }

  function updateCategoryBoxActive() {
    const active = state.categoryFilter || 'ALL';
    document.querySelectorAll('.catbox').forEach(b => {
      b.classList.toggle('active', (b.dataset.cat || 'ALL') === active);
    });
  }

  function fullReset() {
    // Inputs
    const qEl = document.getElementById('q');
    if (qEl) qEl.value = '';

    // State
    state.filter = 'ALL';
    state.categoryFilter = 'ALL';
    state.expandedGroups.clear();
    state.lastQuery = '';
    state.lastActiveTopics = [];
    state.lastQueryConceptTerms = [];

    // UI selects
    const corpusSel = document.getElementById('corpusSelect');
    if (corpusSel) corpusSel.value = 'ALL';
    const catSel = document.getElementById('catSelect');
    if (catSel) catSel.value = 'ALL';

    updateCategoryBoxActive();
    runSearch();
    qEl?.focus?.();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
  }

  function wireUI() {
    const corpusSel = document.getElementById('corpusSelect');
    if (corpusSel) {
      corpusSel.value = state.filter || 'ALL';
      corpusSel.addEventListener('change', () => {
        state.filter = corpusSel.value || 'ALL';
        runSearch();
      });
    }

    const catSel = document.getElementById('catSelect');
    if (catSel) {
      catSel.addEventListener('change', () => {
        state.categoryFilter = catSel.value || 'ALL';
        updateCategoryBoxActive();
        runSearch();
      });
    }

    let qTimer = null;
    const qEl = document.getElementById('q');
    qEl.addEventListener('input', () => {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        qTimer = null;
        runSearch();
      }, 140);
    });
    // "Clear" is a full reset per field-use expectations.
    document.getElementById('clear').addEventListener('click', () => fullReset());
  }

  async function init() {
    try {
      // Footer stamp
      const y = document.getElementById('year');
      if (y) y.textContent = String(new Date().getFullYear());
      wireUI();
      await loadCategories();
      populateCategorySelect();
      renderCategoryBoxes();
      await loadConcepts();
      await loadInspectorProfile();
      await loadInspectorTerms();
      await loadIndex();
      annotateIndex();
      buildSuggestionsUI();
      runSearch();
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
      }
    } catch (e) {
      console.error(e);
      setStatus(`Error: ${e.message}`);
      $("results").innerHTML = `<div class="card"><div class="snip">${escapeHtml(e.message)}</div></div>`;
    }
  }

  window.addEventListener("DOMContentLoaded", init);
})();