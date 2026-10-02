# Railway matchmaking service

This service supplies an ephemeral Team Deathmatch queue, room reservation, and the prototype's real-time room relay. Deployed clients exchange player poses, fire cues, hit reports, health/death/respawn updates, and team scores. The server enforces room membership, opposing teams, basic fire-rate limits, bounded damage, and respawn delay. Important: hit detection still runs on clients, and the server trusts reported hits, so this is a playable prototype—not cheat-resistant or production-authoritative netcode.

## Deploy on Railway

1. Push this repository to GitHub and create a Railway project using **Deploy from GitHub repo**.
2. Open the service's **Settings** and set **Root Directory** to `/server`. The included `server/railway.json` provides the start command, health check, and restart policy.
3. Deploy the service. In **Settings → Networking**, generate a public domain. It should be an HTTPS URL such as `https://your-service.up.railway.app`.
4. Copy `.env.production.example` to `.env.production.local` in the repository root and replace the example domain with the public domain from Railway. The ignored local file is read by Vite during web, standalone, macOS, and Windows production builds.
5. Rebuild and publish the game packages. They will connect to the same hosted queue automatically. If no build URL is configured, players can still use **Set up online connection** in the Multiplayer menu.
6. Open the game's Multiplayer entry and join the queue. Once six players are queued, matchmaking waits 30 seconds to let more players join (up to 12), then starts the match automatically.

The macOS/Windows packages contain the game client, not a public matchmaking host. The matchmaking service must remain deployed on a reachable server (such as Railway) so different players can meet in the same queue; running a server process only on each player's computer would create separate queues.

Railway's current Infrastructure as Code workflow is CLI-managed; for this isolated service, the Dashboard settings above are the shortest setup. Do not add a Railway bucket for matchmaking.

Environment variables:

- `MATCH_MIN_SIZE` — minimum players needed before the 30-second fill window begins; defaults to 6 and cannot be lower than 6.
- `MATCH_MAX_SIZE` — maximum players in a room before the match starts; defaults to 12.
- `ALLOWED_ORIGINS` — optional comma-separated WebSocket Origin allowlist. Leave unset for the desktop/standalone prototype; configure the exact hosted web origins before public production use.
- `PORT` — provided by Railway automatically; defaults to `8080` for local runs. In Railway Networking, route the public domain to internal port `8080`.

The queue and rooms are in memory. Keep one Railway replica for this prototype; restarts clear active queues. No storage bucket or database is needed for live matchmaking. Add Redis for shared queues across replicas and a database only when persistent accounts, match results, or stats are required.
