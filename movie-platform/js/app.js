/* ReelRadar — movie discovery front end.
 * Reads data/movies.json (refreshed on a schedule by scripts/fetch-movies.mjs)
 * and polls it so new releases appear without reloading the page. */
(() => {
  'use strict';

  const DATA_URL = 'data/movies.json';
  const POLL_MS = 5 * 60 * 1000; // check for fresh data every 5 minutes
  const NEW_DAYS = 21; // "NEW" badge for movies released in the last N days
  const IMG = 'https://image.tmdb.org/t/p/';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    content: $('#content'),
    hero: $('#hero'),
    notice: $('#notice'),
    genre: $('#genre'),
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

  const state = {
    data: null,
    view: 'home',
    query: '',
    genre: '',
    justAdded: new Set(),
    watchlist: new Set(store.get('rr:watchlist', [])),
  };

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const today = () => new Date().toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const year = (d) => (d ? d.slice(0, 4) : '');
  const fmtDate = (d) =>
    d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBA';
  const fmtRuntime = (m) => (m ? `${Math.floor(m / 60)}h ${m % 60}m` : '');
  const hue = (id) => (Number(id) * 47) % 360;

  const movie = (id) => state.data?.movies?.[id];
  const section = (name) => (state.data?.sections?.[name] || []).map(movie).filter(Boolean);
  const allMovies = () => Object.values(state.data?.movies || {});
  const genreNames = (m) => (m.genre_ids || []).map((g) => state.data.genres?.[g]).filter(Boolean);

  const isUpcoming = (m) => m.release_date && m.release_date > today();
  const isNew = (m) => {
    if (!m.release_date || isUpcoming(m)) return false;
    return daysBetween(m.release_date, today()) <= NEW_DAYS;
  };

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    const units = [
      [86400, 'day'],
      [3600, 'hour'],
      [60, 'minute'],
    ];
    for (const [sec, name] of units) {
      if (s >= sec) {
        const n = Math.floor(s / sec);
        return `${n} ${name}${n > 1 ? 's' : ''} ago`;
      }
    }
    return '';
  }

  // ---------- data ----------
  async function fetchData() {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.movies || !data?.sections) throw new Error('Malformed data file');
    return data;
  }

  // Track which titles this browser has already seen, so newly added
  // releases get a "JUST ADDED" badge on the next visit.
  function trackSeen(data, { markNew }) {
    const ids = Object.keys(data.movies);
    const seen = store.get('rr:seen', null);
    if (markNew && Array.isArray(seen)) {
      const prev = new Set(seen.map(String));
      ids.forEach((id) => !prev.has(id) && state.justAdded.add(id));
    }
    store.set('rr:seen', ids);
  }

  async function checkForUpdates() {
    if (!state.data) return;
    try {
      const fresh = await fetchData();
      if (fresh.generatedAt === state.data.generatedAt) return;
      const before = new Set(Object.keys(state.data.movies));
      const added = Object.keys(fresh.movies).filter((id) => !before.has(id));
      added.forEach((id) => state.justAdded.add(id));
      state.data = fresh;
      store.set('rr:seen', Object.keys(fresh.movies));
      fillGenres();
      render();
      if (added.length) {
        const first = movie(added[0]);
        toast(
          `${added.length} new title${added.length > 1 ? 's' : ''} just landed${first ? ` — including <b>${esc(first.title)}</b>` : ''}`,
          first ? { label: 'View', action: () => openMovie(first.id) } : null,
        );
      } else {
        toast('Movie listings refreshed with the latest info');
      }
    } catch (err) {
      console.warn('Update check failed:', err);
    }
  }

  // ---------- rendering ----------
  function poster(m) {
    if (m.poster) {
      return `<img src="${IMG}w342${esc(m.poster)}" alt="" loading="lazy" decoding="async" />`;
    }
    return `<div class="poster-fallback" style="--h:${hue(m.id)}">${esc(m.title)}</div>`;
  }

  function badges(m) {
    const b = [];
    if (state.justAdded.has(String(m.id))) b.push('<span class="badge fresh">Just added</span>');
    if (isNew(m)) b.push('<span class="badge new">New</span>');
    if (isUpcoming(m)) b.push(`<span class="badge soon">${esc(fmtDate(m.release_date).replace(/, \d{4}$/, ''))}</span>`);
    return b.length ? `<div class="badges">${b.join('')}</div>` : '';
  }

  function card(m) {
    const rating = m.vote_count > 20 ? `<span class="rating">★ ${m.vote_average.toFixed(1)}</span>` : '';
    const sub = isUpcoming(m) ? `Coming ${fmtDate(m.release_date)}` : year(m.release_date);
    return `
      <button class="card" data-id="${m.id}" aria-label="${esc(m.title)}">
        <div class="poster">${poster(m)}${badges(m)}${rating}</div>
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-sub">${esc(sub)}</div>
      </button>`;
  }

  function row(title, movies, link) {
    if (!movies.length) return '';
    const more = link ? `<a href="${link}">See all ›</a>` : '';
    return `
      <section class="row">
        <div class="row-head"><h2>${esc(title)}</h2>${more}</div>
        <div class="row-track">${movies.slice(0, 30).map(card).join('')}</div>
      </section>`;
  }

  function grid(title, sub, movies, emptyMsg) {
    return `
      <h1 class="page-title">${esc(title)}</h1>
      ${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}
      ${movies.length ? `<div class="grid">${movies.map(card).join('')}</div>` : `<div class="empty">${esc(emptyMsg)}</div>`}`;
  }

  function renderHero() {
    const trending = section('trending').filter((m) => m.overview);
    const pool = trending.some((m) => m.backdrop) ? trending.filter((m) => m.backdrop) : trending;
    const m = pool.find(isNew) || pool[0];
    if (!m || state.view !== 'home' || state.query || state.genre) {
      els.hero.hidden = true;
      return;
    }
    els.hero.hidden = false;
    els.hero.style.backgroundImage = m.backdrop
      ? `url("${IMG}original${m.backdrop}")`
      : `linear-gradient(120deg, hsl(${hue(m.id)} 45% 22%), hsl(${hue(m.id) + 40} 50% 10%))`;
    const inList = state.watchlist.has(m.id);
    els.hero.innerHTML = `
      <div class="hero-inner">
        <div class="eyebrow">${isNew(m) ? 'New release · Trending now' : 'Trending now'}</div>
        <h1>${esc(m.title)}</h1>
        <div class="meta">${esc([year(m.release_date), genreNames(m).slice(0, 3).join(' · '), m.vote_count > 20 ? `★ ${m.vote_average.toFixed(1)}` : ''].filter(Boolean).join('  •  '))}</div>
        <p>${esc(m.overview)}</p>
        <div class="btns">
          ${m.trailer ? `<button class="btn primary" data-trailer="${m.id}">▶ Play trailer</button>` : ''}
          <button class="btn" data-id="${m.id}">ⓘ More info</button>
          <button class="btn ${inList ? 'on' : ''}" data-watch="${m.id}">${inList ? '✓ In My List' : '+ My List'}</button>
        </div>
      </div>`;
  }

  function render() {
    if (!state.data) return;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view && !state.query));
    renderHero();
    renderUpdated();

    // Search / genre filter overrides the current view.
    if (state.query || state.genre) {
      const q = state.query.toLowerCase();
      const results = allMovies()
        .filter((m) => !q || m.title.toLowerCase().includes(q) || (m.overview || '').toLowerCase().includes(q))
        .filter((m) => !state.genre || (m.genre_ids || []).includes(Number(state.genre)))
        .sort((a, b) => b.popularity - a.popularity);
      const label = [state.query && `“${state.query}”`, state.genre && state.data.genres[state.genre]].filter(Boolean).join(' in ');
      els.content.innerHTML = grid(`Results for ${label}`, `${results.length} movie${results.length === 1 ? '' : 's'}`, results, 'No movies match your search.');
      return;
    }

    const watch = [...state.watchlist].map(movie).filter(Boolean);
    const justAdded = [...state.justAdded].map(movie).filter(Boolean);

    switch (state.view) {
      case 'new':
        els.content.innerHTML = grid('New Releases', 'Recently released in theaters and on streaming, newest first.', section('now_playing'), 'No new releases right now.');
        break;
      case 'upcoming':
        els.content.innerHTML = grid('Coming Soon', 'Upcoming releases, soonest first.', section('upcoming'), 'No upcoming releases listed yet.');
        break;
      case 'mylist':
        els.content.innerHTML = grid('My List', 'Movies you saved. Stored in this browser.', watch, 'Your list is empty — tap “+ My List” on any movie.');
        break;
      default:
        els.content.innerHTML = [
          row('Just Added', justAdded),
          row('New Releases', section('now_playing'), '#/new'),
          row('Trending Today', section('trending')),
          row('Coming Soon', section('upcoming'), '#/upcoming'),
          row('My List', watch, '#/mylist'),
          row('Popular', section('popular')),
          row('Top Rated', section('top_rated')),
        ].join('');
    }
  }

  function renderUpdated() {
    if (!state.data) return;
    const when = new Date(state.data.generatedAt);
    els.updated.innerHTML = `<span class="dot"></span>Auto-updating · catalog refreshed ${esc(timeAgo(state.data.generatedAt))}`;
    els.updated.title = when.toLocaleString();
  }

  function fillGenres() {
    const current = els.genre.value;
    const entries = Object.entries(state.data.genres || {}).sort((a, b) => a[1].localeCompare(b[1]));
    els.genre.innerHTML = `<option value="">All genres</option>${entries.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}`;
    els.genre.value = current;
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

  function whereToWatch(m) {
    const p = m.providers;
    const region = state.data.region ? ` in ${esc(state.data.region)}` : '';
    const groups = p ? [providerGroup('Stream', p.stream, p.link), providerGroup('Free', p.free, p.link), providerGroup('Rent', p.rent, p.link), providerGroup('Buy', p.buy, p.link)].join('') : '';
    let body = groups;
    if (!body) {
      body = isUpcoming(m)
        ? `<p class="watch-none">Releases ${esc(fmtDate(m.release_date))}. Streaming options will appear here automatically once announced.</p>`
        : isNew(m)
          ? '<p class="watch-none">Now playing in theaters. Streaming options will show up here automatically when available.</p>'
          : `<p class="watch-none">No streaming options listed${region} yet.</p>`;
    }
    const more = p?.link ? `<a class="watch-link" href="${esc(p.link)}" target="_blank" rel="noopener">All options on TMDB / JustWatch ›</a>` : '';
    return `<div class="watch"><h3>Where to watch${region}</h3>${body}${more}</div>`;
  }

  function openMovie(id, { autoplay = false } = {}) {
    const m = movie(id);
    if (!m) return;
    const inList = state.watchlist.has(m.id);
    const meta = [
      m.certification && `<span class="cert">${esc(m.certification)}</span>`,
      `<span>${isUpcoming(m) ? 'Releases ' : ''}${esc(fmtDate(m.release_date))}</span>`,
      m.runtime && `<span>${esc(fmtRuntime(m.runtime))}</span>`,
      genreNames(m).length && `<span>${esc(genreNames(m).join(', '))}</span>`,
      m.vote_count > 20 && `<span class="score">★ ${m.vote_average.toFixed(1)} <small>(${m.vote_count.toLocaleString()})</small></span>`,
    ].filter(Boolean);

    els.modalBody.innerHTML = `
      <div class="m-media" id="m-media" style="${m.backdrop ? `background-image:url('${IMG}w1280${esc(m.backdrop)}')` : `background:linear-gradient(160deg,hsl(${hue(m.id)} 45% 30%),#0b0d12)`}"></div>
      <div class="m-body">
        <h2 id="modal-title">${esc(m.title)}</h2>
        ${m.tagline ? `<p class="m-tagline">${esc(m.tagline)}</p>` : ''}
        <div class="m-meta">${meta.join('')}</div>
        <div class="btns">
          ${m.trailer ? `<button class="btn primary" data-play="${esc(m.trailer)}">▶ Play trailer</button>` : ''}
          <button class="btn ${inList ? 'on' : ''}" data-watch="${m.id}">${inList ? '✓ In My List' : '+ My List'}</button>
          <a class="btn" href="https://www.themoviedb.org/movie/${m.id}" target="_blank" rel="noopener">TMDB ↗</a>
        </div>
        <p class="m-overview">${esc(m.overview || 'No synopsis available yet.')}</p>
        ${whereToWatch(m)}
      </div>`;

    if (!els.modal.open) els.modal.showModal();
    els.modal.scrollTop = 0;
    if (location.hash !== `#/movie/${m.id}`) history.replaceState(null, '', `#/movie/${m.id}`);
    if (autoplay && m.trailer) playTrailer(m.trailer);
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

  function toggleWatch(id) {
    id = Number(id);
    state.watchlist.has(id) ? state.watchlist.delete(id) : state.watchlist.add(id);
    store.set('rr:watchlist', [...state.watchlist]);
    const on = state.watchlist.has(id);
    document.querySelectorAll(`[data-watch="${id}"]`).forEach((b) => {
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
  function route() {
    const [, view = '', id] = location.hash.split('/');
    if (view === 'movie' && id) {
      if (!els.content.querySelector('.row, .grid, .empty')) render(); // deep link: draw the page behind
      openMovie(id);
      return;
    }
    closeModal();
    state.view = ['new', 'upcoming', 'mylist'].includes(view) ? view : 'home';
    state.query = '';
    els.search.value = '';
    render();
    window.scrollTo(0, 0);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id],[data-trailer],[data-play],[data-watch]');
    if (!t) return;
    if (t.dataset.watch) return toggleWatch(t.dataset.watch);
    if (t.dataset.play) return playTrailer(t.dataset.play);
    if (t.dataset.trailer) return openMovie(t.dataset.trailer, { autoplay: true });
    if (t.dataset.id) return openMovie(t.dataset.id);
  });

  $('#modal-close').addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => e.target === els.modal && closeModal());
  els.modal.addEventListener('close', () => {
    els.modalBody.innerHTML = ''; // stops trailer playback
    if (location.hash.startsWith('#/movie/')) {
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
  window.addEventListener('hashchange', route);

  // Check for new releases when the tab regains focus, plus on a timer.
  document.addEventListener('visibilitychange', () => !document.hidden && checkForUpdates());
  setInterval(checkForUpdates, POLL_MS);
  setInterval(renderUpdated, 60 * 1000);

  // ---------- boot ----------
  async function init() {
    try {
      state.data = await fetchData();
    } catch (err) {
      els.content.innerHTML = `<div class="empty">Couldn’t load movies (${esc(err.message)}). If you opened this file directly, serve the folder over HTTP — see README.</div>`;
      return;
    }
    if (state.data.source === 'sample') {
      els.notice.hidden = false;
      els.notice.innerHTML = 'Showing <b>sample data</b>. Add a free TMDB key as the <code>TMDB_READ_TOKEN</code> repository secret (or run <code>scripts/fetch-movies.mjs</code>) to load real, auto-updating releases.';
    }
    trackSeen(state.data, { markNew: true });
    fillGenres();
    route();
  }

  init();
})();
