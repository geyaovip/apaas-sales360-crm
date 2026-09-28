import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, errorText } from './api';

type Draft = { summary: string; questions: string[]; draft: string };

export function AiFollowUp({ targetType, targetId, onUse }: { targetType: 'customer' | 'opportunity'; targetId: string; onUse: (content: string) => void }) {
  const [result, setResult] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; api<{ result: Draft | null }>(`/ai/follow-up-drafts/${targetType}/${targetId}`).then(value => { if (active) setResult(value.result); }).catch(() => {}); return () => { active = false; }; }, [targetType, targetId]);
  async function generate() {
    setBusy(true); setError('');
    try { const value = await api<{ result: Draft }>('/ai/follow-up-drafts', { method: 'POST', body: { target_type: targetType, target_id: targetId } }); setResult(value.result); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <section className="panel ai-insight"><div className="panel-title"><h2><Sparkles size={17}/> AI 跟进助手</h2><button type="button" className="button secondary" disabled={busy} onClick={() => void generate()}>{busy ? '生成中…' : result ? '重新生成' : '生成跟进草稿'}</button></div><p className="muted">根据当前客户或商机记录整理；实际沟通内容请在保存前核实。</p>{error && <div className="notice error" role="alert">{error}</div>}{result && <div className="ai-insight-body"><p>{result.summary}</p>{result.questions.length > 0 && <><strong>下次沟通可核实</strong><ul>{result.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></>}<strong>待编辑的跟进草稿</strong><p className="ai-draft">{result.draft}</p><button type="button" className="button primary" onClick={() => onUse(result.draft)}>编辑并记录跟进</button></div>}</section>;
}
