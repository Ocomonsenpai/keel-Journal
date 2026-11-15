# Keel — trading journal

A static website (no build step) with a Supabase backend for accounts and cloud sync.

| File | What it is |
| --- | --- |
| `index.html` | Landing page (the site's home page) |
| `app.html` | The journal app: page layout and styles |
| `app.js` | App logic and the data layer (Supabase, or browser storage as a fallback) |
| `config.js` | Your Supabase URL and anon key |
| `supabase/schema.sql` | Database tables and security rules |

## Modes

- **Local only** (default, `config.js` empty): data is saved in the browser, with sample trades to explore.
- **Cloud** (`config.js` filled in): users sign up / sign in, and trades, plan, limits and routine
  history are stored in Postgres. Row level security means each user can only read and change their own rows.

## Connect Supabase (about 5 minutes)

1. Create a free project at <https://supabase.com/dashboard>.
2. In the project, open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon / publishable** key.
   Do not use the `service_role` / secret key — it bypasses security and must never go in a website.
4. Paste both into `config.js`.
5. Under **Authentication → URL Configuration**, set **Site URL** to wherever you host the site
   (for local testing: `http://localhost:4317`). Then add `http://localhost:4317/app.html`
   (and later `https://your-domain/app.html`) under **Redirect URLs**, so confirmation emails open the app.
6. Optional: **Authentication → Providers → Email** — turn off "Confirm email" if you want sign-up to log
   people in straight away while testing.

## Run locally

```bash
python3 -m http.server 4317
```

Then open <http://localhost:4317> for the landing page, or <http://localhost:4317/app.html> for the journal.

## Deploy

Upload the four files (keeping the `supabase/` folder is optional) to any static host:
Netlify, Vercel, Cloudflare Pages or GitHub Pages. Then update the Site URL in step 5.
