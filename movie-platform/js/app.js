/* ReelRadar — movie & TV discovery front end.
 * Reads data/<REGION>.json (refreshed on a schedule by scripts/fetch-movies.mjs)
 * and polls it so new releases appear without reloading the page. */
(() => {
  'use strict';

  const DATA_DIR = 'data/';
  const POLL_MS = 5 * 60 * 1000; // check for fresh data every 5 minutes
  const NEW_DAYS = 21; // "NEW" badge for titles released in the last N days
  const IMG = 'https://image.tmdb.org/t/p/';
  const REGION_INFO = {
    US: { flag: '🇺🇸', name: 'United States' },
    GB: { flag: '🇬🇧', name: 'United Kingdom' },
    CA: { flag: '🇨🇦', name: 'Canada' },
  };
  const VIEWS = ['home', 'movies', 'tv', 'new', 'upcoming', 'mylist'];

  const $ = (sel) => document.querySelector(sel);
  const els = {
    content: $('#content'),
    hero: $('#hero'),
    notice: $('#notice'),
    genre: $('#genre'),
    region: $('#region'),
    search: $('#search'),
    modal: $('#modal'),
    modalBody: $('#modal-body'),
    toast: $('#toast'),
    updated: $('#updated'),
  };

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable — features degrade gracefully */
      }
    },
  };

  // Watchlist entries are "movie-123" / "tv-456"; older versions stored bare movie ids.
  const savedList = store.get('rr:watchlist', []).map((k) => (typeof k === 'number' ? `movie-${k}` : String(k)));

  const state = {
    data: null,
    regions: ['US'],
    region: null,
    view: 'home',
    query: '',
    genre: '',
    justAdded: new Set(),
    watchlist: new Set(savedList),
  };

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const today = () => new Date().toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const year = (d) => (d ? d.slice(0, 4) : '');
  const fmtDate = (d, withYear = true) =>
    d
      ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
      : 'TBA';
  const fmtRuntime = (m) => (m ? (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`) : '');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const hue = (id) => (Number(id) * 47) % 360;

  const item = (key) => state.data?.items?.[key];
  const section = (name) => (state.data?.sections?.[name] || []).map(item).filter(Boolean);
  const allItems = () => Object.values(state.data?.items || {});
  const genreNames = (it) => (it.genre_ids || []).map((g) => state.data.genres?.[g]).filter(Boolean);
  const dedupe = (list) => list.filter((it, i, a) => a.findIndex((x) => x.key === it.key) === i);

  // When does this title next "arrive"? Movie release, series premiere or new-season premiere.
  function arrivalDate(it) {
    if (it.release_date && it.release_date > today()) return it.release_date;
    const next = it.tv?.next_episode;
    if (next?.episode === 1 && next.date > today()) return next.date;
    return null;
  }
  const isUpcoming = (it) => Boolean(arrivalDate(it));
  const isNew = (it) => {
    if (!it.release_date || it.release_date > today()) return false;
    return daysBetween(it.release_date, today()) <= NEW_DAYS;
  };
  const hasNewEpisode = (it) => {
    const d = it.tv?.last_episode?.date;
    return Boolean(d && d <= today() && daysBetween(d, today()) <= 7);
  };
  const epCode = (e) => `S${e.season}·E${e.episode}`;

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    for (const [sec, name] of [[86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
      if (s >= sec) return `${plural(Math.floor(s / sec), name)} ago`;
    }
    return '';
  }

  function guessRegion(available) {
    const saved = store.get('rr:region', null);
    if (available.includes(saved)) return saved;
    for (const lang of navigator.languages || [navigator.language || '']) {
      const country = lang.split('-')[1]?.toUpperCase();
      if (country === 'UK' && available.includes('GB')) return 'GB';
      if (available.includes(country)) return country;
    }
    return available.includes('US') ? 'US' : available[0];
  }

  // ---------- data ----------
  async function fetchJson(path) {
    const res = await fetch(`${DATA_DIR}${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${path}`);
    return res.json();
  }

  async function fetchRegion(region) {
    const data = await fetchJson(`${region}.json`);
    if (!data?.items || !data?.sections) throw new Error('Malformed data file');
    return data;
  }

  // Track which titles this browser has already seen (per region), so newly added
  // releases get a "JUST ADDED" badge on the next visit.
  function trackSeen(data, { markNew }) {
    const key = `rr:seen:${data.region}`;
    const keys = Object.keys(data.items);
    const seen = store.get(key, null);
    if (markNew && Array.isArray(seen)) {
      const prev = new Set(seen);
      keys.forEach((k) => !prev.has(k) && state.justAdded.add(k));
    }
    store.set(key, keys);
  }

  async function loadRegion(region, { initial = false } = {}) {
    const data = await fetchRegion(region);
    state.data = data;
    state.region = region;
    state.justAdded = new Set();
    store.set('rr:region', region);
    els.region.value = region;
    trackSeen(data, { markNew: true });
    fillGenres();
    showNotice();
    if (!initial) render();
  }

  async function checkForUpdates() {
    if (!state.data) return;
    try {
      const fresh = await fetchRegion(state.region);
      if (fresh.generatedAt === state.data.generatedAt) return;
      const before = new Set(Object.keys(state.data.items));
      const added = Object.keys(fresh.items).filter((k) => !before.has(k));
      added.forEach((k) => state.justAdded.add(k));
      state.data = fresh;
      store.set(`rr:seen:${fresh.region}`, Object.keys(fresh.items));
      fillGenres();
      render();
      if (added.length) {
        const first = item(added[0]);
        toast(
          `${plural(added.length, 'new title')} just landed${first ? ` — including <b>${esc(first.title)}</b>` : ''}`,
          first ? { label: 'View', action: () => openItem(first.key) } : null,
        );
      } else {
        toast('Listings refreshed with the latest info');
      }
    } catch (err) {
      console.warn('Update check failed:', err);
    }
  }

  // ---------- rendering ----------
  function poster(it) {
    if (it.poster) return `<img src="${IMG}w342${esc(it.poster)}" alt="" loading="lazy" decoding="async" />`;
    return `<div class="poster-fallback" style="--h:${hue(it.id)}">${esc(it.title)}</div>`;
  }

  function badges(it) {
    const b = [];
    if (state.justAdded.has(it.key)) b.push('<span class="badge fresh">Just added</span>');
    const arrive = arrivalDate(it);
    if (arrive) {
      const label = it.type === 'tv' && it.tv?.next_episode?.season > 1 && arrive === it.tv.next_episode.date ? `S${it.tv.next_episode.season} · ${fmtDate(arrive, false)}` : fmtDate(arrive, false);
      b.push(`<span class="badge soon">${esc(label)}</span>`);
    } else if (isNew(it)) {
      b.push(`<span class="badge new">${it.type === 'tv' ? 'New series' : 'New'}</span>`);
    } else if (hasNewEpisode(it)) {
      b.push('<span class="badge new">New episode</span>');
    }
    return b.length ? `<div class="badges">${b.join('')}</div>` : '';
  }

  function cardSub(it) {
    const arrive = arrivalDate(it);
    if (it.type === 'tv') {
      if (arrive && it.release_date > today()) return `Premieres ${fmtDate(arrive)}`;
      if (arrive) return `Season ${it.tv.next_episode.season} · ${fmtDate(arrive)}`;
      if (hasNewEpisode(it)) return `${epCode(it.tv.last_episode)} out ${fmtDate(it.tv.last_episode.date, false)}`;
      return [year(it.release_date), it.tv?.seasons ? plural(it.tv.seasons, 'season') : ''].filter(Boolean).join(' · ');
    }
    return arrive ? `Coming ${fmtDate(arrive)}` : year(it.release_date);
  }

  function card(it) {
    const rating = it.vote_count > 20 ? `<span class="rating">★ ${it.vote_average.toFixed(1)}</span>` : '';
    const type = it.type === 'tv' ? '<span class="type-tag">TV</span>' : '';
    return `
      <button class="card" data-key="${esc(it.key)}" aria-label="${esc(it.title)}${it.type === 'tv' ? ' (TV series)' : ''}">
        <div class="poster">${poster(it)}${badges(it)}${type}${rating}</div>
        <div class="card-title">${esc(it.title)}</div>
        <div class="card-sub">${esc(cardSub(it))}</div>
      </button>`;
  }

  function row(title, items, link) {
    if (!items.length) return '';
    const more = link ? `<a href="${link}">See all ›</a>` : '';
    return `
      <section class="row">
        <div class="row-head"><h2>${esc(title)}</h2>${more}</div>
        <div class="row-track">${items.slice(0, 30).map(card).join('')}</div>
      </section>`;
  }

  function grid(title, sub, items, emptyMsg) {
    return `
      <h1 class="page-title">${esc(title)}</h1>
      ${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}
      ${items.length ? `<div class="grid">${items.map(card).join('')}</div>` : `<div class="empty">${esc(emptyMsg)}</div>`}`;
  }

  function renderHero() {
    const trending = dedupe([...section('trending_movies').slice(0, 10), ...section('trending_tv').slice(0, 10)]).filter((it) => it.overview);
    const pool = trending.some((it) => it.backdrop) ? trending.filter((it) => it.backdrop) : trending;
    const it = pool.find(isNew) || pool.find(hasNewEpisode) || pool[0];
    if (!it || state.view !== 'home' || state.query || state.genre) {
      els.hero.hidden = true;
      return;
    }
    els.hero.hidden = false;
    els.hero.style.backgroundImage = it.backdrop
      ? `url("${IMG}original${it.backdrop}")`
      : `linear-gradient(120deg, hsl(${hue(it.id)} 45% 22%), hsl(${hue(it.id) + 40} 50% 10%))`;
    const inList = state.watchlist.has(it.key);
    const eyebrow = isNew(it) ? (it.type === 'tv' ? 'New series · Trending now' : 'New release · Trending now') : hasNewEpisode(it) ? 'New episode · Trending now' : 'Trending now';
    const meta = [
      it.type === 'tv' ? 'TV series' : year(it.release_date),
      it.type === 'tv' && it.tv?.seasons ? plural(it.tv.seasons, 'season') : '',
      genreNames(it).slice(0, 3).join(' · '),
      it.vote_count > 20 ? `★ ${it.vote_average.toFixed(1)}` : '',
    ].filter(Boolean);
    els.hero.innerHTML = `
      <div class="hero-inner">
        <div class="eyebrow">${eyebrow}</div>
        <h1>${esc(it.title)}</h1>
        <div class="meta">${esc(meta.join('  •  '))}</div>
        <p>${esc(it.overview)}</p>
        <div class="btns">
          ${it.trailer ? `<button class="btn primary" data-trailer="${esc(it.key)}">▶ Play trailer</button>` : ''}
          <button class="btn" data-key="${esc(it.key)}">ⓘ More info</button>
          <button class="btn ${inList ? 'on' : ''}" data-watch="${esc(it.key)}">${inList ? '✓ In My List' : '+ My List'}</button>
        </div>
      </div>`;
  }

  const byDateDesc = (a, b) => String(b.release_date || '').localeCompare(String(a.release_date || ''));
  const byArrival = (a, b) => String(arrivalDate(a) || '').localeCompare(String(arrivalDate(b) || ''));

  function render() {
    if (!state.data) return;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view && !state.query));
    renderHero();
    renderUpdated();

    // Search / genre filter overrides the current view (scoped to Movies or TV when on those pages).
    if (state.query || state.genre) {
      const q = state.query.toLowerCase();
      const scope = state.view === 'movies' ? 'movie' : state.view === 'tv' ? 'tv' : null;
      const results = allItems()
        .filter((it) => !scope || it.type === scope)
        .filter((it) => !q || it.title.toLowerCase().includes(q) || (it.overview || '').toLowerCase().includes(q))
        .filter((it) => !state.genre || (it.genre_ids || []).includes(Number(state.genre)))
        .sort((a, b) => b.popularity - a.popularity);
      const label = [state.query && `“${state.query}”`, state.genre && state.data.genres[state.genre]].filter(Boolean).join(' in ');
      const where = scope === 'movie' ? ' · Movies' : scope === 'tv' ? ' · TV' : '';
      els.content.innerHTML = grid(`Results for ${label}`, `${plural(results.length, 'title')}${where}`, results, 'Nothing matches your search.');
      return;
    }

    const watch = [...state.watchlist].map(item).filter(Boolean);
    const justAdded = [...state.justAdded].map(item).filter(Boolean);
    const regionName = REGION_INFO[state.region]?.name || state.region;

    switch (state.view) {
      case 'movies':
        els.content.innerHTML = [
          '<h1 class="page-title">Movies</h1>',
          row('New Releases', section('now_playing')),
          row('Trending Today', section('trending_movies')),
          row('Coming Soon', section('upcoming_movies')),
          row('Popular', section('popular_movies')),
          row('Top Rated', section('top_rated_movies')),
        ].join('');
        break;
      case 'tv':
        els.content.innerHTML = [
          '<h1 class="page-title">TV Shows</h1>',
          row('New Episodes This Week', section('new_episodes')),
          row('Trending Today', section('trending_tv')),
          row('New Series', section('new_tv')),
          row('Premieres & New Seasons', section('upcoming_tv')),
          row(`Popular on Streaming in ${regionName}`, section('popular_tv')),
          row('Top Rated', section('top_rated_tv')),
        ].join('');
        break;
      case 'new':
        els.content.innerHTML = grid(
          'New Releases',
          'Movies just out in theaters or on streaming, and brand-new series — newest first.',
          dedupe([...section('now_playing'), ...section('new_tv')]).sort(byDateDesc),
          'No new releases right now.',
        );
        break;
      case 'upcoming':
        els.content.innerHTML = grid(
          'Coming Soon',
          'Upcoming movies, series premieres and new seasons — soonest first.',
          dedupe([...section('upcoming_movies'), ...section('upcoming_tv')]).filter(isUpcoming).sort(byArrival),
          'Nothing upcoming listed yet.',
        );
        break;
      case 'mylist':
        els.content.innerHTML = grid('My List', 'Titles you saved. Stored in this browser.', watch, 'Your list is empty — tap “+ My List” on any movie or show.');
        break;
      default:
        els.content.innerHTML = [
          row('Just Added', justAdded),
          row('New Movie Releases', section('now_playing'), '#/new'),
          row('New Episodes This Week', section('new_episodes'), '#/tv'),
          row('Trending Movies', section('trending_movies'), '#/movies'),
          row('Trending TV Shows', section('trending_tv'), '#/tv'),
          row('Coming Soon', dedupe([...section('upcoming_movies'), ...section('upcoming_tv')]).filter(isUpcoming).sort(byArrival), '#/upcoming'),
          row('My List', watch, '#/mylist'),
          row('New Series', section('new_tv')),
          row('Popular Movies', section('popular_movies')),
          row(`Popular TV in ${regionName}`, section('popular_tv')),
        ].join('');
    }
  }

  function renderUpdated() {
    if (!state.data) return;
    els.updated.innerHTML = `<span class="dot"></span>Auto-updating · catalog refreshed ${esc(timeAgo(state.data.generatedAt))}`;
    els.updated.title = new Date(state.data.generatedAt).toLocaleString();
  }

  function fillGenres() {
    const current = els.genre.value;
    const entries = Object.entries(state.data.genres || {}).sort((a, b) => a[1].localeCompare(b[1]));
    els.genre.innerHTML = `<option value="">All genres</option>${entries.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}`;
    els.genre.value = entries.some(([id]) => id === current) ? current : '';
    state.genre = els.genre.value;
  }

  function fillRegions() {
    els.region.innerHTML = state.regions
      .map((r) => `<option value="${r}">${REGION_INFO[r]?.flag || '🌐'} ${r === 'GB' ? 'UK' : r}</option>`)
      .join('');
    els.region.hidden = state.regions.length < 2;
  }

  function showNotice() {
    els.notice.hidden = state.data.source !== 'sample';
    if (!els.notice.hidden) {
      els.notice.innerHTML = 'Showing <b>sample data</b>. Add a free TMDB key as the <code>TMDB_READ_TOKEN</code> repository secret (or run <code>scripts/fetch-movies.mjs</code>) to load real, auto-updating releases.';
    }
  }

  // ---------- modal ----------
  function providerGroup(label, list, link) {
    if (!list?.length) return '';
    return `
      <div class="watch-group">
        <h4>${label}</h4>
        <div class="providers">
          ${list.map((p) => `<a class="provider" href="${esc(link || '#')}" target="_blank" rel="noopener">${p.logo ? `<img src="${IMG}w92${esc(p.logo)}" alt="" loading="lazy" />` : ''}${esc(p.name)}</a>`).join('')}
        </div>
      </div>`;
  }

  function whereToWatch(it) {
    const p = it.providers;
    const regionName = REGION_INFO[state.region]?.name || state.region;
    const groups = p ? [providerGroup('Stream', p.stream, p.link), providerGroup('Free', p.free, p.link), providerGroup('Rent', p.rent, p.link), providerGroup('Buy', p.buy, p.link)].join('') : '';
    let body = groups;
    if (!body) {
      const arrive = arrivalDate(it);
      body = arrive
        ? `<p class="watch-none">${it.type === 'tv' ? 'Premieres' : 'Releases'} ${esc(fmtDate(arrive))}. Where to watch will appear here automatically once announced.</p>`
        : it.type === 'movie' && isNew(it)
          ? '<p class="watch-none">Now playing in theaters. Streaming options will show up here automatically when available.</p>'
          : `<p class="watch-none">No streaming options listed in ${esc(regionName)} yet.</p>`;
    }
    const more = p?.link ? `<a class="watch-link" href="${esc(p.link)}" target="_blank" rel="noopener">All options on TMDB / JustWatch ›</a>` : '';
    return `<div class="watch"><h3>Where to watch in ${esc(regionName)}</h3>${body}${more}</div>`;
  }

  function tvDetails(it) {
    const tv = it.tv;
    if (!tv) return '';
    const lines = [];
    const next = tv.next_episode;
    if (next?.date && next.date >= today()) {
      const what = next.episode === 1 ? (next.season === 1 ? 'Series premiere' : `Season ${next.season} premiere`) : `Next episode ${epCode(next)}${next.name ? ` “${next.name}”` : ''}`;
      lines.push(`<li><b>${esc(what)}</b> — ${esc(fmtDate(next.date))}</li>`);
    }
    if (tv.last_episode?.date && tv.last_episode.date <= today()) {
      lines.push(`<li>Latest: ${esc(epCode(tv.last_episode))}${tv.last_episode.name ? ` “${esc(tv.last_episode.name)}”` : ''} — ${esc(fmtDate(tv.last_episode.date))}</li>`);
    }
    if (tv.networks?.length) lines.push(`<li>On ${esc(tv.networks.join(', '))}</li>`);
    return lines.length ? `<ul class="tv-facts">${lines.join('')}</ul>` : '';
  }

  function openItem(key, { autoplay = false } = {}) {
    const it = item(key);
    if (!it) return;
    const inList = state.watchlist.has(it.key);
    const tv = it.tv;
    const years = tv
      ? `${year(it.release_date) || 'TBA'}${tv.status === 'Ended' || tv.status === 'Canceled' ? `–${year(tv.last_air_date)}` : it.release_date && it.release_date <= today() ? '–present' : ''}`
      : '';
    const meta = [
      it.certification && `<span class="cert">${esc(it.certification)}</span>`,
      tv ? '<span class="kind">TV series</span>' : '',
      tv ? `<span>${esc(years)}</span>` : `<span>${isUpcoming(it) ? 'Releases ' : ''}${esc(fmtDate(it.release_date))}</span>`,
      tv && tv.seasons && `<span>${esc(plural(tv.seasons, 'season'))} · ${esc(plural(tv.episodes, 'episode'))}</span>`,
      it.runtime && `<span>${esc(fmtRuntime(it.runtime))}${tv ? ' / ep' : ''}</span>`,
      genreNames(it).length && `<span>${esc(genreNames(it).join(', '))}</span>`,
      it.vote_count > 20 && `<span class="score">★ ${it.vote_average.toFixed(1)} <small>(${it.vote_count.toLocaleString()})</small></span>`,
      tv?.status && tv.status !== 'Returning Series' && `<span>${esc(tv.status)}</span>`,
    ].filter(Boolean);

    els.modalBody.innerHTML = `
      <div class="m-media" id="m-media" style="${it.backdrop ? `background-image:url('${IMG}w1280${esc(it.backdrop)}')` : `background:linear-gradient(160deg,hsl(${hue(it.id)} 45% 30%),#0b0d12)`}"></div>
      <div class="m-body">
        <h2 id="modal-title">${esc(it.title)}</h2>
        ${it.tagline ? `<p class="m-tagline">${esc(it.tagline)}</p>` : ''}
        <div class="m-meta">${meta.join('')}</div>
        <div class="btns">
          ${it.trailer ? `<button class="btn primary" data-play="${esc(it.trailer)}">▶ Play trailer</button>` : ''}
          <button class="btn ${inList ? 'on' : ''}" data-watch="${esc(it.key)}">${inList ? '✓ In My List' : '+ My List'}</button>
          <a class="btn" href="https://www.themoviedb.org/${it.type}/${it.id}" target="_blank" rel="noopener">TMDB ↗</a>
        </div>
        <p class="m-overview">${esc(it.overview || 'No synopsis available yet.')}</p>
        ${tvDetails(it)}
        ${whereToWatch(it)}
      </div>`;

    if (!els.modal.open) els.modal.showModal();
    els.modal.scrollTop = 0;
    const hash = `#/${it.type}/${it.id}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    if (autoplay && it.trailer) playTrailer(it.trailer);
  }

  function playTrailer(key) {
    const media = $('#m-media');
    if (!media) return;
    media.classList.add('playing');
    media.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0" title="Trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  }

  function closeModal() {
    if (els.modal.open) els.modal.close();
  }

  function toggleWatch(key) {
    state.watchlist.has(key) ? state.watchlist.delete(key) : state.watchlist.add(key);
    store.set('rr:watchlist', [...state.watchlist]);
    const on = state.watchlist.has(key);
    document.querySelectorAll(`[data-watch="${CSS.escape(key)}"]`).forEach((b) => {
      b.classList.toggle('on', on);
      b.textContent = on ? '✓ In My List' : '+ My List';
    });
    if (state.view === 'mylist' || state.view === 'home') {
      // Re-render the page behind the modal so the list stays in sync.
      const scroll = window.scrollY;
      render();
      window.scrollTo(0, scroll);
    }
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(html, cta) {
    clearTimeout(toastTimer);
    els.toast.innerHTML = `<span>${html}</span>${cta ? `<button type="button">${esc(cta.label)}</button>` : ''}`;
    els.toast.hidden = false;
    if (cta) els.toast.querySelector('button').onclick = () => { els.toast.hidden = true; cta.action(); };
    toastTimer = setTimeout(() => (els.toast.hidden = true), 9000);
  }

  // ---------- routing ----------
  // #/  #/movies  #/tv  #/new  #/upcoming  #/mylist   — pages
  // #/movie/123  #/tv/456                             — title details
  function route() {
    const [, a = '', b] = location.hash.split('/');
    if ((a === 'movie' || a === 'tv') && b) {
      if (!els.content.querySelector('.row, .grid, .empty')) render(); // deep link: draw the page behind
      openItem(`${a}-${b}`);
      return;
    }
    closeModal();
    state.view = VIEWS.includes(a) ? a : 'home';
    state.query = '';
    els.search.value = '';
    render();
    window.scrollTo(0, 0);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-key],[data-trailer],[data-play],[data-watch]');
    if (!t) return;
    if (t.dataset.watch) return toggleWatch(t.dataset.watch);
    if (t.dataset.play) return playTrailer(t.dataset.play);
    if (t.dataset.trailer) return openItem(t.dataset.trailer, { autoplay: true });
    if (t.dataset.key) return openItem(t.dataset.key);
  });

  $('#modal-close').addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => e.target === els.modal && closeModal());
  els.modal.addEventListener('close', () => {
    els.modalBody.innerHTML = ''; // stops trailer playback
    if (/^#\/(movie|tv)\/\d+/.test(location.hash)) {
      history.replaceState(null, '', state.view === 'home' ? '#/' : `#/${state.view}`);
    }
  });

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim();
      render();
    }, 150);
  });
  els.genre.addEventListener('change', () => {
    state.genre = els.genre.value;
    render();
  });
  els.region.addEventListener('change', async () => {
    const region = els.region.value;
    try {
      await loadRegion(region);
      toast(`Showing release dates and streaming services for ${esc(REGION_INFO[region]?.name || region)}`);
    } catch (err) {
      els.region.value = state.region;
      toast(`Couldn’t load ${esc(region)} listings — please try again.`);
    }
  });
  window.addEventListener('hashchange', route);

  // Check for new releases when the tab regains focus, plus on a timer.
  document.addEventListener('visibilitychange', () => !document.hidden && checkForUpdates());
  setInterval(checkForUpdates, POLL_MS);
  setInterval(renderUpdated, 60 * 1000);

  // ---------- boot ----------
  async function init() {
    try {
      const index = await fetchJson('regions.json');
      if (Array.isArray(index.regions) && index.regions.length) state.regions = index.regions;
    } catch {
      /* no index — fall back to US only */
    }
    fillRegions();
    try {
      await loadRegion(guessRegion(state.regions), { initial: true });
    } catch (err) {
      els.content.innerHTML = `<div class="empty">Couldn’t load listings (${esc(err.message)}). If you opened this file directly, serve the folder over HTTP — see README.</div>`;
      return;
    }
    route();
  }

  init();
})();
