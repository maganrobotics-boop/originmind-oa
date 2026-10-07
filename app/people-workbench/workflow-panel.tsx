'use client';
import { useState } from 'react';
export type Weekly={id:string;member_id:string;member_name:string;source_title:string;source_text:string;title:string;content:string;state:string;approval_id:string|null;approval_status:string|null;current_reviewer_name:string|null;accepted:boolean;submittedContent:string;confirmed_at:string};
export type Dispute={id:string;target_type:string;target_id:string;member_id:string;member_name:string;assignee_member_id:string;assignee_name:string;reason:string;state:string;resolution:string;created_at:string;resolved_at:string};
export type Workflow={weekly:Weekly[];sources:{id:string;title:string;content:string;kind:string}[];disputes:Dispute[];isDisputeOwner:boolean;reviewerName:string;disputeOwnerName:string};
type Run=(body:object,success:string)=>Promise<boolean|undefined>;
const time=(s:string)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'';
export function WeeklyPanel({workflow,memberId,own,manager,busy,run}:{workflow:Workflow;memberId:string;own:boolean;manager:boolean;busy:boolean;run:Run}){
  const [title,setTitle]=useState(''),[source,setSource]=useState('');
  const entries=workflow.weekly.filter(w=>w.member_id===memberId);
  return <section className="pw-panel"><div className="pw-section-title"><h2>周报与本人工作确认</h2><span>审核人：{workflow.reviewerName||'待设置'}</span></div>
    <p>从周报带入 → 本人修改并确认 → 提交 OA → 任一指定技术审核人通过 → 负责人审核通过。只有审核通过的内容计入工作与绩效依据。</p>
    {own&&workflow.sources.length>0&&<details className="pw-source"><summary>可同步的本人周报（{workflow.sources.length}）</summary>{workflow.sources.map(s=><div className="pw-purchase" key={s.id}><span>{s.title} · {s.kind}</span><button disabled={busy} onClick={()=>void run({action:'work_create',memberId,sourceId:s.id},'周报已同步，请核对并修改本人工作。')}>带入周报</button></div>)}</details>}
    {(own||manager)&&!memberId.startsWith('bill:')&&<details className="pw-source"><summary>导入周报原文</summary><p>尚未接入 OA 的周报可以粘贴原文或上传 TXT。原文保留，工作内容由本人修改确认。</p><label>周报标题<input value={title} maxLength={150} onChange={e=>setTitle(e.target.value)} placeholder="例如：10 月第 1 周工作周报"/></label><label>周报原文<textarea rows={5} maxLength={20000} value={source} onChange={e=>setSource(e.target.value)}/></label><label>读取 TXT 文件<input type="file" accept=".txt,text/plain" onChange={async e=>{const f=e.target.files?.[0];if(f&&f.size<=60000){setSource((await f.text()).slice(0,20000));if(!title)setTitle(f.name.replace(/\.txt$/i,''));}e.target.value='';}}/></label><button disabled={busy||!title.trim()||!source.trim()} onClick={async()=>{if(await run({action:'work_create',memberId,title,sourceText:source},'周报已带入，等待本人修改确认。')){setTitle('');setSource('');}}}>导入并等待本人确认</button></details>}
    {entries.length?entries.map(w=><WeeklyCard key={w.id+':'+w.state+':'+w.content} entry={w} own={own} busy={busy} run={run} reviewer={workflow.reviewerName} owner={workflow.disputeOwnerName}/>):<p className="pw-empty">暂无已同步到该成员的周报。导入后由本人核对，未经确认不会生成已完成工作。</p>}
  </section>;
}
function WeeklyCard({entry:w,own,busy,run,reviewer,owner}:{entry:Weekly;own:boolean;busy:boolean;run:Run;reviewer:string;owner:string}){
  const [title,setTitle]=useState(w.title),[content,setContent]=useState(w.content),[reason,setReason]=useState('');
  const editable=own&&!w.approval_id&&w.state==='draft';
  return <article className="pw-work"><div><h3>{w.title}</h3><span className="pw-badge">{w.accepted?'已审核通过':w.approval_status||({draft:'待本人确认',submitting:'待重试提交',disputed:'异议处理中'} as Record<string,string>)[w.state]||w.state}</span></div>
    <details className="pw-source"><summary>查看周报原文：{w.source_title}</summary><pre>{w.source_text}</pre></details>
    {editable?<><label>工作标题<input value={title} maxLength={150} onChange={e=>setTitle(e.target.value)}/></label><label>核对并修改本人的实际工作<textarea rows={7} value={content} maxLength={3500} onChange={e=>setContent(e.target.value)}/></label><div className="pw-toolbar"><button disabled={busy||!content.trim()} onClick={()=>void run({action:'work_save',id:w.id,title,content},'修改已保存，尚未提交审核。')}>保存修改</button><button className="pw-primary" disabled={busy||!title.trim()||!content.trim()} onClick={()=>void run({action:'work_submit',id:w.id,title,content},'本人已确认，已提交 OA 审核。')}>本人确认并提交 {reviewer} 审核</button></div></>:<><p>本人提交内容</p><pre className="pw-work-text">{w.submittedContent||w.content||'待本人补充'}</pre>{w.confirmed_at&&<p>本人确认时间：{time(w.confirmed_at)}</p>}</>}
    {own&&!w.approval_id&&w.state==='submitting'&&<button disabled={busy} onClick={()=>void run({action:'work_submit',id:w.id},'已提交 OA 审核。')}>重试提交（保留已确认内容）</button>}
    {w.approval_id&&<p><a href={'/?approval='+encodeURIComponent(w.approval_id)}>查看原 OA 申请／审核意见</a> · 当前处理人：{w.current_reviewer_name||'已完成'}{w.approval_status==='已退回'?'；可在原申请修改后重新提交。':''}</p>}
    {editable&&<details className="pw-source"><summary>对此工作记录有异议</summary><p>异议会进入 {owner} 的 OA 待办。</p><textarea aria-label="工作异议原因" value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/><button disabled={busy||!reason.trim()} onClick={()=>void run({action:'work_dispute',id:w.id,reason},'异议已转交指定处理人。')}>提交异议</button></details>}
  </article>;
}
export function DisputesPanel({workflow,busy,run,onOpen}:{workflow:Workflow;busy:boolean;run:Run;onOpen:(d:Dispute)=>void}){
  const open=workflow.disputes.filter(d=>d.state==='open'),closed=workflow.disputes.filter(d=>d.state!=='open');
  if(!workflow.isDisputeOwner&&!workflow.disputes.length)return null;
  return <section className="pw-panel" id="disputes"><div className="pw-section-title"><h2>{workflow.isDisputeOwner?'我的异议待办':'异议处理记录'}</h2><span>待处理 {open.length} 条</span></div><p>异议由 {workflow.disputeOwnerName} 处理，处理后退回本人核对确认。</p>{open.map(d=><DisputeCard key={d.id} dispute={d} canResolve={workflow.isDisputeOwner} busy={busy} run={run} onOpen={onOpen}/>)}{!open.length&&<p>暂无待处理异议。</p>}{closed.length>0&&<details><summary>已处理（{closed.length}）</summary>{closed.map(d=><DisputeCard key={d.id} dispute={d} canResolve={false} busy={busy} run={run} onOpen={onOpen}/>)}</details>}</section>;
}
function DisputeCard({dispute:d,canResolve,busy,run,onOpen}:{dispute:Dispute;canResolve:boolean;busy:boolean;run:Run;onOpen:(d:Dispute)=>void}){
  const [resolution,setResolution]=useState('');
  return <article className="pw-work"><div><h3>{d.member_name} · {d.target_type==='expense'?'消费账单':'工作记录'}</h3><button onClick={()=>onOpen(d)}>查看对应记录</button></div><p>{time(d.created_at)} · 处理人：{d.assignee_name}</p><p className="pw-work-text">{d.reason}</p>{d.state==='resolved'?<p className="pw-notice">处理意见：{d.resolution} · {time(d.resolved_at)}</p>:canResolve&&<><label>处理意见<textarea value={resolution} maxLength={1500} rows={3} onChange={e=>setResolution(e.target.value)} placeholder="填写核实结果，以及需要本人修改或补充的内容"/></label><button className="pw-primary" disabled={busy||!resolution.trim()} onClick={()=>void run({action:'resolve_dispute',id:d.id,resolution},'处理意见已保存，已退回本人重新确认。')}>处理完成，退回本人确认</button></>}</article>;
}
