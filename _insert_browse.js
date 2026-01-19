

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

      recs.sort((a,b) => String(a.heading||'').localeCompare(String(b.heading||'')));

      const label = (catId === 'OTHER') ? 'Other' : (state.categoriesById[catId]?.label || 'Other');

      const details = document.createElement('details');
      details.className = 'catgroup';

      const summary = document.createElement('summary');
      summary.className = 'catgroup-summary';
      summary.innerHTML = `<span class="catgroup-title"><strong>${escapeHtml(catId === 'OTHER' ? '' : catId)}</strong>${catId === 'OTHER' ? '' : ' — '}${escapeHtml(label)}</span><span class="catgroup-count">${recs.length}</span>`;
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

        const catBadge = (catId !== 'OTHER')
          ? `<span class="badge badge-soft"><strong>${escapeHtml(catId)}</strong> ${escapeHtml(label)}</span>`
          : `<span class="badge badge-soft">${escapeHtml(label)}</span>`;

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
        snip.textContent = 'Browse: click Show code for verbatim.';
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
