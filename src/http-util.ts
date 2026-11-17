// HTTP helpers shared by every handler: JSON replies, auth, errors, pagination.
// Erasable TypeScript only. No Date/Math.random: the request id is a counter,
// so identical request sequences produce identical headers (replay-safe).

import type { ServerResponse } from 'node:http';
import type { Ctx } from './types.ts';

export function jsonBody(res: ServerResponse, status: number, value: unknown, ctx: Ctx, extraHeaders?: Record<string, string>): void {
  // One Buffer for both the length and the write: avoids the separate
  // byteLength scan and Node's internal string-to-Buffer conversion in end().
  // Same bytes, same headers as before.
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': ctx.nextRequestId(),
    'content-length': String(body.length),
  };
  if (extraHeaders) {
    for (const [key, val] of Object.entries(extraHeaders)) headers[key.toLowerCase()] = val;
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function errorJson(res: ServerResponse, status: number, message: string, ctx: Ctx): void {
  jsonBody(res, status, { message }, ctx);
}

/** True when the request carries the trial bearer token. */
export function isAuthenticated(reqHeaders: Map<string, string>, ctx: Ctx): boolean {
  const auth = reqHeaders.get('authorization');
  if (!auth) return false;
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  return token.length > 0 && token === ctx.token;
}

/** Parse a page/per_page pair the GitHub way: defaults page 1, per_page 30. */
export function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) && perRaw >= 1 ? Math.min(perRaw, 100) : 30;
  return { page, perPage };
}

/** Slice a list into one page and build the GitHub Link header (rel="next" etc.). */
export function paginate<T>(items: readonly T[], page: number, perPage: number, basePath: string, query: URLSearchParams): { pageItems: T[]; link: string | null } {
  const total = items.length;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${basePath}?${q.toString()}>`;
  };
  if (page < lastPage) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (lastPage > 1) links.push(`${urlFor(lastPage)}; rel="last"`);
  if (page > 1) {
    links.push(`${urlFor(1)}; rel="first"`);
    links.push(`${urlFor(page - 1)}; rel="prev"`);
  }
  return { pageItems, link: links.length > 0 ? links.join(', ') : null };
}

/** A JSON object body as a record, or null when it is not an object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((entry) => typeof entry !== 'string')) return undefined;
  return value as string[];
}
