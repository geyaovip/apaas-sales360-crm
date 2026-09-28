export type Role = 'admin' | 'marketing' | 'manager' | 'sales' | 'csm';
export interface Membership { role: Role; orgUnitId: string }
export interface Session { user: { id: string; name: string; email: string; memberships: Membership[] }; tenant: { id: string; name: string; slug: string } }
export interface Org { id: string; name: string; parentId: string | null }
export interface User { id: string; name: string; email?: string; memberships: Membership[] }
export interface Lead { id: string; name: string; contactName?: string | null; contactPhone?: string | null; contactEmail?: string | null; source: string; notes?: string | null; status: string; ownerId?: string | null; orgUnitId: string; version: number; createdAt: string; updatedAt: string; firstProcessedAt?: string | null }
export interface Customer { id: string; name: string; registrationId?: string | null; industry?: string | null; region?: string | null; ownerId: string; serviceOwnerId?: string | null; orgUnitId: string; status: string; version: number; createdAt: string; contacts?: Contact[]; opportunities?: Opportunity[] }
export interface Contact { id: string; name: string; title?: string | null; phone?: string | null; email?: string | null; version: number }
export interface Opportunity { id: string; name: string; customerId: string; customer?: { id: string; name: string }; ownerId: string; orgUnitId: string; stage: string; amount: string; currency: string; probability: number; expectedCloseAt?: string | null; nextAction?: string | null; nextActionAt?: string | null; version: number; updatedAt: string }
export interface FollowUp { id: string; targetType: string; targetId: string; type: string; content: string; occurredAt: string; nextAt?: string | null }
export interface Task { id: string; title: string; targetType: string; targetId: string; dueAt?: string | null; status: string; createdAt: string }
export interface Paged<T> { items: T[]; total: number; page: number; page_size: number }
export interface Dashboard { pending_leads: number; active_opportunities: number; due_today: number; overdue: number; expected_amount_cny: string; expected_amount_note: string; open_tasks: Task[]; recent_follow_ups: FollowUp[] }
export interface ServiceTask { id: string; planId: string; title: string; assigneeId: string; dueAt: string; status: string; completionNote?: string | null; reviewReason?: string | null; version: number }
export interface ServicePlan { id: string; customerId: string; customer?: { id: string; name: string; serviceOwnerId?: string | null; ownerId?: string; orgUnitId?: string }; title: string; ownerId: string; startsAt: string; endsAt: string; status: string; note?: string | null; tasks?: ServiceTask[]; _count?: { tasks: number } }
export interface ServiceRisk { id: string; customerId: string; customer?: { id: string; name: string }; title: string; severity: string; detail: string; status: string; resolution?: string | null; ownerId: string; createdAt: string }
export interface ServiceReport { plans: number; open_risks: number; approved_tasks: number; pending_tasks: number; renewal_opportunities: number; definition: string }

export class ApiError extends Error { constructor(public code: string, message: string, public status: number, public details: Record<string, unknown> = {}) { super(message); } }
export async function api<T>(path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method: options.method || 'GET', credentials: 'include', headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}) }, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error?.code || 'HTTP_ERROR', data.error?.message || `请求失败 (${response.status})`, response.status, data.error?.details || {});
  return data as T;
}
export function query(params: Record<string, string | number | undefined | null>) { const s = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') s.set(key, String(value)); }); return s.toString(); }
export function errorText(error: unknown) { return error instanceof Error ? error.message : '操作失败，请稍后重试'; }
export const leadStatus: Record<string, string> = { new: '待分配', assigned: '待接受', working: '跟进中', returned: '已退回', qualified: '已确认有效', conversion_pending: '待审核转化', conversion_approved: '可转化', converted: '已转化', invalid: '无效' };
export const opportunityStage: Record<string, string> = { discovery: '发现需求', proposal: '方案沟通', negotiation: '商务谈判', won: '已赢单', lost: '已输单' };
export function date(value?: string | null) { return value ? new Date(value).toLocaleDateString('zh-CN') : '—'; }
export function dateTime(value?: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
