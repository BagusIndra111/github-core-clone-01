// GraphQL v4 executor for the github-core-clone-01 forge.
// Serves POST /api/graphql: the 18 suite documents, introspection
// (__type), cursor pagination, global ids, and the five mutations.
// Hand-written recursive-descent parser + resolver over ctx.store.
// Erasable TypeScript only. No Date/Math.random: no timestamps here.

import type { ServerResponse } from 'node:http';
import type { Ctx, Comment, HttpReq, Issue, Pull, Repo, Viewer } from './types.ts';
import { asRecord, asString, errorJson, isAuthenticated, jsonBody } from './http-util.ts';

export async function handleGraphql(ctx: Ctx, req: HttpReq, res: ServerResponse): Promise<boolean> {
  if (req.path !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    errorJson(res, 405, 'Method not allowed', ctx);
    return true;
  }
  // Auth is decided before any body inspection.
  if (!isAuthenticated(req.headers, ctx)) {
    errorJson(res, 401, 'Unauthorized', ctx);
    return true;
  }
  if (req.malformedJson) {
    errorJson(res, 400, 'Malformed JSON body', ctx);
    return true;
  }
  const body = req.json;
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const entry of body) out.push(executeOperation(ctx, entry));
    jsonBody(res, 200, out, ctx);
    return true;
  }
  jsonBody(res, 200, executeOperation(ctx, body), ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  kind: string;
  value: string;
}

