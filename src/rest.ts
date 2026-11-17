// GitHub REST v3 handlers for the github-core-clone-01 forge.
// Every route in checks-rest.ts, with the exact statuses and body shapes
// that file asserts. All replies are application/json with a non-empty
// X-GitHub-Request-Id (via jsonBody in http-util.ts).
//
// Auth: every /api/v3 route requires the bearer token (401 otherwise).
// Ownership: owner !== viewer login is a 404, never a 403. A missing repo
// is a 404 JSON {message}. A malformed JSON body is a 400 JSON {message}.
// An unknown /api/v3 route is a 404 JSON {message}.
//
// Contents commits and merge commits are real git objects built with
// git-core.ts: author/committer are the viewer "Name <email>", the
// timestamp is ctx.nowEpoch, timezone +0000. A contents PUT stores the
// message verbatim (no trailing newline added), so GET /commits echoes
// exactly the message the client sent.
//
// Pagination Link headers carry ABSOLUTE urls: the suite's sameOrigin()
// helper runs `new URL(value)` on the Link target, so a relative target
// fails the origin check and the pagination walk stops.

import type { ServerResponse } from 'node:http';
import { buildCommit, buildTreeFromMap, flattenTree, parseCommit, parseTree } from './git-core.ts';
import type { Ctx, GitObject, HttpReq, Pull, Repo, Store } from './types.ts';
import { asBoolean, asRecord, asString, asStringArray, errorJson, isAuthenticated, jsonBody, paginate, pagination } from './http-util.ts';

function baseUrlOf(req: HttpReq): string {
  const host = req.headers.get('host');
  return host !== undefined && host !== '' ? `http://${host}` : 'http://localhost';
}

function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => {
      // decodeURIComponent of a segment with no '%' is the identity (it only
      // transforms %XX sequences), so skip the call on the common path.
      if (!part.includes('%')) return part;
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function parseNumber(value: string): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/** The request JSON body as a record, or null when it is absent / not an object. Never throws. */
function bodyRecord(req: HttpReq): Record<string, unknown> | null {
  try {
    return asRecord(req.json);
  } catch {
    return null;
  }
}

function noContent(res: ServerResponse, ctx: Ctx): void {
  res.writeHead(204, { 'content-type': 'application/json', 'x-github-request-id': ctx.nextRequestId() });
  res.end();
}

/** Rewrite paginate()'s relative Link targets to absolute urls on this origin. */
function absoluteLink(link: string | null, baseUrl: string): string | null {
  if (link === null) return null;
  return link.replace(/<([^>]+)>/g, (_whole: string, url: string): string => `<${baseUrl}${url}>`);
}

// --- git helpers for the contents API ----------------------------------------

function lookupFor(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string): GitObject | undefined => repo.objects.get(oid);
}

