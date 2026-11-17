// Git object model + wire primitives for the github-core-clone-01 forge.
// Erasable TypeScript only. Node stdlib only (node:crypto, node:zlib).
// No wall-clock, no randomness, no git binary. Deterministic output:
// pack objects are sorted by oid, tree entries use git sort order.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType } from './types.ts';

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0` + data (two updates: no copy of the data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}

/** Build a commit object body. Author/committer are "Name <email>". */
export function buildCommit(o: { tree: string; parents: string[]; author: string; committer: string; timestamp: number; message: string }): Buffer {
  const lines: string[] = [`tree ${o.tree}`];
  for (const parent of o.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${o.author} ${o.timestamp} +0000`);
  lines.push(`committer ${o.committer} ${o.timestamp} +0000`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

/** Compare two tree entry names the git way: directories compare as name + '/'. */
function compareTreeNames(aMode: string, aName: string, bMode: string, bName: string): number {
  const aKey = aMode === '40000' ? `${aName}/` : aName;
  const bKey = bMode === '40000' ? `${bName}/` : bName;
  return Buffer.compare(Buffer.from(aKey, 'utf8'), Buffer.from(bKey, 'utf8'));
}

/** Build a tree object body, sorting entries in git tree order. */
export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => compareTreeNames(a.mode, a.name, b.mode, b.name));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build an annotated tag object body. */
export function buildTag(o: { object: string; type: string; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const lines: string[] = [
    `object ${o.object}`,
    `type ${o.type}`,
    `tag ${o.tag}`,
    `tagger ${o.tagger} ${o.timestamp} +0000`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

/** Parse a commit object body. Author/committer keep their full header value. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse a tree object body, returning entries in stored order. */
export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Parse an annotated tag object body. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/**
 * All objects reachable from the tips (including the tips themselves).
 * Missing objects are skipped, never thrown: the server must stay up
 * when a client names an oid it does not hold.
 */
export function collectReachable(tips: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    if (isOid(tip)) stack.push(tip);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag oid (recursively) to its non-tag target, or the oid itself. */
function peelToNonTag(lookup: (oid: string) => GitObject | undefined, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = lookup(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
}

/** True when ancestor equals descendant or is reachable from it via parents. */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, descendant: string): boolean {
  const target = peelToNonTag(lookup, ancestor);
  let start = peelToNonTag(lookup, descendant);
  if (target === start) return true;
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === target) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A merge base of a and b: the first common ancestor found by BFS from b. */
export function findMergeBase(lookup: (oid: string) => GitObject | undefined, a: string, b: string): string | undefined {
  const aAncestors = new Set<string>();
  const aQueue: string[] = [peelToNonTag(lookup, a)];
  while (aQueue.length > 0) {
    const oid = aQueue.shift() as string;
    if (aAncestors.has(oid)) continue;
    aAncestors.add(oid);
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) aQueue.push(parent);
    }
  }
  const seen = new Set<string>();
  const bQueue: string[] = [peelToNonTag(lookup, b)];
  while (bQueue.length > 0) {
    const oid = bQueue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAncestors.has(oid)) return oid;
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) bQueue.push(parent);
    }
  }
  return undefined;
}

