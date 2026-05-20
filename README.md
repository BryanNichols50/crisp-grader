# CRISP Daily Coaching System
### Hendrick Honda Charlotte

AI-powered BDC call grader using the CRISP framework. Drop in a CarWars CSV, get a full leaderboard, per-agent coaching sheets, follow-up flags, and S2S leads.

---

## Live App

After setup: `https://YOUR-USERNAME.github.io/crisp-grader/`

---

## One-time setup (5 minutes)

### 1. Fork or clone this repo
```
git clone https://github.com/YOUR-USERNAME/crisp-grader.git
cd crisp-grader
```

### 2. Enable GitHub Pages
- Go to your repo on GitHub
- **Settings → Pages**
- Under **Source**, select **GitHub Actions**
- Save

### 3. Push to main — it deploys automatically
```
git add .
git commit -m "initial deploy"
git push origin main
```

GitHub Actions builds and deploys in ~2 minutes. You'll see a green checkmark under the **Actions** tab when it's live.

### 4. Add your Anthropic API key
- Go to **Settings → Secrets and variables → Actions**
- Click **New repository secret**
- Name: `ANTHROPIC_API_KEY`
- Value: your key from console.anthropic.com

> **No API key?** The app works without one when opened through Claude.ai — it uses your existing session. The API key is only needed if you want to run it standalone outside of Claude.

---

## Daily workflow

1. Download CarWars CSV (blue arrow → Staff Activity)
2. Open `https://YOUR-USERNAME.github.io/crisp-grader/`
3. Drop the CSV into the upload zone
4. Hit **Grade calls**
5. Come back in 3–4 minutes to finished reports

---

## What it produces

| Tab | Contents |
|-----|----------|
| GM Summary | Team leaderboard, CRISP benchmarks vs CarWars top 20%, urgent follow-ups |
| Follow-Up | TODAY / THIS WEEK / MONITOR flags with reasons |
| S2S Leads | RED alerts and ORANGE leads with BDC openers (service calls) |
| No Answer | Voicemails and no-answers for activity tracking |
| Agent tabs | Per-agent drill-down with every call graded |

---

## CRISP Framework

| Step | Points | What it measures |
|------|--------|-----------------|
| C — Connect | 0–20 | Professional greeting, contact gathered |
| R+I — Request/Invite | 0–30 | Appointment requested + test drive invited |
| S — Set | 0–25 | Specific date/time, Whittle & Shepherd, verbal contract |
| OH — Objection Handling | 0–15 | Transition/Disrupt/Ask, Feel/Felt/Found, Onion |
| P — Pursue | 0–10 | Confirmed next step, outbound Statement of Purpose |

**Grades:** A=90+ · B=75–89 · C=60–74 · D=45–59 · F<45

**CarWars benchmarks (top 20% dealers):**
- Connect: 80% · Request/Invite: 75% · Set: 45% · Pursue: 100%
