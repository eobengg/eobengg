#!/usr/bin/env node
/**
 * Pulls the latest movies and TV shows from TMDB (https://www.themoviedb.org)
 * and writes one data file per region (data/US.json, data/GB.json, …) plus
 * data/regions.json. The website reads these and polls them for changes.
 *
 * Each title's details are fetched once: TMDB returns streaming providers,
 * release dates and age ratings for every country in a single response, so
 * adding regions costs only a few extra list requests.
 *
 * Env vars:
 *   TMDB_READ_TOKEN        TMDB "API Read Access Token" (v4) or v3 API key
 *   TMDB_API_KEY           Alternative place for the same credential
 *   TMDB_REGIONS           Comma-separated ISO countries (default US,GB,CA)
 *   TMDB_LANGUAGE          Language for titles & overviews (default en-US)
 *   TMDB_PAGES             Pages (20 titles each) per list (default 2)
 *   TMDB_REFRESH_MINUTES   If set, keep running and refresh on this interval
 *
 * Usage:
 *   node scripts/fetch-movies.mjs [output-dir]
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.themoviedb.org/3';

// Tolerate common copy/paste slips: surrounding spaces or quotes, a "Bearer " prefix.
const clean = (v) => (v || '').trim().replace(/^Bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
let TOKEN = clean(process.env.TMDB_READ_TOKEN);
let KEY = clean(process.env.TMDB_API_KEY);
// A v4 Read Access Token is a long JWT (three dot-separated parts); a v3 API key is a
// short 32-character hex string. Accept either one in either variable.
const isJwt = (v) => v.split('.').length === 3;
if (TOKEN && !isJwt(TOKEN)) {
  KEY = KEY || TOKEN;
  TOKEN = '';
}
if (KEY && isJwt(KEY) && !TOKEN) {
  TOKEN = KEY;
  KEY = '';
}

const REGIONS = [
  ...new Set(
    (process.env.TMDB_REGIONS || process.env.TMDB_REGION || 'US,GB,CA')
      .split(',')
      .map((r) => r.trim().toUpperCase())
      .filter((r) => /^[A-Z]{2}$/.test(r)),
  ),
];
const LANGUAGE = process.env.TMDB_LANGUAGE || 'en-US';
const PAGES = Math.max(1, Number(process.env.TMDB_PAGES || 2));
const REFRESH_MINUTES = Number(process.env.TMDB_REFRESH_MINUTES || 0);
const CONCURRENCY = 8;
// Talk shows, news and soaps crowd out scripted series in discovery lists.
const TV_EXCLUDED_GENRES = '10763,10767,10766';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(process.argv[2] || resolve(here, '../data'));

if (!TOKEN && !KEY) {
  console.error('Missing TMDB credentials: set TMDB_READ_TOKEN or TMDB_API_KEY.');
  console.error('Get a free key at https://www.themoviedb.org/settings/api');
  process.exit(1);
}
if (!REGIONS.length) {
  console.error('TMDB_REGIONS must list at least one 2-letter country code, e.g. US,GB,CA');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

async function tmdb(path, params = {}, attempt = 0) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries({ language: LANGUAGE, ...params })) {
    url.searchParams.set(k, String(v));
  }
  const headers = { accept: 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  else url.searchParams.set('api_key', KEY);

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    if (attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return tmdb(path, params, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await sleep(retryAfter * 1000);
    return tmdb(path, params, attempt + 1);
  }
  if (res.status === 401) {
    throw new Error(
      `TMDB rejected the credentials (401): ${await res.text()}\n` +
        `Check the secret value at https://www.themoviedb.org/settings/api — copy either the ` +
        `"API Read Access Token" (long, starts with "eyJ") or the "API Key" (32 characters), ` +
        `with no extra spaces, and save it as the TMDB_READ_TOKEN repository secret.`,
    );
  }
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}: ${await res.text()}`);
  return res.json();
}

async function list(path, params = {}, pages = PAGES) {
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const data = await tmdb(path, { ...params, page });
    results.push(...data.results);
    if (page >= data.total_pages) break;
  }
  return results;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const ids = (results) => [...new Set(results.map((r) => r.id))];

// ---------- field extraction ----------
function pickTrailer(videos = []) {
  const yt = videos.filter((v) => v.site === 'YouTube');
  const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1);
  return yt.sort((a, b) => rank(a) - rank(b))[0]?.key || null;
}

function pickProviders(all, region) {
  const r = all?.results?.[region];
  if (!r) return null;
  const map = (arr = []) =>
    [...arr]
      .sort((a, b) => a.display_priority - b.display_priority)
      .map((p) => ({ name: p.provider_name, logo: p.logo_path }));
  return {
    link: r.link || null,
    stream: map(r.flatrate),
    free: map([...(r.free || []), ...(r.ads || [])]),
    rent: map(r.rent),
    buy: map(r.buy),
  };
}

function movieRelease(releaseDates, region, fallback) {
  const dates = releaseDates?.results?.find((r) => r.iso_3166_1 === region)?.release_dates || [];
  // Prefer theatrical (3), then limited theatrical (2), then digital (4).
  const preferred = dates.find((d) => d.type === 3) || dates.find((d) => d.type === 2) || dates.find((d) => d.type === 4);
  return {
    date: preferred?.release_date?.slice(0, 10) || fallback || null,
    certification: dates.map((d) => d.certification).find(Boolean) || null,
  };
}

const episode = (e) =>
  e ? { date: e.air_date || null, season: e.season_number, episode: e.episode_number, name: e.name || '' } : null;

// Region-independent part of a title, plus the raw data needed per region.
function baseMovie(m) {
  return {
    item: {
      key: `movie-${m.id}`,
      type: 'movie',
      id: m.id,
      title: m.title,
      tagline: m.tagline || '',
      overview: m.overview || '',
      poster: m.poster_path,
      backdrop: m.backdrop_path,
      runtime: m.runtime || null,
      vote_average: Math.round((m.vote_average || 0) * 10) / 10,
      vote_count: m.vote_count || 0,
      popularity: m.popularity || 0,
      genre_ids: (m.genres || []).map((g) => g.id),
      trailer: pickTrailer(m.videos?.results),
    },
    forRegion: (region) => {
      const rel = movieRelease(m.release_dates, region, m.release_date);
      return { release_date: rel.date, certification: rel.certification, providers: pickProviders(m['watch/providers'], region) };
    },
  };
}

function baseShow(s) {
  return {
    item: {
      key: `tv-${s.id}`,
      type: 'tv',
      id: s.id,
      title: s.name,
      tagline: s.tagline || '',
      overview: s.overview || '',
      poster: s.poster_path,
      backdrop: s.backdrop_path,
      release_date: s.first_air_date || null,
      runtime: s.episode_run_time?.[0] || s.last_episode_to_air?.runtime || null,
      vote_average: Math.round((s.vote_average || 0) * 10) / 10,
      vote_count: s.vote_count || 0,
      popularity: s.popularity || 0,
      genre_ids: (s.genres || []).map((g) => g.id),
      trailer: pickTrailer(s.videos?.results),
      tv: {
        status: s.status || null,
        seasons: s.number_of_seasons || 0,
        episodes: s.number_of_episodes || 0,
        networks: (s.networks || []).map((n) => n.name).slice(0, 3),
        last_air_date: s.last_air_date || null,
        last_episode: episode(s.last_episode_to_air),
        next_episode: episode(s.next_episode_to_air),
      },
    },
    forRegion: (region) => ({
      certification: s.content_ratings?.results?.find((r) => r.iso_3166_1 === region)?.rating || null,
      providers: pickProviders(s['watch/providers'], region),
    }),
  };
}

// ---------- snapshot ----------
async function buildSnapshots() {
  const today = isoDay(0);
  const tvDiscover = { sort_by: 'popularity.desc', without_genres: TV_EXCLUDED_GENRES };

  console.log(`Fetching lists for ${REGIONS.join(', ')}…`);
  const [movieGenres, tvGenres, global] = await Promise.all([
    tmdb('/genre/movie/list'),
    tmdb('/genre/tv/list'),
    Promise.all([
      list('/trending/movie/day'),
      list('/movie/top_rated', {}, 1),
      list('/trending/tv/day'),
      list('/tv/airing_today'),
      list('/tv/on_the_air'),
      list('/tv/top_rated', {}, 1),
      list('/discover/tv', { ...tvDiscover, 'first_air_date.gte': isoDay(-60), 'first_air_date.lte': today }),
      list('/discover/tv', { ...tvDiscover, 'first_air_date.gte': isoDay(1), 'first_air_date.lte': isoDay(120) }),
    ]),
  ]);
  const [trendingMovies, topMovies, trendingTv, airingToday, onTheAir, topTv, newTv, upcomingTv] = global;

  const regional = {};
  for (const region of REGIONS) {
    const [nowPlaying, upcoming, popularMovies, popularTv] = await Promise.all([
      list('/movie/now_playing', { region }),
      list('/movie/upcoming', { region }, PAGES + 1),
      list('/movie/popular', { region }),
      list('/discover/tv', { ...tvDiscover, watch_region: region, with_watch_monetization_types: 'flatrate|free|ads' }),
    ]);
    regional[region] = { nowPlaying, upcoming, popularMovies, popularTv };
  }

  const movieIds = ids([
    ...trendingMovies,
    ...topMovies,
    ...Object.values(regional).flatMap((r) => [...r.nowPlaying, ...r.upcoming, ...r.popularMovies]),
  ]);
  const tvIds = ids([
    ...trendingTv,
    ...airingToday,
    ...onTheAir,
    ...topTv,
    ...newTv,
    ...upcomingTv,
    ...Object.values(regional).flatMap((r) => r.popularTv),
  ]);
  console.log(`Fetching details for ${movieIds.length} movies and ${tvIds.length} shows…`);

  const base = {};
  const jobs = [
    ...movieIds.map((id) => ({ type: 'movie', id })),
    ...tvIds.map((id) => ({ type: 'tv', id })),
  ];
  let failed = 0;
  await mapLimit(jobs, CONCURRENCY, async ({ type, id }) => {
    try {
      const extra = type === 'movie' ? 'videos,watch/providers,release_dates' : 'videos,watch/providers,content_ratings';
      const data = await tmdb(`/${type}/${id}`, { append_to_response: extra });
      base[`${type}-${id}`] = type === 'movie' ? baseMovie(data) : baseShow(data);
    } catch (err) {
      failed++;
      console.warn(`  skipped ${type} ${id}: ${err.message.split('\n')[0]}`);
    }
  });
  if (failed > jobs.length / 2) throw new Error(`Too many detail lookups failed (${failed}/${jobs.length})`);

  const generatedAt = new Date().toISOString();
  const genres = Object.fromEntries(
    [...movieGenres.genres, ...tvGenres.genres].map((g) => [g.id, g.name]),
  );

  const snapshots = {};
  for (const region of REGIONS) {
    const items = {};
    const use = (type, results) =>
      ids(results)
        .map((id) => `${type}-${id}`)
        .filter((key) => {
          if (!base[key]) return false;
          items[key] ||= { ...base[key].item, ...base[key].forRegion(region) };
          return true;
        });
    const byDate = (dir, dateOf = (it) => it.release_date) => (a, b) =>
      dir * String(dateOf(items[a]) || '').localeCompare(String(dateOf(items[b]) || ''));
    const r = regional[region];
    const weekAgo = isoDay(-7);

    const sections = {
      // Movies
      trending_movies: use('movie', trendingMovies),
      now_playing: use('movie', r.nowPlaying)
        .filter((k) => (items[k].release_date || '') <= today)
        .sort(byDate(-1)),
      upcoming_movies: use('movie', r.upcoming)
        .filter((k) => (items[k].release_date || '') > today)
        .sort(byDate(1)),
      popular_movies: use('movie', r.popularMovies),
      top_rated_movies: use('movie', topMovies),
      // TV
      trending_tv: use('tv', trendingTv),
      new_episodes: use('tv', [...airingToday, ...onTheAir])
        .filter((k) => (items[k].tv.last_episode?.date || '') >= weekAgo)
        .sort(byDate(-1, (it) => it.tv.last_episode?.date)),
      new_tv: use('tv', newTv)
        .filter((k) => items[k].poster)
        .sort(byDate(-1)),
      upcoming_tv: [
        ...use('tv', upcomingTv).filter((k) => items[k].poster && (items[k].release_date || '') > today),
        // Returning shows with a new season premiering soon.
        ...use('tv', [...trendingTv, ...onTheAir, ...topTv]).filter((k) => {
          const next = items[k].tv.next_episode;
          return next?.episode === 1 && next.season > 1 && (next.date || '') > today;
        }),
      ]
        .filter((k, i, a) => a.indexOf(k) === i)
        .sort(byDate(1, (it) => (it.release_date > today ? it.release_date : it.tv.next_episode?.date))),
      popular_tv: use('tv', r.popularTv),
      top_rated_tv: use('tv', topTv),
    };

    snapshots[region] = { generatedAt, source: 'tmdb', region, genres, sections, items };
  }
  return snapshots;
}

async function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, path); // atomic swap so the site never reads a half-written file
}

async function runOnce() {
  const snapshots = await buildSnapshots();
  await mkdir(OUT_DIR, { recursive: true });
  for (const [region, snap] of Object.entries(snapshots)) {
    await writeJson(join(OUT_DIR, `${region}.json`), snap);
    const s = snap.sections;
    console.log(
      `${region}: ${Object.keys(snap.items).length} titles ` +
        `(movies: now playing ${s.now_playing.length}, upcoming ${s.upcoming_movies.length}; ` +
        `TV: new episodes ${s.new_episodes.length}, new series ${s.new_tv.length}, upcoming ${s.upcoming_tv.length})`,
    );
  }
  const generatedAt = Object.values(snapshots)[0].generatedAt;
  await writeJson(join(OUT_DIR, 'regions.json'), { generatedAt, regions: Object.keys(snapshots) });
}

if (REFRESH_MINUTES > 0) {
  console.log(`Auto-refresh every ${REFRESH_MINUTES} min. Ctrl+C to stop.`);
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.error(`Refresh failed (keeping previous data): ${err.message}`);
    }
    await sleep(REFRESH_MINUTES * 60 * 1000);
  }
} else {
  runOnce().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
