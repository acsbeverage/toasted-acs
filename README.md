# Toasted — ACS Beverage Co. Backend

This server handles email notifications for Toasted (order alerts to Kevin, Jessica, and the placing rep).

---

## Deploy in 4 steps (~20 minutes)

### Step 1 — Put Toasted HTML in the public folder

Copy your `vinopro-platform.html` file into this folder and rename it:

```
toasted-backend/
  public/
    index.html    ← rename vinopro-platform.html to index.html
```

### Step 2 — Push to GitHub

1. Go to [github.com](https://github.com) and create a **New repository** called `toasted-acs`
2. Make it **Private**
3. On your computer, open Terminal and run:

```bash
cd toasted-backend
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/toasted-acs.git
git push -u origin main
```

### Step 3 — Deploy on Render.com (free)

1. Go to [render.com](https://render.com) and sign up (free, no credit card)
2. Click **New +** → **Web Service**
3. Connect your GitHub account and select `toasted-acs`
4. Render auto-detects the settings from `render.yaml`
5. Add these **Environment Variables** in Render dashboard:

| Key | Value |
|-----|-------|
| `SENDGRID_API_KEY` | *(your SendGrid key — see Step 4)* |
| `FROM_EMAIL` | `accounting@acsbeverage.com` |
| `FROM_NAME` | `Toasted — ACS Beverage Co.` |
| `NOTIFY_EMAILS` | `kevin@acsbeverage.com,jessica@acsbeverage.com` |

6. Click **Deploy** — in ~3 minutes you get a URL like `https://toasted-acs.onrender.com`

### Step 4 — Set up SendGrid (free — 100 emails/day)

1. Go to [sendgrid.com](https://sendgrid.com) and sign up for free
2. Go to **Settings → Sender Authentication** and verify `acsbeverageco.com`
3. Go to **Settings → API Keys** → **Create API Key** → **Restricted Access**
   - Enable: **Mail Send → Full Access**
4. Copy the API key and paste it into Render as `SENDGRID_API_KEY`
5. Trigger a redeploy in Render (click **Manual Deploy → Deploy latest commit**)

---

## Test it's working

Visit `https://toasted-acs.onrender.com/health` — you should see:
```json
{ "status": "ok", "time": "..." }
```

Place a test order in Toasted — Kevin and Jessica should receive an email within seconds.

---

## Custom domain (optional)

To use `portal.acsbeverageco.com`:

1. In Render dashboard → your service → **Custom Domains** → Add `portal.acsbeverageco.com`
2. Render gives you a CNAME record to add to your DNS
3. In your domain registrar (GoDaddy, Namecheap, etc.) add that CNAME
4. SSL is automatic — done in ~10 minutes

---

## File structure

```
toasted-backend/
├── server.js          ← Express server (email API + serves Toasted)
├── package.json
├── render.yaml        ← Render deployment config
├── .env.example       ← Copy to .env for local testing
├── .gitignore
├── README.md
└── public/
    └── index.html     ← Your Toasted HTML file goes here
```

---

## Local testing (optional)

```bash
npm install
cp .env.example .env
# Edit .env and add your SendGrid key
node server.js
# Open http://localhost:3000
```
