import { Injectable } from '@nestjs/common';
import { Prisma } from './generated/client';
import { z } from 'zod';
import { Actor, AppError, hash, parse } from './common';
import { PrismaService } from './prisma.service';
import { CrmService } from './crm.service';
import { AiTurn, generateAiAnswer } from './ai-model';
import { aiStatus, clearAiSettings, publicAiSettings, resolveAiConnection, saveAiSettings, testAiSettings } from './ai-settings';

const chatInput = z.object({
  conversation_id: z.string().uuid().optional(),
  context_type: z.enum(['dashboard', 'lead', 'customer', 'opportunity']),
  context_id: z.string().uuid().optional(),
  message: z.string().trim().min(2).max(2000),
});
type ContextType = z.infer<typeof chatInput>['context_type'];
const draftInput = z.object({ target_type: z.enum(['lead', 'customer', 'opportunity']), target_id: z.string().uuid() });
const draftSchema = z.object({ summary: z.string().min(1).max(1000), questions: z.array(z.string().min(1).max(300)).max(5), draft: z.string().min(1).max(2000) });
const draftFormat = { name: 'crm_follow_up_draft', schema: { type: 'object', additionalProperties: false, required: ['summary', 'questions', 'draft'], properties: { summary: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } }, draft: { type: 'string' } } } };

@Injectable()
export class AiService {
  constructor(private db: PrismaService, private crm: CrmService) {}

  status(actor: Actor) { return aiStatus(this.db, actor.tenantId); }
  settings(actor: Actor) { return publicAiSettings(this.db, actor); }
  saveSettings(actor: Actor, body: unknown) { return saveAiSettings(this.db, actor, body); }
  testSettings(actor: Actor, body: unknown) { return testAiSettings(this.db, actor, body); }
  clearSettings(actor: Actor) { return clearAiSettings(this.db, actor); }
  private async answer(actor: Actor, instructions: string, context: unknown, turns: AiTurn[], format?: { name: string; schema: Record<string, unknown> }) {
    return generateAiAnswer(await resolveAiConnection(this.db, actor.tenantId), instructions, context, turns, format);
  }

  private async context(actor: Actor, type: ContextType, id?: string) {
    if (type !== 'dashboard' && !id) throw new AppError('VALIDATION_ERROR', '请选择业务记录后再提问', 400);
    if (type === 'lead') {
      const lead = await this.crm.getLead(actor, id!);
      const followUps = await this.crm.listFollowUps(actor, { target_type: 'lead', target_id: id, page_size: 10 });
      return { title: `线索 · ${lead.name}`, href: `/leads/${id}`, data: { name: lead.name, status: lead.status, source: lead.source, notes: lead.notes, createdAt: lead.createdAt, updatedAt: lead.updatedAt, followUps: followUps.items.map(f => ({ content: f.content, occurredAt: f.occurredAt, nextAt: f.nextAt })) } };
    }
    if (type === 'customer') {
      const customer = await this.crm.getCustomer(actor, id!);
      const followUps = await this.crm.listFollowUps(actor, { target_type: 'customer', target_id: id, page_size: 10 });
      return { title: `客户 · ${customer.name}`, href: `/customers/${id}`, data: { name: customer.name, industry: customer.industry, region: customer.region, status: customer.status, opportunities: customer.opportunities.map(o => ({ id: o.id, name: o.name, stage: o.stage, amount: o.amount, nextAction: o.nextAction, nextActionAt: o.nextActionAt })), followUps: followUps.items.map(f => ({ content: f.content, occurredAt: f.occurredAt, nextAt: f.nextAt })) } };
    }
    if (type === 'opportunity') {
      const opportunity = await this.crm.getOpportunity(actor, id!);
      const followUps = await this.crm.listFollowUps(actor, { target_type: 'opportunity', target_id: id, page_size: 10 });
      return { title: `商机 · ${opportunity.name}`, href: `/opportunities/${id}`, data: { name: opportunity.name, customer: opportunity.customer.name, stage: opportunity.stage, amount: opportunity.amount, currency: opportunity.currency, probability: opportunity.probability, expectedCloseAt: opportunity.expectedCloseAt, nextAction: opportunity.nextAction, nextActionAt: opportunity.nextActionAt, followUps: followUps.items.map(f => ({ content: f.content, occurredAt: f.occurredAt, nextAt: f.nextAt })) } };
    }
    const dashboard = await this.crm.dashboard(actor);
    return { title: '销售工作台', href: '/', data: dashboard };
  }

