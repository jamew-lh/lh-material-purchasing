import { handler, json, readBody, signToken, safeEqual, HttpError } from '../lib/core.mjs';

export default handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const { password } = await readBody(req);
  const admin = process.env.ADMIN_PASSWORD;
  const viewer = process.env.VIEWER_PASSWORD;
  if (!admin) throw new HttpError(500, 'ADMIN_PASSWORD is not set in Netlify environment variables');

  let role = null;
  if (password && safeEqual(password, admin)) role = 'admin';
  else if (password && viewer && safeEqual(password, viewer)) role = 'viewer';

  if (!role) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    throw new HttpError(401, 'Incorrect password');
  }
  return json({ token: signToken(role), role });
});

export const config = { path: '/api/login' };
