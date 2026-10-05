# Vangaurd matchmaking server 2.3

This is the online server for Vangaurd Beta 0.9. It replaces the matchmaking service on Railway (it replaces the earlier prototype that needed 6 queued players).

What it does:

- **Map vote.** Every new match opens with a 10-second vote on 3 maps picked at random from the 6 in the game. The map with the most votes wins; ties and no-votes are settled at random. Everyone in the match gets the same choice, and players who join later are sent straight to the chosen map.
- **Kill Confirmed is free-for-all.** No teams: every player scores on their own. Grabbing anyone else's dog tag scores for you, grabbing your own denies it. First to 20 wins.
- **Team Deathmatch** is unchanged: two teams, server-side health and kills, first to 50.
- Matches start with 2 players, and late joiners drop into a running match.
- **Only the newest game build can play online.** The game sends its build number when it queues. The server reads the newest build from `version.json` on the latest GitHub release (every 5 minutes) and turns older builds away with an "update to play online" message. Builds from before Beta 0.9 send no build number and are always turned away.
- **Ping marks** (middle mouse in the game) are relayed to the player's teammates.
- **Accounts.** The game asks players to sign in (or create an account) before the main menu. Usernames are unique (case-insensitive): a taken name can only be used by signing in to that account, and online play needs a signed-in account (the in-match name is always the account name). Passwords are stored only as salted scrypt hashes; the game keeps a sign-in token, never the password. Ten failed attempts from one address pause sign-in for ten minutes.

This build of the game needs this server for online play. An older server still runs matches, but there is no map vote and Kill Confirmed stays team-based.

## Deploy on Railway

The Railway service `opus-of-duty` (project Vangaurd) deploys this folder automatically: its **Root Directory** is `/server` and it follows the `main` branch, so pushing a change here redeploys the server. `railway.json` supplies the start command (`npm start`), the `/health` check and the restart policy. Railway provides `PORT`; route the public domain to port `8080`. Accounts are stored on the volume `vangaurd-accounts`, mounted at `/data` (`DATA_DIR=/data`).

The game points at `https://opus-of-duty-production-f963.up.railway.app` by default.

## Check that it worked

Open `https://opus-of-duty-production-f963.up.railway.app/health` in a browser. You should see `"version":"2.3.0"`, `"accountsPersistent":true`, `"minClientBuild"` (the newest game build), `"mapVoteSeconds":10` and the six map names. If you see an older version, the old code is still running.

## Optional settings

Set these as Railway service variables if you want to change the defaults.

| Variable | Default | What it does |
| --- | --- | --- |
| `MATCH_MIN_SIZE` | `2` | Players needed before a new match starts |
| `MATCH_MAX_SIZE` | `12` | Most players in one match |
| `MATCH_COUNTDOWN` | `5` | Seconds of countdown once enough players are queued |
| `MAP_VOTE_SECONDS` | `10` | Length of the map vote (`0` skips the vote and picks a random map) |
| `KC_SCORE_LIMIT` | `20` | Confirmed kills needed to win Kill Confirmed |
| `TDM_SCORE_LIMIT` | `50` | Kills needed to win Team Deathmatch |
| `VERSION_GATE` | `on` | `off` lets every game build play online |
| `MIN_CLIENT_BUILD` | `1` | Lowest game build allowed. Used when GitHub cannot be reached, and as a floor otherwise |
| `LATEST_VERSION_URL` | latest release `version.json` | Where the newest build number is read from (`off` to only use `MIN_CLIENT_BUILD`) |
| `DATA_DIR` | `./data` | Where `accounts.json` is kept. **Must be on a volume** or accounts are lost on every deploy (Railway: volume mounted at `/data`, `DATA_DIR=/data`) |
| `SESSION_DAYS` | `60` | Days a "Stay signed in" token lasts without being used |
| `ALLOWED_ORIGINS` | unset | Optional comma-separated WebSocket Origin allowlist. Leave unset for the standalone and desktop builds |

## Using a different address

If you deploy this as a new service with a new address, open the game, choose **Multiplayer**, then **Set up online connection**, paste the new address and choose **Save server**. The game remembers it on that device.

## Run it on your own computer

```
npm install
npm start
```

It listens on port 8080 unless `PORT` is set. `node test-protocol.mjs` checks a running server (start it with `PORT=8099 MATCH_COUNTDOWN=2 MAP_VOTE_SECONDS=2 KC_SCORE_LIMIT=3 VERSION_GATE=off` first).
