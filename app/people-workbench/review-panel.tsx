'use client';
import {useState} from 'react';
export type Review={state:string;financeAt:string;ownerAt:string;archivedAt:string;returnNote:string;canArchive:boolean;locked:boolean};
export type ReviewPolicy={technicalNames:string[];financeName:string;ownerName:string;isFinance:boolean;isOwner:boolean};
export const reviewLabel=(review?:Review)=>review?({confirmation:'待本人确认',finance:'待财务审核',owner:'待负责人审核',payment:'审核通过，待报销完成',archived:'已归档'} as Record<string,string>)[review.state]||'待核对':'';
export function ReviewPanel({id,review,policy,busy,onSave}:{id:string;review?:Review;policy?:ReviewPolicy|null;busy:boolean;onSave:(body:object)=>Promise<boolean|undefined>}){
  const [note,setNote]=useState('');
  if(!review||!policy)return null;
  const canReview=policy.isFinance&&review.state==='finance'||policy.isOwner&&review.state==='owner';
  return <section className="pw-panel"><h3>审核与归档 · {reviewLabel(review)}</h3><p>{policy.financeName} 财务审核 → {policy.ownerName} 审核 → 全部报销完成 → 归档</p>{review.returnNote&&<p className="pw-error">退回说明：{review.returnNote}</p>}{review.financeAt&&<p>财务已审核：{new Date(review.financeAt).toLocaleString('zh-CN')}</p>}{review.ownerAt&&<p>负责人已审核：{new Date(review.ownerAt).toLocaleString('zh-CN')}</p>}{review.archivedAt&&<p>归档时间：{new Date(review.archivedAt).toLocaleString('zh-CN')}</p>}{!review.locked&&(policy.isFinance||policy.isOwner)&&<><label>审核意见／退回问题<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={1000} rows={2}/></label><div className="pw-confirm-bar">{canReview&&<button className="pw-primary" disabled={busy} onClick={()=>void onSave({action:review.state==='finance'?'review_finance':'review_owner',ids:[id],note})}>{review.state==='finance'?'财务通过，交负责人审核':'负责人审核通过'}</button>}<button disabled={busy||!note.trim()} onClick={()=>void onSave({action:'review_return',ids:[id],note})}>退回补充，重新审核</button></div></>}<small>本人填报“已报销”后仍需财务核实全额到账。金额、归属或材料改变后须重审；未报完或有问题不能归档。</small></section>;
}
