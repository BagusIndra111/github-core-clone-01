// Smart-HTTP git transport for the github-core-clone-01 forge.
// Routes: /{owner}/{repo}.git/info/refs, .../git-upload-pack, .../git-receive-pack.
// Erasable TypeScript only. Node stdlib only. No wall-clock, no randomness.
// Every reply carries x-github-request-id from ctx.nextRequestId().

import type { ServerResponse } from 'node:http';
import type { Ctx, GitObject, GitObjectType, HttpReq, Repo } from './types.ts';
import { isAuthenticated, errorJson } from './http-util.ts';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './git-core.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, ctx: Ctx): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function lookupFor(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string): GitObject | undefined => repo.objects.get(oid);
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Peel an annotated tag ref to its commit oid, or undefined. */
function peelRef(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj) return undefined;
    if (obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** v0 ref advertisement body for one service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent symref=HEAD:refs/heads/main'
    : 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent';
  const chunks: Buffer[] = [];
  chunks.push(pktLine(`# service=${service}\n`));
  // The protocol requires a flush packet between the service line and the
  // ref lines; without it a real git client aborts the exchange right after
  // reading the advertisement (it never sends the POST).
  chunks.push(pktFlush());
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    chunks.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelRef(repo, ref.oid);
        if (peeled && peeled !== ref.oid) chunks.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** v2 capability advertisement body (upload-pack only). */
function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

// --- pkt-line request parsing -------------------------------------------------

interface ParsedPktBody {
  /** Data-packet payloads, in order, split into sections by flush/delim. */
  sections: string[][];
  /** Byte offset in the body just past the first flush packet, or -1. */
  firstFlushEnd: number;
}

/**
 * Parse a pkt-line request body into sections. Returns null when the body
 * is not a pkt-line stream at all (the malformed-request case: the caller
 * answers 400 and the server stays up). The raw packfile of a receive-pack
 * body starts right after the first flush and is returned via firstFlushEnd.
 */
function parseRequestBody(body: Buffer): ParsedPktBody | null {
  const sections: string[][] = [[]];
  let offset = 0;
  let firstFlushEnd = -1;
  while (offset < body.length) {
    if (offset + 4 > body.length) return null;
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      if (firstFlushEnd < 0) firstFlushEnd = offset + 4;
      sections.push([]);
      offset += 4;
      // A receive-pack body carries a raw packfile right after the first
      // flush; it does not parse as pkt-lines, so stop here and let the
      // caller take the remainder as the pack. A v0 upload-pack body, by
      // contrast, continues with pkt-lined have/done lines after a flush.
      if (offset < body.length) {
        const next = body.subarray(offset, offset + 4).toString('ascii');
        if (!/^[0-9a-fA-F]{4}$/.test(next)) break;
      }
      continue;
    }
    if (length === 1) { sections.push([]); offset += 4; continue; }
    if (length === 2) { offset += 4; continue; }
    if (length === 3 || length > 65520 || offset + length > body.length) return null;
    sections[sections.length - 1].push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { sections, firstFlushEnd };
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// --- fetch computation ---------------------------------------------------------

interface FetchPlan {
  toSend: Set<string>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Held objects: the full closure of each have, except a have that is a
 * known shallow boundary of the client, whose closure stops at the commit
 * itself (its parents are exactly what a deepen is asking for).
 */
function heldSet(repo: Repo, haves: string[], inputShallow: string[]): Set<string> {
  const lookup = lookupFor(repo);
  const shallowSet = new Set(inputShallow);
  const held = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      const obj = lookup(have);
      if (!obj) continue;
      held.add(have);
      if (obj.type === 'commit') {
        const tree = parseCommit(obj.data).tree;
        for (const oid of collectReachable([tree], lookup)) held.add(oid);
      } else {
        for (const oid of collectReachable([have], lookup)) held.add(oid);
      }
    } else {
      for (const oid of collectReachable([have], lookup)) held.add(oid);
    }
  }
  return held;
}

interface DepthWalk {
  objects: Set<string>;
  /** Commits at the depth boundary (their parents were not included). */
  boundary: Set<string>;
  /** Commits included together with at least one of their parents. */
  withParent: Set<string>;
}

/** Walk wants limited to `depth` commit generations from each want. */
function depthLimitedWalk(repo: Repo, wants: string[], depth: number): DepthWalk {
  const lookup = lookupFor(repo);
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const withParent = new Set<string>();
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const obj = lookup(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(want);
      const target = peelRef(repo, want);
      if (target && target !== want) queue.push(target);
      continue;
    }
    if (obj.type === 'commit') queue.push(want);
    else for (const oid of collectReachable([want], lookup)) objects.add(oid);
  }
  for (const oid of queue) if (!dist.has(oid)) dist.set(oid, 0);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    const d = dist.get(oid) as number;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    objects.add(oid);
    const commit = parseCommit(obj.data);
    for (const treeOid of collectReachable([commit.tree], lookup)) objects.add(treeOid);
    if (d >= depth - 1) {
      boundary.add(oid);
      continue;
    }
    withParent.add(oid);
    for (const parent of commit.parents) {
      if (!dist.has(parent)) { dist.set(parent, d + 1); queue.push(parent); }
    }
  }
  return { objects, boundary, withParent };
}

