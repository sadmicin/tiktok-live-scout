export async function commitJsonToGitHub(path, data, message) {
  console.log('ℹ️ GitHub runtime log commits are disabled to prevent Railway redeploy loops');
  console.log(`ℹ️ Would have written: ${path}`);
  return null;
}
