import { Injectable } from '@nestjs/common';
import { Prisma } from './generated/client';
import { z } from 'zod';
import { Actor, bad, hasRole, parse, requireRole, text, uuid } from './common';
import { PrismaService } from './prisma.service';

@Injectable()
export class CsmService {
  constructor(private db: PrismaService) {}
  private audit(tx: Prisma.TransactionClient, actor: Actor, action: string, type: string, resourceId: string, detail: Record<string, unknown> = {}) { return tx.auditLog.create({ data: { tenantId: actor.tenantId, actorId: actor.id, action, resourceType: type, resourceId, after: detail as Prisma.InputJsonObject } }); }
  private async managerOrgIds(actor: Actor) { const roots = actor.memberships.filter(m => m.role === 'manager').map(m => m.orgUnitId); const orgs = await this.db.orgUnit.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, parentId: true } }); const ids = new Set(roots); let changed = true; while (changed) { changed = false; for (const org of orgs) if (org.parentId && ids.has(org.parentId) && !ids.has(org.id)) { ids.add(org.id); changed = true; } } return [...ids]; }
  private async managerCanSee(actor: Actor, orgUnitId: string) { return hasRole(actor, 'admin') || (hasRole(actor, 'manager') && (await this.managerOrgIds(actor)).includes(orgUnitId)); }
  private async customer(actor: Actor, id: string) {
    const item = await this.db.customer.findFirst({ where: { id, tenantId: actor.tenantId, deletedAt: null } });
    if (!item) bad('NOT_FOUND', '客户不存在', 404);
    if (!(await this.managerCanSee(actor, item.orgUnitId)) && item.serviceOwnerId !== actor.id && item.ownerId !== actor.id) bad('FORBIDDEN', '无权访问该客户服务记录', 403);
    return item;
  }
  private async plan(actor: Actor, id: string) {
    const item = await this.db.servicePlan.findFirst({ where: { id, tenantId: actor.tenantId }, include: { customer: { select: { id: true, name: true, serviceOwnerId: true, ownerId: true, orgUnitId: true } }, tasks: { orderBy: { createdAt: 'desc' } } } });
    if (!item) bad('NOT_FOUND', '服务计划不存在', 404);
    if (!(await this.managerCanSee(actor, item.customer.orgUnitId)) && item.customer.serviceOwnerId !== actor.id && item.customer.ownerId !== actor.id && !item.tasks.some(t => t.assigneeId === actor.id)) bad('FORBIDDEN', '无权访问该服务计划', 403);
    return item;
  }
  async assignOwner(actor: Actor, customerId: string, body: unknown) {
    requireRole(actor, 'admin', 'manager'); const input = parse(z.object({ csm_user_id: uuid, version: z.number().int().positive() }), body);
    const customer = await this.customer(actor, customerId);
    if (!(await this.managerCanSee(actor, customer.orgUnitId))) bad('FORBIDDEN', '只能管理本组织客户', 403);
    const member = await this.db.membership.findFirst({ where: { tenantId: actor.tenantId, userId: input.csm_user_id, orgUnitId: customer.orgUnitId, role: 'csm', user: { active: true } } });
    if (!member) bad('CSM_INVALID', '请选择该组织内有效的 CSM 成员');
    return this.db.$transaction(async tx => { const changed = await tx.customer.updateMany({ where: { id: customerId, tenantId: actor.tenantId, version: input.version }, data: { serviceOwnerId: input.csm_user_id, version: { increment: 1 } } }); if (!changed.count) bad('VERSION_CONFLICT', '客户资料已被修改，请刷新后重试', 409); await this.audit(tx, actor, 'customer.csm_assigned', 'customer', customerId, { from: customer.serviceOwnerId, to: input.csm_user_id }); return tx.customer.findUniqueOrThrow({ where: { id: customerId } }); });
  }
  async listPlans(actor: Actor) {
    requireRole(actor, 'admin', 'manager', 'sales', 'csm');
    const where: Prisma.ServicePlanWhereInput = { tenantId: actor.tenantId, ...(hasRole(actor, 'admin') ? {} : hasRole(actor, 'manager') ? { customer: { orgUnitId: { in: await this.managerOrgIds(actor) } } } : { OR: [{ ownerId: actor.id }, { customer: { ownerId: actor.id } }, { tasks: { some: { assigneeId: actor.id } } }] }) };
    return this.db.servicePlan.findMany({ where, include: { customer: { select: { id: true, name: true } }, _count: { select: { tasks: true } } }, orderBy: { createdAt: 'desc' } });
  }
  async createPlan(actor: Actor, body: unknown) {
    requireRole(actor, 'admin', 'csm'); const input = parse(z.object({ customer_id: uuid, title: text(1, 200), starts_at: z.string().datetime(), ends_at: z.string().datetime(), note: z.string().max(2000).optional() }), body);
    const customer = await this.customer(actor, input.customer_id);
    if (!customer.serviceOwnerId) bad('CSM_UNASSIGNED', '请先为客户分配 CSM');
    if (hasRole(actor, 'csm') && !hasRole(actor, 'admin') && customer.serviceOwnerId !== actor.id) bad('FORBIDDEN', '只有该客户 CSM 可创建服务计划', 403);
    if (new Date(input.starts_at) >= new Date(input.ends_at)) bad('DATE_RANGE', '服务计划结束时间必须晚于开始时间');
    return this.db.$transaction(async tx => { const item = await tx.servicePlan.create({ data: { tenantId: actor.tenantId, customerId: customer.id, title: input.title, ownerId: customer.serviceOwnerId || actor.id, startsAt: new Date(input.starts_at), endsAt: new Date(input.ends_at), note: input.note } }); await this.audit(tx, actor, 'service_plan.created', 'service_plan', item.id, { customerId: customer.id }); return item; });
  }
  getPlan(actor: Actor, id: string) { return this.plan(actor, id); }
  async createTask(actor: Actor, planId: string, body: unknown) {
    requireRole(actor, 'admin', 'csm'); const plan = await this.plan(actor, planId);
    if (hasRole(actor, 'csm') && !hasRole(actor, 'admin') && plan.ownerId !== actor.id) bad('FORBIDDEN', '只有计划负责人可创建服务任务', 403);
    if (plan.status !== 'active') bad('PLAN_CLOSED', '计划已关闭', 409);
    const input = parse(z.object({ title: text(1, 200), assignee_id: uuid, due_at: z.string().datetime() }), body);
    const member = await this.db.membership.findFirst({ where: { tenantId: actor.tenantId, userId: input.assignee_id, orgUnitId: plan.customer.orgUnitId, role: 'csm', user: { active: true } } });
    if (!member) bad('ASSIGNEE_INVALID', '服务任务只能分配给该组织 CSM');
    return this.db.$transaction(async tx => { const item = await tx.serviceTask.create({ data: { tenantId: actor.tenantId, planId, title: input.title, assigneeId: input.assignee_id, dueAt: new Date(input.due_at) } }); await this.audit(tx, actor, 'service_task.created', 'service_task', item.id, { planId, assigneeId: item.assigneeId }); return item; });
  }
  async submitTask(actor: Actor, taskId: string, body: unknown) {
    const input = parse(z.object({ completion_note: text(2, 2000), version: z.number().int().positive() }), body);
    const task = await this.db.serviceTask.findFirst({ where: { id: taskId, tenantId: actor.tenantId } });
    if (!task) bad('NOT_FOUND', '服务任务不存在', 404);
    if (task.assigneeId !== actor.id) bad('FORBIDDEN', '只能提交自己的服务任务', 403);
    if (!['open','rejected'].includes(task.status)) bad('TASK_STATE', '任务当前不可提交', 409);
    return this.db.$transaction(async tx => { const changed = await tx.serviceTask.updateMany({ where: { id: taskId, tenantId: actor.tenantId, version: input.version, status: { in: ['open','rejected'] } }, data: { status: 'submitted', completionNote: input.completion_note, reviewReason: null, submittedAt: new Date(), version: { increment: 1 } } }); if (!changed.count) bad('VERSION_CONFLICT', '任务已被修改，请刷新后重试', 409); await this.audit(tx, actor, 'service_task.submitted', 'service_task', taskId); return tx.serviceTask.findUniqueOrThrow({ where: { id: taskId } }); });
  }
  async reviewTask(actor: Actor, taskId: string, body: unknown) {
    requireRole(actor, 'admin', 'manager'); const input = parse(z.object({ decision: z.enum(['approve','reject']), reason: z.string().trim().max(1000).optional(), version: z.number().int().positive() }), body);
    if (input.decision === 'reject' && !input.reason) bad('REASON_REQUIRED', '拒绝时必须填写原因');
    const task = await this.db.serviceTask.findFirst({ where: { id: taskId, tenantId: actor.tenantId }, include: { plan: { include: { customer: true } } } });
    if (!task) bad('NOT_FOUND', '服务任务不存在', 404);
    if (task.status !== 'submitted') bad('TASK_STATE', '任务未提交或已审核', 409);
    if (!(await this.managerCanSee(actor, task.plan.customer.orgUnitId))) bad('FORBIDDEN', '只能审核本组织任务', 403);
    if (task.assigneeId === actor.id) bad('SELF_REVIEW', '不能审核自己的服务任务', 403);
    return this.db.$transaction(async tx => { const changed = await tx.serviceTask.updateMany({ where: { id: taskId, tenantId: actor.tenantId, version: input.version, status: 'submitted' }, data: { status: input.decision === 'approve' ? 'approved' : 'rejected', reviewReason: input.reason, reviewedBy: actor.id, reviewedAt: new Date(), version: { increment: 1 } } }); if (!changed.count) bad('VERSION_CONFLICT', '任务已被修改，请刷新后重试', 409); await this.audit(tx, actor, `service_task.${input.decision}`, 'service_task', taskId, { reason: input.reason }); return tx.serviceTask.findUniqueOrThrow({ where: { id: taskId } }); });
  }
  async listRisks(actor: Actor) { requireRole(actor, 'admin', 'manager', 'sales', 'csm'); return this.db.serviceRisk.findMany({ where: { tenantId: actor.tenantId, ...(hasRole(actor, 'admin') ? {} : hasRole(actor, 'manager') ? { customer: { orgUnitId: { in: await this.managerOrgIds(actor) } } } : { customer: { OR: [{ ownerId: actor.id }, { serviceOwnerId: actor.id }] } }) }, include: { customer: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } }); }
  async createRisk(actor: Actor, body: unknown) { requireRole(actor, 'admin', 'csm'); const input = parse(z.object({ customer_id: uuid, title: text(1, 200), severity: z.enum(['low','medium','high']), detail: text(2, 3000) }), body); const customer = await this.customer(actor, input.customer_id); if (!customer.serviceOwnerId) bad('CSM_UNASSIGNED', '请先为客户分配 CSM'); if (hasRole(actor, 'csm') && !hasRole(actor, 'admin') && customer.serviceOwnerId !== actor.id) bad('FORBIDDEN', '只有该客户 CSM 可登记风险', 403); return this.db.$transaction(async tx => { const item = await tx.serviceRisk.create({ data: { tenantId: actor.tenantId, customerId: customer.id, title: input.title, severity: input.severity, detail: input.detail, ownerId: customer.serviceOwnerId! } }); await this.audit(tx, actor, 'service_risk.created', 'service_risk', item.id, { customerId: customer.id, severity: item.severity }); return item; }); }
  async closeRisk(actor: Actor, riskId: string, body: unknown) { const input = parse(z.object({ resolution: text(2, 3000) }), body); const risk = await this.db.serviceRisk.findFirst({ where: { id: riskId, tenantId: actor.tenantId }, include: { customer: { select: { orgUnitId: true } } } }); if (!risk) bad('NOT_FOUND', '风险不存在', 404); if (risk.ownerId !== actor.id && !(await this.managerCanSee(actor, risk.customer.orgUnitId))) bad('FORBIDDEN', '没有关闭该风险的权限', 403); if (risk.status !== 'open') bad('RISK_CLOSED', '风险已关闭', 409); return this.db.$transaction(async tx => { const changed = await tx.serviceRisk.updateMany({ where: { id: riskId, tenantId: actor.tenantId, status: 'open' }, data: { status: 'closed', resolution: input.resolution, closedAt: new Date() } }); if (!changed.count) bad('RISK_CLOSED', '风险已关闭', 409); await this.audit(tx, actor, 'service_risk.closed', 'service_risk', riskId, { resolution: input.resolution }); return tx.serviceRisk.findUniqueOrThrow({ where: { id: riskId } }); }); }
  async createRenewal(actor: Actor, body: unknown) { requireRole(actor, 'admin', 'csm'); const input = parse(z.object({ customer_id: uuid, name: text(1, 200), amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/), expected_close_at: z.string().datetime() }), body); const customer = await this.customer(actor, input.customer_id); if (!customer.serviceOwnerId) bad('CSM_UNASSIGNED', '请先为客户分配 CSM'); if (hasRole(actor, 'csm') && !hasRole(actor, 'admin') && customer.serviceOwnerId !== actor.id) bad('FORBIDDEN', '只有该客户 CSM 可发起续约', 403); return this.db.$transaction(async tx => { const item = await tx.opportunity.create({ data: { tenantId: actor.tenantId, customerId: customer.id, name: input.name, kind: 'renewal', ownerId: customer.ownerId, orgUnitId: customer.orgUnitId, amount: new Prisma.Decimal(input.amount), expectedCloseAt: new Date(input.expected_close_at) } }); await this.audit(tx, actor, 'renewal.created', 'opportunity', item.id, { customerId: customer.id }); return item; }); }
  async report(actor: Actor) { requireRole(actor, 'admin', 'manager', 'csm'); const orgIds = hasRole(actor, 'manager') && !hasRole(actor, 'admin') ? await this.managerOrgIds(actor) : []; const planScope = hasRole(actor, 'admin') ? {} : hasRole(actor, 'manager') ? { customer: { orgUnitId: { in: orgIds } } } : { ownerId: actor.id }; const taskScope = hasRole(actor, 'admin') ? {} : { plan: planScope }; const customerScope = hasRole(actor, 'admin') ? {} : hasRole(actor, 'manager') ? { customer: { orgUnitId: { in: orgIds } } } : { customer: { serviceOwnerId: actor.id } }; const [plans, openRisks, approvedTasks, pendingTasks, renewals] = await Promise.all([this.db.servicePlan.count({ where: { tenantId: actor.tenantId, ...planScope } }), this.db.serviceRisk.count({ where: { tenantId: actor.tenantId, status: 'open', ...customerScope } }), this.db.serviceTask.count({ where: { tenantId: actor.tenantId, status: 'approved', ...taskScope } }), this.db.serviceTask.count({ where: { tenantId: actor.tenantId, status: 'submitted', ...taskScope } }), this.db.opportunity.count({ where: { tenantId: actor.tenantId, kind: 'renewal', ...customerScope } })]); return { plans, open_risks: openRisks, approved_tasks: approvedTasks, pending_tasks: pendingTasks, renewal_opportunities: renewals, definition: '按当前用户可见范围内的服务计划、风险、任务与续约商机原始记录计数' }; }
}
