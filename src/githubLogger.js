function encodeBase64Utf8(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN');

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }

  return body;
}

function getLogBranch() {
  return process.env.GITHUB_LOG_BRANCH || process.env.GITHUB_BRANCH || 'main';
}

async function getExistingFileSha(repo, path, branch) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F','/')}?ref=${branch}`;

  try {
    const file = await githubRequest(url);
    return file.sha;
  } catch (e) {
    if (String(e.message).includes('404')) return null;
    throw e;
  }
}

async function commitFile(path, content, message, alreadyBase64 = false) {
  const repo = process.env.GITHUB_REPO || 'sadmicin/tiktok-live-scout';
  const branch = getLogBranch();

  if (!process.env.GITHUB_TOKEN) {
    console.log('Skipping GitHub commit - no token');
    return null;
  }

  const sha = await getExistingFileSha(repo, path, branch);

  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F','/')}`;

  return githubRequest(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: alreadyBase64 ? content : encodeBase64Utf8(content),
      branch,
      ...(sha ? { sha } : {})
    })
  });
}

export async function commitJsonToGitHub(path, data, message) {
  return commitFile(
    path,
    JSON.stringify(data, null, 2),
    message
  );
}

export async function commitImageToGitHub(path, base64, message) {
  return commitFile(
    path,
    base64,
    message,
    true
  );
}