  async list(actor: Actor) {
    const rows = await this.db.aiConversation.findMany({ where: { tenantId: actor.tenantId, userId: actor.id }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, contextType: true, contextId: true, title: true, updatedAt: true } });
    const checked = await Promise.allSettled(rows.map(async row => { await this.context(actor, row.contextType as ContextType, row.contextId || undefined); return row; }));
    return checked.filter((item): item is PromiseFulfilledResult<typeof rows[number]> => item.status === 'fulfilled').map(item => item.value);
  }

  async get(actor: Actor, id: string) {
    const row = await this.db.aiConversation.findFirst({ where: { id, tenantId: actor.tenantId, userId: actor.id } });
    if (!row) throw new AppError('NOT_FOUND', '对话不存在', 404);
    await this.context(actor, row.contextType as ContextType, row.contextId || undefined);
    return row;
  }

  async remove(actor: Actor, id: string) {
    const row = await this.db.aiConversation.findFirst({ where: { id, tenantId: actor.tenantId, userId: actor.id }, select: { id: true } });
    if (!row) throw new AppError('NOT_FOUND', '对话不存在', 404);
    await this.db.aiConversation.delete({ where: { id: row.id } });
    return { ok: true };
  }

  async latestFollowUpDraft(actor: Actor, type: string, id: string) {
    const input = parse(draftInput, { target_type: type, target_id: id });
    const source = await this.context(actor, input.target_type, input.target_id);
    const sourceHash = hash(JSON.stringify(source.data));
    const rows = await this.db.auditLog.findMany({ where: { tenantId: actor.tenantId, actorId: actor.id, action: 'ai.follow_up_draft', resourceType: 'ai_follow_up_draft', resourceId: id }, orderBy: { createdAt: 'desc' }, take: 5 });
    const row = rows.find(item => { const data = item.after as { targetType?: string; sourceHash?: string } | null; return data?.targetType === type && data.sourceHash === sourceHash; });
    const value = row?.after as { draft?: z.infer<typeof draftSchema> } | null;
    return { result: value?.draft || null, generated_at: row?.createdAt || null };
  }

  async generateFollowUpDraft(actor: Actor, body: unknown) {
    const input = parse(draftInput, body);
    const source = await this.context(actor, input.target_type, input.target_id);
    const sourceHash = hash(JSON.stringify(source.data));
    const raw = await this.answer(actor, '你是 Sales 360 跟进助手。只能根据现有线索、客户、商机和跟进记录整理摘要与沟通问题。draft 是供销售编辑的待记录草稿，不得捏造已发生的电话、会议、承诺、报价或订单；缺失的实际沟通内容要明确待补充。', source.data, [{ role: 'user', content: '请生成可供人工核实和编辑的跟进草稿。' }], draftFormat);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new AppError('AI_INVALID_OUTPUT', 'AI 草稿格式无效，请重试', 502); }
    const result = draftSchema.safeParse(parsed);
    if (!result.success) throw new AppError('AI_INVALID_OUTPUT', 'AI 草稿格式无效，请重试', 502);
    const fresh = await this.context(actor, input.target_type, input.target_id);
    if (hash(JSON.stringify(fresh.data)) !== sourceHash) throw new AppError('VERSION_CONFLICT', '业务记录已更新，请重新生成草稿', 409);
    const row = await this.db.auditLog.create({ data: { tenantId: actor.tenantId, actorId: actor.id, action: 'ai.follow_up_draft', resourceType: 'ai_follow_up_draft', resourceId: input.target_id, after: { targetType: input.target_type, sourceHash, model: (await resolveAiConnection(this.db, actor.tenantId))?.model, draft: result.data } as Prisma.InputJsonValue } });
    return { result: result.data, generated_at: row.createdAt, source: { title: source.title, href: source.href } };
  }

  async chat(actor: Actor, body: unknown) {
    const input = parse(chatInput, body);
    const source = await this.context(actor, input.context_type, input.context_id);
    const old = input.conversation_id ? await this.get(actor, input.conversation_id) : null;
    if (old && (old.contextType !== input.context_type || old.contextId !== (input.context_id || null))) throw new AppError('AI_CONTEXT_CHANGED', '业务对象已切换，请新建对话', 409);
    const history = (old?.messages || []) as AiTurn[];
    const prompt = [...history, { role: 'user' as const, content: input.message }];
    const answer = await this.answer(actor, '你是 Sales 360 销售业务助手。根据当前线索、客户、商机或工作台数据回答；给出可核实的下一步和可复制的跟进草稿时，明确标记为建议，不能宣称已经保存。', { source: source.title, data: source.data }, prompt);
    const messages = [...prompt, { role: 'assistant' as const, content: answer }].slice(-20);
    let conversation;
    if (old) {
      const changed = await this.db.aiConversation.updateMany({ where: { id: old.id, tenantId: actor.tenantId, userId: actor.id, version: old.version }, data: { messages: messages as Prisma.InputJsonValue, version: { increment: 1 } } });
      if (!changed.count) throw new AppError('VERSION_CONFLICT', '对话已更新，请刷新后重试', 409);
      conversation = await this.db.aiConversation.findUniqueOrThrow({ where: { id: old.id } });
    } else {
      conversation = await this.db.aiConversation.create({ data: { tenantId: actor.tenantId, userId: actor.id, contextType: input.context_type, contextId: input.context_id, title: source.title, messages: messages as Prisma.InputJsonValue } });
    }
    await this.db.auditLog.create({ data: { tenantId: actor.tenantId, actorId: actor.id, action: 'ai.chat', resourceType: 'ai_conversation', resourceId: conversation.id, after: { contextType: input.context_type, contextId: input.context_id || null, model: (await resolveAiConnection(this.db, actor.tenantId))?.model } } });
    return { conversation_id: conversation.id, answer, messages, sources: [{ title: source.title, href: source.href }] };
  }
}