const PUNCTS = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '@', '|', '&']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCTS.has(ch)) {
      tokens.push({ kind: ch, value: ch });
      i++;
      continue;
    }
    if (ch === '$') {
      const m = /^[_A-Za-z][_A-Za-z0-9]*/.exec(src.slice(i + 1));
      if (!m) throw new Error('Bad variable name after $');
      tokens.push({ kind: '$', value: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
          continue;
        }
        out += src[j];
        j++;
      }
      if (j >= src.length) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error('Bad number');
      const raw = m[0];
      tokens.push({ kind: raw.includes('.') || /[eE]/.test(raw) ? 'float' : 'int', value: raw });
      i += raw.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const m = /^[_A-Za-z][_A-Za-z0-9]*/.exec(src.slice(i));
      if (!m) throw new Error('Bad name');
      tokens.push({ kind: 'name', value: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in query`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

interface GqlValue {
  kind: string;
  value: unknown;
}

interface Arg {
  name: string;
  value: GqlValue;
}

interface SelField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Arg[];
  selections: Selection[] | null;
}

interface SelFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = SelField | SelFragment;

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Parser {
  tokens: Token[];
  pos: number;
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

function peek(p: Parser): Token {
  return p.tokens[p.pos] ?? { kind: 'eof', value: '' };
}

function nextTok(p: Parser): Token {
  const t = peek(p);
  p.pos++;
  return t;
}

function expectPunct(p: Parser, kind: string): void {
  const t = nextTok(p);
  if (t.kind !== kind) throw new Error(`Expected "${kind}" but got "${t.value}"`);
}

function expectName(p: Parser): string {
  const t = nextTok(p);
  if (t.kind !== 'name') throw new Error(`Expected a name but got "${t.value}"`);
  return t.value;
}

function expectKeyword(p: Parser, kw: string): void {
  const t = nextTok(p);
  if (t.kind !== 'name' || t.value !== kw) throw new Error(`Expected "${kw}" but got "${t.value}"`);
}

function skipBalanced(p: Parser): void {
  let depth = 0;
  while (p.pos < p.tokens.length) {
    const t = nextTok(p);
    if (t.kind === '(') depth++;
    else if (t.kind === ')') {
      depth--;
      if (depth === 0) return;
    }
  }
  throw new Error('Unbalanced parentheses');
}

function parseValue(p: Parser): GqlValue {
  const t = nextTok(p);
  if (t.kind === 'string') return { kind: 'string', value: t.value };
  if (t.kind === 'int' || t.kind === 'float') return { kind: 'number', value: Number(t.value) };
  if (t.kind === '$') return { kind: 'variable', value: t.value };
  if (t.kind === '[') {
    const items: GqlValue[] = [];
    while (peek(p).kind !== ']') items.push(parseValue(p));
    nextTok(p);
    return { kind: 'list', value: items };
  }
  if (t.kind === '{') {
    const entries: Arg[] = [];
    while (peek(p).kind !== '}') {
      const k = expectName(p);
      expectPunct(p, ':');
      entries.push({ name: k, value: parseValue(p) });
    }
    nextTok(p);
    return { kind: 'object', value: entries };
  }
  if (t.kind === 'name') {
    if (t.value === 'true') return { kind: 'boolean', value: true };
    if (t.value === 'false') return { kind: 'boolean', value: false };
    if (t.value === 'null') return { kind: 'null', value: null };
    return { kind: 'enum', value: t.value };
  }
  throw new Error(`Unexpected value token "${t.value}"`);
}

function parseSelectionSet(p: Parser): Selection[] {
  expectPunct(p, '{');
  const sels: Selection[] = [];
  while (true) {
    const t = peek(p);
    if (t.kind === '}') {
      nextTok(p);
      break;
    }
    if (t.kind === 'eof') throw new Error('Unterminated selection set');
    if (t.kind === '...') {
      nextTok(p);
      const n = peek(p);
      if (n.kind === 'name' && n.value === 'on') {
        nextTok(p);
        const typeCond = expectName(p);
        sels.push({ kind: 'fragment', typeCondition: typeCond, selections: parseSelectionSet(p) });
      } else if (n.kind === 'name') {
        const fragName = nextTok(p).value;
        const frag = p.fragments.get(fragName);
        if (!frag) throw new Error(`Unknown fragment "${fragName}"`);
        sels.push({ kind: 'fragment', typeCondition: frag.typeCondition, selections: frag.selections });
      } else {
        sels.push({ kind: 'fragment', typeCondition: null, selections: parseSelectionSet(p) });
      }
      continue;
    }
    let name = expectName(p);
    let alias: string | null = null;
    if (peek(p).kind === ':') {
      nextTok(p);
      alias = name;
      name = expectName(p);
    }
    const args: Arg[] = [];
    if (peek(p).kind === '(') {
      nextTok(p);
      while (peek(p).kind !== ')') {
        if (peek(p).kind === 'eof') throw new Error('Unterminated argument list');
        const argName = expectName(p);
        expectPunct(p, ':');
        args.push({ name: argName, value: parseValue(p) });
      }
      nextTok(p);
    }
    while (peek(p).kind === '@') {
      nextTok(p);
      expectName(p);
      if (peek(p).kind === '(') skipBalanced(p);
    }
    let sub: Selection[] | null = null;
    if (peek(p).kind === '{') sub = parseSelectionSet(p);
    sels.push({ kind: 'field', alias, name, args, selections: sub });
  }
  return sels;
}

function parseDocument(src: string): Operation[] {
  const p: Parser = { tokens: tokenize(src), pos: 0, fragments: new Map() };
  const ops: Operation[] = [];
  while (p.pos < p.tokens.length) {
    const t = peek(p);
    if (t.kind === '{') {
      ops.push({ opType: 'query', name: null, selections: parseSelectionSet(p) });
      continue;
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const opType = t.value as 'query' | 'mutation';
      nextTok(p);
      let name: string | null = null;
      if (peek(p).kind === 'name') name = nextTok(p).value;
      if (peek(p).kind === '(') skipBalanced(p);
      while (peek(p).kind === '@') {
        nextTok(p);
        expectName(p);
        if (peek(p).kind === '(') skipBalanced(p);
      }
      ops.push({ opType, name, selections: parseSelectionSet(p) });
      continue;
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      nextTok(p);
      const fragName = expectName(p);
      expectKeyword(p, 'on');
      const typeCond = expectName(p);
      p.fragments.set(fragName, { typeCondition: typeCond, selections: parseSelectionSet(p) });
      continue;
    }
    throw new Error(`Unexpected token "${t.value}" in document`);
  }
  if (ops.length === 0) throw new Error('Empty document');
  return ops;
}

// ---------------------------------------------------------------------------
// Values / arguments
// ---------------------------------------------------------------------------

function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': {
      const val = variables[v.value as string];
      return val === undefined ? null : val;
    }
    case 'list':
      return (v.value as GqlValue[]).map((e) => resolveValue(e, variables));
    case 'object': {
      const rec: Record<string, unknown> = {};
      for (const e of v.value as Arg[]) rec[e.name] = resolveValue(e.value, variables);
      return rec;
    }
    default:
      return v.value;
  }
}

function argValue(field: SelField, name: string, variables: Record<string, unknown>): unknown {
  const a = field.args.find((x) => x.name === name);
  return a ? resolveValue(a.value, variables) : undefined;
}

function argString(field: SelField, name: string, variables: Record<string, unknown>): string | undefined {
  const v = argValue(field, name, variables);
  return typeof v === 'string' ? v : undefined;
}

function argNumber(field: SelField, name: string, variables: Record<string, unknown>): number | undefined {
  const v = argValue(field, name, variables);
  return typeof v === 'number' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Schema surface (validation) + introspection data
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Node: ['id'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName',
    'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt'],
  BranchRef: ['name', 'prefix'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'isDeprecated', 'deprecationReason', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const CHILD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'BranchRef',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'Comment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged',
    'files', 'title', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author',
    'headRef', 'baseRef', 'additions', 'deletions', 'changedFiles', 'comments',
    'reviews', 'isDraft', 'mergedAt', 'mergeCommit',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate', 'private', 'createdAt',
    'updatedAt', 'url', 'defaultBranch', 'labels', 'forks', 'watchers',
  ],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function validateSelections(sels: Selection[], parentType: string): void {
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      validateSelections(sel.selections, sel.typeCondition ?? parentType);
      continue;
    }
    if (sel.name === '__typename') continue;
    const allowed = TYPE_FIELDS[parentType];
    if (!allowed || !allowed.includes(sel.name)) {
      throw new Error(`Cannot query field "${sel.name}" on type "${parentType}".`);
    }
    if (sel.selections) {
      const child = CHILD_TYPE[parentType]?.[sel.name];
      if (child) validateSelections(sel.selections, child);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function executeOperation(ctx: Ctx, body: unknown): Record<string, unknown> {
  const rec = asRecord(body);
  if (!rec) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string' }] };
  }
  const query = asString(rec.query);
  if (!query) {
    return { data: null, errors: [{ message: 'Missing query string' }] };
  }
  const variables = asRecord(rec.variables) ?? {};
  const operationName = asString(rec.operationName);
  try {
    const ops = parseDocument(query);
    let op = ops[0];
    if (ops.length > 1 && operationName) {
      const found = ops.find((o) => o.name === operationName);
      if (found) op = found;
    }
    validateSelections(op.selections, op.opType === 'query' ? 'Query' : 'Mutation');
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) {
      if (sel.kind === 'fragment') continue;
      data[sel.alias ?? sel.name] = executeRootField(ctx, sel, variables);
    }
    return { data };
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : 'Failed to execute query' }],
    };
  }
}

function executeRootField(ctx: Ctx, field: SelField, variables: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'viewer':
      return buildUser(ctx.viewer, field.selections);
    case 'repository': {
      const owner = argString(field, 'owner', variables) ?? '';
      const name = argString(field, 'name', variables) ?? '';
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) return null;
      return buildRepo(ctx, repo, field.selections, variables);
    }
    case 'node': {
      const id = argString(field, 'id', variables);
      const found = id ? ctx.store.findByGlobalId(id) : undefined;
      if (!found) return null;
      if (found.kind === 'repo') return buildRepo(ctx, found.repo, field.selections, variables);
      if (found.kind === 'issue' && found.issue) return buildIssue(ctx, found.issue, field.selections);
      if (found.kind === 'pull' && found.pull) return buildPull(ctx, found.repo, found.pull, field.selections, variables);
      return null;
    }
    case '__type': {
      const name = argString(field, 'name', variables) ?? '';
      return buildTypeInfo(name, field.selections);
    }
    case 'createIssue':
    case 'closeIssue':
    case 'createPullRequest':
    case 'mergePullRequest':
    case 'addComment':
      return executeMutation(ctx, field, variables);
    default:
      throw new Error(`Cannot query field "${field.name}" on type "Query".`);
  }
}

/** Walk selections, expanding inline fragments that apply to typeName. */
function eachField(sels: Selection[] | null, typeName: string, fn: (f: SelField) => void): void {
  if (!sels) return;
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        eachField(sel.selections, typeName, fn);
      }
      continue;
    }
    fn(sel);
  }
}

function findSubField(sels: Selection[] | null, name: string): SelField | null {
  if (!sels) return null;
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      const f = findSubField(sel.selections, name);
      if (f) return f;
      continue;
    }
    if (sel.name === name) return sel;
  }
  return null;
}

function defaultFields(names: string[]): Selection[] {
  return names.map((name) => ({ kind: 'field', alias: null, name, args: [], selections: null }) as SelField);
}

function buildUser(user: Viewer, sels: Selection[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = sels && sels.length > 0 ? sels : defaultFields(['login']);
  eachField(list, 'User', (f) => {
    if (f.name === 'login') out[f.alias ?? 'login'] = user.login;
    else if (f.name === 'id') out[f.alias ?? 'id'] = String(user.id);
    else if (f.name === 'name') out[f.alias ?? 'name'] = user.name;
    else if (f.name === 'email') out[f.alias ?? 'email'] = user.email;
    else if (f.name === '__typename') out[f.alias ?? '__typename'] = 'User';
  });
  return out;
}

function buildIssue(ctx: Ctx, issue: Issue, sels: Selection[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = sels && sels.length > 0 ? sels : defaultFields(['id', 'number', 'title', 'state', 'body']);
  eachField(list, 'Issue', (f) => {
    switch (f.name) {
      case 'id':
        out[f.alias ?? 'id'] = issue.id;
        break;
      case 'number':
        out[f.alias ?? 'number'] = issue.number;
        break;
      case 'title':
        out[f.alias ?? 'title'] = issue.title;
        break;
      case 'state':
        out[f.alias ?? 'state'] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'body':
        out[f.alias ?? 'body'] = issue.body;
        break;
      case 'createdAt':
        out[f.alias ?? 'createdAt'] = issue.createdAt;
        break;
      case 'updatedAt':
        out[f.alias ?? 'updatedAt'] = issue.updatedAt;
        break;
      case 'closedAt':
        out[f.alias ?? 'closedAt'] = issue.closedAt;
        break;
      case 'labels':
        out[f.alias ?? 'labels'] = [...issue.labels];
        break;
      case '__typename':
        out[f.alias ?? '__typename'] = 'Issue';
        break;
      default:
        break;
    }
  });
  return out;
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(s: string): number | null {
  try {
    const text = Buffer.from(s, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function buildIssueConnection(ctx: Ctx, repo: Repo, field: SelField, variables: Record<string, unknown>): Record<string, unknown> {
  const first = argNumber(field, 'first', variables);
  const afterRaw = argValue(field, 'after', variables);
  const after = typeof afterRaw === 'string' ? afterRaw : null;
  const statesRaw = argValue(field, 'states', variables);
  const orderByRaw = asRecord(argValue(field, 'orderBy', variables));
  let list = [...repo.issues];
  if (Array.isArray(statesRaw) && statesRaw.length > 0) {
    const wanted = new Set(statesRaw.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderByRaw && asString(orderByRaw.direction) === 'ASC' ? 1 : -1;
  const orderField = orderByRaw ? asString(orderByRaw.field) : undefined;
  list.sort((a, b) => {
    let cmp = 0;
    if (orderField === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (orderField === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * direction;
  });
  let startIdx = 0;
  if (after) {
    const n = decodeCursor(after);
    if (n !== null) {
      const idx = list.findIndex((i) => i.number === n);
      if (idx >= 0) {
        startIdx = idx + 1;
      } else {
        // Cursor target left the list (e.g. deleted between pages): resume
        // from the boundary instead of restarting at page 1.
        startIdx = list.findIndex((i) => (direction === 1 ? i.number > n : i.number < n));
        if (startIdx < 0) startIdx = list.length;
      }
    }
  }
  const page = first !== undefined ? list.slice(startIdx, startIdx + first) : list.slice(startIdx);
  const hasNextPage = startIdx + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const out: Record<string, unknown> = {};
  const sels = field.selections && field.selections.length > 0 ? field.selections : defaultFields(['nodes', 'pageInfo']);
  eachField(sels, 'IssueConnection', (f) => {
    if (f.name === 'nodes') {
      out[f.alias ?? 'nodes'] = page.map((iss) => buildIssue(ctx, iss, f.selections));
    } else if (f.name === 'pageInfo') {
      const pi: Record<string, unknown> = {};
      eachField(f.selections, 'PageInfo', (pf) => {
        if (pf.name === 'hasNextPage') pi[pf.alias ?? 'hasNextPage'] = hasNextPage;
        else if (pf.name === 'endCursor') pi[pf.alias ?? 'endCursor'] = endCursor;
      });
      out[f.alias ?? 'pageInfo'] = pi;
    } else if (f.name === 'totalCount') {
      out[f.alias ?? 'totalCount'] = list.length;
    } else if (f.name === '__typename') {
      out[f.alias ?? '__typename'] = 'IssueConnection';
    }
  });
  return out;
}

function buildPullConnection(ctx: Ctx, repo: Repo, field: SelField, variables: Record<string, unknown>): Record<string, unknown> {
  const first = argNumber(field, 'first', variables);
  const list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const page = first !== undefined ? list.slice(0, first) : list;
  const out: Record<string, unknown> = {};
  const sels = field.selections && field.selections.length > 0 ? field.selections : defaultFields(['nodes']);
  eachField(sels, 'PullRequestConnection', (f) => {
    if (f.name === 'nodes') {
      out[f.alias ?? 'nodes'] = page.map((pr) => buildPull(ctx, repo, pr, f.selections, variables));
    } else if (f.name === 'pageInfo') {
      const pi: Record<string, unknown> = {};
      eachField(f.selections, 'PageInfo', (pf) => {
        if (pf.name === 'hasNextPage') pi[pf.alias ?? 'hasNextPage'] = false;
        else if (pf.name === 'endCursor') pi[pf.alias ?? 'endCursor'] = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
      });
      out[f.alias ?? 'pageInfo'] = pi;
    } else if (f.name === 'totalCount') {
      out[f.alias ?? 'totalCount'] = list.length;
    } else if (f.name === '__typename') {
      out[f.alias ?? '__typename'] = 'PullRequestConnection';
    }
  });
  return out;
}

function buildPull(ctx: Ctx, repo: Repo, pull: Pull, sels: Selection[] | null, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = sels && sels.length > 0 ? sels : defaultFields(['id', 'number', 'state', 'headRefName', 'baseRefName']);
  eachField(list, 'PullRequest', (f) => {
    switch (f.name) {
      case 'id':
        out[f.alias ?? 'id'] = pull.id;
        break;
      case 'number':
        out[f.alias ?? 'number'] = pull.number;
        break;
      case 'title':
        out[f.alias ?? 'title'] = pull.title;
        break;
      case 'body':
        out[f.alias ?? 'body'] = pull.body;
        break;
      case 'state':
        out[f.alias ?? 'state'] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'merged':
        out[f.alias ?? 'merged'] = pull.merged;
        break;
      case 'headRefName':
        out[f.alias ?? 'headRefName'] = pull.head.ref;
        break;
      case 'baseRefName':
        out[f.alias ?? 'baseRefName'] = pull.base.ref;
        break;
      case 'mergeable':
        out[f.alias ?? 'mergeable'] = computeMergeable(repo, pull);
        break;
      case 'createdAt':
        out[f.alias ?? 'createdAt'] = pull.createdAt;
        break;
      case 'updatedAt':
        out[f.alias ?? 'updatedAt'] = pull.updatedAt;
        break;
      case 'files': {
        const first = argNumber(f, 'first', variables);
        const files = ctx.store.pullFiles(repo, pull);
        const page = first !== undefined ? files.slice(0, first) : files;
        const filesOut: Record<string, unknown> = {};
        const fsels = f.selections && f.selections.length > 0 ? f.selections : defaultFields(['nodes']);
        eachField(fsels, 'PullRequestChangedFileConnection', (cf) => {
          if (cf.name === 'nodes') {
            filesOut[cf.alias ?? 'nodes'] = page.map((file) => {
              const node: Record<string, unknown> = {};
              eachField(cf.selections, 'PullRequestChangedFile', (nf) => {
                if (nf.name === 'path') node[nf.alias ?? 'path'] = file.filename;
                else if (nf.name === 'additions') node[nf.alias ?? 'additions'] = file.additions;
                else if (nf.name === 'deletions') node[nf.alias ?? 'deletions'] = file.deletions;
              });
              return node;
            });
          } else if (cf.name === 'totalCount') {
            filesOut[cf.alias ?? 'totalCount'] = files.length;
          }
        });
        out[f.alias ?? 'files'] = filesOut;
        break;
      }
      case '__typename':
        out[f.alias ?? '__typename'] = 'PullRequest';
        break;
      default:
        break;
    }
  });
  return out;
}

function buildRepo(ctx: Ctx, repo: Repo, sels: Selection[] | null, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = sels && sels.length > 0 ? sels : defaultFields(['id', 'name']);
  eachField(list, 'Repository', (f) => {
    switch (f.name) {
      case 'id':
        out[f.alias ?? 'id'] = ctx.store.globalIdForRepo(repo);
        break;
      case 'databaseId':
        out[f.alias ?? 'databaseId'] = repo.id;
        break;
      case 'name':
        out[f.alias ?? 'name'] = repo.name;
        break;
      case 'nameWithOwner':
        out[f.alias ?? 'nameWithOwner'] = repo.fullName;
        break;
      case 'owner': {
        const ownerOut: Record<string, unknown> = {};
        eachField(f.selections, 'User', (of) => {
          if (of.name === 'login') ownerOut[of.alias ?? 'login'] = repo.owner;
          else if (of.name === '__typename') ownerOut[of.alias ?? '__typename'] = 'User';
        });
        out[f.alias ?? 'owner'] = ownerOut;
        break;
      }
      case 'defaultBranchRef': {
        const refOut: Record<string, unknown> = {};
        eachField(f.selections, 'BranchRef', (rf) => {
          if (rf.name === 'name') refOut[rf.alias ?? 'name'] = repo.defaultBranch;
          else if (rf.name === '__typename') refOut[rf.alias ?? '__typename'] = 'BranchRef';
        });
        out[f.alias ?? 'defaultBranchRef'] = refOut;
        break;
      }
      case 'viewerPermission':
        out[f.alias ?? 'viewerPermission'] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[f.alias ?? 'hasIssuesEnabled'] = true;
        break;
      case 'description':
        out[f.alias ?? 'description'] = repo.description;
        break;
      case 'createdAt':
        out[f.alias ?? 'createdAt'] = repo.createdAt;
        break;
      case 'updatedAt':
        out[f.alias ?? 'updatedAt'] = repo.updatedAt;
        break;
      case 'issue': {
        const n = argNumber(f, 'number', variables);
        const issue = n !== undefined ? ctx.store.getIssue(repo, n) : undefined;
        out[f.alias ?? 'issue'] = issue ? buildIssue(ctx, issue, f.selections) : null;
        break;
      }
      case 'issues':
        out[f.alias ?? 'issues'] = buildIssueConnection(ctx, repo, f, variables);
        break;
      case 'pullRequests':
        out[f.alias ?? 'pullRequests'] = buildPullConnection(ctx, repo, f, variables);
        break;
      case 'pullRequest': {
        const n = argNumber(f, 'number', variables);
        const pull = n !== undefined ? ctx.store.getPull(repo, n) : undefined;
        out[f.alias ?? 'pullRequest'] = pull ? buildPull(ctx, repo, pull, f.selections, variables) : null;
        break;
      }
      case '__typename':
        out[f.alias ?? '__typename'] = 'Repository';
        break;
      default:
        break;
    }
  });
  return out;
}

function buildTypeInfo(name: string, sels: Selection[] | null): Record<string, unknown> | null {
  const fields = INTROSPECTION_FIELDS[name];
  const enums = INTROSPECTION_ENUMS[name];
  if (!fields && !enums) return null;
  const out: Record<string, unknown> = {};
  const list = sels && sels.length > 0 ? sels : defaultFields(['name']);
  eachField(list, '__Type', (f) => {
    if (f.name === 'name') out[f.alias ?? 'name'] = name;
    else if (f.name === 'kind') out[f.alias ?? 'kind'] = enums ? 'ENUM' : 'OBJECT';
    else if (f.name === 'fields') {
      out[f.alias ?? 'fields'] = (fields ?? []).map((n) => {
        const entry: Record<string, unknown> = {};
        eachField(f.selections, '__Field', (sf) => {
          if (sf.name === 'name') entry[sf.alias ?? 'name'] = n;
          else if (sf.name === 'description') entry[sf.alias ?? 'description'] = null;
          else if (sf.name === 'isDeprecated') entry[sf.alias ?? 'isDeprecated'] = false;
        });
        return entry;
      });
    } else if (f.name === 'enumValues') {
      out[f.alias ?? 'enumValues'] = (enums ?? []).map((n) => {
        const entry: Record<string, unknown> = {};
        eachField(f.selections, '__EnumValue', (sf) => {
          if (sf.name === 'name') entry[sf.alias ?? 'name'] = n;
          else if (sf.name === 'description') entry[sf.alias ?? 'description'] = null;
          else if (sf.name === 'isDeprecated') entry[sf.alias ?? 'isDeprecated'] = false;
        });
        return entry;
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function buildPayload(sels: Selection[] | null, entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  eachField(sels, 'Payload', (f) => {
    if (f.name in entries) out[f.alias ?? f.name] = entries[f.name];
  });
  return out;
}

function executeMutation(ctx: Ctx, field: SelField, variables: Record<string, unknown>): unknown {
  const input = asRecord(argValue(field, 'input', variables)) ?? {};
  switch (field.name) {
    case 'createIssue': {
      const repoId = asString(input.repositoryId);
      const found = repoId ? ctx.store.findByGlobalId(repoId) : undefined;
      if (!found || found.kind !== 'repo') throw new Error('Repository not found for repositoryId');
      const title = asString(input.title) ?? '';
      const body = asString(input.body) ?? '';
      const issue = ctx.store.createIssue(found.repo, title, body, []);
      const issueSel = findSubField(field.selections, 'issue');
      return buildPayload(field.selections, {
        issue: buildIssue(ctx, issue, issueSel ? issueSel.selections : null),
      });
    }
    case 'closeIssue': {
      const issueId = asString(input.issueId);
      const found = issueId ? ctx.store.findByGlobalId(issueId) : undefined;
      if (!found || found.kind !== 'issue' || !found.issue) throw new Error('Issue not found for issueId');
      const patched = ctx.store.patchIssue(found.repo, found.issue.number, { state: 'closed' });
      if (!patched) throw new Error('Issue not found for issueId');
      const issueSel = findSubField(field.selections, 'issue');
      return buildPayload(field.selections, {
        issue: buildIssue(ctx, patched, issueSel ? issueSel.selections : null),
      });
    }
    case 'createPullRequest': {
      const repoId = asString(input.repositoryId);
      const found = repoId ? ctx.store.findByGlobalId(repoId) : undefined;
      if (!found || found.kind !== 'repo') throw new Error('Repository not found for repositoryId');
      const baseRefName = asString(input.baseRefName) ?? found.repo.defaultBranch;
      const headRefName = asString(input.headRefName) ?? '';
      const title = asString(input.title) ?? '';
      const body = asString(input.body) ?? '';
      const pull = ctx.store.createPull(found.repo, headRefName, baseRefName, title, body);
      const prSel = findSubField(field.selections, 'pullRequest');
      return buildPayload(field.selections, {
        pullRequest: buildPull(ctx, found.repo, pull, prSel ? prSel.selections : null, variables),
      });
    }
    case 'mergePullRequest': {
      const pullRequestId = asString(input.pullRequestId);
      const found = pullRequestId ? ctx.store.findByGlobalId(pullRequestId) : undefined;
      if (!found || found.kind !== 'pull' || !found.pull) throw new Error('Pull request not found for pullRequestId');
      const result = ctx.store.mergePull(found.repo, found.pull.number);
      if (!result.ok) throw new Error(`Pull request cannot be merged: ${result.error}`);
      const merged = ctx.store.getPull(found.repo, found.pull.number) ?? found.pull;
      const prSel = findSubField(field.selections, 'pullRequest');
      return buildPayload(field.selections, {
        pullRequest: buildPull(ctx, found.repo, merged, prSel ? prSel.selections : null, variables),
      });
    }
    case 'addComment': {
      const subjectId = asString(input.subjectId);
      const found = subjectId ? ctx.store.findByGlobalId(subjectId) : undefined;
      if (!found || found.kind !== 'issue' || !found.issue) throw new Error('Issue not found for subjectId');
      const body = asString(input.body) ?? '';
      const comment: Comment | undefined = ctx.store.addComment(found.repo, found.issue.number, body);
      if (!comment) throw new Error('Issue not found for subjectId');
      const edgeSel = findSubField(field.selections, 'commentEdge');
      const nodeSel = edgeSel ? findSubField(edgeSel.selections, 'node') : null;
      const node: Record<string, unknown> = {};
      if (nodeSel) {
        eachField(nodeSel.selections, 'Comment', (nf) => {
          if (nf.name === 'id') node[nf.alias ?? 'id'] = String(comment.id);
          else if (nf.name === 'body') node[nf.alias ?? 'body'] = comment.body;
          else if (nf.name === 'createdAt') node[nf.alias ?? 'createdAt'] = comment.createdAt;
        });
      } else {
        node.id = String(comment.id);
        node.body = comment.body;
      }
      const edge: Record<string, unknown> = {};
      if (edgeSel) {
        eachField(edgeSel.selections, 'CommentEdge', (ef) => {
          if (ef.name === 'node') edge[ef.alias ?? 'node'] = node;
        });
        if (!('node' in edge)) edge.node = node;
      } else {
        edge.node = node;
      }
      return buildPayload(field.selections, { commentEdge: edge });
    }
    default:
      throw new Error(`Unknown mutation "${field.name}"`);
  }
}

// ---------------------------------------------------------------------------
// mergeable: ancestor check first, then a 3-way tree diff; UNKNOWN on doubt
// ---------------------------------------------------------------------------

function parseCommitHeader(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line === '') break;
  }
  return { tree, parents };
}

function parseTreeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>, depth: number): void {
  if (depth > 32) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTreeEntries(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out, depth + 1);
    else out.set(path, e.oid);
  }
}

function ancestorsOf(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (seen.size > 20000) break;
    const obj = repo.objects.get(cur);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommitHeader(obj.data).parents) stack.push(parent);
    }
  }
  return seen;
}

function computeMergeable(repo: Repo, pull: Pull): string {
  try {
    if (pull.merged) return 'UNKNOWN';
    const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
    const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    if (!headSha || !baseSha) return 'UNKNOWN';
    if (!repo.objects.has(headSha) || !repo.objects.has(baseSha)) return 'UNKNOWN';
    if (ancestorsOf(repo, headSha).has(baseSha)) return 'MERGEABLE';
    const baseAncestors = ancestorsOf(repo, baseSha);
    let mergeBase: string | null = null;
    const seen = new Set<string>();
    const queue = [headSha];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (baseAncestors.has(cur)) {
        mergeBase = cur;
        break;
      }
      const obj = repo.objects.get(cur);
      if (obj && obj.type === 'commit') {
        for (const parent of parseCommitHeader(obj.data).parents) queue.push(parent);
      }
      if (seen.size > 20000) break;
    }
    if (!mergeBase) return 'UNKNOWN';
    const mbObj = repo.objects.get(mergeBase);
    const headObj = repo.objects.get(headSha);
    const baseObj = repo.objects.get(baseSha);
    if (!mbObj || !headObj || !baseObj) return 'UNKNOWN';
    if (mbObj.type !== 'commit' || headObj.type !== 'commit' || baseObj.type !== 'commit') return 'UNKNOWN';
    const mbMap = new Map<string, string>();
    const headMap = new Map<string, string>();
    const baseMap = new Map<string, string>();
    flattenTree(repo, parseCommitHeader(mbObj.data).tree, '', mbMap, 0);
    flattenTree(repo, parseCommitHeader(headObj.data).tree, '', headMap, 0);
    flattenTree(repo, parseCommitHeader(baseObj.data).tree, '', baseMap, 0);
    const paths = new Set<string>([...mbMap.keys(), ...headMap.keys(), ...baseMap.keys()]);
    for (const path of paths) {
      const m = mbMap.get(path);
      const h = headMap.get(path);
      const b = baseMap.get(path);
      if (h !== m && b !== m && h !== b) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}
