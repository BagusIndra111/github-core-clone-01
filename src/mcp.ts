// MCP JSON-RPC 2.0 Streamable HTTP for the github-core-clone-01 forge.
// Serves POST /mcp: server/discover (2026-07-28 modern era), initialize
// (legacy handshake, accepts 2025-11-25 and the other listed revisions),
// tools/list (byte-identical across calls), tools/call (six canonical
// tools over the same store REST serves). Auth before dispatch: no/invalid
// bearer token -> exactly 401. Non-JSON body -> HTTP 400 + -32700.
// Erasable TypeScript only. No Date/Math.random: no timestamps here.

import type { ServerResponse } from 'node:http';
import type { Ctx, HttpReq, Repo } from './types.ts';
import { asRecord, asString, errorJson, isAuthenticated, jsonBody } from './http-util.ts';

export async function handleMcp(ctx: Ctx, req: HttpReq, res: ServerResponse): Promise<boolean> {
  if (req.path !== '/mcp' && req.path !== '/mcp/') return false;
  if (req.method === 'DELETE') {
    // Best-effort session teardown; the client swallows any failure.
    res.writeHead(204, { 'x-github-request-id': ctx.nextRequestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    errorJson(res, 405, 'Method not allowed', ctx);
    return true;
  }
  // Auth is decided before any tool exists, and before body inspection.
  if (!isAuthenticated(req.headers, ctx)) {
    errorJson(res, 401, 'Unauthorized', ctx);
    return true;
  }
  if (req.malformedJson) {
    const id = extractId(req.body.toString('utf8'));
    rpcError(ctx, res, 400, id, -32700, 'Parse error');
    return true;
  }
  const body = asRecord(req.json);
  if (!body) {
    rpcError(ctx, res, 200, null, -32600, 'Invalid Request');
    return true;
  }
  const hasId = 'id' in body;
  const id = hasId ? (body.id as string | number | null) : undefined;
  const method = asString(body.method);
  if (!method) {
    if (!hasId) {
      res.writeHead(202, { 'x-github-request-id': ctx.nextRequestId() });
      res.end();
      return true;
    }
    rpcError(ctx, res, 200, id ?? null, -32600, 'Invalid Request');
    return true;
  }
  if (!hasId) {
    // JSON-RPC notification (e.g. notifications/initialized): no response.
    res.writeHead(202, { 'x-github-request-id': ctx.nextRequestId() });
    res.end();
    return true;
  }
  const requestId = id as string | number | null;
  switch (method) {
    case 'server/discover':
      rpcResult(ctx, res, 200, requestId, discoverResult());
      return true;
    case 'initialize':
      handleInitialize(ctx, res, requestId, body);
      return true;
    case 'tools/list':
      rpcResult(ctx, res, 200, requestId, { tools: TOOLS });
      return true;
    case 'tools/call':
      handleToolsCall(ctx, req, res, requestId, body);
      return true;
    case 'ping':
      rpcResult(ctx, res, 200, requestId, {});
      return true;
    default:
      if (method.startsWith('notifications/')) {
        rpcResult(ctx, res, 200, requestId, {});
        return true;
      }
      rpcError(ctx, res, 200, requestId, -32601, `Method not found: ${method}`);
      return true;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(ctx: Ctx, res: ServerResponse, status: number, id: string | number | null, result: unknown): void {
  jsonBody(res, status, { jsonrpc: '2.0', id, result }, ctx);
}

function rpcError(ctx: Ctx, res: ServerResponse, status: number, id: string | number | null, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  jsonBody(res, status, { jsonrpc: '2.0', id, error }, ctx);
}

/** Recover the request id from a truncated (non-JSON) body, when possible. */
function extractId(raw: string): string | number | null {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?[0-9]+)/.exec(raw);
  if (!m) return null;
  const token = m[1];
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Handshake: modern discover + legacy initialize
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
    },
  };
}

function handleInitialize(ctx: Ctx, res: ServerResponse, id: string | number | null, body: Record<string, unknown>): void {
  const params = asRecord(body.params) ?? {};
  const meta = asRecord(params._meta);
  const offered =
    asString(params.protocolVersion) ??
    (meta ? asString(meta.protocolVersion) ?? asString(meta['io.modelcontextprotocol/protocolVersion']) : undefined);
  if (offered && !SUPPORTED_VERSIONS.includes(offered)) {
    // The client retries the next legacy revision only on -32602.
    rpcError(ctx, res, 200, id, -32602, `Unsupported protocol version: ${offered}`);
    return;
  }
  const chosen = offered ?? '2026-07-28';
  rpcResult(ctx, res, 200, id, {
    protocolVersion: chosen,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

// ---------------------------------------------------------------------------
// Tools: one constant list, byte-identical on every tools/list call
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name (owner/repo)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Canonical tool for a requested name: exact match, then suffix match. */
function findTool(name: string): string | null {
  const wanted = normName(name);
  const canonicals = Object.keys(TOOL_ALIASES);
  for (const canonical of canonicals) {
    const forms = [canonical, ...TOOL_ALIASES[canonical]];
    for (const form of forms) {
      if (normName(form) === wanted) return canonical;
    }
  }
  for (const canonical of canonicals) {
    const forms = [canonical, ...TOOL_ALIASES[canonical]];
    for (const form of forms) {
      const f = normName(form);
      if (wanted.length > f.length && wanted.endsWith(f)) return canonical;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// tools/call dispatch
// ---------------------------------------------------------------------------

function handleToolsCall(ctx: Ctx, req: HttpReq, res: ServerResponse, id: string | number | null, body: Record<string, unknown>): void {
  const params = asRecord(body.params) ?? {};
  const name = asString(params.name);
  if (!name) {
    rpcError(ctx, res, 200, id, -32602, 'Invalid params: missing tool name');
    return;
  }
  const canonical = findTool(name);
  if (!canonical) {
    rpcError(ctx, res, 200, id, -32602, `Unknown tool: ${name}`);
    return;
  }
  const args = asRecord(params.arguments) ?? {};
  let outcome: ToolOutcome;
  try {
    outcome = runTool(ctx, req, canonical, args);
  } catch (err) {
    outcome = { isError: true, error: err instanceof Error ? err.message : 'Tool failed' };
  }
  if (outcome.isError) {
    rpcResult(ctx, res, 200, id, {
      content: [{ type: 'text', text: JSON.stringify({ error: outcome.error ?? 'Tool failed' }) }],
      isError: true,
    });
    return;
  }
  rpcResult(ctx, res, 200, id, {
    content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
    structuredContent: outcome.structured !== undefined ? outcome.structured : outcome.value,
  });
}

interface ToolOutcome {
  isError: boolean;
  error?: string;
  value?: unknown;
  structured?: unknown;
}

function toolError(message: string): ToolOutcome {
  return { isError: true, error: message };
}

function toolOk(value: unknown, structured?: unknown): ToolOutcome {
  return { isError: false, value, structured };
}

function baseUrl(req: HttpReq): string {
  const host = req.headers.get('host');
  return host ? `http://${host}` : 'http://localhost';
}

/** Pick an argument under its exact name, else under a normalized synonym. */
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(args, n)) return args[n];
  }
  for (const n of names) {
    const nn = normName(n);
    for (const k of Object.keys(args)) {
      if (normName(k) === nn) return args[k];
    }
  }
  return undefined;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function resolveOwnerRepo(ctx: Ctx, args: Record<string, unknown>): { owner: string; repo: string | undefined } {
  let owner = asNonEmptyString(
    pickArg(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']),
  );
  let repo = asNonEmptyString(
    pickArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']),
  );
  if (!owner || !repo) {
    const full = asNonEmptyString(pickArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']));
    if (full && full.includes('/')) {
      const [o, r] = full.split('/');
      if (!owner && o) owner = o;
      if (!repo && r) repo = r;
    }
  }
  return { owner: owner ?? ctx.viewer.login, repo };
}

function runTool(ctx: Ctx, req: HttpReq, canonical: string, args: Record<string, unknown>): ToolOutcome {
  switch (canonical) {
    case 'create_repo': {
      const name =
        asNonEmptyString(pickArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'])) ??
        asNonEmptyString(pickArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']))?.split('/').pop();
      if (!name) return toolError('Missing required argument: name');
      const description = asNonEmptyString(pickArg(args, ['description', 'about', 'summary', 'body'])) ?? '';
      const priv = pickArg(args, ['private', 'is_private']);
      const repo = ctx.store.createRepo(name, { private: priv === true, description });
      return toolOk(repoResult(ctx, req, repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(ctx, args);
      if (!repoName) return toolError('Missing required argument: repo');
      const repo = ctx.store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      return toolOk(repoResult(ctx, req, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(ctx, args);
      const title = asNonEmptyString(pickArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']));
      const body = asNonEmptyString(pickArg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment'])) ?? '';
      if (!repoName) return toolError('Missing required argument: repo');
      if (!title) return toolError('Missing required argument: title');
      const repo = ctx.store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const issue = ctx.store.createIssue(repo, title, body, []);
      return toolOk(ctx.store.issueJson(repo, issue, baseUrl(req)));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(ctx, args);
      if (!repoName) return toolError('Missing required argument: repo');
      const repo = ctx.store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const state = asNonEmptyString(pickArg(args, ['state', 'status']));
      const list = ctx.store.listIssues(repo, state ? { state } : {});
      const arr = list.map((issue) => ctx.store.issueJson(repo, issue, baseUrl(req)));
      return toolOk(arr, { issues: arr });
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(ctx, args);
      const title = asNonEmptyString(pickArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']));
      const body = asNonEmptyString(pickArg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment'])) ?? '';
      const head = asNonEmptyString(
        pickArg(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']),
      );
      const base = asNonEmptyString(
        pickArg(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']),
      );
      if (!repoName) return toolError('Missing required argument: repo');
      if (!title) return toolError('Missing required argument: title');
      if (!head) return toolError('Missing required argument: head');
      if (!base) return toolError('Missing required argument: base');
      const repo = ctx.store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const pull = ctx.store.createPull(repo, head, base, title, body);
      return toolOk(pullResult(ctx, req, repo, pull));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(ctx, args);
      const numRaw = pickArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      const pullNumber =
        typeof numRaw === 'number'
          ? numRaw
          : typeof numRaw === 'string' && /^[0-9]+$/.test(numRaw)
            ? Number(numRaw)
            : undefined;
      if (!repoName) return toolError('Missing required argument: repo');
      if (pullNumber === undefined) return toolError('Missing required argument: pull_number');
      const repo = ctx.store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const pull = ctx.store.getPull(repo, pullNumber);
      if (!pull) return toolError(`Pull request not found: #${pullNumber}`);
      const result = ctx.store.mergePull(repo, pullNumber);
      if (!result.ok) return toolError(`Merge failed: ${result.error}`);
      const merged = ctx.store.getPull(repo, pullNumber) ?? pull;
      return toolOk(pullResult(ctx, req, repo, merged));
    }
    default:
      return toolError(`Unknown tool: ${canonical}`);
  }
}

function repoResult(ctx: Ctx, req: HttpReq, repo: Repo): Record<string, unknown> {
  const obj = ctx.store.repoJson(repo, baseUrl(req)) as Record<string, unknown>;
  if (typeof obj.full_name !== 'string') obj.full_name = repo.fullName;
  return obj;
}

function pullResult(ctx: Ctx, req: HttpReq, repo: Repo, pull: { number: number }): Record<string, unknown> {
  const found = ctx.store.getPull(repo, pull.number);
  const obj = (found ? ctx.store.pullJson(repo, found, baseUrl(req)) : {}) as Record<string, unknown>;
  obj.pull_number = pull.number;
  obj.pull_request_number = pull.number;
  return obj;
}
