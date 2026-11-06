# ReelRadar Premium: subscription plan (proposal)

> Status: **draft for discussion.** Nothing here is built yet. Decisions needed are listed at the end.

## The idea in one line

The free site helps people **find** something to watch. Premium helps them **never miss** what they care about and **stop overpaying** for streaming services, so it more than pays for itself.

## Tiers

| | **Free** | **Plus** | **Premium** |
|---|---|---|---|
| Price per month | $0 | **$3.99** · £3.49 · CA$4.99 | **$6.99** · £5.99 · CA$8.99 |
| Price per year | | $39.99 (2 months free) | $69.99 (2 months free) |
| Browse movies & TV, trailers, where to watch | ✅ | ✅ | ✅ |
| Watchlist | This browser only | Synced across devices | Synced across devices |
| **My Services** filter | Pick 1 service | Unlimited | Unlimited |
| **Release Radar** alerts | | ✅ | ✅ |
| **Calendar feed** | | ✅ | ✅ |
| **Episode tracker** & *Up Next* | | ✅ | ✅ |
| **Subscription Optimizer** | | | ✅ |
| **Tonight's Pick** AI concierge | | 3 a month | Unlimited |
| **Watch Party** voting | Join only | Join only | Host |
| **Family profiles** with kids mode | | | Up to 5 |

All paid plans include a **7-day free trial**. **Founding members** (the first 500 subscribers) keep their launch price for life.

## Premium features

### 1. Release Radar alerts (Plus)
Get an email or push notification when something on your list:
- 🎬 **comes out** in theaters
- 📺 **starts streaming on a service you already pay for**. This is the moment people actually care about: "*Dune* is now on your Max."
- 🆕 **drops a new episode** or announces a new season
- ⏳ **leaves your service soon**: "Last chance: 3 titles on your list leave Netflix on the 30th"

Alerts are sent as a once-a-day digest by default, or instantly for titles you star.

### 2. My Services (free with a limit; unlimited on Plus)
Tick the services you subscribe to (Netflix, Prime Video, Disney+, BBC iPlayer, Crave…). Every row then shows **"Included with your services"** first, and a *Free tonight* filter hides anything you'd have to pay extra for. Free users can pick one service, which gives them a taste of the feature.

### 3. Calendar feed (Plus)
A private calendar link to subscribe to in Google, Apple or Outlook Calendar. Every release date, premiere and new episode from your list appears there automatically. It's simple to build, and people love it.

### 4. Episode tracker & Up Next (Plus)
Mark episodes as watched. Your home page gets an **Up Next** row ("*Severance* S2·E5 is ready") with a progress bar for each season, and catch-up reminders before a new season starts.

### 5. Subscription Optimizer: the headline feature (Premium)
Each month it compares your watchlist and tracked shows with what each service will carry, and gives plain advice:

> 💡 **This month:** Pause **Apple TV+**. Nothing on your list airs there until March.
> 💡 **In December:** Switch to **Max** for one month. 4 of your shows finish their seasons there.
> 💰 **Estimated savings: $16.98 a month**

It shows a running "ReelRadar saved you $___ this year" figure, which makes it easy to justify the subscription. This is the main reason people would pay.

### 6. Tonight's Pick AI concierge (Premium; 3 a month on Plus)
Ask in plain language: *"Something funny, under 100 minutes, on my services, that my partner and I haven't seen."* It answers with 3 picks and a one-line reason for each, using your services, watch history and ratings. It runs on the Claude API, and the per-month cap keeps costs predictable.

### 7. Watch Party voting (Premium hosts; anyone can join)
Make a shortlist and send friends a link. Everyone swipes 👍 / 👎, and the site picks the winner along with where all of you can watch it. Guests don't need an account, which makes this a growth loop: every party brings in new visitors.

### 8. Family profiles & kids mode (Premium)
Up to 5 profiles, each with its own list and alerts. Kids profiles hide anything above an age rating using the **official rating for your country**: G/PG in the US, U/PG in the UK, G/PG in Canada. The site already has this data.

## Suggested build order

| Phase | What ships | Why first |
|---|---|---|
| **A: Accounts** | Sign-in (email link or Google), synced watchlist, My Services (1 free service) | Free accounts are the base we convert from |
| **B: Launch Plus** | Checkout, Release Radar, calendar feed, episode tracker, billing page | The strongest everyday features. Starts revenue |
| **C: Launch Premium** | Subscription Optimizer, Tonight's Pick, Watch Party, family profiles | Higher-value features once Plus works |

## How it would work technically

The current site is static (GitHub Pages), which is great for speed and cost. Subscriptions need a small backend added alongside it:

- **Accounts & database:** Supabase (Postgres, sign-in, row-level security; free tier to start). Stores watchlists, services, watched episodes and profiles.
- **Payments: recommend a *merchant of record*** such as **Paddle** or **Lemon Squeezy**. Selling in the US, UK and Canada means collecting UK VAT and Canadian GST/HST, and a merchant of record files those taxes for you. The alternative is **Stripe + Stripe Tax**: slightly lower fees, but you register and file in each country yourself.
- **Alerts:** the existing 3-hourly job already sees every change in releases. It would compare against users' lists and send email (e.g. Resend) and web push.
- **Feature gating:** paid features are enforced on the server (not just hidden in the browser), so they can't be unlocked by editing the page.

## Risks to clear first ⚠️

1. **TMDB commercial licence.** TMDB's free API is for **non-commercial** use. Once we charge money, we need a commercial agreement with TMDB (contact them via themoviedb.org). Streaming-availability data comes from JustWatch, which has its own terms for commercial use. **This must be sorted out before launch.**
2. **Privacy law.** Accounts mean following UK GDPR, Canada's PIPEDA and US state laws (e.g. California's CCPA). That means a privacy policy, a way to export or delete an account, and consent for marketing email.
3. **"Leaving soon" data** is not in TMDB. That alert needs an extra data source or must be dropped from v1.

## Rough numbers

With 10,000 monthly visitors, 3% converting and 70% of subscribers on Plus, that's 300 subscribers and about **$1,450 per month**. Main costs: payment fees (5% + 50¢ on a merchant of record), Supabase and email (≈$25–50 a month at that size), Claude API for Tonight's Pick (capped), and any TMDB licence fee.

## Decisions needed

1. **Payment provider:** merchant of record (Paddle / Lemon Squeezy, recommended) or Stripe?
2. **Prices and names:** keep *Plus* at $3.99 and *Premium* at $6.99, or adjust?
3. **v1 scope:** is Phase A + B (accounts, then Plus) the right first release?
4. **TMDB licence:** are you happy to contact TMDB about commercial terms?
