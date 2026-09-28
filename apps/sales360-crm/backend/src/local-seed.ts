import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from 'bcryptjs';
import { PrismaClient } from './generated/client';

const accounts = [
  { name: '线索运营', email: 'local-marketing@local.test', role: 'marketing' },
  { name: '销售主管', email: 'local-manager@local.test', role: 'manager' },
  { name: '销售', email: 'local-sales@local.test', role: 'sales' },
  { name: '客户成功', email: 'local-csm@local.test', role: 'csm' },
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Local review accounts are allowed only with a local development database.');
  }
  const accessFile = resolve(process.cwd(), '../review-access.txt');
  const legacyFile = resolve(process.cwd(), '../demo-access.txt');
  const old = existsSync(accessFile) ? readFileSync(accessFile, 'utf8') : existsSync(legacyFile) ? readFileSync(legacyFile, 'utf8') : '';
  const password = old.match(/^password: (.+)$/m)?.[1] ?? randomBytes(15).toString('base64url');
  const db = new PrismaClient();
  try {
    const tenant = await db.tenant.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', name: '默认工作区' } });
    let org = await db.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null, name: '总部' } });
    if (!org) org = await db.orgUnit.create({ data: { tenantId: tenant.id, name: '总部' } });
    const passwordHash = await hash(password, 12);
    for (const account of accounts) {
      const legacyEmail = account.email.replace('local-', 'demo-');
      const existing = await db.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: account.email } } });
      if (!existing) { const legacy = await db.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: legacyEmail } } }); if (legacy) await db.user.update({ where: { id: legacy.id }, data: { email: account.email } }); }
      const user = await db.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: account.email } },
        create: { tenantId: tenant.id, name: account.name, email: account.email, passwordHash },
        update: { name: account.name, passwordHash, active: true },
      });
      await db.membership.upsert({
        where: { tenantId_userId_orgUnitId_role: { tenantId: tenant.id, userId: user.id, orgUnitId: org.id, role: account.role } },
        create: { tenantId: tenant.id, userId: user.id, orgUnitId: org.id, role: account.role },
        update: {},
      });
    }
    writeFileSync(accessFile, `Sales 360 本地验收账号\nworkspace: default\npassword: ${password}\n${accounts.map(a => `${a.role}: ${a.email}`).join('\n')}\n`, { mode: 0o600 });
    chmodSync(accessFile, 0o600);
    if (existsSync(legacyFile)) unlinkSync(legacyFile);
    console.log(`Sales 360: ${accounts.length} local review accounts ready; credentials saved to review-access.txt.`);
  } finally { await db.$disconnect(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
