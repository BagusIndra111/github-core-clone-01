// Shared types for the github-core-clone-01 forge.
// Every module imports from here. No imports (avoids cycles).
// Erasable TypeScript only: interfaces + type annotations, no enums.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
}

/** The request context every handler receives. Built by main.ts. */
export interface Ctx {
  store: Store;
  viewer: Viewer;
  stranger: Viewer;
  token: string;
  nowIso: string;
  nowEpoch: number;
  nextRequestId: () => string;
}

/** One parsed HTTP request (body already read by main.ts). */
export interface HttpReq {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  /** Parsed JSON body, or undefined when the body is empty. Throws on malformed JSON. */
  json: unknown;
  /** True when the body was present but not valid JSON. */
  malformedJson: boolean;
}

/** The store: domain logic + git object/ref storage. Implemented in store.ts. */
export interface Store {
  readonly viewer: Viewer;
  readonly stranger: Viewer;
  readonly nowIso: string;
  readonly nowEpoch: number;

  createRepo(name: string, opts: { private: boolean; description: string }): Repo;
  getRepo(owner: string, name: string): Repo | undefined;
  listRepos(owner: string): Repo[];
  deleteRepo(owner: string, name: string): boolean;

  getObject(repo: Repo, oid: string): GitObject | undefined;
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string;
  hasObject(repo: Repo, oid: string): boolean;
  getRef(repo: Repo, refname: string): string | undefined;
  setRef(repo: Repo, refname: string, oid: string): void;
  deleteRef(repo: Repo, refname: string): void;
  listRefs(repo: Repo): { name: string; oid: string }[];

  createLabel(repo: Repo, name: string, color: string): Label;
  getLabel(repo: Repo, name: string): Label | undefined;

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue;
  getIssue(repo: Repo, number: number): Issue | undefined;
  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[];
  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined;
  addComment(repo: Repo, issueNumber: number, body: string): Comment | undefined;
  listComments(repo: Repo, issueNumber: number): Comment[];

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull;
  getPull(repo: Repo, number: number): Pull | undefined;
  listPulls(repo: Repo, state: string): Pull[];
  /** Squash-merge. Returns the merge commit sha, or an error kind. */
  mergePull(repo: Repo, number: number): { ok: true; sha: string } | { ok: false; error: 'not-found' | 'conflict' | 'already-merged' | 'no-head' };
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[];

  /** Resolve a GraphQL global id (R_<id>, I_<repoId>_<n>, PR_<repoId>_<n>). */
  findByGlobalId(id: string): { kind: 'repo' | 'issue' | 'pull'; repo: Repo; issue?: Issue; pull?: Pull } | undefined;
  globalIdForRepo(repo: Repo): string;
  globalIdForIssue(repo: Repo, issue: Issue): string;
  globalIdForPull(repo: Repo, pull: Pull): string;

  repoJson(repo: Repo, baseUrl: string): Record<string, unknown>;
  issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown>;
  pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown>;
  commentJson(comment: Comment, baseUrl: string): Record<string, unknown>;
  labelJson(label: Label): Record<string, unknown>;
}
