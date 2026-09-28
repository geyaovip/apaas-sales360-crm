import 'dotenv/config';
import { PrismaClient } from './generated/client';
import { hash } from 'bcryptjs';

async function main() {
  const email = process.env.CRM_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.CRM_BOOTSTRAP_PASSWORD;
  if (!email || !password || password === 'set-a-strong-local-password' || password.length < 12) throw new Error('Set CRM_BOOTSTRAP_EMAIL and a strong CRM_BOOTSTRAP_PASSWORD (12+ characters) in .env');
  const db = new PrismaClient();
  try {
    const tenant = await db.tenant.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', name: '默认工作区' } });
    let org = await db.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null, name: '总部' } });
    if (!org) org = await db.orgUnit.create({ data: { tenantId: tenant.id, name: '总部' } });
    const existing = await db.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
    if (existing) {
      console.log('Admin already exists; no password changed.');
      return;
    }
    const user = await db.user.create({ data: { tenantId: tenant.id, email, name: '系统管理员', passwordHash: await hash(password, 12), memberships: { create: { tenantId: tenant.id, orgUnitId: org.id, role: 'admin' } } } });
    console.log(`Created admin ${user.email} in workspace default.`);
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
