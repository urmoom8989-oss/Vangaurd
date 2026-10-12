# Vangaurd matchmaking server 4.0

This is the online server for Vangaurd Release 1.0. It replaces the matchmaking service on Railway (it replaces the earlier prototype that needed 6 queued players).

What it does:

- **Map vote.** Every new match opens with a 10-second vote on 3 maps picked at random from the 6 in the game. The map with the most votes wins; ties and no-votes are settled at random. Everyone in the match gets the same choice, and players who join later are sent straight to the chosen map.
- **Kill Confirmed is free-for-all.** No teams: every player scores on their own. Grabbing anyone else's dog tag scores for you, grabbing your own denies it. First to 20 wins.
- **Team Deathmatch** is unchanged: two teams, server-side health and kills, first to 50.
- **One match per mode (Beta 1.3).** Matches start with 2 players. While the match has room (fewer than 12), new players drop into it mid-game. While it is full, they wait in line and the game shows their place; they join when a spot opens, and when the match ends the players in line start the next match.
- **Killstreaks (Beta 1.3).** UAV, Counter-UAV, care package, airstrike, sentry gun and attack helicopter call-ins are relayed to the match, and a player's killstreak can still damage others for a while after they die.
- **Lobby announcements and maintenance (Beta 1.3).** The console's **Server** tab shows a banner at the bottom of every player's lobby (an announcement, or a "Downtime begins soon" warning with the start time) and switches maintenance on and off: everyone but the owner, moderators and developers is signed out and sees "Login failed · Vangaurd is undergoing maintenance" with a Retry button.
- **Steam (Beta 1.3).** **Require Steam** in the Server tab refuses players whose game wasn't started from Steam, except the owner and the players on the "play without Steam" list there.
- **Developers (Beta 1.3).** Developers (the owner, and anyone added in the Server tab) get the in-game replay recorder and can sign in during maintenance.
- **Drone mode (developers, Beta 1.31).** The Multiplayer screen has **Drone mode** for developers: pick a mode and a map. If a match of that mode is being played on that map the developer watches it from the drone, invisible like a moderator spectating; otherwise the server opens an empty match on that map just for them (nobody is ever put into it). The map stays open while the drone flies and closes when it leaves. Developers can also use the F10 drone in their own online matches. Players who are not developers are refused (`drone_info`, `spectate_join` with `drone: true`).
- **Unreleased versions (Release 1.0).** A game newer than the newest released build (for example Release 1.0, build 29, while it is a GitHub pre-release and the newest release is build 28) is refused at sign-in, registration and matchmaking with "This version of Vangaurd is not available yet" (`code: 'unavailable'`), except for the owner. Releasing the version (marking it as the latest release, or setting the build in the console) lets everyone in.
- **DLC and operators (Release 1.0).** The Halloween Pack is a Steam DLC. Set its Steam DLC App ID in the console's Server tab (DLC) or with `STEAM_DLC_HALLOWEEN`; the game checks ownership with Steam. The owner can grant any DLC to any player there (and take it back); grants are sent to the player at once and logged. Players' chosen operator (`op`) is relayed with their state so others see it.
- **Usernames** can never contain "Parallel" or "Developer" (any spelling with digits, - or _ in between). Existing accounts keep working.
- **Only the newest game build can play online.** The game sends its build number when it queues. The newest build is the highest of the `version.json` on the latest GitHub release (read every 5 minutes), `latest.json` in this folder, the build set in the console's Server tab, and `MIN_CLIENT_BUILD`. Older builds are turned away with an "update to play online" message. Builds from before Beta 0.9 send no build number and are always turned away.
- **Ping marks** (middle mouse in the game) are relayed to the player's teammates.
- **Accounts.** The game asks players to sign in (or create an account) before the main menu. Usernames are unique (case-insensitive): a taken name can only be used by signing in to that account, and online play needs a signed-in account (the in-match name is always the account name). Passwords are stored only as salted scrypt hashes; the game keeps a sign-in token, never the password. Ten failed attempts from one address pause sign-in for ten minutes.
- **Email codes.** Creating an account needs an email address and the 6-digit code sent to it; until an email sender is set up (see [Email codes](#email-codes)) new accounts are paused and the game says so. Every sign-in (with the username or the email, plus the password) asks for a fresh code sent to the account's email. Accounts made before email existed are asked to add one the next time they sign in. **Forgot password?** in the game sends a code to the account's email and sets a new password (and signs the account out everywhere else). Codes last 10 minutes and allow 5 tries; at most 6 codes an hour go to one address.
- **Friends and parties.** Players add friends by username (requests are accepted or declined), see who is online, searching or in a match, and invite online friends to a party of up to 6. When the party leader queues, the others are brought into the same match on the same team. Friends are saved with the accounts; parties last while their members are online.
- **Cloud saves.** Each account's game data (XP and level, loadouts, camos, perks, weapon stats, singleplayer records and settings other than graphics) is uploaded by the game a few seconds after it changes and downloaded when the player signs in on another device. Saves are kept in `saves.json` next to the accounts, up to 256 KB each; every upload bumps a revision number, and an upload based on an older revision is refused with the current save so the game can pick the newer one.
- **Party ready check.** When a party leader starts a match search, every member who is not already in a match gets a ready check (20 seconds). The search starts once everyone is ready; anyone answering "Not ready" (or not answering) stops it.
- **Recently played.** The friends panel lists the players from your recent online matches (kept in memory for a few hours) with an Add friend button.
- **Bug reports and news.** The game's pause menu sends bug reports (with version, mode, map and match) that appear in the console's **Bugs** tab. News posts written in the console's **News** tab are served at `/news` and shown in the game after sign-in, next to the patch notes.
- **Spectating (moderators).** On a player's page in the console, **Spectate** (shown while they are in a match) sends an offer to the moderator's own signed-in game. Accepting joins that match as an invisible spectator: the moderator watches from the player's eyes (or a chase camera), can switch between players, and sees their kills, headshots and shots. Players never see spectators.
- **Anti-cheat console and bans.** `/admin` on this server is the moderation console (see below). Moderators review player reports and ban accounts, optionally together with the devices they played on. Bans are checked here on sign-in, resume and queueing, so they apply to every game version; from Beta 1.0 on the game shows a ban screen whose only button closes the game. Reports come from the **Report player** button on the end-of-match screen and only work for players who were in a match together in the last few hours. Moderation data lives in `moderation.json` next to the accounts.

This build of the game needs this server for online play. An older server still runs matches, but there is no map vote and Kill Confirmed stays team-based.

## Deploy on Railway

The Railway service `opus-of-duty` (project Vangaurd) deploys this folder automatically: its **Root Directory** is `/server` and it follows the `main` branch, so pushing a change here redeploys the server. `railway.json` supplies the start command (`npm start`), the `/health` check and the restart policy. Railway provides `PORT`; route the public domain to port `8080`. Accounts and cloud saves are stored on the volume `vangaurd-accounts`, mounted at `/data` (`DATA_DIR=/data`).

The game points at `https://opus-of-duty-production-f963.up.railway.app` by default.

From Beta 1.3 the main server runs in Railway's US East region (service **Settings → Region**) and `REGION` is `na-east`. To add Europe: create a second service from this folder in an EU region with its own volume, set `REGION=eu`, `MAIN_SERVER_URL=<main server address>` and `INTERNAL_KEY=<a long random secret>`, then on the main service set the same `INTERNAL_KEY` and `REGIONS=[{"id":"eu","name":"Europe","url":"<EU service address>"}]`. Games pick the closer region by ping.

## Check that it worked

Open `https://opus-of-duty-production-f963.up.railway.app/health` in a browser. You should see `"version":"3.2.0"`, `"region":"na-east"`, `"email"` (`"gmail"`, `"smtp"` or `"brevo"` once email is set up, `false` before) with `"emailReady":true` and `"emailStatus"` saying why not if it is `false`, `"accountsPersistent":true`, `"saves"` (accounts with a cloud save), `"minClientBuild"` (the newest game build), `"mapVoteSeconds":10` and the six map names. If you see an older version, the old code is still running.

## Anti-cheat console (`/admin`)

Open `https://opus-of-duty-production-f963.up.railway.app/admin/`. The first time, the server log shows a one-time line `moderation console is not set up yet: … setup code XXXX-XXXX-XXXX`; enter that code with your game account's username and password and that account becomes the owner. After that, sign in with your game account. The owner can add moderators by username (they sign in with their own game accounts), and on a player's page can set their level or copy another account's progress onto them (for fixing progress that ended up on the wrong account). The console only talks to this server, so it works with every game version.

## Email codes

New accounts confirm their email with a code, so **sign-up is paused until the server can send email** (existing accounts keep signing in, without codes until then). Set up **one** sender as Railway service variables; the service redeploys by itself, checks the sender when it starts (the log shows `email: … ready` or `email is NOT working: <reason>`), and `/health` shows `"emailReady":true` once it works.

**Gmail through a Google Apps Script** (free, works on every Railway plan, sends from your Gmail):

1. Signed in to the Gmail account that should send the codes, open <https://script.google.com>, choose **New project**, replace everything with the contents of [`gmail-script.gs`](gmail-script.gs), set `KEY` at the top to a long random value, and save.
2. **Deploy → New deployment**, type **Web app**, *Execute as:* **Me**, *Who has access:* **Anyone**, **Deploy**. Authorize it with your account (Google shows "Google hasn't verified this app" for your own scripts: **Advanced → Go to … (unsafe) → Allow**).
3. Copy the **Web app URL** (ends in `/exec`) and set:

| Variable | Value |
| --- | --- |
| `GMAIL_SCRIPT_URL` | the Web app URL |
| `GMAIL_SCRIPT_KEY` | the `KEY` from the script |

A normal Google account can send about 100 of these emails a day. If you edit the script later, deploy it with **Manage deployments → Edit → New version** so the URL stays the same.

**Gmail over SMTP** (only on Railway's Pro plan and above; Railway blocks outgoing SMTP on Free, Trial and Hobby): turn on 2-Step Verification, create an app password (Google Account → Security → 2-Step Verification → **App passwords**), then set `SMTP_HOST`=`smtp.gmail.com`, `SMTP_PORT`=`465`, `SMTP_USER`=the Gmail address, `SMTP_PASS`=the 16-letter app password.

**Brevo** (free, every plan): make an account at brevo.com, verify a sender (your Gmail works), create an API key under **SMTP & API → API keys**, then set `BREVO_API_KEY`=the key and `MAIL_FROM`=the verified sender.

Optional: `MAIL_FROM_NAME` (sender name for SMTP and Brevo, default `Vangaurd`). `EMAIL_REQUIRED=off` lets accounts be created without a code while no sender is set up. If the start-up check finds the sender broken, players can still sign in without a code (the log notes each one) so nobody is locked out, but sign-up waits for a working sender.

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
| `MIN_CLIENT_BUILD` | `1` | Lowest game build allowed (a floor under `latest.json`) |
| `LATEST_VERSION_URL` | latest release `version.json` | Where the newest build number is read from every 5 minutes (`off` to not read it) |
| `RELEASE_PAGE_URL` | latest GitHub release | Download page shown to outdated games (`steam` tells them to update through Steam instead) |
| `RELEASE_KEY` | unset | Lets a release pipeline `POST /release` `{ "build": 27, "label": "Beta 1.4" }` with the header `x-release-key` |
| `REGION` | `na-east` | The region this server is in (shown on `/health` and in the game) |
| `REGIONS` | unset | Main server only: regional match servers, e.g. `[{"id":"eu","name":"Europe","url":"https://vangaurd-eu.up.railway.app"}]`. The game plays on the closest one (by ping); accounts, friends and moderation stay on the main server |
| `MAIN_SERVER_URL` | unset | Makes this a regional match server for that main server (e.g. the Europe service). Needs `INTERNAL_KEY` |
| `INTERNAL_KEY` | unset | Shared secret between the main server and its regional servers (same value on all of them) |
| `STEAM_WEB_API_KEY` / `STEAM_APP_ID` | unset | With both set, "Require Steam" also checks each player's Steam ticket with Steam |
| `DATA_DIR` | `./data` | Where `accounts.json`, `saves.json` and `moderation.json` are kept. **Must be on a volume** or accounts and saves are lost on every deploy (Railway: volume mounted at `/data`, `DATA_DIR=/data`) |
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
