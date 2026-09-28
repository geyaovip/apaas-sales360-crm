import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
config();

const base = process.env.TEST_API_URL || 'http://127.0.0.1:4301/api/v1';
const nonce = randomUUID().slice(0, 8);

async function request(path, method = 'GET', body, cookie, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json();
  return { status: response.status, body: json, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login(email, password) {
  const result = await request('/auth/login', 'POST', { workspace: 'default', email, password });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.cookie;
}
function ok(result, expected = 201) { assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body; }

const admin = await login(process.env.CRM_BOOTSTRAP_EMAIL, process.env.CRM_BOOTSTRAP_PASSWORD);
const orgs = ok(await request('/org-units', 'GET', undefined, admin), 200);
const orgId = orgs.find(o => o.name === '总部').id;
const password = `LocalTest-${nonce}-Strong!`;
const sales = ok(await request('/admin/users', 'POST', { email: `sales-${nonce}@example.local`, name: `销售${nonce}`, password, org_unit_id: orgId, role: 'sales' }, admin));
const other = ok(await request('/admin/users', 'POST', { email: `other-${nonce}@example.local`, name: `其他销售${nonce}`, password, org_unit_id: orgId, role: 'sales' }, admin));
const manager = ok(await request('/admin/users', 'POST', { email: `manager-${nonce}@example.local`, name: `主管${nonce}`, password, org_unit_id: orgId, role: 'manager' }, admin));
const lead = ok(await request('/leads', 'POST', { name: `真实测试客户${nonce}`, contact_name: '王先生', contact_phone: `1300000${nonce}`, source: '官网', org_unit_id: orgId }, admin));
const assigned = ok(await request(`/leads/${lead.id}/assign`, 'POST', { assignee_id: sales.id, version: lead.version, reason: '测试分配' }, admin));
const salesCookie = await login(sales.email, password);
const otherCookie = await login(other.email, password);
assert.equal((await request(`/leads/${lead.id}`, 'GET', undefined, otherCookie)).status, 404);
const reassigned = ok(await request(`/leads/${lead.id}/assign`, 'POST', { assignee_id: other.id, version: assigned.version }, admin));
const assignedAgain = ok(await request(`/leads/${lead.id}/assign`, 'POST', { assignee_id: sales.id, version: reassigned.version }, admin));
assert.equal(assignedAgain.assignedAt, assigned.assignedAt, 'first assignment date remains stable for reporting');
const accepted = ok(await request(`/leads/${lead.id}/accept`, 'POST', { version: assignedAgain.version }, salesCookie));
const qualified = ok(await request(`/leads/${lead.id}/qualify`, 'POST', { version: accepted.version }, salesCookie));
const requested = ok(await request(`/leads/${lead.id}/request-conversion`, 'POST', { version: qualified.version }, salesCookie));
const managerCookie = await login(manager.email, password);
const approved = ok(await request(`/leads/${lead.id}/review-conversion`, 'POST', { decision: 'approve', version: requested.lead.version }, managerCookie));
const key = randomUUID();
const payload = { customer_id: null, create_opportunity: true, opportunity_name: `采购项目${nonce}` };
const converted = ok(await request(`/leads/${lead.id}/convert`, 'POST', payload, salesCookie, { 'idempotency-key': key }));
const retry = ok(await request(`/leads/${lead.id}/convert`, 'POST', payload, salesCookie, { 'idempotency-key': key }));
assert.deepEqual(converted, retry);
const customer = ok(await request(`/customers/${converted.customer_id}`, 'GET', undefined, salesCookie), 200);
assert.equal(customer.name, lead.name);
const opportunity = ok(await request(`/opportunities/${converted.opportunity_id}`, 'GET', undefined, salesCookie), 200);
const advanced = ok(await request(`/opportunities/${opportunity.id}/advance`, 'POST', { version: opportunity.version }, salesCookie));
assert.equal(advanced.stage, 'proposal');
ok(await request('/follow-ups', 'POST', { target_type: 'opportunity', target_id: opportunity.id, type: 'call', content: '已沟通采购需求', next_at: new Date(Date.now() + 86400000).toISOString() }, salesCookie));
const dashboard = ok(await request('/dashboard', 'GET', undefined, salesCookie), 200);
assert.ok(dashboard.active_opportunities >= 1);
const timeline = ok(await request(`/leads/${lead.id}/timeline`, 'GET', undefined, salesCookie), 200);
assert.ok(timeline.some(x => x.action === 'lead.converted'));
assert.equal((await request(`/customers/${customer.id}`, 'GET', undefined, otherCookie)).status, 404);
const csm = ok(await request('/admin/users', 'POST', { email: `csm-${nonce}@example.local`, name: `客户成功${nonce}`, password, org_unit_id: orgId, role: 'csm' }, admin));
const otherCsm = ok(await request('/admin/users', 'POST', { email: `other-csm-${nonce}@example.local`, name: `其他客户成功${nonce}`, password, org_unit_id: orgId, role: 'csm' }, admin));
ok(await request(`/csm/customers/${customer.id}/assign`, 'POST', { csm_user_id: csm.id, version: customer.version }, admin));
const csmCookie = await login(csm.email, password);
const otherCsmCookie = await login(otherCsm.email, password);
const plan = ok(await request('/csm/plans', 'POST', { customer_id: customer.id, title: `上线陪跑${nonce}`, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() }, csmCookie));
assert.equal((await request(`/csm/plans/${plan.id}`, 'GET', undefined, otherCsmCookie)).status, 403);
const serviceTask = ok(await request(`/csm/plans/${plan.id}/tasks`, 'POST', { title: '完成首次培训', assignee_id: csm.id, due_at: new Date(Date.now() + 86400000).toISOString() }, csmCookie));
const submitted = ok(await request(`/csm/tasks/${serviceTask.id}/submit`, 'POST', { completion_note: '已完成客户培训并记录反馈', version: serviceTask.version }, csmCookie));
assert.equal((await request(`/csm/tasks/${serviceTask.id}/review`, 'POST', { decision: 'approve', version: submitted.version }, csmCookie)).status, 403);
const reviewed = ok(await request(`/csm/tasks/${serviceTask.id}/review`, 'POST', { decision: 'approve', version: submitted.version }, managerCookie));
assert.equal(reviewed.status, 'approved');
const risk = ok(await request('/csm/risks', 'POST', { customer_id: customer.id, title: '上线延期风险', severity: 'high', detail: '客户内部评审延期' }, csmCookie));
const closed = ok(await request(`/csm/risks/${risk.id}/close`, 'POST', { resolution: '与客户重新确认上线排期' }, csmCookie));
assert.equal(closed.status, 'closed');
const renewal = ok(await request('/csm/renewals', 'POST', { customer_id: customer.id, name: '年度续约', amount: '8000.00', expected_close_at: new Date(Date.now() + 90 * 86400000).toISOString() }, csmCookie));
assert.equal(renewal.kind, 'renewal');
const serviceReport = ok(await request('/csm/report', 'GET', undefined, csmCookie), 200);
assert.ok(serviceReport.approved_tasks >= 1 && serviceReport.renewal_opportunities >= 1);
console.log('PASS Sales 360 API core flow: lead conversion, CRM, CSM plans/tasks/review/risk/renewal, idempotency and role isolation');
