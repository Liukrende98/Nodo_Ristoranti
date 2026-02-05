import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/db';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('refresh_token')?.value;

  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } }).catch(() => {});
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete('access_token');
  response.cookies.delete('refresh_token');
  return response;
}