function commitTreeOid(repo: Repo, commitSha: string): string | undefined {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** Resolve a ?ref= value (or the default branch) to a commit sha, or undefined when unknown. */
function resolveTip(store: Store, repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined) return store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
  const branch = store.getRef(repo, `refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const direct = store.getRef(repo, ref);
  if (direct !== undefined) return direct;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = store.getObject(repo, ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
  }
  return undefined;
}

/** Blob oid at `path` in the given tree, or undefined when absent. */
function findBlobOid(repo: Repo, treeOid: string | undefined, path: string): string | undefined {
  if (treeOid === undefined) return undefined;
  return flattenTree(lookupFor(repo), treeOid).get(path)?.oid;
}

/** New root tree oid with `path` set to `blobOid` (creating parent dirs). Stores new tree objects. */
function setFileInTree(repo: Repo, parentTreeOid: string | undefined, path: string, blobOid: string): string {
  const lookup = lookupFor(repo);
  const files = parentTreeOid === undefined ? new Map<string, { oid: string; mode: string }>() : flattenTree(lookup, parentTreeOid);
  files.set(path, { oid: blobOid, mode: '100644' });
  const built = buildTreeFromMap(files, lookup);
  for (const [oid, obj] of built.objects) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  return built.rootOid;
}

/** New root tree oid with `path` removed (pruning dirs that become empty). Stores new tree objects. */
function removeFileFromTree(repo: Repo, parentTreeOid: string | undefined, path: string): string {
  const lookup = lookupFor(repo);
  const files = parentTreeOid === undefined ? new Map<string, { oid: string; mode: string }>() : flattenTree(lookup, parentTreeOid);
  files.delete(path);
  const built = buildTreeFromMap(files, lookup);
  for (const [oid, obj] of built.objects) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  return built.rootOid;
}

/** The entry at `segments` below `rootTreeOid`: a file blob, a directory tree, or undefined. */
function findEntry(repo: Repo, rootTreeOid: string, segments: string[]): { kind: 'file' | 'dir'; oid: string } | undefined {
  let currentOid = rootTreeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(currentOid);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid };
    if (entry.mode !== '40000') return undefined;
    currentOid = entry.oid;
  }
  return undefined;
}

function parseIdentity(text: string): { name: string; email: string } {
  const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(text);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) return { name: match[1], email: match[2] };
  return { name: text, email: '' };
}

/** History newest-first: breadth-first walk of parents from the tip. */
function listCommitHistory(repo: Repo, tip: string): { sha: string; message: string; tree: string; author: string; committer: string }[] {
  const out: { sha: string; message: string; tree: string; author: string; committer: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({ sha, message: parsed.message, tree: parsed.tree, author: parsed.author, committer: parsed.committer });
    for (const parent of parsed.parents) queue.push(parent);
  }
  return out;
}

function commitJson(entry: { sha: string; message: string; tree: string; author: string; committer: string }, nowIso: string): Record<string, unknown> {
  const author = parseIdentity(entry.author);
  const committer = parseIdentity(entry.committer);
  return {
    sha: entry.sha,
    commit: {
      message: entry.message,
      author: { name: author.name, email: author.email, date: nowIso },
      committer: { name: committer.name, email: committer.email, date: nowIso },
      tree: { sha: entry.tree },
    },
  };
}

// --- /api/v3 entry point ------------------------------------------------------

export async function handleRest(ctx: Ctx, req: HttpReq, res: ServerResponse): Promise<boolean> {
  const segments = segmentsOf(req.path);
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  if (!isAuthenticated(req.headers, ctx)) {
    errorJson(res, 401, 'requires authentication', ctx);
    return true;
  }
  const hasBodyMethod = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE';
  if (hasBodyMethod && req.malformedJson) {
    errorJson(res, 400, 'malformed JSON body', ctx);
    return true;
  }
  const baseUrl = baseUrlOf(req);
  const store = ctx.store;

  if (segments.length === 2) {
    if (req.method !== 'GET') {
      errorJson(res, 404, 'not found', ctx);
      return true;
    }
    jsonBody(res, 200, {}, ctx, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (segments.length === 3 && segments[2] === 'meta') {
    if (req.method !== 'GET') {
      errorJson(res, 404, 'not found', ctx);
      return true;
    }
    jsonBody(res, 200, { installed_version: '1.0.0' }, ctx);
    return true;
  }

  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (req.method === 'POST') {
      const body = bodyRecord(req);
      if (body === null) {
        errorJson(res, 400, 'request body must be a JSON object', ctx);
        return true;
      }
      const name = asString(body.name);
      if (name === undefined || name === '') {
        errorJson(res, 400, 'name is required', ctx);
        return true;
      }
      if (store.getRepo(ctx.viewer.login, name) !== undefined) {
        errorJson(res, 422, 'repository already exists', ctx);
        return true;
      }
      const repo = store.createRepo(name, {
        private: asBoolean(body.private) ?? false,
        description: asString(body.description) ?? '',
      });
      jsonBody(res, 201, store.repoJson(repo, baseUrl), ctx);
      return true;
    }
    if (req.method === 'GET') {
      const { page, perPage } = pagination(req.query);
      const { pageItems, link } = paginate(
        store.listRepos(ctx.viewer.login).map((repo) => store.repoJson(repo, baseUrl)),
        page,
        perPage,
        '/api/v3/user/repos',
        req.query,
      );
      const absolute = absoluteLink(link, baseUrl);
      jsonBody(res, 200, pageItems, ctx, absolute === null ? undefined : { link: absolute });
      return true;
    }
    errorJson(res, 404, 'not found', ctx);
    return true;
  }

  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = segments[3] as string;
    const name = segments[4] as string;
    if (owner !== ctx.viewer.login) {
      errorJson(res, 404, 'repository not found', ctx);
      return true;
    }
    const repo = store.getRepo(owner, name);
    if (repo === undefined) {
      errorJson(res, 404, 'repository not found', ctx);
      return true;
    }
    return handleRepoRoute(ctx, req, res, repo, segments, baseUrl);
  }

  errorJson(res, 404, 'not found', ctx);
  return true;
}

// --- /api/v3/repos/{owner}/{name}... ------------------------------------------

async function handleRepoRoute(ctx: Ctx, req: HttpReq, res: ServerResponse, repo: Repo, segments: string[], baseUrl: string): Promise<boolean> {
  const store = ctx.store;

  if (segments.length === 5) {
    if (req.method === 'GET') {
      jsonBody(res, 200, store.repoJson(repo, baseUrl), ctx);
      return true;
    }
    if (req.method === 'PATCH') {
      const body = bodyRecord(req);
      if (body === null) {
        errorJson(res, 400, 'request body must be a JSON object', ctx);
        return true;
      }
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(body.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      repo.updatedAt = ctx.nowIso;
      jsonBody(res, 200, store.repoJson(repo, baseUrl), ctx);
      return true;
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      noContent(res, ctx);
      return true;
    }
    errorJson(res, 404, 'not found', ctx);
    return true;
  }

  const tail = segments[5] as string;

  if (segments.length === 7 && tail === 'git' && segments[6] === 'refs') {
    if (req.method !== 'POST') {
      errorJson(res, 404, 'not found', ctx);
      return true;
    }
    const body = bodyRecord(req);
    if (body === null) {
      errorJson(res, 400, 'request body must be a JSON object', ctx);
      return true;
    }
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === undefined || sha === undefined) {
      errorJson(res, 400, 'ref and sha are required', ctx);
      return true;
    }
    if (!ref.startsWith('refs/heads/')) {
      errorJson(res, 422, 'only refs/heads/ references can be created', ctx);
      return true;
    }
    if (store.getRef(repo, ref) !== undefined) {
      errorJson(res, 422, 'reference already exists', ctx);
      return true;
    }
    const obj = store.getObject(repo, sha);
    if (obj === undefined || obj.type !== 'commit') {
      errorJson(res, 422, 'sha is not a commit in this repository', ctx);
      return true;
    }
    store.setRef(repo, ref, sha);
    jsonBody(res, 201, { ref, object: { sha } }, ctx);
    return true;
  }

  if (segments.length === 6) {
    if (tail === 'branches' && req.method === 'GET') {
      const branches = store
        .listRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
      jsonBody(res, 200, branches, ctx);
      return true;
    }
    if (tail === 'commits' && req.method === 'GET') {
      const shaParam = req.query.get('sha') ?? undefined;
      const tip = resolveTip(store, repo, shaParam);
      if (tip === undefined) {
        if (shaParam !== undefined) {
          errorJson(res, 404, 'ref not found', ctx);
          return true;
        }
        jsonBody(res, 200, [], ctx);
        return true;
      }
      const history = listCommitHistory(repo, tip).map((entry) => commitJson(entry, ctx.nowIso));
      jsonBody(res, 200, history, ctx);
      return true;
    }
    if (tail === 'labels' && req.method === 'POST') {
      const body = bodyRecord(req);
      if (body === null) {
        errorJson(res, 400, 'request body must be a JSON object', ctx);
        return true;
      }
      const name = asString(body.name);
      if (name === undefined || name === '') {
        errorJson(res, 400, 'name is required', ctx);
        return true;
      }
      const label = store.createLabel(repo, name, asString(body.color) ?? 'ededed');
      jsonBody(res, 201, store.labelJson(label), ctx);
      return true;
    }
    if (tail === 'issues') {
      if (req.method === 'POST') {
        const body = bodyRecord(req);
        if (body === null) {
          errorJson(res, 400, 'request body must be a JSON object', ctx);
          return true;
        }
        const title = asString(body.title);
        if (title === undefined) {
          errorJson(res, 400, 'title is required', ctx);
          return true;
        }
        const labels = asStringArray(body.labels) ?? [];
        for (const labelName of labels) {
          if (store.getLabel(repo, labelName) === undefined) {
            errorJson(res, 422, `label ${labelName} does not exist`, ctx);
            return true;
          }
        }
        const issue = store.createIssue(repo, title, asString(body.body) ?? '', labels);
        jsonBody(res, 201, store.issueJson(repo, issue, baseUrl), ctx);
        return true;
      }
      if (req.method === 'GET') {
        const { page, perPage } = pagination(req.query);
        const items = store.listIssues(repo, {
          state: req.query.get('state') ?? undefined,
          sort: req.query.get('sort') ?? undefined,
          direction: req.query.get('direction') ?? undefined,
        });
        const { pageItems, link } = paginate(
          items.map((issue) => store.issueJson(repo, issue, baseUrl)),
          page,
          perPage,
          `/api/v3/repos/${repo.owner}/${repo.name}/issues`,
          req.query,
        );
        const absolute = absoluteLink(link, baseUrl);
        jsonBody(res, 200, pageItems, ctx, absolute === null ? undefined : { link: absolute });
        return true;
      }
      errorJson(res, 404, 'not found', ctx);
      return true;
    }
    if (tail === 'pulls') {
      if (req.method === 'POST') {
        const body = bodyRecord(req);
        if (body === null) {
          errorJson(res, 400, 'request body must be a JSON object', ctx);
          return true;
        }
        const head = asString(body.head);
        const base = asString(body.base);
        const title = asString(body.title);
        if (head === undefined || base === undefined || title === undefined) {
          errorJson(res, 400, 'head, base and title are required', ctx);
          return true;
        }
        if (store.getRef(repo, `refs/heads/${head}`) === undefined || store.getRef(repo, `refs/heads/${base}`) === undefined) {
          errorJson(res, 422, 'head or base branch not found', ctx);
          return true;
        }
        const pull = store.createPull(repo, head, base, title, asString(body.body) ?? '');
        jsonBody(res, 201, store.pullJson(repo, pull, baseUrl), ctx);
        return true;
      }
      if (req.method === 'GET') {
        const { page, perPage } = pagination(req.query);
        const items = store.listPulls(repo, req.query.get('state') ?? 'open');
        const { pageItems, link } = paginate(
          items.map((pull) => store.pullJson(repo, pull, baseUrl)),
          page,
          perPage,
          `/api/v3/repos/${repo.owner}/${repo.name}/pulls`,
          req.query,
        );
        const absolute = absoluteLink(link, baseUrl);
        jsonBody(res, 200, pageItems, ctx, absolute === null ? undefined : { link: absolute });
        return true;
      }
      errorJson(res, 404, 'not found', ctx);
      return true;
    }
  }

  if (segments.length >= 6 && tail === 'contents') {
    return handleContents(ctx, req, res, repo, segments);
  }

  if (segments.length === 7 && tail === 'issues') {
    const number = parseNumber(segments[6] as string);
    if (number === undefined) {
      errorJson(res, 404, 'issue not found', ctx);
      return true;
    }
    if (req.method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) {
        errorJson(res, 404, 'issue not found', ctx);
        return true;
      }
      jsonBody(res, 200, store.issueJson(repo, issue, baseUrl), ctx);
      return true;
    }
    if (req.method === 'PATCH') {
      const body = bodyRecord(req);
      if (body === null) {
        errorJson(res, 400, 'request body must be a JSON object', ctx);
        return true;
      }
      const state = asString(body.state);
      if (state !== undefined && state !== 'open' && state !== 'closed') {
        errorJson(res, 400, 'state must be open or closed', ctx);
        return true;
      }
      const issue = store.patchIssue(repo, number, {
        state,
        title: asString(body.title),
        body: asString(body.body),
      });
      if (issue === undefined) {
        errorJson(res, 404, 'issue not found', ctx);
        return true;
      }
      jsonBody(res, 200, store.issueJson(repo, issue, baseUrl), ctx);
      return true;
    }
    errorJson(res, 404, 'not found', ctx);
    return true;
  }

  if (segments.length === 8 && tail === 'issues' && segments[7] === 'comments') {
    const number = parseNumber(segments[6] as string);
    if (number === undefined || store.getIssue(repo, number) === undefined) {
      errorJson(res, 404, 'issue not found', ctx);
      return true;
    }
    if (req.method === 'POST') {
      const body = bodyRecord(req);
      if (body === null) {
        errorJson(res, 400, 'request body must be a JSON object', ctx);
        return true;
      }
      const commentBody = asString(body.body);
      if (commentBody === undefined) {
        errorJson(res, 400, 'body is required', ctx);
        return true;
      }
      const comment = store.addComment(repo, number, commentBody);
      if (comment === undefined) {
        errorJson(res, 404, 'issue not found', ctx);
        return true;
      }
      jsonBody(res, 201, store.commentJson(comment, baseUrl), ctx);
      return true;
    }
    if (req.method === 'GET') {
      jsonBody(
        res,
        200,
        store.listComments(repo, number).map((comment) => store.commentJson(comment, baseUrl)),
        ctx,
      );
      return true;
    }
    errorJson(res, 404, 'not found', ctx);
    return true;
  }

  if (segments.length === 7 && tail === 'pulls') {
    const number = parseNumber(segments[6] as string);
    if (number === undefined) {
      errorJson(res, 404, 'pull request not found', ctx);
      return true;
    }
    if (req.method === 'GET') {
      const pull = store.getPull(repo, number);
      if (pull === undefined) {
        errorJson(res, 404, 'pull request not found', ctx);
        return true;
      }
      jsonBody(res, 200, store.pullJson(repo, pull, baseUrl), ctx);
      return true;
    }
    errorJson(res, 404, 'not found', ctx);
    return true;
  }

  if (segments.length === 8 && tail === 'pulls') {
    const number = parseNumber(segments[6] as string);
    if (number === undefined) {
      errorJson(res, 404, 'pull request not found', ctx);
      return true;
    }
    if (segments[7] === 'files' && req.method === 'GET') {
      const pull = store.getPull(repo, number);
      if (pull === undefined) {
        errorJson(res, 404, 'pull request not found', ctx);
        return true;
      }
      jsonBody(res, 200, store.pullFiles(repo, pull), ctx);
      return true;
    }
    if (segments[7] === 'merge' && req.method === 'PUT') {
      const pull = store.getPull(repo, number);
      if (pull === undefined) {
        errorJson(res, 404, 'pull request not found', ctx);
        return true;
      }
      const result = store.mergePull(repo, number);
      if (result.ok) {
        const merged = store.getPull(repo, number) as Pull;
        jsonBody(res, 200, { merged: true, sha: result.sha, message: `${merged.title} (#${merged.number})` }, ctx);
        return true;
      }
      if (result.error === 'not-found') {
        errorJson(res, 404, 'pull request not found', ctx);
        return true;
      }
      if (result.error === 'conflict' || result.error === 'already-merged') {
        errorJson(res, 405, result.error === 'conflict' ? 'merge conflict' : 'pull request is already merged', ctx);
        return true;
      }
      errorJson(res, 422, 'head or base branch has no commit', ctx);
      return true;
    }
    errorJson(res, 404, 'not found', ctx);
    return true;
  }

  errorJson(res, 404, 'not found', ctx);
  return true;
}

