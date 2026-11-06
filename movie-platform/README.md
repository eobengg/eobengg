# 🎬 ReelRadar: a movie & TV platform that updates itself

A website for finding movies and TV shows: what's new in theaters, new episodes this week, what's coming soon, what's trending, trailers, and **where each title can be legally streamed, rented or bought** in the **US, UK and Canada**. New releases show up on their own, with no manual edits.

## Features

- **Home page** with a featured trending title and rows for *Just Added*, *New Movie Releases*, *New Episodes This Week*, *Trending*, *Coming Soon*, *New Series*, *Popular* and *My List*
- **Movies** and **TV Shows** pages. For TV: new episodes, new series, premieres and new seasons, popular on streaming, and top rated. Each show's page lists seasons, episodes, network, the next episode date and the latest episode
- **Regions: 🇺🇸 US, 🇬🇧 UK and 🇨🇦 Canada.** Release dates, age ratings and streaming services match the chosen country. The site guesses it from the browser language, and visitors can switch
- **Trailers** that play inside the page (YouTube)
- **Where to watch**: streaming, free, rent and buy options for the selected country (TMDB / JustWatch data)
- **Search** and a **genre filter**
- **My List**: a watchlist saved in the browser
- Badges: **NEW** / **NEW SERIES** (released in the last 21 days), **NEW EPISODE** (aired this week), the **release or premiere date** for upcoming titles, and **JUST ADDED** for titles added since your last visit
- Links to any title, e.g. `#/movie/12345` or `#/tv/6789`
- Works on phones and desktops, with no build step (plain HTML, CSS and JS)

## How the auto-updates work

```
 TMDB API ──(every 3h, GitHub Action)──► data/US.json, GB.json, CA.json ──► GitHub Pages
                                                  ▲
                         browser re-checks it every 5 min and when the tab regains focus
```

1. **Server side:** `.github/workflows/movie-platform.yml` runs every 3 hours. It calls `scripts/fetch-movies.mjs`, which downloads the current movie lists (*now playing*, *upcoming*, *trending*, *popular*, *top rated*) and TV lists (*airing today*, *on the air*, *new series*, *upcoming premieres*, *popular on streaming*, *top rated*), plus details, trailers and streaming providers for each title. TMDB returns every country's data in one request per title, so each title is fetched once and split into one file per region. Then it redeploys the site. If TMDB has an outage, the job fails and the last good version stays live.
2. **Browser side:** an open page re-checks its region's data file every 5 minutes and whenever you come back to the tab. When new titles arrive, the page updates in place and shows a pop-up like *"3 new titles just landed"*. Titles first appear in **Coming Soon**, move to **New Releases** on release day, and their streaming options fill in once services announce them. Shows move into **New Episodes This Week** whenever an episode airs.

## Setup (about 5 minutes)

1. **Get a free TMDB key:** create an account at <https://www.themoviedb.org/signup>, then go to *Settings → API* and copy the **API Read Access Token** (the long one starting with `eyJ`). The shorter 32-character **API Key** also works.
2. **Add it to GitHub:** in this repo, open *Settings → Secrets and variables → Actions → New repository secret*. Name it `TMDB_READ_TOKEN` and paste the token.
   - Optional: under the *Variables* tab, set `TMDB_REGIONS` to change the countries. The default is `US,GB,CA`. Any 2-letter country code works; add a flag and name for it in `REGION_INFO` in `js/app.js`.
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
| `TMDB_REGIONS` | `US,GB,CA` | Countries to build data files for (release dates, age ratings, streaming providers) |
| `TMDB_LANGUAGE` | `en-US` | Language for titles and descriptions |
| `TMDB_PAGES` | `2` | Pages of 20 titles to fetch per list |
| `TMDB_REFRESH_MINUTES` | none | Keep running and refresh on this interval |

In the browser code (`js/app.js`): `POLL_MS` sets how often the page re-checks for updates, and `NEW_DAYS` sets how long the NEW badge stays on.

## Project layout

```
movie-platform/
├── index.html
├── css/styles.css
├── js/app.js                 # UI, routing, auto-update polling
├── data/
│   ├── regions.json          # which regions exist
│   └── US.json, GB.json, CA.json  # one data file per region (sample until the Action replaces them)
└── scripts/fetch-movies.mjs  # TMDB → data/*.json
```

## Legal note

This site lists movies and TV shows and sends people to **licensed** services to watch them. It does not host or embed copyrighted films. TMDB's terms require the attribution shown in the footer.
