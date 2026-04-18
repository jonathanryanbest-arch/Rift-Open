# The Rift Open — Sportsbook

Year V of the Rift Open. Live odds board, crowd voting, and a parlay builder for the group chat.

## What it does

- **5 boards**: To Win It All, Most Beers, House Calls (OOB), Most Slurs, Most Improved
- **Live voting**: 👍 bet on / 👎 fade each line; tallies update in real time via Server-Sent Events
- **Crowd favorite**: each board highlights the line the crowd is riding hardest
- **Line movement arrows**: ↑ or ↓ appears when a line accumulates 3+ net votes
- **Biggest Steal / Biggest Trap**: live headline strip that reshuffles as votes come in
- **Parlay builder**: tap any line to add it; American + decimal payout on $100; shareable URL
- **5-minute refresh**: countdown in the header with a drain-down bar
- **Return streak**: localStorage counter to keep people coming back daily

## Run locally

```bash
node server.js
# open http://localhost:3000
```

No npm install needed — zero dependencies, pure Node `http`.

## Deploy to Railway

1. Push this repo to GitHub
2. New Project → Deploy from GitHub repo
3. Railway auto-detects Node and runs `npm start`
4. Add a public domain under Settings → Networking
5. (Optional) Add a Volume mounted at `/app/data` so votes persist across redeploys

The server listens on `process.env.PORT`, which Railway sets automatically.

## Share link format

Parlays are encoded in the URL hash, e.g.:

```
https://your-domain/#p=win:MURPH,beers:MAX
```

Paste it in the group chat; it hydrates on load.
