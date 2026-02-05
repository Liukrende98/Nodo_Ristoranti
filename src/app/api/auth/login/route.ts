import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  auditLog,
} from '@/lib/auth';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Simple in-memory rate limiter (use Redis in production)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const attempts = loginAttempts.get(key);

  if (!attempts || attempts.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (attempts.count >= MAX_ATTEMPTS) return false;
  attempts.count++;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Email e password richiesti' },
        { status: 400 }
      );
    }

    const { email, password } = parsed.data;

    // Rate limiting by email
    if (!checkRateLimit(email.toLowerCase())) {
      return NextResponse.json(
        { error: 'Troppi tentativi. Riprova tra 15 minuti.' },
        { status: 429 }
      );
    }

    // Find user (search across tenants by email - tenant isolation at query level)
    const user = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        isActive: true,
      },
      include: {
        tenant: {
          select: { id: true, name: true, slug: true, isActive: true, settings: true },
        },
      },
    });

    if (!user || !user.tenant.isActive) {
      return NextResponse.json(
        { error: 'Credenziali non valide' },
        { status: 401 }
      );
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      return NextResponse.json(
        { error: 'Credenziali non valide' },
        { status: 401 }
      );
    }

    // Generate tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    });

    const refreshTokenValue = generateRefreshToken({ userId: user.id });

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshTokenValue,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Audit log
    await auditLog(
      user.tenantId,
      user.id,
      'user.login',
      'user',
      user.id,
      { email: user.email },
      req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || undefined
    );

    // Set refresh token as httpOnly cookie
    const response = NextResponse.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name,
          slug: user.tenant.slug,
          settings: user.tenant.settings,
        },
      },
    });

    response.cookies.set('refresh_token', refreshTokenValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/',
    });

    response.cookies.set('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60, // 15 minutes
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Errore interno del server' },
      { status: 500 }
    );
  }
}
