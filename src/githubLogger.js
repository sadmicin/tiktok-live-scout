function encodeBase64Utf8(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN');
  }

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
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body;
}

async function getExistingFileSha(repo, path, branch) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}?ref=${encodeURIComponent(branch)}`;

  try {
    const file = await githubRequest(url);
    return file.sha;
  } catch (error) {
    if (String(error.message).includes('GitHub API 404')) {
      return null;
    }
    throw error;
  }
}

export async function commitJsonToGitHub(path, data, message) {
  const repo = process.env.GITHUB_REPO || 'sadmicin/tiktok-live-scout';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    console.log('ℹ️ GITHUB_TOKEN not set; skipping GitHub log commit');
    return null;
  }

  const content = JSON.stringify(data, null, 2);
  const sha = await getExistingFileSha(repo, path, branch);

  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`;

  const result = await githubRequest(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(content),
      branch,
      ...(sha ? { sha } : {})
    })
  });

  return result?.commit?.sha || null;
}
