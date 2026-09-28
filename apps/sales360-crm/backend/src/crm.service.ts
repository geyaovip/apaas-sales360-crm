import { Injectable } from '@nestjs/common';
import { Prisma, Lead, Customer, Opportunity } from './generated/client';
import { z } from 'zod';
import { Actor, AppError, bad, hasRole, normalizedName, pageSchema, parse, requireRole, text, uuid, hash } from './common';
import { PrismaService } from './prisma.service';

const leadCreateSchema = z.object({
  name: text(1, 200), contact_name: text(1, 100).optional(), contact_phone: text(1, 40).optional(),
  contact_email: z.string().email().max(255).optional(), source: text(1, 80), notes: z.string().max(5000).optional(),
  org_unit_id: uuid, duplicate_confirmed: z.boolean().default(false),
});
const leadUpdateSchema = leadCreateSchema.pick({ name: true, contact_name: true, contact_phone: true, contact_email: true, source: true, notes: true }).partial().extend({ version: z.number().int().positive() });
const reasonSchema = z.object({ reason: text(2, 1000), version: z.number().int().positive() });
const versionSchema = z.object({ version: z.number().int().positive() });
const customerSchema = z.object({ name: text(1, 200), registration_id: text(1, 80).optional(), industry: text(1, 100).optional(), region: text(1, 100).optional(), owner_id: uuid, org_unit_id: uuid });
const contactSchema = z.object({ name: text(1, 100), title: text(1, 100).optional(), phone: text(1, 40).optional(), email: z.string().email().optional(), preferred_contact: z.enum(['phone', 'email', 'other']).optional() });
const opportunitySchema = z.object({ customer_id: uuid, name: text(1, 200), owner_id: uuid, org_unit_id: uuid, amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/).default('0'), currency: z.string().length(3).default('CNY'), probability: z.number().int().min(0).max(100).default(10), expected_close_at: z.string().datetime().optional(), next_action: z.string().max(500).optional(), next_action_at: z.string().datetime().optional() });
const followUpSchema = z.object({ target_type: z.enum(['lead', 'customer', 'opportunity']), target_id: uuid, type: z.enum(['call', 'meeting', 'message', 'visit', 'other']), content: text(1, 5000), occurred_at: z.string().datetime().optional(), next_at: z.string().datetime().optional() });

@Injectable()
export class CrmService {
  constructor(private db: PrismaService) {}

