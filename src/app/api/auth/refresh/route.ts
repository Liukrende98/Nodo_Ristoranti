import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/db';
import { verifyRefreshToken, generateAccessToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get('refresh_token')?.value;

    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token mancante' }, { status: 401 });
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return NextResponse.json({ error: 'Refresh token non valido' }, { status: 401 });
    }

    // Verify token exists in DB and not expired
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: {
        user: {
          include: { tenant: { select: { isActive: true } } },
        },
      },
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      if (storedToken) {
        await prisma.refreshToken.delete({ where: { id: storedToken.id } });
      }
      return NextResponse.json({ error: 'Sessione scaduta' }, { status: 401 });
    }

    if (!storedToken.user.isActive || !storedToken.user.tenant.isActive) {
      return NextResponse.json({ error: 'Account disattivato' }, { status: 403 });
    }

    const accessToken = generateAccessToken({
      userId: storedToken.user.id,
      tenantId: storedToken.user.tenantId,
      role: storedToken.user.role,
      email: storedToken.user.email,
    });

    const response = NextResponse.json({ accessToken });

    response.cookies.set('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Refresh error:', error);
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
  }
}
