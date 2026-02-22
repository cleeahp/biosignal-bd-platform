/**
 * GET /api/test-linkedin
 *
 * Test-only endpoint: attempts a LinkedIn login and reports success/failure.
 * NEVER returns or logs credentials — only reports whether env vars are present
 * and whether a session cookie (li_at) was obtained.
 *
 * Response shape:
 *   { success: boolean, method: string|null, error: string|null,
 *     credentials_present: { email: boolean, password: boolean } }
 */

import { LinkedInClient } from '../../lib/linkedinClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }

  const hasEmail    = !!process.env.LINKEDIN_EMAIL;
  const hasPassword = !!process.env.LINKEDIN_PASSWORD;

  const credentialsPresent = { email: hasEmail, password: hasPassword };

  if (!hasEmail || !hasPassword) {
    const missing = [
      !hasEmail    && 'LINKEDIN_EMAIL',
      !hasPassword && 'LINKEDIN_PASSWORD',
    ].filter(Boolean).join(', ');

    return res.status(200).json({
      success:             false,
      method:              null,
      error:               `Credentials not configured: ${missing} missing. ` +
                           'Add them in Vercel dashboard → Settings → Environment Variables.',
      credentials_present: credentialsPresent,
    });
  }

  try {
    const client = new LinkedInClient();
    const ok     = await client.login();

    if (ok) {
      return res.status(200).json({
        success:             true,
        method:              client.lastLoginMethod,
        error:               null,
        credentials_present: credentialsPresent,
      });
    }

    return res.status(200).json({
      success:             false,
      method:              null,
      error:               'Login failed — li_at session cookie not received. ' +
                           'Check Vercel function logs for detailed diagnostics. ' +
                           'LinkedIn may require manual verification of the account.',
      credentials_present: credentialsPresent,
    });
  } catch (err) {
    return res.status(200).json({
      success:             false,
      method:              null,
      error:               err.message,
      credentials_present: credentialsPresent,
    });
  }
}
