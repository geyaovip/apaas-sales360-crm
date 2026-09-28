import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { z, ZodSchema } from 'zod';
import { PrismaService } from './prisma.service';

export type Role = 'admin' | 'marketing' | 'manager' | 'sales' | 'csm';
export interface Actor {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  memberships: { role: string; orgUnitId: string }[];
}
export interface AuthRequest extends Request {
  actor: Actor;
  requestId: string;
}

export class AppError extends HttpException {
  constructor(public code: string, message: string, status: number, public details: Record<string, unknown> = {}) {
    super(message, status);
  }
}

export function bad(code: string, message: string, status = HttpStatus.UNPROCESSABLE_ENTITY): never {
  throw new AppError(code, message, status);
}
export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', '提交内容有误，请检查表单', 400, { fields: result.error.flatten().fieldErrors });
  }
  return result.data;
}
export function hasRole(actor: Actor, ...roles: Role[]) { return actor.memberships.some(m => roles.includes(m.role as Role)); }
export function requireRole(actor: Actor, ...roles: Role[]) {
  if (!hasRole(actor, ...roles)) bad('FORBIDDEN', '没有执行此操作的权限', 403);
}
export function normalizedName(name: string) { return name.trim().replace(/\s+/g, '').toLocaleLowerCase(); }
export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export const uuid = z.string().uuid();
export const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) });
export const text = (min = 1, max = 255) => z.string().trim().min(min).max(max);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private db: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = request.cookies?.crm_session;
    if (!token || typeof token !== 'string') bad('UNAUTHENTICATED', '请先登录', 401);
    const session = await this.db.session.findUnique({ where: { tokenHash: hash(token) }, include: { user: { include: { memberships: true } } } });
    if (!session || session.expiresAt <= new Date() || !session.user.active) bad('UNAUTHENTICATED', '登录已失效，请重新登录', 401);
    request.actor = {
      id: session.user.id, tenantId: session.tenantId, name: session.user.name, email: session.user.email,
      memberships: session.user.memberships.filter(m => m.tenantId === session.tenantId).map(m => ({ role: m.role, orgUnitId: m.orgUnitId })),
    };
    return true;
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<AuthRequest>();
    const requestId = request.requestId || randomUUID();
    if (error instanceof AppError) {
      response.status(error.getStatus()).json({ error: { code: error.code, message: error.message, request_id: requestId, details: error.details } });
      return;
    }
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json({ error: { code: 'HTTP_ERROR', message: error.message, request_id: requestId, details: {} } });
      return;
    }
    const maybe = error as { code?: string };
    if (maybe?.code === 'P2025') {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: '记录不存在或已被删除', request_id: requestId, details: {} } });
      return;
    }
    if (maybe?.code === 'P2002') {
      response.status(409).json({ error: { code: 'DUPLICATE', message: '记录已存在，请刷新后重试', request_id: requestId, details: {} } });
      return;
    }
    console.error(`[${requestId}]`, error instanceof Error ? error.stack : 'Unknown error');
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试', request_id: requestId, details: {} } });
  }
}
