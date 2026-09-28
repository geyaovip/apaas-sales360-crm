import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AppError, AuthRequest, hash, parse, SessionGuard, text } from './common';
import { compare, hash as hashPassword } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Response } from 'express';
import { z } from 'zod';

const loginSchema = z.object({ workspace: text(1, 80).default('default'), email: z.string().trim().email().max(255), password: z.string().min(1) });
const sessionMs = 7 * 24 * 60 * 60 * 1000;

@Controller('api/v1')
export class AuthController {
  constructor(private db: PrismaService) {}

  @Post('auth/login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    const tenant = await this.db.tenant.findUnique({ where: { slug: input.workspace } });
    const user = tenant ? await this.db.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: input.email.toLowerCase() } }, include: { memberships: true } }) : null;
    if (!user || !user.active || !(await compare(input.password, user.passwordHash))) throw new AppError('INVALID_CREDENTIALS', '邮箱或密码错误', 401);
    const token = randomBytes(32).toString('base64url');
    await this.db.session.create({ data: { tenantId: tenant!.id, userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + sessionMs) } });
    res.cookie('crm_session', token, { httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'strict', path: '/', maxAge: sessionMs });
    return { user: { id: user.id, name: user.name, email: user.email, roles: user.memberships.map(m => m.role) }, tenant: { id: tenant!.id, name: tenant!.name, slug: tenant!.slug } };
  }

  @UseGuards(SessionGuard)
  @Post('auth/logout')
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.db.session.deleteMany({ where: { tenantId: req.actor.tenantId, tokenHash: hash(req.cookies.crm_session) } });
    res.clearCookie('crm_session', { path: '/' });
    return { ok: true };
  }

  @UseGuards(SessionGuard)
  @Post('auth/password')
  async changePassword(@Req() req: AuthRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ current_password: z.string().min(1), new_password: z.string().min(12).max(200) }), body);
    const user = await this.db.user.findFirstOrThrow({ where: { id: req.actor.id, tenantId: req.actor.tenantId } });
    if (!(await compare(input.current_password, user.passwordHash))) throw new AppError('INVALID_CREDENTIALS', '当前密码错误', 401);
    if (input.current_password === input.new_password) throw new AppError('VALIDATION_ERROR', '新密码不能与当前密码相同', 400);
    await this.db.$transaction([
      this.db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.new_password, 12) } }),
      this.db.session.deleteMany({ where: { userId: user.id, tenantId: req.actor.tenantId } }),
    ]);
    res.clearCookie('crm_session', { path: '/' });
    return { ok: true };
  }

  @UseGuards(SessionGuard)
  @Get('me')
  async me(@Req() req: AuthRequest) {
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: req.actor.tenantId } });
    return { user: { id: req.actor.id, name: req.actor.name, email: req.actor.email, memberships: req.actor.memberships }, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } };
  }

  @UseGuards(SessionGuard)
  @Get('org-units')
  orgUnits(@Req() req: AuthRequest) { return this.db.orgUnit.findMany({ where: { tenantId: req.actor.tenantId }, orderBy: { name: 'asc' } }); }

  @UseGuards(SessionGuard)
  @Get('users')
  async users(@Req() req: AuthRequest) {
    const users = await this.db.user.findMany({ where: { tenantId: req.actor.tenantId, active: true }, select: { id: true, name: true, memberships: { select: { role: true, orgUnitId: true } } }, orderBy: { name: 'asc' } });
    return users;
  }
}