function computeFetch(repo: Repo, wants: string[], haves: string[], inputShallow: string[], depth: number | null): FetchPlan {
  const lookup = lookupFor(repo);
  const held = heldSet(repo, haves, inputShallow);
  let wanted: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth === null) {
    wanted = collectReachable(wants, lookup);
  } else {
    const walk = depthLimitedWalk(repo, wants, depth);
    wanted = walk.objects;
    shallow = [...walk.boundary].sort();
    unshallow = inputShallow.filter((oid) => walk.withParent.has(oid)).sort();
  }
  const toSend = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) toSend.add(oid);
  // Acks only exist for haves the client already holds; with no haves the
  // answer is empty, so skip the full-history walk entirely (a depth-1
  // clone of a 200-commit repo paid ~2 ms per fetch for it).
  const acks: string[] = [];
  if (haves.length > 0) {
    const fullWanted = collectReachable(wants, lookup);
    for (const have of haves) if (fullWanted.has(have)) acks.push(have);
  }
  return { toSend, shallow, unshallow, acks };
}

function buildPack(repo: Repo, oids: Set<string>): Buffer {
  const objects: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ oid, type: obj.type, data: obj.data });
  }
  return writePack(objects);
}

// --- ls-refs ------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  // The client sends peel/symrefs/unborn only when it wants them; a flag
  // absent from the request means the caller turned it off.
  const flag = (name: string): boolean => args.some((arg) => arg.replace(/\n$/, '') === name);
  const peel = flag('peel');
  const symrefs = flag('symrefs');
  const unborn = flag('unborn');
  const prefixes: string[] = [];
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const chunks: Buffer[] = [];
  const mainOid = headOid(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (prefixes.length === 0) {
    if (mainOid !== ZERO_OID) {
      chunks.push(pktLine(symrefs ? `${mainOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${mainOid} HEAD\n`));
    } else if (unborn) {
      chunks.push(pktLine(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `unborn HEAD\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelRef(repo, ref.oid);
        if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// --- upload-pack ---------------------------------------------------------------

function parseFetchArgs(args: string[]): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

function v2FetchResponse(repo: Repo, args: string[]): Buffer {
  const { wants, haves, shallow, depth } = parseFetchArgs(args);
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(repo, plan.toSend);
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  chunks.push(pktFlush());
  if (depth !== null) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktFlush());
  }
  chunks.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(pack)) chunks.push(chunk);
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function v0FetchResponse(repo: Repo, sections: string[][]): Buffer {
  const first = sections[0] ?? [];
  const second = sections[1] ?? [];
  const args = [...first, ...second];
  const { wants, haves, shallow, depth } = parseFetchArgs(args);
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(repo, plan.toSend);
  const chunks: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  if (depth !== null) {
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  }
  for (const chunk of sidebandChunks(pack)) chunks.push(chunk);
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function handleUploadPack(ctx: Ctx, req: HttpReq, res: ServerResponse, repo: Repo): void {
  const parsed = parseRequestBody(req.body);
  if (!parsed) {
    errorJson(res, 400, 'malformed pkt-line request', ctx);
    return;
  }
  const isV2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
  if (isV2) {
    const commandSection = parsed.sections[0] ?? [];
    const argSection = parsed.sections[1] ?? [];
    const commandLine = (commandSection[0] ?? '').replace(/\n$/, '');
    if (commandLine === 'command=ls-refs') {
      sendBytes(res, 200, UPLOAD_RESULT, handleLsRefs(repo, argSection), ctx);
      return;
    }
    if (commandLine === 'command=fetch') {
      sendBytes(res, 200, UPLOAD_RESULT, v2FetchResponse(repo, argSection), ctx);
      return;
    }
    errorJson(res, 400, 'unknown git-upload-pack command', ctx);
    return;
  }
  sendBytes(res, 200, UPLOAD_RESULT, v0FetchResponse(repo, parsed.sections), ctx);
}

// --- receive-pack ---------------------------------------------------------------

function handleReceivePack(ctx: Ctx, req: HttpReq, res: ServerResponse, repo: Repo): void {
  const parsed = parseRequestBody(req.body);
  if (!parsed || parsed.firstFlushEnd < 0) {
    errorJson(res, 400, 'malformed pkt-line request', ctx);
    return;
  }
  const commandLines = parsed.sections[0] ?? [];
  const packBytes = req.body.subarray(parsed.firstFlushEnd);
  interface Command { oldOid: string; newOid: string; ref: string; caps: string; }
  const commands: Command[] = [];
  let sideband = false;
  let malformed = false;
  for (let index = 0; index < commandLines.length; index += 1) {
    const raw = (commandLines[index] ?? '').replace(/\n$/, '');
    if (!raw) continue;
    const nul = raw.indexOf('\0');
    const head = nul >= 0 ? raw.slice(0, nul) : raw;
    const caps = nul >= 0 ? raw.slice(nul + 1) : '';
    if (index === 0 && caps) sideband = caps.split(' ').includes('side-band-64k');
    const parts = head.split(' ');
    if (parts.length !== 3 || !/^[0-9a-f]{40}$/.test(parts[0]) || !/^[0-9a-f]{40}$/.test(parts[1]) || !parts[2].startsWith('refs/')) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps });
  }
  const reportLines: string[] = [];
  if (malformed || commands.length === 0) {
    reportLines.push('unpack error');
    for (const command of commands) reportLines.push(`ng ${command.ref} malformed command`);
  } else {
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes);
        // readPack already keyed every object by its recomputed oid, so the
        // oid is verified; store directly instead of re-hashing each object
        // a second time in putObject (the stored !== oid check could never
        // fire: readPack's key IS the recomputed hash).
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch {
        unpackOk = false;
        unpackDetail = 'unpack error';
      }
    }
    if (!unpackOk) {
      reportLines.push(`unpack ${unpackDetail}`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack error`);
    } else {
      reportLines.push('unpack ok');
      const lookup = lookupFor(repo);
      for (const command of commands) {
        const current = ctx.store.getRef(repo, command.ref);
        if (command.newOid === ZERO_OID) {
          if (!current) {
            reportLines.push(`ng ${command.ref} ref does not exist`);
          } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
            reportLines.push(`ng ${command.ref} non-fast-forward`);
          } else {
            ctx.store.deleteRef(repo, command.ref);
            reportLines.push(`ok ${command.ref}`);
          }
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} missing object`);
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          if (current) {
            reportLines.push(`ng ${command.ref} non-fast-forward`);
          } else {
            ctx.store.setRef(repo, command.ref, command.newOid);
            reportLines.push(`ok ${command.ref}`);
          }
          continue;
        }
        if (!current || command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        if (!isAncestor(lookup, current, command.newOid)) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        ctx.store.setRef(repo, command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
    }
  }
  const inner = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
  let body: Buffer;
  if (sideband) {
    const outer: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(inner.length, offset + CHUNK))])));
    }
    outer.push(pktFlush());
    body = Buffer.concat(outer);
  } else {
    body = Buffer.concat([inner, pktFlush()]);
  }
  sendBytes(res, 200, RECEIVE_RESULT, body, ctx);
}

// --- entry point ------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns true when the path was a git
 * route and was handled (including 401/404 answers); false otherwise so
 * the main router can answer it.
 */
export async function handleGit(ctx: Ctx, req: HttpReq, res: ServerResponse): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.path);
  if (!match) return false;
  const owner = match[1];
  const repoName = match[2];
  const subpath = match[3] ?? '';
  if (subpath !== '/info/refs' && subpath !== '/git-upload-pack' && subpath !== '/git-receive-pack') return false;
  if (!isAuthenticated(req.headers, ctx)) {
    errorJson(res, 401, 'authentication required', ctx);
    return true;
  }
  if (owner !== ctx.viewer.login) {
    errorJson(res, 404, 'repository not found', ctx);
    return true;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    errorJson(res, 404, 'repository not found', ctx);
    return true;
  }
  if (req.method === 'GET' && subpath === '/info/refs') {
    const service = req.query.get('service');
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
      if (isV2) sendBytes(res, 200, UPLOAD_AD, v2Advertisement(), ctx);
      else sendBytes(res, 200, UPLOAD_AD, v0Advertisement(repo, 'git-upload-pack'), ctx);
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'), ctx);
      return true;
    }
    errorJson(res, 400, 'unknown service', ctx);
    return true;
  }
  if (req.method === 'POST' && subpath === '/git-upload-pack') {
    handleUploadPack(ctx, req, res, repo);
    return true;
  }
  if (req.method === 'POST' && subpath === '/git-receive-pack') {
    handleReceivePack(ctx, req, res, repo);
    return true;
  }
  errorJson(res, 404, 'not found', ctx);
  return true;
}

// Re-exported for other modules that need merge-base / reachability math.
export { collectReachable, findMergeBase, hashObject, parseCommit, parseTree, buildTree } from './git-core.ts';
