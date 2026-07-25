import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from './app/lib/auth';

// Runs on every request (Edge runtime) — keep this dependency-free and fast.
// Static assets are excluded via the matcher below; everything else needs a
// valid session except the handful of paths listed explicitly.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // Always open: the login page itself, and the endpoints that create/destroy
  // the session (a session cookie obviously can't gate the request that sets it).
  if (pathname === '/login' || pathname === '/api/login' || pathname === '/api/logout') {
    return NextResponse.next();
  }

  // The podcast generator's self-callback (app/api/analyze/route.ts) is called
  // server-to-server — either our own process hitting 127.0.0.1, or Upstash
  // QStash if QSTASH_TOKEN is ever set — neither carries a browser session
  // cookie, so this one specific path+query combination must stay reachable
  // without one. The trigger call (no isCallback param) still requires a session.
  if (pathname === '/api/analyze' && searchParams.get('isCallback') === 'true') {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.AUTH_SECRET || '';
  const session = token && secret ? await verifySessionToken(token, secret) : null;

  if (session) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('from', pathname);
  return NextResponse.redirect(loginUrl);
}
