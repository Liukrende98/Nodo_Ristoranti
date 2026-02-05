import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import prisma from './db';

// ─── Types ───────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

// ─── Config ──────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

// ─── Password ────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── JWT ─────────────────────────────────────────────────

export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function generateRefreshToken(payload: { userId: string }): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
  });
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): { userId: string } | null {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET) as { userId: string };
  } catch {
    return null;
  }
}

// ─── Auth Context from Request ───────────────────────────

export async function getAuthFromRequest(req: NextRequest): Promise<AuthContext | null> {
  // Try Authorization header first
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return verifyAccessToken(token);
  }

  // Try cookie
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;
  if (token) {
    return verifyAccessToken(token);
  }

  return null;
}

// ─── Auth Middleware (for API routes) ────────────────────

type RoleRequirement = string | string[];

export function withAuth(
  handler: (req: NextRequest, ctx: AuthContext) => Promise<NextResponse>,
  requiredRoles?: RoleRequirement
) {
  return async (req: NextRequest, routeCtx?: any) => {
    const auth = await getAuthFromRequest(req);

    if (!auth) {
      return NextResponse.json({ error: 'Non autenticato' }, { status: 401 });
    }

    // Check role
    if (requiredRoles) {
      const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
      if (!roles.includes(auth.role)) {
        return NextResponse.json({ error: 'Permessi insufficienti' }, { status: 403 });
      }
    }

    // Check tenant is active
    const tenant = await prisma.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { isActive: true },
    });

    if (!tenant?.isActive) {
      return NextResponse.json({ error: 'Tenant disattivato' }, { status: 403 });
    }

    return handler(req, auth);
  };
}

// ─── RBAC Permissions ────────────────────────────────────

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 50,
  admin: 40,
  manager: 30,
  staff: 20,
  delivery: 10,
};

export function hasMinRole(userRole: string, minRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[minRole] ?? 100);
}

const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  admin: ['orders.*', 'tasks.*', 'stations.*', 'menu.*', 'inventory.*', 'workflows.*', 'users.read', 'users.create', 'analytics.*', 'delivery.*', 'shifts.*'],
  manager: ['orders.*', 'tasks.*', 'stations.read', 'menu.read', 'inventory.read', 'inventory.adjust', 'analytics.read', 'delivery.*', 'shifts.read'],
  staff: ['orders.read', 'tasks.read', 'tasks.update', 'stations.read'],
  delivery: ['orders.read', 'delivery.read', 'delivery.update'],
};

export function hasPermission(role: string, permission: string): boolean {
  const perms = ROLE_PERMISSIONS[role] || [];
  if (perms.includes('*')) return true;

  const [resource, action] = permission.split('.');
  return perms.includes(permission) || perms.includes(`${resource}.*`);
}

// ─── Audit Logging ───────────────────────────────────────

export async function auditLog(
  tenantId: string,
  userId: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: any,
  ipAddress?: string
) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action,
        entityType,
        entityId,
        details: details ?? undefined,
        ipAddress,
      },
    });
  } catch (error) {
    // Audit log failure should not break operations
    console.error('Audit log failed:', error);
  }
}
