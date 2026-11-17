// In-memory store for the github-core-clone-01 forge.
// Implements the Store interface from types.ts exactly. All timestamps come
// from the trial clock (nowIso / nowEpoch) passed to createStore; nothing
// here reads the wall clock or randomness.
//
// Git objects are built with git-core.ts (the sibling module), whose
// signatures are (verified against entry/src/git-core.ts):
//   hashObject(type, data) -> oid
//   buildCommit({ tree, parents, author, committer, timestamp, message })
//     author / committer are "Name <email>"; buildCommit appends
//     " <timestamp> +0000" to each.
//   parseCommit(data) -> { tree, parents, author, committer, message }
//   findMergeBase(lookup, a, b) -> merge-base commit oid | undefined
//   flattenTree(lookup, treeOid) -> Map<path, { oid, mode }>
//   buildTreeFromMap(files, lookup) -> { rootOid, objects }
//     (the returned objects must be stored into the repo by the caller)

import { buildCommit, buildTreeFromMap, findMergeBase, flattenTree, hashObject, parseCommit } from './git-core.ts';
import type { Comment, GitObject, GitObjectType, Issue, Label, Pull, Repo, Store, Viewer } from './types.ts';

type FileMap = Map<string, { oid: string; mode: string }>;

/** Lines in a blob: newline count, plus one for a non-empty last line without a trailing newline. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') count += 1;
  }
  if (text[text.length - 1] !== '\n') count += 1;
  return count;
}

export function createStore(viewer: Viewer, stranger: Viewer, nowIso: string, nowEpoch: number): Store {
  const repos = new Map<string, Repo>();
  let nextRepoId = 1;
  const identity = `${viewer.name} <${viewer.email}>`;

  function lookupFor(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string): GitObject | undefined => repo.objects.get(oid);
  }

  function commitTreeOid(repo: Repo, commitSha: string): string | undefined {
    const obj = repo.objects.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  function blobText(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'blob') return '';
    return obj.data.toString('utf8');
  }

  function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  function storeObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  function treeFiles(repo: Repo, treeOid: string | undefined): FileMap {
    if (treeOid === undefined) return new Map<string, { oid: string; mode: string }>();
    return flattenTree(lookupFor(repo), treeOid);
  }

  function createRepo(name: string, opts: { private: boolean; description: string }): Repo {
    const key = `${viewer.login}/${name}`;
    const existing = repos.get(key);
    if (existing !== undefined) return existing;
    const repo: Repo = {
      id: nextRepoId,
      owner: viewer.login,
      name,
      fullName: `${viewer.login}/${name}`,
      description: opts.description,
      private: opts.private,
      defaultBranch: 'main',
      createdAt: nowIso,
      updatedAt: nowIso,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    nextRepoId += 1;
    repos.set(key, repo);
    return repo;
  }

  function getRepo(owner: string, name: string): Repo | undefined {
    return repos.get(`${owner}/${name}`);
  }

  function listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  function deleteRepo(owner: string, name: string): boolean {
    return repos.delete(`${owner}/${name}`);
  }

  function getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  function hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  function getRef(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  function setRef(repo: Repo, refname: string, oid: string): void {
    repo.refs.set(refname, oid);
  }

  function deleteRef(repo: Repo, refname: string): void {
    repo.refs.delete(refname);
  }

  function listRefs(repo: Repo): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    return out;
  }

  function createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  function getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: `I_${repo.id}_${number}`,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: nowIso,
      updatedAt: nowIso,
      closedAt: null,
      seq: number,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  function getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((candidate) => candidate.number === number);
  }

  function listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[] {
    const state = opts.state ?? 'open';
    const filtered = repo.issues.filter((issue) => {
      if (state === 'all') return true;
      if (state === 'closed') return issue.state === 'closed';
      return issue.state === 'open';
    });
    const direction = opts.direction ?? 'desc';
    const sorted = [...filtered];
    if (opts.sort === 'created') {
      sorted.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    } else {
      sorted.sort((a, b) => b.seq - a.seq);
    }
    return sorted;
  }

  function patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined {
    const issue = getIssue(repo, number);
    if (issue === undefined) return undefined;
    if (patch.state === 'closed') {
      issue.state = 'closed';
      issue.closedAt = nowIso;
    } else if (patch.state === 'open') {
      issue.state = 'open';
      issue.closedAt = null;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = nowIso;
    return issue;
  }

  function addComment(repo: Repo, issueNumber: number, body: string): Comment | undefined {
    const issue = getIssue(repo, issueNumber);
    if (issue === undefined) return undefined;
    const comment: Comment = { id: repo.nextCommentId, body, createdAt: nowIso };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  function listComments(repo: Repo, issueNumber: number): Comment[] {
    const issue = getIssue(repo, issueNumber);
    if (issue === undefined) return [];
    return [...issue.comments];
  }

  function createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: `PR_${repo.id}_${number}`,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: head, sha: repo.refs.get(`refs/heads/${head}`) ?? '' },
      base: { ref: base, sha: repo.refs.get(`refs/heads/${base}`) ?? '' },
      createdAt: nowIso,
      updatedAt: nowIso,
      seq: number,
    };
    repo.pulls.push(pull);
    return pull;
  }

  function getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((candidate) => candidate.number === number);
  }

  function listPulls(repo: Repo, state: string): Pull[] {
    const wanted = state === '' ? 'open' : state;
    const filtered = repo.pulls.filter((pull) => {
      if (wanted === 'all') return true;
      if (wanted === 'closed') return pull.state === 'closed';
      return pull.state === 'open';
    });
    return [...filtered].sort((a, b) => a.seq - b.seq);
  }

  function mergePull(repo: Repo, number: number): { ok: true; sha: string } | { ok: false; error: 'not-found' | 'conflict' | 'already-merged' | 'no-head' } {
    const pull = getPull(repo, number);
    if (pull === undefined) return { ok: false, error: 'not-found' };
    if (pull.merged || pull.state === 'closed') return { ok: false, error: 'already-merged' };
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    if (headTip === '' || baseTip === '') return { ok: false, error: 'no-head' };
    const headObj = repo.objects.get(headTip);
    const baseObj = repo.objects.get(baseTip);
    if (headObj === undefined || headObj.type !== 'commit' || baseObj === undefined || baseObj.type !== 'commit') {
      return { ok: false, error: 'no-head' };
    }
    const lookup = lookupFor(repo);
    const mergeBase = findMergeBase(lookup, headTip, baseTip);
    const baseTree = mergeBase === undefined ? undefined : commitTreeOid(repo, mergeBase);
    const headTree = commitTreeOid(repo, headTip);
    const tipTree = commitTreeOid(repo, baseTip);
    if (headTree === undefined || tipTree === undefined) return { ok: false, error: 'no-head' };
    const baseFiles = treeFiles(repo, baseTree);
    const headFiles = treeFiles(repo, headTree);
    const tipFiles = treeFiles(repo, tipTree);
    const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of allPaths) {
      const baseOid = baseFiles.get(path)?.oid;
      const headOid = headFiles.get(path)?.oid;
      const tipOid = tipFiles.get(path)?.oid;
      if (headOid !== baseOid && tipOid !== baseOid && headOid !== tipOid) {
        return { ok: false, error: 'conflict' };
      }
    }
    const merged = new Map<string, { oid: string; mode: string }>(tipFiles);
    for (const path of allPaths) {
      const baseOid = baseFiles.get(path)?.oid;
      const headEntry = headFiles.get(path);
      if (headEntry?.oid !== baseOid) {
        if (headEntry === undefined) merged.delete(path);
        else merged.set(path, { oid: headEntry.oid, mode: headEntry.mode });
      }
    }
    const built = buildTreeFromMap(merged, lookup);
    storeObjects(repo, built.objects);
    const message = `${pull.title} (#${pull.number})\n`;
    const commitData = buildCommit({ tree: built.rootOid, parents: [baseTip], author: identity, committer: identity, timestamp: nowEpoch, message });
    const sha = putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = nowIso;
    return { ok: true, sha };
  }

  function pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    if (headTip === '' || baseTip === '') return [];
    const lookup = lookupFor(repo);
    const mergeBase = findMergeBase(lookup, headTip, baseTip);
    const baseTree = mergeBase === undefined ? undefined : commitTreeOid(repo, mergeBase);
    const headTree = commitTreeOid(repo, headTip);
    if (headTree === undefined) return [];
    const baseFiles = treeFiles(repo, baseTree);
    const headFiles = treeFiles(repo, headTree);
    const paths = [...new Set<string>([...baseFiles.keys(), ...headFiles.keys()])].sort();
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const path of paths) {
      const baseEntry = baseFiles.get(path);
      const headEntry = headFiles.get(path);
      if (baseEntry?.oid === headEntry?.oid) continue;
      if (baseEntry === undefined && headEntry !== undefined) {
        const additions = countLines(blobText(repo, headEntry.oid));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (headEntry === undefined && baseEntry !== undefined) {
        const deletions = countLines(blobText(repo, baseEntry.oid));
        out.push({ filename: path, status: 'deleted', additions: 0, deletions, changes: deletions });
      } else if (baseEntry !== undefined && headEntry !== undefined) {
        const additions = countLines(blobText(repo, headEntry.oid));
        const deletions = countLines(blobText(repo, baseEntry.oid));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  function findByGlobalId(id: string): { kind: 'repo' | 'issue' | 'pull'; repo: Repo; issue?: Issue; pull?: Pull } | undefined {
    if (id.startsWith('R_')) {
      const repoId = Number(id.slice(2));
      for (const repo of repos.values()) {
        if (repo.id === repoId) return { kind: 'repo', repo };
      }
      return undefined;
    }
    if (id.startsWith('PR_')) {
      const parts = id.slice(3).split('_');
      if (parts.length !== 2) return undefined;
      const repoId = Number(parts[0]);
      const number = Number(parts[1]);
      for (const repo of repos.values()) {
        if (repo.id !== repoId) continue;
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull !== undefined) return { kind: 'pull', repo, pull };
      }
      return undefined;
    }
    if (id.startsWith('I_')) {
      const parts = id.slice(2).split('_');
      if (parts.length !== 2) return undefined;
      const repoId = Number(parts[0]);
      const number = Number(parts[1]);
      for (const repo of repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (issue !== undefined) return { kind: 'issue', repo, issue };
      }
      return undefined;
    }
    return undefined;
  }

  function globalIdForRepo(repo: Repo): string {
    return `R_${repo.id}`;
  }

  function globalIdForIssue(repo: Repo, issue: Issue): string {
    return `I_${repo.id}_${issue.number}`;
  }

  function globalIdForPull(repo: Repo, pull: Pull): string {
    return `PR_${repo.id}_${pull.number}`;
  }

  function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
    const url = `${baseUrl}/repos/${repo.fullName}`;
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      html_url: `${baseUrl}/${repo.fullName}`,
      url,
      clone_url: `${baseUrl}/${repo.fullName}.git`,
      git_url: `${baseUrl}/${repo.fullName}.git`,
    };
  }

  function issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
    const url = `${baseUrl}/repos/${repo.fullName}/issues/${issue.number}`;
    return {
      id: globalIdForIssue(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return label !== undefined ? labelJson(label) : { name, color: '' };
      }),
      user: { login: viewer.login },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      comments: issue.comments.length,
      url,
      html_url: url,
      comments_url: `${url}/comments`,
    };
  }

  function pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
    const url = `${baseUrl}/repos/${repo.fullName}/pulls/${pull.number}`;
    return {
      id: globalIdForPull(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      closed_at: pull.state === 'closed' ? (pull.mergedAt ?? pull.updatedAt) : null,
      head: { ref: pull.head.ref, sha: pull.head.sha },
      base: { ref: pull.base.ref, sha: pull.base.sha },
      user: { login: viewer.login },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      url,
      html_url: url,
    };
  }

  function commentJson(comment: Comment, baseUrl: string): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      user: { login: viewer.login },
      url: `${baseUrl}/comments/${comment.id}`,
    };
  }

  function labelJson(label: Label): Record<string, unknown> {
    return { name: label.name, color: label.color };
  }

  const store: Store = {
    viewer,
    stranger,
    nowIso,
    nowEpoch,
    createRepo,
    getRepo,
    listRepos,
    deleteRepo,
    getObject,
    putObject,
    hasObject,
    getRef,
    setRef,
    deleteRef,
    listRefs,
    createLabel,
    getLabel,
    createIssue,
    getIssue,
    listIssues,
    patchIssue,
    addComment,
    listComments,
    createPull,
    getPull,
    listPulls,
    mergePull,
    pullFiles,
    findByGlobalId,
    globalIdForRepo,
    globalIdForIssue,
    globalIdForPull,
    repoJson,
    issueJson,
    pullJson,
    commentJson,
    labelJson,
  };
  return store;
}
