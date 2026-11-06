# 🎬 ReelRadar: a movie platform that updates itself

A website for finding movies: what's new in theaters, what's coming soon, what's trending, trailers, and **where each movie can be legally streamed, rented or bought**. New releases show up on their own, with no manual edits.

## Features

- **Home page** with a featured trending movie and rows for *Just Added*, *New Releases*, *Trending*, *Coming Soon*, *Popular*, *Top Rated* and *My List*
- **Trailers** that play inside the page (YouTube)
- **Where to watch**: streaming, free, rent and buy options for your country (TMDB / JustWatch data)
- **Search** and a **genre filter**
- **My List**: a watchlist saved in the browser
- Badges: **NEW** (released in the last 21 days), the **release date** for upcoming films, and **JUST ADDED** for titles added since your last visit
- Links to any movie, e.g. `#/movie/12345`
- Works on phones and desktops, with no build step (plain HTML, CSS and JS)

## How the auto-updates work

```
 TMDB API ──(every 3h, GitHub Action)──► data/movies.json ──► GitHub Pages
                                                  ▲
                         browser re-checks it every 5 min and when the tab regains focus
```

1. **Server side:** `.github/workflows/movie-platform.yml` runs every 3 hours. It calls `scripts/fetch-movies.mjs`, which downloads the current *now playing*, *upcoming*, *trending*, *popular* and *top rated* lists, plus details, trailers and streaming providers for each movie. Then it redeploys the site. If TMDB has an outage, the job fails and the last good version stays live.
2. **Browser side:** an open page re-checks `data/movies.json` every 5 minutes and whenever you come back to the tab. When new titles arrive, the page updates in place and shows a pop-up like *"3 new titles just landed"*. Movies first appear in **Coming Soon**, move to **New Releases** on release day, and their streaming options fill in once services announce them.

## Setup (about 5 minutes)

1. **Get a free TMDB key:** create an account at <https://www.themoviedb.org/signup>, then go to *Settings → API* and copy the **API Read Access Token**.
2. **Add it to GitHub:** in this repo, open *Settings → Secrets and variables → Actions → New repository secret*. Name it `TMDB_READ_TOKEN` and paste the token.
   - Optional: under the *Variables* tab, set `TMDB_REGION` (e.g. `GB`, `GH`, `CA`) to get release dates and streaming services for that country. The default is `US`.
3. **Turn on GitHub Pages:** *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
4. **Run it once:** *Actions → "Movie platform — refresh releases & deploy" → Run workflow*. Your site will be at `https://<username>.github.io/<repo>/`.

Until you add a key, the site runs on fictional sample data, and a banner says so.

## Run locally

```bash
cd movie-platform

# optional: load real data
export TMDB_READ_TOKEN=your_token_here
node scripts/fetch-movies.mjs

# serve the site (the page loads data with fetch, so opening index.html directly won't work)
python3 -m http.server 8000
# open http://localhost:8000
```

### Self-hosting on your own server

To keep the data fresh without GitHub Actions, run the fetcher in loop mode next to any static web server:

```bash
TMDB_READ_TOKEN=... TMDB_REFRESH_MINUTES=60 node scripts/fetch-movies.mjs
```

It writes the file atomically (to a temp file, then renamed), so visitors never get a half-written file.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TMDB_READ_TOKEN` / `TMDB_API_KEY` | none | TMDB credentials (one is required for real data) |
| `TMDB_REGION` | `US` | Country for release dates and streaming providers |
| `TMDB_LANGUAGE` | `en-US` | Language for titles and descriptions |
| `TMDB_PAGES` | `2` | Pages of 20 movies to fetch per list |
| `TMDB_REFRESH_MINUTES` | none | Keep running and refresh on this interval |

In the browser code (`js/app.js`): `POLL_MS` sets how often the page re-checks for updates, and `NEW_DAYS` sets how long the NEW badge stays on.

## Project layout

```
movie-platform/
├── index.html
├── css/styles.css
├── js/app.js                 # UI, routing, auto-update polling
├── data/movies.json          # data the site reads (sample until the Action replaces it)
└── scripts/fetch-movies.mjs  # TMDB → movies.json
```

## Legal note

This site lists movies and sends people to **licensed** services to watch them. It does not host or embed copyrighted films. TMDB's terms require the attribution shown in the footer.
