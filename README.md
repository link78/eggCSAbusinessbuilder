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

## Features

- 📊 **Revenue Calculator** — real-time supply/demand sliders
- 📦 **Subscription Plans** — Small Family ($19/mo), Family ($28/mo); **Solo / Couple** (flexible, min 1 box, 12-egg $5/wk or 18-egg $7/wk); **Custom Plan** (min 2 boxes, 2 weeks, mixed 12-egg and/or 18-egg boxes). All plans: +$2/delivery when choosing local delivery.
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
| `SESSION_SECRET` | Production only | Secret used to sign session cookies. Use a long, random string. |
| `PORT` | No | Port to listen on (default: `3000`) |
| `NODE_ENV` | No | Set to `production` to enable secure cookies and enforce `SESSION_SECRET` |

