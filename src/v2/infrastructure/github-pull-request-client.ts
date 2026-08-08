export interface GitHubPullRequestLocator {
  provider: 'github';
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubPullRequestMetadata extends GitHubPullRequestLocator {
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

interface GitHubPullResponse {
  number?: unknown;
  html_url?: unknown;
  base?: {
    ref?: unknown;
    sha?: unknown;
    repo?: { full_name?: unknown };
  };
  head?: {
    ref?: unknown;
    sha?: unknown;
  };
}

const REF_PATTERN = /^[^\s~^:?*\\\[]+$/;

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestLocator {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid pull request URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only https://github.com/<owner>/<repo>/pull/<number> URLs are supported by --pr.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'pull' || !/^\d+$/.test(parts[3])) {
    throw new Error('Expected a GitHub pull request URL like https://github.com/owner/repo/pull/123.');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const number = Number(parts[3]);
  return {
    provider: 'github',
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

export function githubRepositoryFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  let pathname: string | undefined;
  const scpMatch = /^(?:[^@]+@)?github\.com:(.+)$/i.exec(trimmed);
  if (scpMatch) {
    pathname = scpMatch[1];
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.toLowerCase() !== 'github.com') return undefined;
      pathname = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) return undefined;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

function validateSha(value: unknown, field: string): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub PR metadata has an invalid ${field}.`);
  return sha;
}

function validateRef(value: unknown, field: string): string {
  const ref = String(value ?? '').trim();
  if (ref === '' || !REF_PATTERN.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new Error(`GitHub PR metadata has an invalid ${field}.`);
  }
  return ref;
}

export interface GitHubPullRequestClientOptions {
  fetchImpl?: typeof fetch;
  token?: string;
}

export class GitHubPullRequestClient {
  constructor(private readonly options: GitHubPullRequestClientOptions = {}) {}

  async resolve(value: string): Promise<GitHubPullRequestMetadata> {
    const locator = parseGitHubPullRequestUrl(value);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const token = this.options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codegraph-pr-review',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repo)}/pulls/${locator.number}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
      const authHint = response.status === 401 || response.status === 403 || response.status === 404
        ? ' Set GH_TOKEN or GITHUB_TOKEN when reviewing a private repository.'
        : '';
      throw new Error(`GitHub PR lookup failed (${response.status} ${response.statusText}): ${detail}.${authHint}`);
    }
    const payload = await response.json() as GitHubPullResponse;
    const fullName = String(payload.base?.repo?.full_name ?? '').toLowerCase();
    if (fullName !== `${locator.owner}/${locator.repo}`.toLowerCase()) {
      throw new Error('GitHub PR metadata does not match the repository in the supplied URL.');
    }
    return {
      ...locator,
      baseRef: validateRef(payload.base?.ref, 'base ref'),
      baseSha: validateSha(payload.base?.sha, 'base SHA'),
      headRef: validateRef(payload.head?.ref, 'head ref'),
      headSha: validateSha(payload.head?.sha, 'head SHA'),
    };
  }
}

export async function resolveGitHubPullRequest(
  value: string,
  options: GitHubPullRequestClientOptions = {},
): Promise<GitHubPullRequestMetadata> {
  return new GitHubPullRequestClient(options).resolve(value);
}
