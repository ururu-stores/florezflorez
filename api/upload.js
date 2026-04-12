module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verify GitHub token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }
  const token = authHeader.replace('Bearer ', '');

  // Verify the token is valid and has repo access
  const userRes = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': 'token ' + token },
  });
  if (!userRes.ok) {
    res.status(401).json({ error: 'Invalid GitHub token' });
    return;
  }

  const { filename, content } = req.body;
  if (!filename || !content) {
    res.status(400).json({ error: 'Missing filename or content' });
    return;
  }

  // Sanitize filename
  const safeName = filename.replace(/[^a-z0-9._\-]/gi, '-');
  const path = 'uploads/' + safeName;

  const repo = 'taoofdre/florezflorez';
  const branch = 'main';

  try {
    // Check if file already exists (need its SHA to update)
    let sha = null;
    const existsRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
      { headers: { 'Authorization': 'token ' + token } }
    );
    if (existsRes.ok) {
      const existsData = await existsRes.json();
      sha = existsData.sha;
    }

    // Create or update the file
    const body = {
      message: 'Upload image: ' + safeName,
      content: content,
      branch: branch,
    };
    if (sha) body.sha = sha;

    const createRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      res.status(500).json({ error: err.message || 'GitHub API error' });
      return;
    }

    res.status(200).json({ path: '/' + path, filename: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
