/**
 * The gate. Every request to the console passes through here first.
 *
 * This exists because the first deployment was publicly readable. Vercel's project-level
 * Deployment Protection reported `ssoProtection: enabled` with
 * `deploymentType: all_except_custom_domains`, and the production .vercel.app URL still
 * answered 200 to an anonymous request and served the entire lead list. Whatever the
 * cause (plan tier, or that setting not covering production aliases), the lesson is the
 * same: protection that lives outside the application is protection you cannot test from
 * inside it, and I could not even read the setting back reliably, let alone write it.
 *
 * So the gate is now code. It ships with the app, it is covered by the same build, and
 * it can be verified with curl.
 *
 * It fails CLOSED. If CONSOLE_PASSWORD is unset or empty, every request is denied rather
 * than allowed, because the failure we are guarding against is exactly a misconfiguration
 * quietly leaving the list open. A console nobody can reach is a bad afternoon; a lead
 * list anyone can read is a different kind of problem.
 */

import { NextResponse, type NextRequest } from 'next/server';

export const config = {
  // Everything, including static chunks and the favicon. The browser replays the
  // credentials on every request once it has them, so the cost of covering the lot is
  // nil and the alternative is reasoning about which paths leak what.
  matcher: '/:path*',
};

function deny(): NextResponse {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Ashby Radar", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Length-independent comparison. Not because a remote timing attack on a Vercel edge
 * function is a realistic threat here, but because the correct version is four lines and
 * there is no reason to write the incorrect one.
 */
function matches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function proxy(request: NextRequest): NextResponse {
  const expected = process.env.CONSOLE_PASSWORD;
  if (!expected) return deny();

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return deny();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return deny();
  }

  // Only the password is checked. A username on a single-operator tool is a field to
  // remember, not a second factor, so anything is accepted there.
  const password = decoded.slice(decoded.indexOf(':') + 1);
  if (!matches(password, expected)) return deny();

  return NextResponse.next();
}