// --- /api/v3/repos/{owner}/{name}/contents/{path} ------------------------------

async function handleContents(ctx: Ctx, req: HttpReq, res: ServerResponse, repo: Repo, segments: string[]): Promise<boolean> {
  const store = ctx.store;
  const pathSegments = segments.slice(6);
  const path = pathSegments.join('/');
  const identity = `${ctx.viewer.name} <${ctx.viewer.email}>`;

  if (req.method === 'PUT') {
    const body = bodyRecord(req);
    if (body === null) {
      errorJson(res, 400, 'request body must be a JSON object', ctx);
      return true;
    }
    const message = asString(body.message);
    const contentB64 = asString(body.content);
    if (message === undefined || contentB64 === undefined) {
      errorJson(res, 400, 'message and content are required', ctx);
      return true;
    }
    if (path === '') {
      errorJson(res, 400, 'path is required', ctx);
      return true;
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = store.getRef(repo, branchRef);
    if (asString(body.branch) !== undefined && tip === undefined) {
      errorJson(res, 404, 'branch not found', ctx);
      return true;
    }
    const parentTree = tip === undefined ? undefined : commitTreeOid(repo, tip);
    const existingBlobSha = findBlobOid(repo, parentTree, path);
    const shaParam = asString(body.sha);
    if (shaParam !== undefined) {
      if (existingBlobSha === undefined || existingBlobSha !== shaParam) {
        errorJson(res, 409, 'sha does not match the current blob', ctx);
        return true;
      }
    } else if (existingBlobSha !== undefined) {
      errorJson(res, 422, 'sha is required to update an existing file', ctx);
      return true;
    }
    const contentBytes = Buffer.from(contentB64, 'base64');
    const blobSha = store.putObject(repo, 'blob', contentBytes);
    const newTreeOid = setFileInTree(repo, parentTree, path, blobSha);
    const commitData = buildCommit({
      tree: newTreeOid,
      parents: tip === undefined ? [] : [tip],
      author: identity,
      committer: identity,
      timestamp: ctx.nowEpoch,
      message,
    });
    const commitSha = store.putObject(repo, 'commit', commitData);
    store.setRef(repo, branchRef, commitSha);
    const status = existingBlobSha === undefined ? 201 : 200;
    jsonBody(
      res,
      status,
      {
        content: {
          name: pathSegments[pathSegments.length - 1] as string,
          path,
          sha: blobSha,
          size: contentBytes.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha },
      },
      ctx,
    );
    return true;
  }

  if (req.method === 'GET') {
    const refParam = req.query.get('ref') ?? undefined;
    const tip = resolveTip(store, repo, refParam);
    if (tip === undefined) {
      errorJson(res, 404, refParam === undefined ? 'repository has no commits' : 'ref not found', ctx);
      return true;
    }
    const rootTree = commitTreeOid(repo, tip);
    if (rootTree === undefined) {
      errorJson(res, 404, 'ref not found', ctx);
      return true;
    }
    if (pathSegments.length === 0) {
      const entries = parseTreeOf(repo, rootTree).map((entry) => dirEntryJson(repo, entry, entry.name));
      jsonBody(res, 200, entries, ctx);
      return true;
    }
    const found = findEntry(repo, rootTree, pathSegments);
    if (found === undefined) {
      errorJson(res, 404, 'file not found', ctx);
      return true;
    }
    if (found.kind === 'dir') {
      const entries = parseTreeOf(repo, found.oid).map((entry) => dirEntryJson(repo, entry, `${path}/${entry.name}`));
      jsonBody(res, 200, entries, ctx);
      return true;
    }
    const blob = store.getObject(repo, found.oid);
    if (blob === undefined || blob.type !== 'blob') {
      errorJson(res, 404, 'file not found', ctx);
      return true;
    }
    jsonBody(
      res,
      200,
      {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: found.oid,
        size: blob.data.length,
        name: pathSegments[pathSegments.length - 1] as string,
        path,
      },
      ctx,
    );
    return true;
  }

  if (req.method === 'DELETE') {
    const body = bodyRecord(req);
    if (body === null) {
      errorJson(res, 400, 'request body must be a JSON object', ctx);
      return true;
    }
    const message = asString(body.message);
    const shaParam = asString(body.sha);
    if (message === undefined || shaParam === undefined) {
      errorJson(res, 400, 'message and sha are required', ctx);
      return true;
    }
    if (path === '') {
      errorJson(res, 400, 'path is required', ctx);
      return true;
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = store.getRef(repo, branchRef);
    if (tip === undefined) {
      errorJson(res, 404, 'file not found', ctx);
      return true;
    }
    const parentTree = commitTreeOid(repo, tip);
    const existingBlobSha = findBlobOid(repo, parentTree, path);
    if (existingBlobSha === undefined) {
      errorJson(res, 404, 'file not found', ctx);
      return true;
    }
    if (existingBlobSha !== shaParam) {
      errorJson(res, 409, 'sha does not match the current blob', ctx);
      return true;
    }
    const newTreeOid = removeFileFromTree(repo, parentTree, path);
    const commitData = buildCommit({
      tree: newTreeOid,
      parents: [tip],
      author: identity,
      committer: identity,
      timestamp: ctx.nowEpoch,
      message,
    });
    const commitSha = store.putObject(repo, 'commit', commitData);
    store.setRef(repo, branchRef, commitSha);
    jsonBody(res, 200, { commit: { sha: commitSha } }, ctx);
    return true;
  }

  errorJson(res, 404, 'not found', ctx);
  return true;
}

function parseTreeOf(repo: Repo, treeOid: string): { mode: string; name: string; oid: string }[] {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

/** One directory-listing entry: files carry their byte size, directories do not. */
function dirEntryJson(repo: Repo, entry: { mode: string; name: string; oid: string }, path: string): Record<string, unknown> {
  if (entry.mode === '40000') {
    return { type: 'dir', name: entry.name, path, sha: entry.oid };
  }
  const blob = repo.objects.get(entry.oid);
  const size = blob !== undefined && blob.type === 'blob' ? blob.data.length : 0;
  return { type: 'file', name: entry.name, path, sha: entry.oid, size };
}
