// github-core-clone-01: a GitHub-compatible git forge (single process, Node 22, stdlib only).
//
// Lifecycle (per the kit's wire contract):
//   1. bind an ephemeral port (listen(0); never 8080, where the suite listens),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. serve until GET $MAKEFUN_ENV_URL/done answers {"done": true}, then exit 0.
//
// Surfaces served on that port:
//   GET  /healthz                     (no auth; the suite's boot check)
//   /{owner}/{repo}.git/...           git smart HTTP (upload-pack v2 + v0, receive-pack v0)
//   /api/v3/...                       GitHub REST v3
//   POST /api/graphql                 GitHub GraphQL v4
//   POST /mcp                         Model Context Protocol (Streamable HTTP)
//
// Determinism: no wall clock and no unseeded randomness anywhere in a request
// path. Server timestamps come from MAKEFUN_TRIAL_NOW; ids are sequential;
// the X-GitHub-Request-Id header is a monotonic counter. (Commit objects carry
// the client's own author/committer bytes from pushes, stored verbatim.)

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scenarioUsers } from './src/scenario.ts';
import { createStore } from './src/store.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { errorJson, jsonBody } from './src/http-util.ts';
import type { Ctx, HttpReq } from './src/types.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function register(envUrl: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 201) return true;
      if (res.status === 409) return true; // first register wins; a later one is 409
    } catch {
      // the env may not be reachable yet; retry below
    }
    await sleep(250 * (attempt + 1));
  }
  return false;
}

async function waitDone(envUrl: string): Promise<void> {
  let interval = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { method: 'GET' });
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // the env may flap; keep polling
    }
    await sleep(interval);
    if (interval < 2000) interval = Math.min(2000, interval * 2);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // A GET/HEAD with no transfer-encoding and no (or zero) content-length
  // carries no body per HTTP semantics; skip the stream entirely. The async
  // iterator alone cost ~0.05 ms per bodyless request, ~28% of a GET-issue
  // round trip. Anything that might carry a body falls through to the read.
  const method = (req.method ?? 'GET').toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && req.headers['transfer-encoding'] === undefined) {
    const length = req.headers['content-length'];
    if (length === undefined || length === '0') return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function headerMap(req: IncomingMessage): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') map.set(key.toLowerCase(), value);
    else if (Array.isArray(value) && value.length > 0) map.set(key.toLowerCase(), value[0]);
  }
  return map;
}

async function main(): Promise<void> {
  const token = env('MAKEFUN_SHOP_TOKEN') ?? '';
  const envUrl = env('MAKEFUN_ENV_URL');
  const nowIso = env('MAKEFUN_TRIAL_NOW') ?? '2025-01-01T00:00:00Z';
  const nowEpoch = Math.floor(Date.parse(nowIso) / 1000);
  const users = scenarioUsers();
  const viewer = { id: users.viewer.id, login: users.viewer.login, name: users.viewer.name, email: users.viewer.email };
  const stranger = { id: users.stranger.id, login: users.stranger.login, name: users.stranger.name, email: users.stranger.email };

  let requestCounter = 0;
  const store = createStore(viewer, stranger, nowIso, nowEpoch);
  const ctx: Ctx = {
    store,
    viewer,
    stranger,
    token,
    nowIso,
    nowEpoch,
    nextRequestId: () => {
      requestCounter += 1;
      return `req-${requestCounter.toString(16).padStart(8, '0')}`;
    },
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      const headers = headerMap(req);
      const body = await readBody(req);

      // Parse JSON only for the JSON surfaces; git bodies are binary.
      let json: unknown = undefined;
      let malformedJson = false;
      const isJsonRoute = path.startsWith('/api/') || path === '/mcp';
      if (isJsonRoute && body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          malformedJson = true;
        }
      }

      const httpReq: HttpReq = { method, path, query: url.searchParams, headers, body, json, malformedJson };

      if (method === 'GET' && path === '/healthz') {
        jsonBody(res, 200, { ok: true }, ctx);
        return;
      }

      let handled = false;
      if (path === '/api/graphql') {
        handled = await handleGraphql(ctx, httpReq, res);
      } else if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        handled = await handleRest(ctx, httpReq, res);
      } else if (path === '/mcp') {
        handled = await handleMcp(ctx, httpReq, res);
      } else if (path.includes('.git/') || path.endsWith('.git')) {
        handled = await handleGit(ctx, httpReq, res);
      }

      if (!handled) {
        errorJson(res, 404, 'Not Found', ctx);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        errorJson(res, 500, message, ctx);
      } catch {
        try {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message }));
        } catch {
          // the socket is gone; nothing more to do
        }
      }
    }
  });

  server.on('clientError', (_err: Error, socket: { end: (data: string) => void }) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      // ignore
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`forge listening on ${port}\n`);

  if (envUrl !== undefined) {
    const ok = await register(envUrl, port);
    if (!ok) {
      process.stderr.write('register failed after retries; serving anyway\n');
    }
    await waitDone(envUrl);
    server.close();
    process.exit(0);
  }

  // No env (local run): serve until killed.
  process.stdout.write('no MAKEFUN_ENV_URL; serving without register/done\n');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