// --- packfiles ---------------------------------------------------------------

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Packfile v2, full objects only (no deltas), objects sorted by oid. */
export function writePack(objects: { oid: string; type: GitObjectType; data: Buffer }[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    // Level 1: these packs are small (a clone fetch carries 3 objects, ~1 KiB
    // total); level 1 halves the deflate cost of the 1 KiB blob vs the
    // default level 6, and the output is still a valid, deterministic,
    // compressed packfile (same object order, same ids).
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readDeltaVarint(delta: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= delta.length) throw new Error('delta size varint is truncated');
    const byte = delta[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new Error('delta size varint is too long');
  }
  return { value, next: pos };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaVarint(delta, 0);
  const target = readDeltaVarint(delta, source.next);
  if (source.value !== base.length) throw new Error(`delta expects a ${source.value}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  let offset = target.next;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > target.value) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset: number | null;
  baseOid: string | null;
}

/**
 * Parse a packfile (v2/v3), resolve OFS + REF deltas, verify the trailer.
 * Returns the resolved objects keyed by recomputed oid. Throws on a bad
 * trailer, a truncated/corrupt pack, or an unresolvable delta base.
 */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error(`pack trailer ${trailer} does not match its bytes ${computed}`);
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry has no size header');
    const first = buf[offset];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    let byte = first;
    while (byte & 0x80) {
      if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
      byte = buf[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (typeCode === 6) {
      if (offset >= buf.length) throw new Error('ofs-delta has no base offset');
      byte = buf[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
        byte = buf[offset++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (value <= 0 || baseOffset < 0) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`);
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!(typeCode in CODE_TYPES)) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    let inflated: Buffer;
    try {
      const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      const written = result.engine.bytesWritten;
      if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
      inflated = result.buffer;
      offset += written;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('zlib stream')) throw err;
      throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
    }
    if (inflated.length !== size) throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.length}`);
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: inflated, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  // Resolve deltas iteratively: plain entries first, then deltas whose base
  // is already resolved. No progress over a full pass means a cycle or a
  // base that is neither in the pack nor supplied (this server never
  // accepts thin packs from outside, so a missing base is an error).
  const resolved = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const pending = new Set<number>(raw.map((entry) => entry.offset));
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const entryOffset of [...pending]) {
      const entry = byOffset.get(entryOffset) as RawPackEntry;
      if (entry.typeCode !== 6 && entry.typeCode !== 7) {
        const type = CODE_TYPES[entry.typeCode];
        const oid = hashObject(type, entry.data);
        resolved.set(oid, { type, data: entry.data });
        resolvedByOffset.set(entryOffset, { type, data: entry.data, oid });
        pending.delete(entryOffset);
        progress = true;
        continue;
      }
      let base: { type: GitObjectType; data: Buffer; oid: string } | undefined;
      if (entry.typeCode === 6) {
        base = resolvedByOffset.get(entry.baseOffset as number);
      } else {
        for (const candidate of resolvedByOffset.values()) {
          if (candidate.oid === entry.baseOid) { base = candidate; break; }
        }
      }
      if (!base) continue;
      const data = applyDelta(base.data, entry.data);
      const oid = hashObject(base.type, data);
      resolved.set(oid, { type: base.type, data });
      resolvedByOffset.set(entryOffset, { type: base.type, data, oid });
      pending.delete(entryOffset);
      progress = true;
    }
  }
  if (pending.size > 0) {
    const stuck = byOffset.get([...pending][0] as number) as RawPackEntry;
    if (stuck.typeCode === 6) throw new Error(`ofs-delta base at offset ${stuck.baseOffset} is not in the pack`);
    throw new Error(`ref-delta base ${stuck.baseOid} is neither in the pack nor supplied by the client`);
  }
  return resolved;
}

// --- pkt-lines ---------------------------------------------------------------

/** Encode one pkt-line (string or bytes). Throws when the payload is too long. */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > 65516) throw new Error('pkt-line payload exceeds 65516 bytes');
  const out = Buffer.allocUnsafe(payload.length + 4);
  out.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}

/** The flush packet `0000` (shared: callers only concat it, never mutate it). */
const PKT_FLUSH = Buffer.from('0000', 'ascii');
export function pktFlush(): Buffer {
  return PKT_FLUSH;
}

/** Encode a delim packet `0001` (shared: callers only concat it, never mutate it). */
const PKT_DELIM = Buffer.from('0001', 'ascii');
export function pktDelim(): Buffer {
  return PKT_DELIM;
}

/** Encode a response-end packet `0002` (shared: callers only concat it, never mutate it). */
const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');
export function pktResponseEnd(): Buffer {
  return PKT_RESPONSE_END;
}

export interface PktLinePacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole pkt-line stream. Throws on a bad header or truncation. */
export function parsePktLines(buf: Buffer): PktLinePacket[] {
  const packets: PktLinePacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > 65520) throw new Error(`pkt-line length ${length} exceeds 65520`);
    if (offset + length > buf.length) throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// --- trees from file lists ---------------------------------------------------

/** Build nested trees + blobs from a flat file list. Modes 100644 / 40000. */
export function treeFromFiles(files: { path: string; data: Buffer }[]): { rootOid: string; objects: Map<string, GitObject> } {
  const objects = new Map<string, GitObject>();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  function buildDir(entries: { path: string; data: Buffer }[]): string {
    const treeEntries: { mode: string; name: string; oid: string }[] = [];
    const groups = new Map<string, { path: string; data: Buffer }[]>();
    const order: string[] = [];
    for (const file of entries) {
      const slash = file.path.indexOf('/');
      if (slash < 0) {
        const oid = hashObject('blob', file.data);
        objects.set(oid, { type: 'blob', data: file.data });
        treeEntries.push({ mode: '100644', name: file.path, oid });
      } else {
        const dir = file.path.slice(0, slash);
        const rest = { path: file.path.slice(slash + 1), data: file.data };
        if (!groups.has(dir)) { groups.set(dir, []); order.push(dir); }
        (groups.get(dir) as { path: string; data: Buffer }[]).push(rest);
      }
    }
    for (const dir of order) {
      const oid = buildDir(groups.get(dir) as { path: string; data: Buffer }[]);
      treeEntries.push({ mode: '40000', name: dir, oid });
    }
    const data = buildTree(treeEntries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return { rootOid: buildDir(sorted), objects };
}

/** All files in a tree, recursively: path -> { oid, mode }. */
export function flattenTree(lookup: (oid: string) => GitObject | undefined, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  function walk(oid: string, prefix: string): void {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  }
  walk(treeOid, '');
  return out;
}

/**
 * Build nested trees from a flat file map. Every tree is rebuilt from its
 * entries, which yields the same oid as a reused tree whenever the subtree
 * is unchanged (hashing is content-addressed), so reuse is automatic.
 */
export function buildTreeFromMap(files: Map<string, { oid: string; mode: string }>, lookup: (oid: string) => GitObject | undefined): { rootOid: string; objects: Map<string, GitObject> } {
  void lookup;
  const objects = new Map<string, GitObject>();
  const sortedPaths = [...files.keys()].sort();
  function buildDir(paths: string[], prefix: string): string {
    const treeEntries: { mode: string; name: string; oid: string }[] = [];
    const groups = new Map<string, string[]>();
    const order: string[] = [];
    for (const path of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        const entry = files.get(prefix + path) as { oid: string; mode: string };
        treeEntries.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        const dir = path.slice(0, slash);
        if (!groups.has(dir)) { groups.set(dir, []); order.push(dir); }
        (groups.get(dir) as string[]).push(path.slice(slash + 1));
      }
    }
    for (const dir of order) {
      const oid = buildDir(groups.get(dir) as string[], `${prefix}${dir}/`);
      treeEntries.push({ mode: '40000', name: dir, oid });
    }
    const data = buildTree(treeEntries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return { rootOid: buildDir(sortedPaths, ''), objects };
}
