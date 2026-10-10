'use client';
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, Trophy, UsersRound } from 'lucide-react';
type Result = { id:string; createdAt:string; mapId:string; mapName:string; status:string; ranked:boolean; rankTime:number|null; time:number; found:number; total:number; returned:boolean; quickPractice:boolean; failureReason?:string };
type Player = { email:string; displayName:string; lastSeen:number; testCount:number|null; completedCount:number|null; best:Result|null; latest:Result|null; recentResults:Result[]; pendingJobs:number; resultsError:string };
type Dashboard = { window:string; mode:string; mapId:string; asOf:number; maps:{id:string;name:string}[]; records:Player[];
  source:{status:'connected'|'partial'|'not_connected'|'unavailable';message:string};
  summary:{onlineCounts:Record<string,number|null>;active:number|null;tested:number|null;tests:number|null;completed:number|null;unavailable:number|null};
  pagination:{page:number;total:number;totalPages:number};note:string };
const windows=[{id:'24h',label:'过去24小时'},{id:'3d',label:'近3天'},{id:'7d',label:'近7天'}];
const date=(value:number|string)=>new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});
const duration=(seconds:number|null|undefined)=>typeof seconds==='number' && Number.isFinite(seconds)?`${Math.floor(seconds/60)}分${(seconds%60).toFixed(1)}秒`:'—';
const statusNames:Record<string,string>={COMPLETE:'已完成',INCOMPLETE:'未完成',CANCELLED:'已取消',FAILED:'失败',RUNNING:'运行中',QUEUED:'等待评测',INTERRUPTED:'已中断'};
function Score({result}:{result:Result|null}) {
  if(!result)return <span className="fs-no-score">本期暂无成绩</span>;
  return <><strong>{result.found}/{result.total} 块 · {result.returned?'已返回':'未返回'}</strong><small>{statusNames[result.status] || result.status} · {result.quickPractice?'用时':result.ranked?'平均用时':'首轮用时'} {duration(!result.quickPractice && result.ranked ? result.rankTime : result.time)}</small></>;
}
export function ArenaOverview({onAwards}:{onAwards:()=>void}) {
 const [window,setWindow]=useState('24h'),[mapId,setMapId]=useState(''),[mode,setMode]=useState('auto'),[sort,setSort]=useState('best');
 const [search,setSearch]=useState(''),[q,setQ]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
 const [data,setData]=useState<Dashboard|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');setData(null);
  const params=new URLSearchParams({view:'arena',window,mapId,mode,sort,q,page:String(page)});
  void fetch('/api/admin/future-stars?'+params,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
   const body=await response.json() as Dashboard & {error?:string};if(!response.ok)throw new Error(body.error || '竞技场统计暂不可用。');
   if(!controller.signal.aborted)setData(body);
  }).catch(error=>{if(!controller.signal.aborted){setData(null);setError(error instanceof Error?error.message:'读取未完成。');}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return ()=>controller.abort();
 },[window,mapId,mode,sort,q,page,revision]);
 return <div className="fs-arena-overview">
  <div className="fs-time-cards" aria-label="竞技场近期上线人数">{windows.map(item=><button key={item.id} type="button" className="fs-time-card" aria-pressed={window===item.id} onClick={()=>{setWindow(item.id);setMapId('');setMode('auto');setPage(1);}}><span>{item.label}</span><strong>{loading || !data?'—':data.summary.onlineCounts[item.id] ?? '—'}<small>人上线</small></strong><em>竞技场账户 · 去重人数</em></button>)}</div>
  <div className="fs-section-heading fs-arena-heading"><div><h2>竞技场上线与成绩</h2><p>只看近期上线的人，以及他们在所选时段的测试成绩。</p></div><div className="fs-inline"><button type="button" onClick={onAwards}><Trophy size={15}/>获奖登记</button><button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={15}/>刷新</button></div></div>
  <form className="fs-filters" onSubmit={event=>{event.preventDefault();setQ(search.trim());setPage(1);}}>
   <label className="fs-search"><Search size={16}/><input aria-label="搜索竞技场用户" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索姓名或邮箱" maxLength={100}/></label>
   <select aria-label="成绩地图" value={mapId || data?.mapId || ''} onChange={event=>{setMapId(event.target.value);setMode('auto');setPage(1);}}>{!data?.maps.length&&<option value="">暂无近期测试地图</option>}{data?.maps.map(map=><option key={map.id} value={map.id}>{map.name}</option>)}</select>
   <select aria-label="测试模式" value={mode==='auto'?data?.mode || 'full':mode} onChange={event=>{setMode(event.target.value);setPage(1);}}><option value="quick">快速练习</option><option value="full">完整挑战</option></select>
   <select aria-label="竞技场排序方式" value={sort} onChange={event=>{setSort(event.target.value);setPage(1);}}><option value="best">本期最好成绩优先</option><option value="recent">最近活动优先</option><option value="tests">测试次数最多优先</option></select><button type="submit">查询</button>
  </form>
  {!loading&&data&&['connected','partial'].includes(data.source.status)&&<><p className="fs-activity-caption">{windows.find(item=>item.id===window)?.label} · {data.summary.active ?? '—'} 人上线 · 所选地图与模式 {data.summary.tested ?? '—'} 人测试 / {data.summary.tests ?? '—'} 次结果 / {data.summary.completed ?? '—'} 次完成<span>截至 {date(data.asOf)}（北京时间）</span></p><p className="fs-footnote">{data.note}</p>{(data.summary.unavailable ?? 0)>0&&<p className="fs-error" role="alert">{data.summary.unavailable} 人的成绩暂未完整读取，汇总暂不显示，不能视为零；请刷新重试。</p>}</>}
  {!loading && data && ['not_connected','unavailable'].includes(data.source.status) && <div className="fs-empty" role="status"><UsersRound size={25}/><strong>{data.source.message}</strong><p>{data.note}</p></div>}
  {error&&<div className="fs-error" role="alert">{error}<button type="button" onClick={()=>setRevision(n=>n+1)}>重新读取</button></div>}
  {loading?<div className="fs-empty" role="status"><RefreshCw size={22}/>正在读取竞技场上线与成绩…</div>:data&&['connected','partial'].includes(data.source.status)&&<>
   {data.records.length===0?<div className="fs-empty"><UsersRound size={25}/>{data.source.status==='partial'?'暂未读到符合条件的记录，数据不完整。':'所选时段没有符合条件的上线用户。'}</div>:<div className="fs-arena-players">{data.records.map((row,index)=><article className="fs-arena-player" key={row.email}>
    <div className="fs-arena-row"><div className="fs-person"><b className="fs-rank">{(page-1)*20+index+1}</b><span>{row.displayName.slice(0,1)}</span><div><h3>{row.displayName}</h3><p>{row.email}</p><small>最近活动 {date(row.lastSeen)}</small></div></div>
     <div className="fs-arena-score"><label>本期最好成绩</label>{row.resultsError?<small>{row.resultsError}</small>:<Score result={row.best}/>}</div>
     <div className="fs-arena-score"><label>最近一次</label>{row.resultsError?<small>暂不可确认</small>:<Score result={row.latest}/>}{row.latest&&<small>{date(row.latest.createdAt)}</small>}</div>
     <div className="fs-arena-count"><strong>{row.resultsError?'—':row.testCount}<small>次结果</small></strong><span>完成 {row.resultsError?'—':row.completedCount} 次</span>{row.pendingJobs>0&&<span>{row.pendingJobs} 次评测进行中</span>}</div>
    </div>
    {row.recentResults.length>0&&<details className="fs-arena-details"><summary>查看本期最近 {row.recentResults.length} 次测试</summary><div>{row.recentResults.map(run=><div className="fs-arena-run" key={run.id}><time>{date(run.createdAt)}</time><span>{statusNames[run.status] || run.status} · {run.found}/{run.total} 块 · {run.returned?'已返回':'未返回'} · {run.quickPractice?'用时':run.ranked?'平均用时':'首轮用时'} {duration(!run.quickPractice && run.ranked ? run.rankTime : run.time)}</span>{run.failureReason&&<small>{run.failureReason}</small>}</div>)}</div></details>}
   </article>)}</div>}
   <div className="fs-pages"><span>共 {data.pagination.total} 位已知活跃用户 · 第 {page} 页</span><button type="button" disabled={page<=1} onClick={()=>setPage(n=>n-1)}><ChevronLeft size={14}/>上一页</button><button type="button" disabled={page>=data.pagination.totalPages} onClick={()=>setPage(n=>n+1)}>下一页<ChevronRight size={14}/></button></div>
  </>}
 </div>;
}