  private async orgScope(actor: Actor): Promise<string[]> {
    if (hasRole(actor, 'admin', 'marketing')) return [];
    const roots = actor.memberships.filter(m => m.role === 'manager').map(m => m.orgUnitId);
    if (!roots.length) return [];
    const orgs = await this.db.orgUnit.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, parentId: true } });
    const ids = new Set(roots);
    let changed = true;
    while (changed) { changed = false; for (const org of orgs) if (org.parentId && ids.has(org.parentId) && !ids.has(org.id)) { ids.add(org.id); changed = true; } }
    return [...ids];
  }
  private async leadWhere(actor: Actor): Promise<Prisma.LeadWhereInput> {
    const base: Prisma.LeadWhereInput = { tenantId: actor.tenantId, deletedAt: null };
    if (hasRole(actor, 'admin', 'marketing')) return base;
    const orgs = await this.orgScope(actor);
    return { ...base, OR: [{ ownerId: actor.id }, ...(orgs.length ? [{ orgUnitId: { in: orgs } }] : [])] };
  }
  private async customerWhere(actor: Actor): Promise<Prisma.CustomerWhereInput> {
    const base: Prisma.CustomerWhereInput = { tenantId: actor.tenantId, deletedAt: null };
    if (hasRole(actor, 'admin')) return base;
    const orgs = await this.orgScope(actor);
    return { ...base, OR: [{ ownerId: actor.id }, { serviceOwnerId: actor.id }, ...(orgs.length ? [{ orgUnitId: { in: orgs } }] : [])] };
  }
  private async opportunityWhere(actor: Actor): Promise<Prisma.OpportunityWhereInput> {
    const base: Prisma.OpportunityWhereInput = { tenantId: actor.tenantId, deletedAt: null };
    if (hasRole(actor, 'admin')) return base;
    const orgs = await this.orgScope(actor);
    return { ...base, OR: [{ ownerId: actor.id }, { customer: { serviceOwnerId: actor.id } }, { participants: { some: { userId: actor.id } } }, ...(orgs.length ? [{ orgUnitId: { in: orgs } }] : [])] };
  }
  private async lead(actor: Actor, id: string) {
    const lead = await this.db.lead.findFirst({ where: { ...(await this.leadWhere(actor)), id } });
    if (!lead) bad('NOT_FOUND', '线索不存在或无权查看', 404);
    return lead;
  }
  private async customer(actor: Actor, id: string) {
    const item = await this.db.customer.findFirst({ where: { ...(await this.customerWhere(actor)), id } });
    if (!item) bad('NOT_FOUND', '客户不存在或无权查看', 404);
    return item;
  }
  private async opportunity(actor: Actor, id: string) {
    const item = await this.db.opportunity.findFirst({ where: { ...(await this.opportunityWhere(actor)), id } });
    if (!item) bad('NOT_FOUND', '商机不存在或无权查看', 404);
    return item;
  }
  private async ensureLeadEditor(actor: Actor, lead: Lead) {
    if (hasRole(actor, 'admin', 'marketing')) return;
    if (lead.ownerId === actor.id) return;
    if ((await this.orgScope(actor)).includes(lead.orgUnitId)) return;
    bad('FORBIDDEN', '没有修改该线索的权限', 403);
  }
  private async ensureUser(tenantId: string, userId: string) {
    const user = await this.db.user.findFirst({ where: { id: userId, tenantId, active: true } });
    if (!user) bad('ASSIGNEE_NOT_FOUND', '指定成员不存在或已停用');
    return user;
  }
  private async ensureOrg(tenantId: string, orgId: string) {
    const org = await this.db.orgUnit.findFirst({ where: { id: orgId, tenantId } });
    if (!org) bad('ORG_NOT_FOUND', '组织不存在');
    return org;
  }
  private audit(tx: Prisma.TransactionClient, actor: Actor, action: string, resourceType: string, resourceId: string, before: Record<string, unknown> = {}, after: Record<string, unknown> = {}) {
    return tx.auditLog.create({ data: { tenantId: actor.tenantId, actorId: actor.id, action, resourceType, resourceId, before: before as Prisma.InputJsonObject, after: after as Prisma.InputJsonObject } });
  }
  private task(tx: Prisma.TransactionClient, actor: Actor, assigneeId: string, title: string, targetType: string, targetId: string, dueAt?: Date) {
    return tx.task.create({ data: { tenantId: actor.tenantId, assigneeId, title, targetType, targetId, dueAt } });
  }
  private outbox(tx: Prisma.TransactionClient, actor: Actor, eventType: string, targetId: string, version: number, payload: Record<string, unknown>) {
    return tx.outboxEvent.create({ data: { tenantId: actor.tenantId, eventType, dedupeKey: `${eventType}:${targetId}:${version}`, payload: payload as Prisma.InputJsonObject } });
  }
  private conflict(): never { return bad('VERSION_CONFLICT', '记录已被修改，请刷新后重试', 409); }
  private state(lead: Lead, allowed: string[]) { if (!allowed.includes(lead.status)) bad('LEAD_STATE_CONFLICT', `当前线索状态不允许此操作：${lead.status}`, 409); }

  async listLeads(actor: Actor, query: Record<string, unknown>) {
    const q = parse(pageSchema.extend({ scope: z.enum(['all', 'mine', 'unassigned', 'team', 'processed']).default('all'), status: z.string().optional(), source: z.string().optional(), owner_id: z.string().optional(), q: z.string().optional() }), query);
    const where: Prisma.LeadWhereInput = { ...(await this.leadWhere(actor)), ...(q.status ? { status: q.status } : {}), ...(q.source ? { source: q.source } : {}) };
    if (q.scope === 'mine') where.ownerId = actor.id;
    if (q.scope === 'unassigned') where.ownerId = null;
    if (q.scope === 'processed') where.firstProcessedAt = { not: null };
    if (q.scope === 'team') { const orgs = await this.orgScope(actor); where.orgUnitId = { in: orgs }; }
    if (q.owner_id) where.ownerId = q.owner_id;
    if (q.q) where.AND = [{ OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { contactName: { contains: q.q, mode: 'insensitive' } }] }];
    const [items, total] = await this.db.$transaction([
      this.db.lead.findMany({ where, orderBy: { createdAt: 'desc' }, skip: ((q.page ?? 1) - 1) * (q.page_size ?? 20), take: q.page_size ?? 20, select: { id: true, name: true, source: true, status: true, ownerId: true, orgUnitId: true, contactName: true, version: true, createdAt: true, updatedAt: true, firstProcessedAt: true } }),
      this.db.lead.count({ where }),
    ]);
    return { items, total, page: q.page, page_size: q.page_size };
  }

  async createLead(actor: Actor, body: unknown) {
    requireRole(actor, 'admin', 'marketing', 'manager');
    const input = parse(leadCreateSchema, body);
    await this.ensureOrg(actor.tenantId, input.org_unit_id);
    const duplicate = await this.db.lead.findFirst({ where: { tenantId: actor.tenantId, deletedAt: null, OR: [
      { name: { equals: input.name, mode: 'insensitive' } },
      ...(input.contact_phone ? [{ contactPhone: input.contact_phone }] : []), ...(input.contact_email ? [{ contactEmail: input.contact_email }] : []),
    ] } });
    if (duplicate && !input.duplicate_confirmed) throw new AppError('DUPLICATE_CANDIDATE', '发现可能重复的线索，请确认后再创建', 409, { candidate_id: duplicate.id });
    return this.db.$transaction(async tx => {
      const lead = await tx.lead.create({ data: { tenantId: actor.tenantId, name: input.name, contactName: input.contact_name, contactPhone: input.contact_phone, contactEmail: input.contact_email, source: input.source, notes: input.notes, orgUnitId: input.org_unit_id, createdById: actor.id, duplicateConfirmed: input.duplicate_confirmed } });
      await this.audit(tx, actor, 'lead.created', 'lead', lead.id, {}, { status: lead.status, source: lead.source });
      return lead;
    });
  }
  async getLead(actor: Actor, id: string) { return this.lead(actor, id); }
  async leadDuplicates(actor: Actor, id: string) {
    const lead = await this.lead(actor, id);
    const conditions: Prisma.LeadWhereInput[] = [];
    if (lead.contactPhone) conditions.push({ contactPhone: lead.contactPhone });
    if (lead.contactEmail) conditions.push({ contactEmail: lead.contactEmail });
    if (!conditions.length) return [];
    return this.db.lead.findMany({ where: { ...(await this.leadWhere(actor)), id: { not: id }, OR: conditions }, select: { id: true, name: true, status: true, ownerId: true }, take: 10 });
  }
  async leadTimeline(actor: Actor, id: string) {
    await this.lead(actor, id);
    const [audits, assignments, followups] = await Promise.all([
      this.db.auditLog.findMany({ where: { tenantId: actor.tenantId, resourceType: 'lead', resourceId: id }, orderBy: { createdAt: 'desc' } }),
      this.db.leadAssignment.findMany({ where: { tenantId: actor.tenantId, leadId: id }, orderBy: { createdAt: 'desc' } }),
      this.db.followUp.findMany({ where: { tenantId: actor.tenantId, targetType: 'lead', targetId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    return [...audits.map(a => ({ id: a.id, kind: 'audit', action: a.action, actorId: a.actorId, data: a.after, createdAt: a.createdAt })), ...assignments.map(a => ({ id: a.id, kind: 'assignment', action: a.strategy, actorId: a.actorId, data: { toUserId: a.toUserId, reason: a.reason }, createdAt: a.createdAt })), ...followups.map(f => ({ id: f.id, kind: 'follow_up', action: f.type, actorId: f.authorId, data: { content: f.content, nextAt: f.nextAt }, createdAt: f.createdAt }))].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async updateLead(actor: Actor, id: string, body: unknown) {
    const input = parse(leadUpdateSchema, body); const lead = await this.lead(actor, id); await this.ensureLeadEditor(actor, lead);
    if (['converted', 'invalid'].includes(lead.status)) this.state(lead, ['new', 'assigned', 'working', 'returned', 'qualified']);
    return this.db.$transaction(async tx => {
      const updated = await tx.lead.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version }, data: { ...(input.name ? { name: input.name } : {}), ...(input.contact_name !== undefined ? { contactName: input.contact_name } : {}), ...(input.contact_phone !== undefined ? { contactPhone: input.contact_phone } : {}), ...(input.contact_email !== undefined ? { contactEmail: input.contact_email } : {}), ...(input.source ? { source: input.source } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}), version: { increment: 1 } } });
      if (!updated.count) this.conflict();
      await this.audit(tx, actor, 'lead.updated', 'lead', id, { version: lead.version }, { version: lead.version + 1 });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  async assignLead(actor: Actor, id: string, body: unknown, strategy = 'manual') {
    requireRole(actor, 'admin', 'marketing', 'manager');
    const input = parse(z.object({ assignee_id: uuid, reason: z.string().max(1000).optional(), version: z.number().int().positive() }), body);
    const lead = await this.lead(actor, id); this.state(lead, ['new', 'returned', 'assigned']);
    const user = await this.ensureUser(actor.tenantId, input.assignee_id);
    const member = await this.db.membership.findFirst({ where: { tenantId: actor.tenantId, userId: user.id, orgUnitId: lead.orgUnitId, role: 'sales' } });
    if (!member) bad('ASSIGNEE_ROLE', '被分配人必须是该组织的销售');
    return this.db.$transaction(async tx => {
      const updated = await tx.lead.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version, status: { in: ['new', 'returned', 'assigned'] } }, data: { ownerId: user.id, status: 'assigned', assignedAt: lead.assignedAt || new Date(), version: { increment: 1 } } });
      if (!updated.count) this.conflict();
      await tx.leadAssignment.create({ data: { tenantId: actor.tenantId, leadId: id, fromUserId: lead.ownerId, toUserId: user.id, reason: input.reason, strategy, actorId: actor.id } });
      await this.audit(tx, actor, 'lead.assigned', 'lead', id, { ownerId: lead.ownerId }, { ownerId: user.id, status: 'assigned' });
      await this.task(tx, actor, user.id, `处理线索：${lead.name}`, 'lead', id);
      await this.outbox(tx, actor, 'lead.assigned', id, lead.version + 1, { leadId: id, assigneeId: user.id });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  private async changeLeadStatus(actor: Actor, id: string, body: unknown, allowed: string[], next: string, action: string, reasonRequired = false) {
    const input = parse(reasonRequired ? reasonSchema : versionSchema, body) as { version: number; reason?: string };
    const lead = await this.lead(actor, id); await this.ensureLeadEditor(actor, lead); this.state(lead, allowed);
    return this.db.$transaction(async tx => {
      const result = await tx.lead.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version, status: { in: allowed } }, data: { status: next, version: { increment: 1 }, ...(['working', 'returned', 'invalid', 'qualified'].includes(next) && !lead.firstProcessedAt ? { firstProcessedAt: new Date() } : {}) } });
      if (!result.count) this.conflict();
      await this.audit(tx, actor, action, 'lead', id, { status: lead.status }, { status: next, reason: input.reason });
      if (next === 'returned') await this.task(tx, actor, lead.createdById, `重新分配线索：${lead.name}`, 'lead', id);
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }
  acceptLead(actor: Actor, id: string, body: unknown) { return this.changeLeadStatus(actor, id, body, ['assigned'], 'working', 'lead.accepted'); }
  returnLead(actor: Actor, id: string, body: unknown) { return this.changeLeadStatus(actor, id, body, ['assigned', 'working'], 'returned', 'lead.returned', true); }
  invalidateLead(actor: Actor, id: string, body: unknown) { return this.changeLeadStatus(actor, id, body, ['new', 'assigned', 'working'], 'invalid', 'lead.invalidated', true); }
  qualifyLead(actor: Actor, id: string, body: unknown) { return this.changeLeadStatus(actor, id, body, ['working'], 'qualified', 'lead.qualified'); }

  async requestConversion(actor: Actor, id: string, body: unknown) {
    const input = parse(versionSchema, body); const lead = await this.lead(actor, id); await this.ensureLeadEditor(actor, lead); this.state(lead, ['qualified']);
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
    if (!tenant.approvalRequired) return { approval_required: false, lead };
    return this.db.$transaction(async tx => {
      const result = await tx.lead.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version, status: 'qualified' }, data: { status: 'conversion_pending', version: { increment: 1 } } });
      if (!result.count) this.conflict();
      const request = await tx.conversionRequest.create({ data: { tenantId: actor.tenantId, leadId: id, requestedBy: actor.id } });
      await this.audit(tx, actor, 'lead.conversion_requested', 'lead', id, { status: 'qualified' }, { status: 'conversion_pending', requestId: request.id });
      const manager = await tx.membership.findFirst({ where: { tenantId: actor.tenantId, orgUnitId: lead.orgUnitId, role: 'manager' } });
      if (manager) await this.task(tx, actor, manager.userId, `审核线索转化：${lead.name}`, 'lead', id);
      return { approval_required: true, request_id: request.id, lead: await tx.lead.findUniqueOrThrow({ where: { id } }) };
    });
  }
  async reviewConversion(actor: Actor, id: string, body: unknown) {
    requireRole(actor, 'admin', 'manager');
    const input = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(1000).optional(), version: z.number().int().positive() }), body);
    if (input.decision === 'reject' && !input.reason?.trim()) bad('REASON_REQUIRED', '拒绝时必须填写原因');
    const lead = await this.lead(actor, id); this.state(lead, ['conversion_pending']);
    return this.db.$transaction(async tx => {
      const pending = await tx.conversionRequest.findFirst({ where: { tenantId: actor.tenantId, leadId: id, status: 'pending' }, orderBy: { createdAt: 'desc' } });
      if (!pending) this.conflict();
      const next = input.decision === 'approve' ? 'conversion_approved' : 'qualified';
      const result = await tx.lead.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version, status: 'conversion_pending' }, data: { status: next, version: { increment: 1 } } });
      if (!result.count) this.conflict();
      await tx.conversionRequest.update({ where: { id: pending.id }, data: { status: input.decision === 'approve' ? 'approved' : 'rejected', reason: input.reason, reviewedBy: actor.id, reviewedAt: new Date() } });
      await this.audit(tx, actor, `lead.conversion_${input.decision}`, 'lead', id, { status: 'conversion_pending' }, { status: next, reason: input.reason });
      await this.task(tx, actor, pending.requestedBy, `线索转化${input.decision === 'approve' ? '已通过' : '已拒绝'}：${lead.name}`, 'lead', id);
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  async convertLead(actor: Actor, id: string, body: unknown, key: string | undefined) {
    if (!key || key.length > 120) bad('IDEMPOTENCY_KEY_REQUIRED', '缺少有效的幂等键', 400);
    const input = parse(z.object({ customer_id: uuid.nullable().optional(), create_opportunity: z.boolean().default(false), opportunity_name: text(1, 200).optional() }), body);
    if (input.create_opportunity && !input.opportunity_name) bad('OPPORTUNITY_NAME_REQUIRED', '请填写商机名称');
    const requestHash = hash(JSON.stringify({ id, ...input }));
    const previous = await this.db.idempotencyKey.findUnique({ where: { tenantId_userId_key: { tenantId: actor.tenantId, userId: actor.id, key } } });
    if (previous) { if (previous.requestHash !== requestHash) this.conflict(); return previous.response; }
    const lead = await this.lead(actor, id); await this.ensureLeadEditor(actor, lead);
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
    this.state(lead, [tenant.approvalRequired ? 'conversion_approved' : 'qualified']);
    if (input.customer_id) await this.customer(actor, input.customer_id);
    try {
      return await this.db.$transaction(async tx => {
        const updated = await tx.lead.updateMany({ where: { id, tenantId: actor.tenantId, version: lead.version, status: lead.status }, data: { status: 'converted', convertedAt: new Date(), version: { increment: 1 } } });
        if (!updated.count) this.conflict();
        const customer = input.customer_id ? await tx.customer.findUniqueOrThrow({ where: { id: input.customer_id } }) : await tx.customer.create({ data: { tenantId: actor.tenantId, name: lead.name, normalizedName: normalizedName(lead.name), ownerId: lead.ownerId || actor.id, orgUnitId: lead.orgUnitId, sourceLeadId: lead.id } });
        const contact = lead.contactName ? await tx.contact.create({ data: { tenantId: actor.tenantId, customerId: customer.id, name: lead.contactName, phone: lead.contactPhone, email: lead.contactEmail } }) : null;
        const opportunity = input.create_opportunity ? await tx.opportunity.create({ data: { tenantId: actor.tenantId, customerId: customer.id, name: input.opportunity_name!, ownerId: lead.ownerId || actor.id, orgUnitId: lead.orgUnitId } }) : null;
        await tx.lead.update({ where: { id }, data: { convertedCustomerId: customer.id } });
        await this.audit(tx, actor, 'lead.converted', 'lead', id, { status: lead.status }, { status: 'converted', customerId: customer.id, opportunityId: opportunity?.id });
        const response = { lead_id: id, customer_id: customer.id, contact_id: contact?.id || null, opportunity_id: opportunity?.id || null, converted_at: new Date().toISOString() };
        await tx.idempotencyKey.create({ data: { tenantId: actor.tenantId, userId: actor.id, key, requestHash, response, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
        return response;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const retry = await this.db.idempotencyKey.findUnique({ where: { tenantId_userId_key: { tenantId: actor.tenantId, userId: actor.id, key } } });
        if (retry && retry.requestHash === requestHash) return retry.response;
      }
      throw error;
    }
  }

  async listCustomers(actor: Actor, query: Record<string, unknown>) {
    const q = parse(pageSchema.extend({ q: z.string().optional(), owner_id: z.string().optional() }), query);
    const where: Prisma.CustomerWhereInput = { ...(await this.customerWhere(actor)), ...(q.owner_id ? { ownerId: q.owner_id } : {}), ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}) };
    const [items, total] = await this.db.$transaction([
      this.db.customer.findMany({ where, select: { id: true, name: true, industry: true, region: true, ownerId: true, serviceOwnerId: true, orgUnitId: true, version: true, status: true, createdAt: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, skip: ((q.page ?? 1) - 1) * (q.page_size ?? 20), take: q.page_size ?? 20 }),
      this.db.customer.count({ where }),
    ]);
    return { items, total, page: q.page, page_size: q.page_size };
  }
  async customerDuplicates(actor: Actor, query: Record<string, unknown>) {
    const q = parse(z.object({ name: z.string().optional(), registration_id: z.string().optional() }), query);
    if (!q.name && !q.registration_id) bad('QUERY_REQUIRED', '请输入客户名称或统一标识', 400);
    return this.db.customer.findMany({ where: { ...(await this.customerWhere(actor)), OR: [
      ...(q.registration_id ? [{ registrationId: q.registration_id }] : []), ...(q.name ? [{ normalizedName: normalizedName(q.name) }] : []),
    ] }, select: { id: true, name: true, ownerId: true, status: true }, take: 10 });
  }
  async createCustomer(actor: Actor, body: unknown) {
    requireRole(actor, 'admin', 'manager', 'sales'); const input = parse(customerSchema, body);
    await this.ensureOrg(actor.tenantId, input.org_unit_id); await this.ensureUser(actor.tenantId, input.owner_id);
    if (!hasRole(actor, 'admin', 'manager') && input.owner_id !== actor.id) bad('FORBIDDEN', '销售只能为自己创建客户', 403);
    if (input.registration_id) {
      const duplicate = await this.db.customer.findFirst({ where: { tenantId: actor.tenantId, registrationId: input.registration_id, deletedAt: null } });
      if (duplicate) throw new AppError('CUSTOMER_DUPLICATE', '该统一标识已有客户', 409, { candidate_id: duplicate.id });
    }
    return this.db.$transaction(async tx => {
      const item = await tx.customer.create({ data: { tenantId: actor.tenantId, name: input.name, normalizedName: normalizedName(input.name), registrationId: input.registration_id, industry: input.industry, region: input.region, ownerId: input.owner_id, orgUnitId: input.org_unit_id } });
      await this.audit(tx, actor, 'customer.created', 'customer', item.id, {}, { name: item.name, ownerId: item.ownerId });
      return item;
    });
  }
  async getCustomer(actor: Actor, id: string) {
    await this.customer(actor, id);
    return this.db.customer.findUniqueOrThrow({ where: { id }, include: { contacts: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }, opportunities: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } } } });
  }
  async updateCustomer(actor: Actor, id: string, body: unknown) {
    const customer = await this.customer(actor, id);
    const input = parse(customerSchema.pick({ name: true, registration_id: true, industry: true, region: true }).partial().extend({ version: z.number().int().positive() }), body);
    if (customer.ownerId !== actor.id && !hasRole(actor, 'admin', 'manager')) bad('FORBIDDEN', '没有修改该客户的权限', 403);
    return this.db.$transaction(async tx => {
      const result = await tx.customer.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version }, data: { ...(input.name ? { name: input.name, normalizedName: normalizedName(input.name) } : {}), ...(input.registration_id !== undefined ? { registrationId: input.registration_id } : {}), ...(input.industry !== undefined ? { industry: input.industry } : {}), ...(input.region !== undefined ? { region: input.region } : {}), version: { increment: 1 } } });
      if (!result.count) this.conflict();
      await this.audit(tx, actor, 'customer.updated', 'customer', id, { version: customer.version }, { version: customer.version + 1 });
      return tx.customer.findUniqueOrThrow({ where: { id } });
    });
  }
  async transferCustomer(actor: Actor, id: string, body: unknown) {
    requireRole(actor, 'admin', 'manager'); const item = await this.customer(actor, id);
    const input = parse(z.object({ owner_id: uuid, reason: text(2, 1000), version: z.number().int().positive() }), body);
    await this.ensureUser(actor.tenantId, input.owner_id);
    return this.db.$transaction(async tx => {
      const result = await tx.customer.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version }, data: { ownerId: input.owner_id, version: { increment: 1 } } });
      if (!result.count) this.conflict();
      await this.audit(tx, actor, 'customer.transferred', 'customer', id, { ownerId: item.ownerId }, { ownerId: input.owner_id, reason: input.reason });
      await this.task(tx, actor, input.owner_id, `接手客户：${item.name}`, 'customer', id);
      return tx.customer.findUniqueOrThrow({ where: { id } });
    });
  }
  async listContacts(actor: Actor, customerId: string) {
    await this.customer(actor, customerId);
    return this.db.contact.findMany({ where: { tenantId: actor.tenantId, customerId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  }
  async createContact(actor: Actor, customerId: string, body: unknown) {
    const customer = await this.customer(actor, customerId);
    if (customer.ownerId !== actor.id && !hasRole(actor, 'admin', 'manager')) bad('FORBIDDEN', '没有修改该客户的权限', 403);
    const input = parse(contactSchema, body);
    return this.db.$transaction(async tx => {
      const contact = await tx.contact.create({ data: { tenantId: actor.tenantId, customerId, name: input.name, title: input.title, phone: input.phone, email: input.email, preferredContact: input.preferred_contact } });
      await this.audit(tx, actor, 'contact.created', 'contact', contact.id, {}, { customerId, name: input.name });
      return contact;
    });
  }
  async getContact(actor: Actor, id: string) {
    const contact = await this.db.contact.findFirst({ where: { id, tenantId: actor.tenantId, deletedAt: null } });
    if (!contact) bad('NOT_FOUND', '联系人不存在', 404);
    await this.customer(actor, contact.customerId);
    return contact;
  }
  async updateContact(actor: Actor, id: string, body: unknown) {
    const item = await this.getContact(actor, id); const customer = await this.customer(actor, item.customerId);
    if (customer.ownerId !== actor.id && !hasRole(actor, 'admin', 'manager')) bad('FORBIDDEN', '没有修改该联系人的权限', 403);
    const input = parse(contactSchema.partial().extend({ version: z.number().int().positive() }), body);
    return this.db.$transaction(async tx => {
      const result = await tx.contact.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version }, data: { ...(input.name ? { name: input.name } : {}), ...(input.title !== undefined ? { title: input.title } : {}), ...(input.phone !== undefined ? { phone: input.phone } : {}), ...(input.email !== undefined ? { email: input.email } : {}), ...(input.preferred_contact !== undefined ? { preferredContact: input.preferred_contact } : {}), version: { increment: 1 } } });
      if (!result.count) this.conflict();
      await this.audit(tx, actor, 'contact.updated', 'contact', id, { version: item.version }, { version: item.version + 1 });
      return tx.contact.findUniqueOrThrow({ where: { id } });
    });
  }

  async listOpportunities(actor: Actor, query: Record<string, unknown>) {
    const q = parse(pageSchema.extend({ scope: z.enum(['all', 'mine', 'participating', 'team']).default('all'), stage: z.string().optional(), customer_id: z.string().optional(), q: z.string().optional() }), query);
    const where: Prisma.OpportunityWhereInput = { ...(await this.opportunityWhere(actor)), ...(q.stage ? { stage: q.stage } : {}), ...(q.customer_id ? { customerId: q.customer_id } : {}) };
    if (q.scope === 'mine') where.ownerId = actor.id;
    if (q.scope === 'participating') where.participants = { some: { userId: actor.id } };
    if (q.scope === 'team') where.orgUnitId = { in: await this.orgScope(actor) };
    if (q.q) where.AND = [{ OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { customer: { name: { contains: q.q, mode: 'insensitive' } } }] }];
    const [items, total] = await this.db.$transaction([
      this.db.opportunity.findMany({ where, include: { customer: { select: { id: true, name: true } } }, orderBy: { updatedAt: 'desc' }, skip: ((q.page ?? 1) - 1) * (q.page_size ?? 20), take: q.page_size ?? 20 }),
      this.db.opportunity.count({ where }),
    ]);
    return { items, total, page: q.page, page_size: q.page_size };
  }
  async createOpportunity(actor: Actor, body: unknown) {
    requireRole(actor, 'admin', 'manager', 'sales'); const input = parse(opportunitySchema, body);
    await this.customer(actor, input.customer_id); await this.ensureUser(actor.tenantId, input.owner_id); await this.ensureOrg(actor.tenantId, input.org_unit_id);
    if (!hasRole(actor, 'admin', 'manager') && input.owner_id !== actor.id) bad('FORBIDDEN', '销售只能创建自己负责的商机', 403);
    return this.db.$transaction(async tx => {
      const item = await tx.opportunity.create({ data: { tenantId: actor.tenantId, customerId: input.customer_id, name: input.name, ownerId: input.owner_id, orgUnitId: input.org_unit_id, amount: input.amount, currency: input.currency, probability: input.probability, expectedCloseAt: input.expected_close_at ? new Date(input.expected_close_at) : undefined, nextAction: input.next_action, nextActionAt: input.next_action_at ? new Date(input.next_action_at) : undefined } });
      await this.audit(tx, actor, 'opportunity.created', 'opportunity', item.id, {}, { stage: item.stage, amount: item.amount.toString() });
      return item;
    });
  }
  async getOpportunity(actor: Actor, id: string) {
    await this.opportunity(actor, id);
    return this.db.opportunity.findUniqueOrThrow({ where: { id }, include: { customer: { select: { id: true, name: true } }, participants: true } });
  }
  async updateOpportunity(actor: Actor, id: string, body: unknown) {
    const item = await this.opportunity(actor, id);
    if (item.ownerId !== actor.id && !hasRole(actor, 'admin', 'manager')) bad('FORBIDDEN', '没有修改该商机的权限', 403);
    if (['won', 'lost'].includes(item.stage)) bad('OPPORTUNITY_CLOSED', '已关闭的商机不能编辑');
    const input = parse(opportunitySchema.pick({ name: true, amount: true, currency: true, probability: true, expected_close_at: true, next_action: true, next_action_at: true }).partial().extend({ version: z.number().int().positive() }), body);
    return this.db.$transaction(async tx => {
      const result = await tx.opportunity.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version }, data: { ...(input.name ? { name: input.name } : {}), ...(input.amount !== undefined ? { amount: input.amount } : {}), ...(input.currency ? { currency: input.currency } : {}), ...(input.probability !== undefined ? { probability: input.probability } : {}), ...(input.expected_close_at !== undefined ? { expectedCloseAt: new Date(input.expected_close_at) } : {}), ...(input.next_action !== undefined ? { nextAction: input.next_action } : {}), ...(input.next_action_at !== undefined ? { nextActionAt: new Date(input.next_action_at) } : {}), version: { increment: 1 } } });
      if (!result.count) this.conflict();
      await this.audit(tx, actor, 'opportunity.updated', 'opportunity', id, { version: item.version, amount: item.amount.toString() }, { version: item.version + 1, amount: input.amount });
      return tx.opportunity.findUniqueOrThrow({ where: { id } });
    });
  }
  private async changeOpportunity(actor: Actor, id: string, body: unknown, next: string) {
    const item = await this.opportunity(actor, id);
    if (item.ownerId !== actor.id && !hasRole(actor, 'admin', 'manager')) bad('FORBIDDEN', '没有推进该商机的权限', 403);
    const schema = next === 'won' ? z.object({ version: z.number().int().positive(), actual_amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/), actual_close_at: z.string().datetime() }) : next === 'lost' ? z.object({ version: z.number().int().positive(), lost_reason: text(2, 1000) }) : versionSchema;
    const input = parse(schema, body);
    const stages = ['discovery', 'proposal', 'negotiation'];
    if (['won', 'lost'].includes(item.stage)) bad('OPPORTUNITY_CLOSED', '已关闭的商机不能推进', 409);
    if (next === 'advance' && item.stage === 'negotiation') bad('OPPORTUNITY_STAGE', '请标记赢单或输单');
    const target = next === 'advance' ? stages[stages.indexOf(item.stage) + 1] : next;
    return this.db.$transaction(async tx => {
      const data: Prisma.OpportunityUpdateManyMutationInput = { stage: target, version: { increment: 1 } };
      if (next === 'won') { const won = parse(z.object({ actual_amount: z.string(), actual_close_at: z.string().datetime() }), body); data.actualAmount = won.actual_amount; data.actualCloseAt = new Date(won.actual_close_at); }
      if (next === 'lost') { const lost = parse(z.object({ lost_reason: text(2, 1000) }), body); data.lostReason = lost.lost_reason; }
      const result = await tx.opportunity.updateMany({ where: { id, tenantId: actor.tenantId, version: input.version, stage: item.stage }, data });
      if (!result.count) this.conflict();
      await this.audit(tx, actor, `opportunity.${target}`, 'opportunity', id, { stage: item.stage }, { stage: target });
      return tx.opportunity.findUniqueOrThrow({ where: { id } });
    });
  }
  advanceOpportunity(actor: Actor, id: string, body: unknown) { return this.changeOpportunity(actor, id, body, 'advance'); }
  winOpportunity(actor: Actor, id: string, body: unknown) { return this.changeOpportunity(actor, id, body, 'won'); }
  loseOpportunity(actor: Actor, id: string, body: unknown) { return this.changeOpportunity(actor, id, body, 'lost'); }

  async listFollowUps(actor: Actor, query: Record<string, unknown>) {
    const q = parse(pageSchema.extend({ target_type: z.enum(['lead', 'customer', 'opportunity']).optional(), target_id: z.string().optional() }), query);
    if (q.target_id && q.target_type) await this.assertTarget(actor, q.target_type, q.target_id);
    const where: Prisma.FollowUpWhereInput = { tenantId: actor.tenantId, deletedAt: null, ...(q.target_type ? { targetType: q.target_type } : {}), ...(q.target_id ? { targetId: q.target_id } : { authorId: actor.id }) };
    const [items, total] = await this.db.$transaction([
      this.db.followUp.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: ((q.page ?? 1) - 1) * (q.page_size ?? 20), take: q.page_size ?? 20 }),
      this.db.followUp.count({ where }),
    ]);
    return { items, total, page: q.page, page_size: q.page_size };
  }
  private async assertTarget(actor: Actor, type: string, id: string) {
    if (type === 'lead') return this.lead(actor, id);
    if (type === 'customer') return this.customer(actor, id);
    if (type === 'opportunity') return this.opportunity(actor, id);
    bad('TARGET_TYPE', '无效的跟进对象');
  }
  async createFollowUp(actor: Actor, body: unknown) {
    const input = parse(followUpSchema, body); await this.assertTarget(actor, input.target_type, input.target_id);
    return this.db.$transaction(async tx => {
      const item = await tx.followUp.create({ data: { tenantId: actor.tenantId, targetType: input.target_type, targetId: input.target_id, authorId: actor.id, type: input.type, content: input.content, occurredAt: input.occurred_at ? new Date(input.occurred_at) : new Date(), nextAt: input.next_at ? new Date(input.next_at) : undefined } });
      await this.audit(tx, actor, 'follow_up.created', input.target_type, input.target_id, {}, { followUpId: item.id, type: item.type });
      if (item.nextAt) await this.task(tx, actor, actor.id, `待跟进：${input.content.slice(0, 40)}`, input.target_type, input.target_id, item.nextAt);
      return item;
    });
  }
  async listTasks(actor: Actor, query: Record<string, unknown>) {
    const q = parse(pageSchema.extend({ status: z.enum(['open', 'done']).default('open') }), query);
    const where = { tenantId: actor.tenantId, assigneeId: actor.id, status: q.status };
    const [items, total] = await this.db.$transaction([
      this.db.task.findMany({ where, orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }], skip: ((q.page ?? 1) - 1) * (q.page_size ?? 20), take: q.page_size ?? 20 }),
      this.db.task.count({ where }),
    ]);
    return { items, total, page: q.page, page_size: q.page_size };
  }
  async completeTask(actor: Actor, id: string) {
    const result = await this.db.task.updateMany({ where: { id, tenantId: actor.tenantId, assigneeId: actor.id, status: 'open' }, data: { status: 'done' } });
    if (!result.count) bad('NOT_FOUND', '待办不存在或已完成', 404);
    return this.db.task.findUniqueOrThrow({ where: { id } });
  }
  async dashboard(actor: Actor) {
    const leadWhere = await this.leadWhere(actor); const oppWhere = await this.opportunityWhere(actor);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const [pendingLeads, activeOpportunities, dueToday, overdue, openTasks, opportunities, recentFollowUps] = await Promise.all([
      this.db.lead.count({ where: { ...leadWhere, status: { in: ['assigned', 'working', 'qualified', 'conversion_pending', 'conversion_approved'] } } }),
      this.db.opportunity.count({ where: { ...oppWhere, stage: { notIn: ['won', 'lost'] } } }),
      this.db.task.count({ where: { tenantId: actor.tenantId, assigneeId: actor.id, status: 'open', dueAt: { gte: today, lt: tomorrow } } }),
      this.db.task.count({ where: { tenantId: actor.tenantId, assigneeId: actor.id, status: 'open', dueAt: { lt: today } } }),
      this.db.task.findMany({ where: { tenantId: actor.tenantId, assigneeId: actor.id, status: 'open' }, orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }], take: 8 }),
      this.db.opportunity.findMany({ where: { ...oppWhere, stage: { notIn: ['won', 'lost'] } }, select: { amount: true, currency: true } }),
      this.db.followUp.findMany({ where: { tenantId: actor.tenantId, authorId: actor.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ]);
    const expectedCny = opportunities.filter(o => o.currency === 'CNY').reduce((sum, o) => sum.plus(o.amount), new Prisma.Decimal(0));
    return { pending_leads: pendingLeads, active_opportunities: activeOpportunities, due_today: dueToday, overdue, expected_amount_cny: expectedCny.toFixed(2), expected_amount_note: '仅汇总 CNY、非终态商机的预计金额', open_tasks: openTasks, recent_follow_ups: recentFollowUps };
  }
  async leadReport(actor: Actor, query: Record<string, unknown>) {
    requireRole(actor, 'admin', 'manager', 'marketing');
    const q = parse(z.object({ from: z.string().datetime(), to: z.string().datetime() }), query);
    const from = new Date(q.from), to = new Date(q.to);
    if (from >= to || to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) bad('DATE_RANGE', '统计时间范围无效');
    const where: Prisma.LeadWhereInput = { ...(await this.leadWhere(actor)), assignedAt: { gte: from, lt: to } };
    const [assigned, processed, byOwner] = await Promise.all([
      this.db.lead.count({ where }),
      this.db.lead.count({ where: { ...where, firstProcessedAt: { not: null } } }),
      this.db.lead.groupBy({ by: ['ownerId'], where, _count: { _all: true } }),
    ]);
    return { from: from.toISOString(), to: to.toISOString(), assigned, processed, processing_rate: assigned ? processed / assigned : null, definition: '周期内首次分配的线索中，已发生首次有效处理动作的比例', by_owner: byOwner.map(x => ({ owner_id: x.ownerId, count: x._count._all })) };
  }

  async createUser(actor: Actor, body: unknown) {
    requireRole(actor, 'admin');
    const input = parse(z.object({ email: z.string().email(), name: text(1, 100), password: z.string().min(12).max(200), org_unit_id: uuid, role: z.enum(['admin', 'marketing', 'manager', 'sales', 'csm']) }), body);
    await this.ensureOrg(actor.tenantId, input.org_unit_id);
    const { hash: passwordHash } = await import('bcryptjs').then(async b => ({ hash: await b.hash(input.password, 12) }));
    const user = await this.db.user.create({ data: { tenantId: actor.tenantId, email: input.email.toLowerCase(), name: input.name, passwordHash, memberships: { create: { tenantId: actor.tenantId, orgUnitId: input.org_unit_id, role: input.role } } } });
    return { id: user.id, email: user.email, name: user.name, active: user.active };
  }
  async setUserActive(actor: Actor, id: string, active: boolean) {
    requireRole(actor, 'admin');
    if (id === actor.id && !active) bad('SELF_DISABLE', '不能停用当前账号');
    const user = await this.db.user.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!user) bad('NOT_FOUND', '用户不存在', 404);
    await this.db.user.update({ where: { id }, data: { active } });
    if (!active) await this.db.session.deleteMany({ where: { tenantId: actor.tenantId, userId: id } });
    return { id, active };
  }
  async createOrg(actor: Actor, body: unknown) {
    requireRole(actor, 'admin'); const input = parse(z.object({ name: text(1, 100), parent_id: uuid.optional() }), body);
    if (input.parent_id) await this.ensureOrg(actor.tenantId, input.parent_id);
    return this.db.orgUnit.create({ data: { tenantId: actor.tenantId, name: input.name, parentId: input.parent_id } });
  }
  async createPool(actor: Actor, body: unknown) {
    requireRole(actor, 'admin'); const input = parse(z.object({ name: text(1, 100), org_unit_id: uuid, user_ids: z.array(uuid).min(1).max(100) }), body);
    await this.ensureOrg(actor.tenantId, input.org_unit_id);
    for (const userId of input.user_ids) {
      const member = await this.db.membership.findFirst({ where: { tenantId: actor.tenantId, orgUnitId: input.org_unit_id, userId, role: 'sales' } });
      if (!member) bad('POOL_MEMBER_ROLE', '销售池成员必须是该组织销售');
    }
    return this.db.salesPool.create({ data: { tenantId: actor.tenantId, orgUnitId: input.org_unit_id, name: input.name, members: { create: input.user_ids.map((userId, position) => ({ userId, position })) } }, include: { members: true } });
  }
  async listPools(actor: Actor) { requireRole(actor, 'admin', 'marketing', 'manager'); return this.db.salesPool.findMany({ where: { tenantId: actor.tenantId }, include: { members: { orderBy: { position: 'asc' } } } }); }
  async autoAssign(actor: Actor, poolId: string, leadId: string, body: unknown) {
    requireRole(actor, 'admin', 'marketing', 'manager'); const input = parse(versionSchema, body);
    const lead = await this.lead(actor, leadId); this.state(lead, ['new', 'returned']);
    const pool = await this.db.salesPool.findFirst({ where: { id: poolId, tenantId: actor.tenantId, active: true }, include: { members: { where: { active: true }, orderBy: { position: 'asc' } } } });
    if (!pool || pool.orgUnitId !== lead.orgUnitId || !pool.members.length) bad('POOL_UNAVAILABLE', '销售池不可用或没有成员');
    const candidate = pool.members[pool.nextIndex % pool.members.length];
    return this.db.$transaction(async tx => {
      const advanced = await tx.salesPool.updateMany({ where: { id: pool.id, tenantId: actor.tenantId, version: pool.version }, data: { nextIndex: { increment: 1 }, version: { increment: 1 } } });
      if (!advanced.count) this.conflict();
      const updated = await tx.lead.updateMany({ where: { id: lead.id, tenantId: actor.tenantId, version: input.version, status: { in: ['new', 'returned'] } }, data: { ownerId: candidate.userId, status: 'assigned', assignedAt: lead.assignedAt || new Date(), version: { increment: 1 } } });
      if (!updated.count) this.conflict();
      await tx.leadAssignment.create({ data: { tenantId: actor.tenantId, leadId, fromUserId: lead.ownerId, toUserId: candidate.userId, strategy: 'round_robin', actorId: actor.id } });
      await this.audit(tx, actor, 'lead.auto_assigned', 'lead', leadId, { ownerId: lead.ownerId }, { ownerId: candidate.userId });
      await this.task(tx, actor, candidate.userId, `处理线索：${lead.name}`, 'lead', leadId);
      await this.outbox(tx, actor, 'lead.assigned', leadId, lead.version + 1, { leadId, assigneeId: candidate.userId });
      return tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    });
  }
}
