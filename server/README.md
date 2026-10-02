# Railway matchmaking service

This service supplies an ephemeral Team Deathmatch queue, room reservation, and the prototype's real-time room relay. Deployed clients exchange player poses, fire cues, hit reports, health/death/respawn updates, and team scores. The server enforces room membership, opposing teams, basic fire-rate limits, bounded damage, and respawn delay. Important: hit detection still runs on clients, and the server trusts reported hits, so this is a playable prototype—not cheat-resistant or production-authoritative netcode.

## Deploy on Railway

1. Push this repository to GitHub and create a Railway project using **Deploy from GitHub repo**.
2. Open the service's **Settings** and set **Root Directory** to `/server`.
3. In the service's build/deploy settings, set **Build Command** to `npm ci` and **Start Command** to `npm start`. Set **Healthcheck Path** to `/health`.
4. Deploy the service. In **Settings → Networking**, generate a public domain. It should be an HTTPS URL such as `https://your-service.up.railway.app`.
5. Open the game's Multiplayer entry, paste that public URL into **Railway server URL**, choose **Save server**, then **Quick Join**.

Railway's current Infrastructure as Code workflow is CLI-managed; for this isolated service, the Dashboard settings above are the shortest setup. Do not add a Railway bucket for matchmaking.

Environment variables:

- `MATCH_SIZE` — players needed before reserving a room; defaults to 10 (5v5), may be set from 2 through 10 for testing.
- `ALLOWED_ORIGINS` — optional comma-separated WebSocket Origin allowlist. Leave unset for the desktop/standalone prototype; configure the exact hosted web origins before public production use.
- `PORT` — provided by Railway automatically.

The queue and rooms are in memory. Keep one Railway replica for this prototype; restarts clear active queues. No storage bucket or database is needed for live matchmaking. Add Redis for shared queues across replicas and a database only when persistent accounts, match results, or stats are required.
