import { verifyToken } from '../lib/auth.js';
import { json, error, options } from '../lib/response.js';

const FILES = {
  cr: 'data/change-requests.json',
  versions: 'data/versions.json',
};

async function fetchGitHubFile(env, path) {
  const repo = env.GITHUB_REPO || 'JackYu1981/worldcup';
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'User-Agent': 'worldmoney-pages',
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );
  if (!resp.ok) return { data: null, sha: null };
  const file = await resp.json();
  const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  return { data, sha: file.sha };
}

export async function onRequestGet(context) {
  const user = await verifyToken(context.request, context.env);
  if (!user) return error('未登录', 401);

  const url = new URL(context.request.url);
  const type = url.searchParams.get('type');

  if (type === 'versions') {
    const { data } = await fetchGitHubFile(context.env, FILES.versions);
    return json({ versions: data ? (data.versions || []) : [] });
  }

  const { data, sha } = await fetchGitHubFile(context.env, FILES.cr);
  const versions = await fetchGitHubFile(context.env, FILES.versions);
  return json({
    requests: data ? (data.requests || []) : [],
    sha,
    versions: versions.data ? (versions.data.versions || []) : [],
  });
}

export function onRequestOptions() {
  return options();
}
