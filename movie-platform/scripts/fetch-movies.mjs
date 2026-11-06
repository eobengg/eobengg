#!/usr/bin/env node
/**
 * Pulls the latest movie data from TMDB (https://www.themoviedb.org) and writes
 * it to data/movies.json, which the website reads and polls for changes.
 *
 * Env vars:
 *   TMDB_READ_TOKEN        TMDB "API Read Access Token" (v4, preferred), or
 *   TMDB_API_KEY           TMDB v3 API key
 *   TMDB_REGION            ISO country for release dates / streaming info (default US)
 *   TMDB_LANGUAGE          Language for titles & overviews (default en-US)
 *   TMDB_PAGES             Pages (20 movies each) per list (default 2)
 *   TMDB_REFRESH_MINUTES   If set, keep running and refresh on this interval
 *
 * Usage:
 *   node scripts/fetch-movies.mjs [output-path]
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
const REGION = (process.env.TMDB_REGION || 'US').toUpperCase();
const LANGUAGE = process.env.TMDB_LANGUAGE || 'en-US';
const PAGES = Math.max(1, Number(process.env.TMDB_PAGES || 2));
const REFRESH_MINUTES = Number(process.env.TMDB_REFRESH_MINUTES || 0);
const CONCURRENCY = 8;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] || resolve(here, '../data/movies.json'));

if (!TOKEN && !KEY) {
  console.error('Missing TMDB credentials: set TMDB_READ_TOKEN or TMDB_API_KEY.');
  console.error('Get a free key at https://www.themoviedb.org/settings/api');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const uniqIds = (movies) => [...new Set(movies.map((m) => m.id))];

function pickTrailer(videos = []) {
  const yt = videos.filter((v) => v.site === 'YouTube');
  const rank = (v) =>
    (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1);
  return yt.sort((a, b) => rank(a) - rank(b))[0]?.key || null;
}

function pickProviders(all) {
  const r = all?.results?.[REGION];
  if (!r) return null;
  const map = (arr = []) =>
    arr
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

function regionalRelease(releaseDates, fallback) {
  const entry = releaseDates?.results?.find((r) => r.iso_3166_1 === REGION);
  const dates = entry?.release_dates || [];
  // Prefer theatrical (3), then limited theatrical (2), then digital (4).
  const preferred =
    dates.find((d) => d.type === 3) || dates.find((d) => d.type === 2) || dates.find((d) => d.type === 4);
  const certification = dates.map((d) => d.certification).find(Boolean) || null;
  return {
    date: preferred?.release_date?.slice(0, 10) || fallback || null,
    certification,
  };
}

async function details(id) {
  const m = await tmdb(`/movie/${id}`, {
    append_to_response: 'videos,watch/providers,release_dates',
  });
  const release = regionalRelease(m.release_dates, m.release_date);
  return {
    id: m.id,
    title: m.title,
    tagline: m.tagline || '',
    overview: m.overview || '',
    poster: m.poster_path,
    backdrop: m.backdrop_path,
    release_date: release.date,
    certification: release.certification,
    runtime: m.runtime || null,
    vote_average: Math.round((m.vote_average || 0) * 10) / 10,
    vote_count: m.vote_count || 0,
    popularity: m.popularity || 0,
    genre_ids: (m.genres || []).map((g) => g.id),
    trailer: pickTrailer(m.videos?.results),
    providers: pickProviders(m['watch/providers']),
  };
}

async function buildSnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  const regionParams = { region: REGION };

  console.log(`Fetching lists for region ${REGION} (auth: ${TOKEN ? 'v4 read access token' : 'v3 API key'})…`);
  const [genres, trending, nowPlaying, upcoming, popular, topRated] = await Promise.all([
    tmdb('/genre/movie/list'),
    list('/trending/movie/day'),
    list('/movie/now_playing', regionParams),
    list('/movie/upcoming', regionParams, PAGES + 1),
    list('/movie/popular', regionParams),
    list('/movie/top_rated', regionParams, 1),
  ]);

  const allIds = uniqIds([...trending, ...nowPlaying, ...upcoming, ...popular, ...topRated]);
  console.log(`Fetching details, trailers & streaming info for ${allIds.length} movies…`);

  const movies = {};
  const failed = [];
  await mapLimit(allIds, CONCURRENCY, async (id) => {
    try {
      movies[id] = await details(id);
    } catch (err) {
      failed.push(id);
      console.warn(`  skipped ${id}: ${err.message}`);
    }
  });
  if (failed.length > allIds.length / 2) {
    throw new Error(`Too many detail lookups failed (${failed.length}/${allIds.length})`);
  }

  const keep = (arr) => uniqIds(arr).filter((id) => movies[id]);
  const byDate = (dir) => (a, b) =>
    dir * String(movies[a].release_date || '').localeCompare(String(movies[b].release_date || ''));

  return {
    generatedAt: new Date().toISOString(),
    source: 'tmdb',
    region: REGION,
    genres: Object.fromEntries(genres.genres.map((g) => [g.id, g.name])),
    sections: {
      trending: keep(trending),
      now_playing: keep(nowPlaying)
        .filter((id) => (movies[id].release_date || '') <= today)
        .sort(byDate(-1)),
      upcoming: keep(upcoming)
        .filter((id) => (movies[id].release_date || '') > today)
        .sort(byDate(1)),
      popular: keep(popular),
      top_rated: keep(topRated),
    },
    movies,
  };
}

async function writeSnapshot(snapshot) {
  await mkdir(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot));
  await rename(tmp, OUT); // atomic swap so the site never reads a half-written file
  const s = snapshot.sections;
  console.log(
    `Wrote ${Object.keys(snapshot.movies).length} movies to ${OUT} ` +
      `(now playing ${s.now_playing.length}, upcoming ${s.upcoming.length}, trending ${s.trending.length})`,
  );
}

async function runOnce() {
  await writeSnapshot(await buildSnapshot());
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
