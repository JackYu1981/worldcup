import { verifyToken } from '../lib/auth.js';
import { json, error, options } from '../lib/response.js';

const VERSIONS_FILE = 'data/versions.json';
const KV_CR = 'cr:requests';
const KV_CURRENT_VERSION = 'cr:current_version';

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
  const kv = context.env.MATCH_DATA;

  if (type === 'versions') {
    const { data } = await fetchGitHubFile(context.env, VERSIONS_FILE);
    return json({ versions: data ? (data.versions || []) : [] });
  }

  const crData = await kv.get(KV_CR, 'json');
  const currentVersion = await kv.get(KV_CURRENT_VERSION, 'json');
  const versionsFile = await fetchGitHubFile(context.env, VERSIONS_FILE);

  return json({
    requests: crData ? (crData.requests || []) : [],
    current_version: currentVersion || null,
    versions: versionsFile.data ? (versionsFile.data.versions || []) : [],
  });
}

export function onRequestOptions() {
  return options();
}
