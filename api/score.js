// GET /api/score?fid=12345
// Looks up a Farcaster user's Neynar quality score.

export default async function handler(req, res) {
  const { fid } = req.query;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
      {
        headers: {
          'accept': 'application/json',
          'x-api-key': process.env.NEYNAR_API_KEY
        }
      }
    );

    if (!response.ok) {
      throw new Error('Neynar lookup failed');
    }

    const data = await response.json();
    const user = data.users && data.users[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found', score: 0 });
    }

    // Neynar exposes this as experimental.neynar_user_score on v2 bulk user endpoint
    const score = user.experimental?.neynar_user_score ?? user.score ?? 0;

    return res.status(200).json({ score, fid: Number(fid) });

  } catch (err) {
    console.error('score.js error:', err);
    return res.status(500).json({ error: 'Failed to fetch score', score: 0 });
  }
}
