# Railway Discord Fetch Bot

Enterprise-grade Discord bot engineered for zero-downtime deployment on Railway.com.
Two slash commands (`/offsets`, `/fflags`) share a single, configuration-driven
pipeline with mutex-protected caching, exponential backoff, content validation,
sliding-window rate limiting, and structured JSON telemetry.

---

## Architecture

```
src/
├── commands/
│   ├── offsets.js              # Thin config object (URL, filename, color, regex)
│   └── fflags.js               # Thin config object
├── events/
│   ├── interactionCreate.js    # Routes slash commands → dynamicFetchExecutor
│   └── ready.js                # Client-ready telemetry + presence
├── utils/
│   ├── dynamicFetchExecutor.js # The single source of truth for fetch/cache/validate/dispatch
│   ├── cacheManager.js         # TTL cache + mutex (single-flight) + metrics
│   ├── fetchWithRetry.js       # AbortController timeout + exponential backoff
│   ├── rateLimiter.js          # Sliding-window per-user-per-command limiter
│   └── logger.js               # Structured JSON logger → stdout/stderr
└── index.js                    # Client construction, command registration, SIGTERM handling
```

### Why a "command factory" pattern?

Both `/offsets` and `/fflags` do the same thing under the hood: fetch a remote
file, cache it, validate it, and attach it to a Discord reply. The architecture
spec mandates **zero code duplication**, so the entire pipeline lives in
`dynamicFetchExecutor.js`. The command files are pure data — adding a third
command (e.g. `/headers`) is a 20-line config file plus a one-line import.

## Pipeline (per interaction)

1. **Rate-limit check** — sliding window, 1 call / user / 15s, returns ephemeral reply on violation.
2. **`deferReply()`** — beats Discord's 3-second ACK window before any network I/O.
3. **Cache lookup** — 5-minute TTL keyed by URL; hits short-circuit the rest.
4. **Mutex-protected fetch** — single-flight: 50 concurrent callers → 1 network request.
5. **Content validation** — strict regex (C++ header markers / C# markers); rejects HTML/JSON compromise.
6. **Dispatch** — edit the deferred reply with a dynamic embed + file attachment.

## Resilience features

| Feature | Implementation |
|---|---|
| Thundering-herd protection | In-memory mutex keyed by URL in `CacheManager.acquireOrJoin` |
| TTL caching | `Map` with 5-minute expiry, periodic sweep, Buffer (not string) storage |
| Network retry | Exponential backoff: 1s → 2s → 4s, max 3 retries |
| Timeout enforcement | `AbortController` with 5s deadline per attempt |
| DNS / abort retry | `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `AbortError` all retryable |
| Content validation | Per-command `validationRegex`, rejects compromised responses |
| Rate limiting | Sliding window, per-user per-command, 15s window, 1 call |
| Interaction lifecycle | `deferReply()` upfront, `editReply()` on completion |
| Structured logging | JSON to stdout/stderr, Railway-native ingestion |
| Graceful shutdown | `SIGTERM` → `client.destroy()` raced against 10s deadline |

## Local development

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN and DISCORD_CLIENT_ID from https://discord.com/developers/applications

npm install
npm start
```

## Railway deployment

1. Push this repo to a GitHub repository.
2. In Railway, **New Project → Deploy from GitHub repo**.
3. Add variables: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (and optionally the `LOG_LEVEL` etc. from `.env.example`).
4. Railway detects `railway.json` and builds via the multi-stage Dockerfile.
5. The bot logs in, registers global slash commands, and listens for interactions.

### Why the multi-stage Dockerfile?

- **Stage 1 (builder)**: full `node:18` so any transitive native module can compile.
- **Stage 2 (runner)**: `node:18-alpine`, ~120 MB image, no build toolchain, runs as non-root `node` user, only `node_modules` + `package.json` + `src/` copied in.

### SIGTERM handling

Railway sends `SIGTERM` ~30 seconds before `SIGKILL` during a redeploy. The
process listens for `SIGTERM`, calls `client.destroy()` to cleanly close the
Discord gateway WebSocket, and exits. This prevents zombie WebSocket
connections on Discord's side that would otherwise survive until TCP keepalive
fails (minutes later) and could cause Discord to deliver events to a dead
process during the overlap window.

## Observability

Every log line is a single JSON object written to stdout (info/warn/debug) or
stderr (error). Example:

```json
{"timestamp":"2026-07-07T23:26:00.000Z","level":"info","message":"CACHE_HIT","event":"CACHE_HIT","commandName":"offsets","userId":"123456789","latencyMs":12}
```

Railway captures these natively; pipe them into Logflare, Datadog, or Loki
without any adapter. Searchable fields include `event`, `commandName`,
`userId`, and `latencyMs`.

## License

MIT
