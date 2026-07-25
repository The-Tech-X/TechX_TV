import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from '../../lib/auth';

export const runtime = 'nodejs';

// Simple in-memory rate limit — single Render instance, no need for a shared
// store. Resets on deploy/restart, which is fine for slowing down guessing,
// not for airtight abuse prevention.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

    if (tooManyAttempts(ip)) {
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
    }

    const { email, password } = await req.json();

    const authEmail = process.env.AUTH_EMAIL || '';
    const authHashB64 = process.env.AUTH_PASSWORD_HASH_B64 || '';
    const authSecret = process.env.AUTH_SECRET || '';

    if (!authEmail || !authHashB64 || !authSecret) {
      console.error('[Login] AUTH_EMAIL / AUTH_PASSWORD_HASH_B64 / AUTH_SECRET not configured');
      return NextResponse.json({ error: 'Login is not configured on the server' }, { status: 500 });
    }

    const emailOk = typeof email === 'string' && email.trim().toLowerCase() === authEmail.toLowerCase();
    // Always run bcrypt.compare, even when the email is already wrong, so a
    // mismatched email doesn't short-circuit into a faster response than a
    // mismatched password — avoids timing leaking which one failed.
    const authHash = Buffer.from(authHashB64, 'base64').toString('utf8');
    const passwordOk = typeof password === 'string' && await bcrypt.compare(password, authHash);

    if (!emailOk || !passwordOk) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    const token = await createSessionToken(authEmail, authSecret);
    const res = NextResponse.json({ success: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return res;
  } catch (e: any) {
    console.error('[Login] Error:', e);
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
