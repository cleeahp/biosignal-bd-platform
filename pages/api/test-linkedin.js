/**
 * GET /api/test-linkedin
 *
 * Test-only endpoint: checks whether the LINKEDIN_LI_AT cookie is present
 * and valid by making a single authenticated request to /feed/.
 * NEVER returns or logs the cookie value — only reports presence and validity.
 *
 * Response shape:
 *   { success: boolean, cookie_present: boolean, cookie_valid: boolean,
 *     error: string|null }
 */

import { LinkedInClient } from '../../lib/linkedinClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }

  const cookiePresent = !!process.env.LINKEDIN_LI_AT;

  if (!cookiePresent) {
    return res.status(200).json({
      success:        false,
      cookie_present: false,
      cookie_valid:   false,
      error:          'LINKEDIN_LI_AT not configured. ' +
                      'Add it in Vercel dashboard → Settings → Environment Variables. ' +
                      'See LINKEDIN_SETUP.md for instructions on extracting your li_at cookie.',
    });
  }

  try {
    const client = new LinkedInClient(process.env.LINKEDIN_LI_AT);
    const resp   = await client.get('https://www.linkedin.com/feed/');

    if (!resp) {
      return res.status(200).json({
        success:        false,
        cookie_present: true,
        cookie_valid:   false,
        error:          'Request to linkedin.com/feed/ failed — see Vercel function logs.',
      });
    }

    const finalUrl   = resp.url || '';
    const cookieValid = resp.ok && !/authwall|login/i.test(finalUrl);

    return res.status(200).json({
      success:        cookieValid,
      cookie_present: true,
      cookie_valid:   cookieValid,
      error:          cookieValid
        ? null
        : `Cookie expired or invalid — redirected to: ${finalUrl}. ` +
          'Extract a fresh li_at cookie from Chrome DevTools and update the Vercel env var.',
    });
  } catch (err) {
    return res.status(200).json({
      success:        false,
      cookie_present: true,
      cookie_valid:   false,
      error:          err.message,
    });
  }
}
