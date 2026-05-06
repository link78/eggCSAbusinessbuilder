# Egg CSA Business Builder

Revenue calculator — drag the sliders to match your current flock size and target subscriber count. It'll tell you if you have enough eggs to cover demand and what your monthly income looks like. Subscription plans — three tiers designed for the Lincoln market, from singles to large families.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm (included with Node.js)

### 1. Clone the repository

```bash
git clone https://github.com/link78/eggCSAbusinessbuilder.git
cd eggCSAbusinessbuilder
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set the session secret (required in production)

```bash
export SESSION_SECRET="replace-with-a-long-random-string"
```

> In development you can skip this; a default secret will be used and a warning will be printed. **Never skip this step in production.**

### 4. Start the server

```bash
npm start
# or
node server.js
```

The app will be available at **http://localhost:3000**

The SQLite database (`egg_csa.db`) is created automatically on first run — no setup required.

---

## Features

- 📊 **Revenue Calculator** — real-time supply/demand sliders
- 📦 **Subscription Plans** — Solo/Couple ($26), Small Family ($39), Family ($52) per month
  - Choose **pick-up** (select a preferred day) or **local delivery** (enter your address)
  - Monthly billing with a "cancel anytime" policy
- ✅ **Launch Checklist** — 8-step guide saved to your account
- 🗓️ **90-Day Roadmap** — week-by-week plan to reach 15–20 subscribers
- ⭐ **Reviews** — public star ratings from subscribers
- 👤 **Account** — register/login, view and cancel active subscriptions

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Production only | Secret used to sign session cookies. Use a long, random string. |
| `PORT` | No | Port to listen on (default: `3000`) |
| `NODE_ENV` | No | Set to `production` to enable secure cookies and enforce `SESSION_SECRET` |

