# Sakinah Ridge Farm LLC

Revenue calculator — drag the sliders to match your current flock size and target subscriber count. It'll tell you if you have enough eggs to cover demand and what your monthly income looks like. Subscription plans — three tiers designed for the Lincoln market, from singles to large families.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm (included with Node.js)
- [PostgreSQL](https://www.postgresql.org/) v14 or later

### 1. Clone the repository

```bash
git clone https://github.com/link78/eggCSAbusinessbuilder.git
cd eggCSAbusinessbuilder
```

### 2. Create the PostgreSQL database

```bash
createdb egg_csa
```

### 3. Install dependencies

```bash
npm install
```

### 4. Set required environment variables

```bash
export DATABASE_URL="postgresql://user:password@localhost/egg_csa"
export SESSION_SECRET="replace-with-a-long-random-string"
```

> `DATABASE_URL` points to your PostgreSQL database. The schema (tables) is created automatically on first run.
> `SESSION_SECRET` is required in production. In development a default is used and a warning is printed — **never skip this in production.**

### 5. Start the server

```bash
npm start
# or
node server.js
```

The app will be available at **http://localhost:3000**

The database schema is created automatically on first start — no manual migration required.

---

## Deployment

This repository contains the full Node.js/Express application source code required for Railpack-compatible hosts to detect and build the app:

- `package.json` — declares the Node.js runtime, dependencies, and `npm start`
- `package-lock.json` — locks dependency versions for reproducible installs
- `server.js` / `app.js` — Express entry point and application setup
- `db.js` — PostgreSQL schema initialization
- `routes/` — API route handlers
- `*.html` — static frontend pages served by Express
- `railway.json` — Railway build & deploy configuration (Railpack builder, `/healthz` healthcheck)
- `.nvmrc` — pins the Node.js version used at build time

For Railpack or similar Node.js platform deploys:

1. Push the complete repository, including `package.json`, `package-lock.json`, `server.js`, `app.js`, `db.js`, `routes/`, and frontend HTML files.
2. Configure the required environment variables in the host dashboard.
3. Use the default start command:

```bash
npm start
```

Railpack detects this as a Node.js app from `package.json` and starts `server.js` through the `start` script.

### Deploying to Railway

This repo is pre-configured for [Railway](https://railway.com) via `railway.json`:

- **Builder:** Railpack (auto-detects Node.js from `package.json`)
- **Start command:** `npm start`
- **Healthcheck:** `GET /healthz` returns `200 {"status":"ok"}`
- **Node version:** pinned via `.nvmrc` (Node 20) and `engines.node` in `package.json` (`>=18`)

**Steps:**

1. Create a new Railway project and connect this GitHub repository (or run `railway up` from the Railway CLI).
2. Add the **PostgreSQL** plugin to the project. Railway auto-injects `DATABASE_URL` into the service; the schema is created on first start by `db.js`.
3. In the service's **Variables** tab, set at minimum:
   - `SESSION_SECRET` — long random string (e.g. `openssl rand -hex 32`)
   - `NODE_ENV=production`
   - `APP_URL` — your Railway public URL (e.g. `https://<service>.up.railway.app`), required for Stripe redirects
   - Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`) if billing is enabled
4. Railway provides `PORT` automatically — `server.js` already honors `process.env.PORT`.
5. Generate a public domain under **Settings → Networking**; the healthcheck path is `/healthz`.
6. **Persistent uploads:** Railway containers have an ephemeral filesystem. To keep user uploads (profile pictures, farm-update photos, about-page images) across deploys, attach a **Volume** mounted at `/app/uploads` in the service settings.

Once deployed, Railway will redeploy automatically on every push to the connected branch.

---

## Features

- 📊 **Revenue Calculator** — real-time supply/demand sliders
- 📦 **Subscription Plans** — Small Family ($19/mo), Family ($28/mo); **Solo / Couple** (flexible, min 1 box, 12-egg $5/wk or 18-egg $7/wk); **Custom Plan** (min 1 box, mixed 12-egg and/or 18-egg boxes). All plans: +$2/delivery when choosing local delivery.
  - Choose **pick-up** (select a preferred day) or **local delivery** (enter your address)
  - Monthly billing with a "cancel anytime" policy
- ✅ **Launch Checklist** — 8-step guide saved to your account
- 🗓️ **90-Day Roadmap** — week-by-week plan to reach 15–20 subscribers
- ⭐ **Reviews** — public star ratings from subscribers
- 👤 **Account** — register/login, edit profile, upload profile picture, view and cancel active subscriptions
- 🔑 **Admin Panel** — admin users can view all accounts and assign/remove admin roles

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. The schema is created automatically on startup. |
| `DATABASE_SSL` | No | Set to `false` for local PostgreSQL if SSL should be disabled. Remote hosts default to SSL. |
| `SESSION_SECRET` | Production only | Secret used to sign session cookies. Use a long, random string. |
| `PORT` | No | Port to listen on (default: `3000`) |
| `NODE_ENV` | No | Set to `production` to enable secure cookies and enforce `SESSION_SECRET` |
| `APP_URL` | Stripe only | Public base URL used for Stripe checkout redirects. |
| `STRIPE_SECRET_KEY` | Stripe only | Stripe secret API key. |
| `STRIPE_PUBLISHABLE_KEY` | Stripe only | Stripe publishable key exposed to the frontend. |
| `STRIPE_WEBHOOK_SECRET` | Stripe only | Stripe webhook signing secret for `/webhook`. |
| `STRIPE_PRICE_SMALL_FAMILY` | Stripe only | Optional recurring Price ID for the Small Family plan. |
| `STRIPE_PRICE_FAMILY` | Stripe only | Optional recurring Price ID for the Family plan. |
| `STRIPE_PRICE_SOLO_COUPLE` | Stripe only | Optional recurring Price ID for the Solo / Couple plan. |
| `STRIPE_PRICE_CUSTOM` | Stripe only | Optional recurring Price ID for custom plans. |
