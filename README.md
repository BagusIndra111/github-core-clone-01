# Forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/BagusIndra111/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/BagusIndra111/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, standard
library only. It serves git smart HTTP (upload-pack protocol v2 + v0,
receive-pack v0) for clone, fetch and push; the REST v3 API for repositories,
issues, pull requests and contents; the GraphQL v4 API; and a Model Context
Protocol endpoint — all from one in-memory store, with no git binary and no
outside service.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the trial environment
(`$MAKEFUN_ENV_URL/register`), serves until the environment reports done, and
exits 0. With no `MAKEFUN_ENV_URL` set it just serves on its port until killed.

Environment variables:

- `MAKEFUN_ENV_URL` — the trial environment origin (register + done polling).
- `MAKEFUN_SHOP_TOKEN` — the bearer token every API call must carry
  (`/healthz` takes none).
- `MAKEFUN_TRIAL_NOW` — the trial's fixed "now" (ISO 8601); all server
  timestamps come from it so replays are byte-identical.

## Surfaces

- `GET /healthz` — `{"ok": true}`.
- `/{owner}/{repo}.git/...` — git smart HTTP: `info/refs`, `git-upload-pack`
  (protocol v2 + v0), `git-receive-pack` (v0, report-status, fast-forward only).
- `/api/v3/...` — REST v3: repositories, branches, commits, contents, labels,
  issues, comments, pull requests, merges (squash).
- `POST /api/graphql` — GraphQL v4 (viewer, repository, issues, pull requests,
  mutations, introspection, batched operations).
- `POST /mcp` — MCP over Streamable HTTP (initialize, tools/list, tools/call).

## Layout

- `main.ts` — entrypoint: lifecycle, HTTP server, routing.
- `src/scenario.ts` — the scenario's identity derivation (viewer login).
- `src/store.ts` — the in-memory store: repos, git objects/refs, issues, PRs.
- `src/git-core.ts` — git objects, packfiles, pkt-lines.
- `src/git-http.ts` — smart HTTP handlers.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL v4 executor.
- `src/mcp.ts` — MCP handler.
- `src/http-util.ts` — JSON replies, auth, pagination.
- `src/types.ts` — shared types.

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=pqve0qe3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
