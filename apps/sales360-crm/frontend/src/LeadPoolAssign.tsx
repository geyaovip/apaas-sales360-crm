import { useEffect, useState } from 'react';
import { api, type Lead } from './api';

type Pool = { id: string; name: string; orgUnitId: string; active: boolean; members: { userId: string; active: boolean }[] };

export function LeadPoolAssign({ lead, onAssigned }: { lead: Lead; onAssigned: () => void }) {
  const [pools, setPools] = useState<Pool[]>([]); const [poolId, setPoolId] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { let live = true; api<Pool[]>('/admin/lead-pools').then(items => { if (live) setPools(items.filter(item => item.active && item.orgUnitId === lead.orgUnitId && item.members.some(member => member.active))); }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : '分配池加载失败'); }); return () => { live = false; }; }, [lead.orgUnitId]);
  async function assign() { if (!poolId) return; setBusy(true); setError(''); try { await api(`/admin/lead-pools/${poolId}/assign/${lead.id}`, { method: 'POST', body: { version: lead.version } }); onAssigned(); } catch (cause) { setError(cause instanceof Error ? cause.message : '轮转分配失败'); } finally { setBusy(false); } }
  if (!pools.length && !error) return null;
  return <div className="lead-pool-assign"><label className="field"><span>或按销售池轮转</span><select value={poolId} onChange={event => setPoolId(event.target.value)}><option value="">选择分配池</option>{pools.map(pool => <option key={pool.id} value={pool.id}>{pool.name}（{pool.members.length} 人）</option>)}</select></label><button className="button secondary full" disabled={!poolId || busy} onClick={assign}>{busy ? '分配中…' : '轮转分配'}</button>{error && <small role="alert" className="picker-error">{error}</small>}</div>;
}
