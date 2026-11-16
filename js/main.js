/* Site script. No build step, no dependencies.
   Data lives in /data/*.json. Posters and metadata come from the AniList API. */
(() => {
  'use strict';

  const ANILIST = 'https://graphql.anilist.co';
  const CACHE_KEY = 'site.anilist.v1';
  const CACHE_TTL = 12 * 60 * 60 * 1000;
  const STATUS_LABEL = { ongoing: 'Ongoing', scheduled: 'Scheduled', completed: 'Completed' };
  const PALETTE = ['#E5574A', '#E9E5DA', '#B0AB9F', '#C2A25F', '#7FB8A4', '#9AA9D6'];
  const NUMERALS = ['一', '二', '三', '四', '五'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- DOM helper (text is always set as text, never as HTML) ---------- */
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === false || v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === false || kid == null) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  async function getJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  /* ---------- formatting ---------- */
  const money = (n, cur = '$') => cur + (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2));
  const parseDay = s => new Date(String(s).length === 10 ? `${s}T12:00:00` : s);
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  function dayLabel(d) {
    const now = new Date();
    const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff} days ago`;
    return d.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  }

  function span(ms) {
    const mins = Math.floor(ms / 60000);
    const d = Math.floor(mins / 1440);
    const hr = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return `${d}d ${hr}h`;
    if (hr > 0) return `${hr}h ${m}m`;
    return `${Math.max(m, 1)}m`;
  }

  function hashOf(str) {
    let x = 0;
    for (let i = 0; i < str.length; i++) x = (x * 31 + str.codePointAt(i)) >>> 0;
    return x;
  }

  function hostOf(url) {
    try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /* ---------- countdowns ---------- */
  function paintCountdown(node) {
    const target = new Date(node.dataset.iso);
    const ms = target - Date.now();
    node.textContent = ms > 0 ? `${node.dataset.prefix} ${span(ms)}` : 'Out now';
    node.title = target.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function countdown(iso, prefix) {
    const node = h('span', { class: 'count block text-sm font-medium text-vermilion', 'data-iso': iso, 'data-prefix': prefix });
    paintCountdown(node);
    return node;
  }
  setInterval(() => $$('.count[data-iso]').forEach(paintCountdown), 30000);

  /* ---------- setup ---------- */
  function setupNav() {
    const btn = $('#nav-toggle');
    const menu = $('#menu');
    if (!btn || !menu) return;
    const set = open => { btn.setAttribute('aria-expanded', String(open)); menu.classList.toggle('open', open); };
    btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
    menu.addEventListener('click', e => { if (e.target.closest('a')) set(false); });
  }

  function showSetupHint(err) {
    console.error(err);
    const onFile = location.protocol === 'file:';
    document.body.prepend(h('div', { class: 'relative z-[120] bg-accent px-5 py-3 font-bold text-white', role: 'alert' },
      onFile
        ? 'This site reads its data from JSON files, and browsers block that when a page is opened straight from a folder. Run "python -m http.server" in this folder and open http://localhost:8000, or upload the folder to a static host.'
        : 'Could not load data/config.json. Check that the file exists and is valid JSON.'));
  }

  function applyConfig(cfg) {
    $$('[data-brand]').forEach(n => { n.textContent = cfg.brand.name; });
    $$('[data-logo]').forEach(img => {
      if (cfg.brand && cfg.brand.logo) img.src = cfg.brand.logo;
    });
    $$('[data-link]').forEach(a => { const url = cfg.links[a.dataset.link]; if (url) a.href = url; });
    $$('[data-avatar]').forEach(img => {
      if (cfg.profile.avatar) img.src = cfg.profile.avatar;
      img.alt = `Portrait of ${cfg.profile.name}`;
    });
    $$('[data-cfg]').forEach(n => {
      const v = n.dataset.cfg.split('.').reduce((o, k) => (o ? o[k] : undefined), cfg);
      if (v != null) n.textContent = v;
    });
  }

  /* ---------- AniList ---------- */
  async function enrich(items) {
    let store = { t: Date.now(), map: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (raw && Date.now() - raw.t < CACHE_TTL) store = raw;
    } catch (e) { /* storage unavailable, carry on */ }

    const keyOf = r => (r.anilistId ? `id:${r.anilistId}` : `q:${r.search || r.title}`);
    const need = items.filter(r => !r.cover && !store.map[keyOf(r)]);
    const chunks = [];
    for (let i = 0; i < need.length; i += 9) chunks.push(need.slice(i, i + 9));

    await Promise.all(chunks.map(async chunk => {
      const fields = chunk.map((r, j) => {
        const arg = r.anilistId ? `id: ${Number(r.anilistId)}` : `search: ${JSON.stringify(r.search || r.title)}`;
        return `m${j}: Media(${arg}, type: ANIME) { ...F }`;
      }).join('\n');
      const query = `query {\n${fields}\n}\nfragment F on Media { id title { romaji english } coverImage { extraLarge large color } episodes status genres averageScore }`;
      try {
        const res = await fetch(ANILIST, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query }),
        });
        const json = await res.json();
        chunk.forEach((r, j) => {
          const media = json && json.data && json.data[`m${j}`];
          if (media) store.map[keyOf(r)] = media;
        });
      } catch (err) {
        console.warn('AniList request failed, using fallback tiles.', err);
      }
    }));

    try { localStorage.setItem(CACHE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
    items.forEach(r => { r.media = store.map[keyOf(r)] || null; });
  }

  function shape(r) {
    const m = r.media;
    let total = null;
    if (r.episodesTotal !== undefined) total = r.episodesTotal;
    else if (r.status === 'completed' && m) total = m.episodes || null;
    return {
      ...r,
      name: r.title || (m && m.title && (m.title.english || m.title.romaji)) || r.search,
      img: r.cover || (m && m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || null,
      tint: (m && m.coverImage && m.coverImage.color) || null,
      total,
    };
  }

  async function loadReleases() {
    const list = await getJSON('data/releases.json');
    await enrich(list);
    return list.map(shape);
  }

  function fallbackTile(it) {
    const tint = it.tint || `hsl(${hashOf(it.name) % 360} 25% 17%)`;
    return h('div', { class: 'fallback', style: `--t:${tint}` }, h('span', null, it.name));
  }
  function posterNode(it) {
    if (!it.img) return fallbackTile(it);
    const img = h('img', { src: it.img, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(fallbackTile(it)));
    return img;
  }

  function qualityText(list) {
    return h('span', { class: 'flex flex-wrap gap-x-2 text-xs font-bold', 'aria-label': 'Available qualities' },
      (list || []).map(q => h('span', { class: q === '4K' ? 'text-gold' : 'text-muted' }, q)));
  }

  function renderStats(root, stats) {
    if (!root || !stats) return;
    root.replaceChildren(...stats.map(s => h('div', { class: 'flex flex-col-reverse' },
      h('dt', { class: 'text-sm text-muted' }, s.label),
      h('dd', { class: 'font-display text-3xl font-extrabold leading-tight' }, s.value))));
  }

  /* ==========================================================
     Releases
     ========================================================== */
  const SECTION_META = {
    new: { title: 'New', cn: '新作', note: 'Recently added to the channel.' },
    ongoing: { title: 'Ongoing', cn: '连载', note: 'Airing now. Episodes are uploaded as they release.' },
    scheduled: { title: 'Scheduled', cn: '待更', note: 'Coming soon. Times are shown in your local time.' },
    completed: { title: 'Completed', cn: '完结', note: 'Finished series with every episode uploaded.' },
  };

  function epLine(r) {
    if (r.status === 'completed') return r.total ? `${r.total} episodes` : 'Complete';
    if (r.status === 'scheduled') return r.nextRelease ? null : 'Date to be announced';
    if (r.episodesDone == null) return 'Airing now';
    return r.total ? `Episode ${r.episodesDone} of ${r.total}` : `Episode ${r.episodesDone}`;
  }

  function nextLabel(r) {
    return r.status === 'scheduled' ? 'Premieres in' : `Episode ${(r.episodesDone || 0) + 1} in`;
  }

  function releaseCard(r, opts) {
    const line = epLine(r);
    const prefix = opts.showStatus ? `${STATUS_LABEL[r.status]}${line ? ', ' : ''}` : '';
    const next = r.status !== 'completed' && r.nextRelease ? countdown(r.nextRelease, nextLabel(r)) : null;
    return h('button', {
      class: 'rel group block w-full text-left', type: 'button', 'aria-haspopup': 'dialog',
      'aria-label': `${r.name}. Open links`,
      onclick: e => openRelease(r, opts.cfg, e.currentTarget),
    },
      h('div', { class: 'poster aspect-[2/3]' },
        posterNode(r),
        r.new && h('span', { class: 'stamp', title: 'New' }, '新'),
        h('span', { class: 'kind' }, r.type === 'donghua' ? 'Donghua' : 'Anime'),
        h('span', { class: 'poster-hint' }, 'Get links')),
      h('div', { class: 'pt-3' },
        h('h3', { class: 'line-clamp-2 font-bold leading-snug' }, r.name),
        (prefix || line) && h('p', { class: 'mt-0.5 text-sm text-muted' }, prefix + (line || '')),
        next,
        h('div', { class: 'mt-2' }, qualityText(r.qualities))));
  }

  /* ---------- release dialog ---------- */
  const LINK_TYPES = {
    latest: { ico: 'play', tint: '#E5574A' },
    telegram: { ico: 'T', tint: '#5AB7E8' },
    nyaa: { ico: 'N', tint: '#7FB8A4' },
    discord: { ico: 'D', tint: '#9AA4FF' },
    extra: { ico: '↗', tint: '#B0AB9F' },
  };

  function linksFor(r, cfg) {
    const L = r.links || {};
    const out = [];
    const add = (type, url, label) => { if (url) out.push({ type, url, label }); };
    if (r.status !== 'scheduled') {
      add('latest', L.latest, r.status === 'completed' ? 'Final episode' : (r.episodesDone ? `Latest episode (Ep ${r.episodesDone})` : 'Latest episode'));
    }
    add('telegram', L.telegram || cfg.links.telegram, 'Telegram channel');
    add('nyaa', L.nyaa, 'Nyaa.si');
    add('discord', L.discord || cfg.links.discord, 'Discord');
    (L.extra || []).forEach(x => { if (x && x.url) add('extra', x.url, x.label || hostOf(x.url)); });
    return out;
  }

  function linkRow(l) {
    const t = LINK_TYPES[l.type] || LINK_TYPES.extra;
    const ico = h('span', { class: 'dlg-ico', style: `color:${t.tint}`, 'aria-hidden': 'true' });
    if (t.ico === 'play') ico.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor"/></svg>';
    else ico.textContent = t.ico;
    return h('li', null,
      h('a', { class: 'dlg-link', href: l.url, target: '_blank', rel: 'noopener' },
        ico,
        h('span', { class: 'min-w-0' },
          h('span', { class: 'block font-bold' }, l.label),
          h('span', { class: 'block truncate text-sm text-muted' }, hostOf(l.url))),
        h('span', { class: 'text-muted', 'aria-hidden': 'true' }, '\u2197')));
  }

  function openRelease(r, cfg, opener) {
    const dlg = $('#rel-dialog');
    if (!dlg) return;
    $('#dlg-poster').replaceChildren(posterNode(r));
    $('#dlg-eyebrow').textContent = `${STATUS_LABEL[r.status] || r.status} ${r.type === 'donghua' ? 'donghua' : 'anime'}`;
    $('#dlg-title').textContent = r.name;

    const meta = $('#dlg-meta');
    const line = epLine(r);
    meta.replaceChildren(
      line && h('p', { class: 'text-muted' }, line),
      r.status !== 'completed' && r.nextRelease && countdown(r.nextRelease, nextLabel(r)),
      h('div', { class: 'mt-2' }, qualityText(r.qualities)),
      r.subs && r.subs.length ? h('p', { class: 'mt-2 text-sm text-muted' }, `Subs: ${r.subs.join(', ')}`) : null);

    const note = $('#dlg-note');
    note.hidden = !r.note;
    note.textContent = r.note || '';

    const links = linksFor(r, cfg);
    $('#dlg-links').replaceChildren(...links.map(linkRow));
    dlg.dataset.opener = opener ? '1' : '';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('#dlg-title').focus({ preventScroll: true });
  }

  function setupDialog() {
    const dlg = $('#rel-dialog');
    if (!dlg) return;
    dlg.addEventListener('click', e => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }

  async function releasesPage(cfg) {
    renderStats($('#stats'), cfg.stats);
    setupDialog();
    const root = $('#list');

    let items;
    try { items = await loadReleases(); }
    catch (err) {
      console.error(err);
      root.replaceChildren(h('p', { class: 'px-5 py-16 text-muted sm:px-10' }, 'Could not load data/releases.json. Check that it is valid JSON.'));
      return;
    }

    const state = { filter: 'all', type: 'all', q: '' };
    const tabs = $$('.tab');

    const sortRows = rows => rows.slice().sort((a, b) => {
      if (!!b.new - !!a.new) return !!b.new - !!a.new;
      if (a.nextRelease && b.nextRelease) return new Date(a.nextRelease) - new Date(b.nextRelease);
      return a.name.localeCompare(b.name);
    });

    function render() {
      const base = items.filter(r =>
        (state.type === 'all' || r.type === state.type) &&
        (!state.q || r.name.toLowerCase().includes(state.q) || (r.search || '').toLowerCase().includes(state.q)));
      const pick = f => (f === 'all' ? base : f === 'new' ? base.filter(r => r.new) : base.filter(r => r.status === f));

      tabs.forEach(tab => {
        tab.setAttribute('aria-pressed', String(tab.dataset.filter === state.filter));
        $('.n', tab).textContent = pick(tab.dataset.filter).length;
      });

      const groups = state.filter === 'all' ? ['ongoing', 'scheduled', 'completed'] : [state.filter];
      const out = [];
      for (const g of groups) {
        const rows = sortRows(state.filter === 'all' ? base.filter(r => r.status === g) : pick(g));
        if (!rows.length) continue;
        const meta = SECTION_META[g];
        out.push(h('section', { class: 'sec', 'aria-labelledby': `h-${g}` },
          h('h2', { id: `h-${g}`, class: 'flex items-baseline gap-3 font-display text-3xl font-bold sm:text-4xl' },
            meta.title, h('span', { class: 'cn text-2xl', 'aria-hidden': 'true' }, meta.cn)),
          h('p', { class: 'mt-2 text-muted' }, meta.note),
          h('div', { class: 'mt-9 grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5' },
            rows.map(r => releaseCard(r, { cfg, showStatus: g === 'new' })))));
      }
      if (!out.length) {
        out.push(h('div', { class: 'px-5 py-20 text-center text-muted sm:px-10' },
          h('p', null, 'Nothing matches that search. Try another filter or clear the search.'),
          h('button', {
            class: 'btn mt-6', type: 'button',
            onclick: () => { state.filter = 'all'; state.type = 'all'; state.q = ''; $('#q').value = ''; $('#type').value = 'all'; render(); },
          }, 'Clear filters')));
      }
      root.replaceChildren(...out);
      $('#result-status').textContent = `${$$('.rel', root).length} titles shown`;
    }

    tabs.forEach(tab => tab.addEventListener('click', () => { state.filter = tab.dataset.filter; render(); }));
    $('#type').addEventListener('change', e => { state.type = e.target.value; render(); });
    $('#q').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); render(); });
    render();
  }

  /* ==========================================================
     Donate
     ========================================================== */
  async function loadDonors() {
    try { return normDonors(await getJSON('data/donors.json')); }
    catch (err) { console.warn('Could not load data/donors.json', err); return []; }
  }

  function normDonors(list) {
    return list.map((d, i) => {
      const name = String(d.name || 'Anonymous').trim() || 'Anonymous';
      const anon = name.toLowerCase() === 'anonymous';
      const date = parseDay(d.date);
      return {
        name, anon,
        key: anon ? `anon-${i}` : name.toLowerCase(),
        amount: Number(d.amount) || 0,
        comment: String(d.comment || '').trim(),
        date: isNaN(date) ? new Date(0) : date,
      };
    }).filter(d => d.amount > 0);
  }

  function goalStats(cfg, donors) {
    const cur = cfg.goal.currency || '$';
    const goal = Number(cfg.goal.amount) || 50;
    const now = new Date();
    const ym = cfg.goal.month && cfg.goal.month !== 'auto'
      ? cfg.goal.month
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [y, m] = ym.split('-').map(Number);
    const inMonth = donors.filter(d => d.date.getFullYear() === y && d.date.getMonth() + 1 === m);
    const raised = inMonth.reduce((s, d) => s + d.amount, 0);
    const isCurrent = y === now.getFullYear() && m === now.getMonth() + 1;
    return {
      cur, goal, raised,
      left: Math.max(0, goal - raised),
      pct: Math.min(100, (raised / goal) * 100),
      daysLeft: isCurrent ? new Date(y, m, 0).getDate() - now.getDate() : null,
      title: `${new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} goal`,
    };
  }

  /* Realm headline plus the path of realm stones. */
  function renderRealm(root, cfg, g) {
    if (!root) return;
    const realms = cfg.realms || [];
    if (!realms.length) return;
    const n = realms.length;
    let idx = 0;
    realms.forEach((r, k) => { if (g.pct >= r.at) idx = k; });
    const cur = realms[idx];
    const next = realms[idx + 1];
    const frac = next ? (g.pct - cur.at) / (next.at - cur.at) : 1;
    const pos = Math.min(100, ((idx + frac) / (n - 1)) * 100);
    const nextAt = next ? (g.goal * next.at) / 100 : null;
    const nextText = next
      ? `${money(Math.max(0, nextAt - g.raised), g.cur)} to reach ${next.en} (${next.cn})`
      : 'Ascension reached. This month is covered. Thank you, fellow Daoists.';

    const nodes = realms.map((r, k) => h('div', {
      class: `node${k <= idx ? ' reached' : ''}${k === idx ? ' current' : ''}`,
      style: `left:${(k / (n - 1)) * 100}%`,
    },
      h('i', { class: 'node-dot' }),
      h('span', { class: 'node-cn' }, r.cn),
      h('span', { class: 'node-amt' }, money((g.goal * r.at) / 100, g.cur))));

    const fill = h('div', { class: 'path-fill' });
    const head = h('div', { class: 'path-head' }, h('span', { class: 'path-tip' }, money(g.raised, g.cur)));

    root.replaceChildren(
      h('div', { class: 'flex flex-wrap items-end justify-between gap-x-8 gap-y-3' },
        h('div', { class: 'flex items-end gap-4' },
          h('span', { class: 'font-brush text-6xl leading-none text-gold' }, cur.cn),
          h('div', null, h('p', { class: 'text-sm text-muted' }, 'Current realm'), h('p', { class: 'font-display text-xl font-bold' }, cur.en))),
        h('p', { class: 'text-muted' }, nextText)),
      h('div', {
        class: 'path', role: 'progressbar', 'aria-label': 'Cultivation realm progress',
        'aria-valuemin': 0, 'aria-valuemax': g.goal, 'aria-valuenow': Math.min(g.raised, g.goal),
        'aria-valuetext': `${money(g.raised, g.cur)} of ${money(g.goal, g.cur)}, realm ${cur.en}`,
      }, h('div', { class: 'path-track' }, fill, ...nodes, head)));

    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.width = `${pos}%`;
      head.style.left = `${pos}%`;
    }));
  }

  function tierFor(total, tiers) {
    let hit = null;
    for (const t of tiers.slice().sort((a, b) => a.min - b.min)) if (total >= t.min) hit = t;
    return hit;
  }

  function renderGoal(cfg, g) {
    const set = (id, text) => { const n = document.getElementById(id); if (n) n.textContent = text; };
    set('goal-title', g.title);
    set('raised', money(g.raised, g.cur));
    set('goal-amt', money(g.goal, g.cur));
    set('left', money(g.left, g.cur));
    set('days', g.daysLeft == null ? '' : g.daysLeft > 0 ? `${g.daysLeft} days left` : 'Last day');
    renderRealm($('#realm'), cfg, g);
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1800);
  }

  function renderMethods(cfg) {
    $('#methods').replaceChildren(...cfg.methods.map(mt => {
      const isAddr = mt.type === 'address';
      let ctaBtn;
      if (mt.disabled) {
        ctaBtn = h('button', { class: 'btn justify-self-start', type: 'button', disabled: true, 'aria-disabled': 'true' }, mt.cta || 'Coming soon');
      } else if (isAddr) {
        ctaBtn = h('button', { class: 'btn justify-self-start', type: 'button', onclick: e => copyText(mt.address, e.currentTarget) }, mt.cta || 'Copy address');
      } else {
        ctaBtn = h('a', { class: 'btn btn-primary justify-self-start', href: mt.url, target: '_blank', rel: 'noopener' }, mt.cta || `Donate with ${mt.name}`);
      }
      const row = h('li', { class: 'grid grid-cols-[1fr] items-center gap-x-5 gap-y-3 border-b border-line py-6 sm:grid-cols-[1fr_auto]' },
        h('div', null, h('h3', { class: 'text-lg font-bold' }, mt.name), h('p', { class: 'text-muted' }, mt.note)),
        ctaBtn);
      if (isAddr) {
        const qr = mt.qrImage || `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&color=0A0A0B&bgcolor=E9E5DA&data=${encodeURIComponent(`bitcoin:${mt.address}`)}`;
        const img = h('img', { class: 'qr', src: qr, alt: `QR code for the ${mt.name} address`, width: 140, height: 140, loading: 'lazy' });
        img.addEventListener('error', () => img.remove());
        row.append(h('div', { class: 'flex flex-wrap items-center gap-5 sm:col-span-2' }, h('code', { class: 'addr' }, mt.address), img));
      }
      return row;
    }));
  }

  function renderTiers(cfg) {
    const cur = cfg.goal.currency || '$';
    $('#tiers').replaceChildren(...cfg.tiers.map(t =>
      h('li', { class: 'border-t border-line pt-5' },
        h('div', { class: 'font-display text-5xl font-extrabold leading-none', style: `color:${t.color}` }, money(t.min, cur), h('span', { class: 'ml-2 font-sans text-sm font-medium text-muted' }, 'and up')),
        h('h3', { class: 'mt-4 text-lg font-bold' }, t.name, t.cn && h('span', { class: 'block font-brush text-xl font-normal text-muted' }, t.cn)),
        h('ul', { class: 'mt-3 grid gap-2 text-muted' }, t.perks.map(p =>
          h('li', { class: 'flex gap-3' }, h('span', { class: 'mt-[.65em] h-1.5 w-1.5 flex-none rotate-45', style: `background:${t.color}` }), p))))));
  }

  function renderTop(donors, cfg) {
    const cur = cfg.goal.currency || '$';
    const root = $('#top-list');
    const map = new Map();
    for (const d of donors) {
      const row = map.get(d.key) || { name: d.name, total: 0 };
      row.total += d.amount;
      map.set(d.key, row);
    }
    const top = [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 5);
    if (!top.length) { root.replaceChildren(h('li', { class: 'text-muted' }, 'No donations yet. Be the first.')); return; }
    root.replaceChildren(...top.map((r, i) => {
      const tier = tierFor(r.total, cfg.tiers);
      return h('li', { class: 'grid grid-cols-[3rem_1fr_auto] items-center gap-4 border-b border-line py-4' },
        h('span', { class: `ghost-num text-5xl${i === 0 ? ' is-first' : ''}`, 'aria-label': `Rank ${i + 1}` }, NUMERALS[i]),
        h('div', { class: 'min-w-0' },
          h('span', { class: `block break-words font-bold ${i === 0 ? 'text-xl' : ''}` }, r.name),
          tier && h('span', { class: 'role', style: `--c:${tier.color}` }, tier.name)),
        h('span', { class: `font-display text-2xl font-bold ${i === 0 ? 'text-vermilion' : ''}` }, money(r.total, cur)));
    }));
  }

  function renderWall(donors, cfg) {
    const cur = cfg.goal.currency || '$';
    const list = $('#chat');
    const foot = $('#chat-foot');
    const totals = new Map();
    donors.forEach(d => totals.set(d.key, (totals.get(d.key) || 0) + d.amount));
    const sorted = donors.slice().sort((a, b) => b.date - a.date);
    const page = 6;
    let shown = 0;

    if (!sorted.length) { list.replaceChildren(h('li', { class: 'text-muted' }, 'No donations yet.')); return; }

    const msg = d => {
      const tier = tierFor(totals.get(d.key), cfg.tiers);
      const color = tier ? tier.color : PALETTE[hashOf(d.name) % PALETTE.length];
      return h('li', { class: 'border-b border-line py-5' },
        h('div', { class: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
          h('span', { class: 'break-words font-bold', style: `color:${color}` }, d.name),
          h('span', { class: 'bg-paper px-2 text-sm font-extrabold text-ink' }, money(d.amount, cur)),
          h('time', { class: 'ml-auto text-sm text-muted', datetime: d.date.toISOString().slice(0, 10) }, dayLabel(d.date))),
        d.comment && h('p', { class: 'mt-2 break-words text-paper/85' }, d.comment));
    };

    const more = h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: draw }, 'Show more');
    function draw() {
      sorted.slice(shown, shown + page).forEach(d => list.append(msg(d)));
      shown = Math.min(sorted.length, shown + page);
      more.hidden = shown >= sorted.length;
      $('#chat-count').textContent = `Showing ${shown} of ${sorted.length}`;
    }
    foot.append(more, h('span', { id: 'chat-count', class: 'text-sm text-muted' }));
    draw();
  }

  function renderFaq(cfg) {
    const root = $('#faq');
    if (!root) return;
    root.replaceChildren(...cfg.faq.map(f => h('details', null, h('summary', null, f.q), h('p', null, f.a))));
  }

  async function donatePage(cfg) {
    const donors = await loadDonors();
    renderGoal(cfg, goalStats(cfg, donors));
    renderMethods(cfg);
    renderTiers(cfg);
    renderTop(donors, cfg);
    renderWall(donors, cfg);
    renderFaq(cfg);
  }

  /* ==========================================================
     Boot
     ========================================================== */
  async function init() {
    setupNav();
    let cfg;
    try { cfg = await getJSON('data/config.json'); }
    catch (err) { showSetupHint(err); return; }
    applyConfig(cfg);

    const page = document.body.dataset.page;
    try {
      if (page === 'releases') await releasesPage(cfg);
      else if (page === 'donate') await donatePage(cfg);
      else if (page === 'about') renderStats($('#about-stats'), cfg.stats);
    } catch (err) {
      console.error(err);
    }
  }

  init();
})();
