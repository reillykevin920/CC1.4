from pathlib import Path
import re
p=Path('/mnt/data/cc_fix/assets/app.js')
js=p.read_text(encoding='utf-8')

# 1) state: remove mode, add categoryFilter
js = re.sub(r"\n\s*mode:\s*\"INSPECTOR\"[^\n]*\n",
            "\n    categoryFilter: \"ALL\", // cat-01..cat-10 or ALL\n",
            js, count=1)

# 2) perGroupDefault
js = js.replace('const perGroupDefault = (state.mode === "INSPECTOR") ? 8 : 20;',
                'const perGroupDefault = 12;')

# 3) limit / mode usage
js = js.replace('const limit = (state.mode === "INSPECTOR") ? 600 : 1200;',
                'const limit = 800;')

# 4) button label and click handler
js = js.replace('btn.textContent = "Verbatim";', 'btn.textContent = "Show code";')
js = js.replace('btn.addEventListener("click", () => openVerbatim(rec));',
                'btn.addEventListener("click", () => toggleVerbatim(card, rec, btn));')

# 5) Replace openVerbatim(...) with toggleVerbatim(...)
open_pat = re.compile(r"\n\s*async function openVerbatim\(rec\) \{.*?\n\s*\}\n\n", re.DOTALL)

def repl_toggle(m):
    return """

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

"""

js, n = open_pat.subn(repl_toggle, js, count=1)
if n != 1:
    raise SystemExit('Failed to replace openVerbatim function (pattern not found).')

# 6) Replace wireUI() entirely
wire_pat = re.compile(r"\n\s*function wireUI\(\) \{.*?\n\s*\}\n\n", re.DOTALL)

def repl_wire(m):
    return """

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
      o.textContent = `${c.id} - ${c.label}`;
      sel.appendChild(o);
    }
    sel.value = state.categoryFilter || 'ALL';
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
        runSearch();
      });
    }

    document.getElementById('q').addEventListener('input', () => runSearch());
    document.getElementById('clear').addEventListener('click', () => { document.getElementById('q').value=''; runSearch(); document.getElementById('q').focus(); });
  }

"""

js2, n2 = wire_pat.subn(repl_wire, js, count=1)
if n2 != 1:
    raise SystemExit('Failed to replace wireUI function (pattern not found).')
js = js2

# 7) In init(), call populateCategorySelect after loadCategories
js = js.replace('await loadCategories();', 'await loadCategories();\n      populateCategorySelect();')

# 8) Apply category filter in runSearch before render
# Insert after scoring and sorting, before renderResults
insert_point = 'scored.sort((a,b)=>(b._score||0)-(a._score||0));'
if insert_point in js:
    js = js.replace(insert_point, insert_point + "\n\n    let filtered = scored;\n    if (state.filter && state.filter !== 'ALL') {\n      filtered = filtered.filter(r => r.corpus === state.filter);\n    }\n    if (state.categoryFilter && state.categoryFilter !== 'ALL') {\n      filtered = filtered.filter(r => (r._primaryCategoryId || '') === state.categoryFilter);\n    }\n")
else:
    raise SystemExit('Failed to locate insert point for filters.')

# Then renderResults uses filtered
js = js.replace('renderResults(scored.slice(0, limit));', 'renderResults(filtered.slice(0, limit));')

p.write_text(js, encoding='utf-8')
print('patched app.js')
