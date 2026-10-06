export const STAGES = Object.freeze({reported_settled:'已报销（本人填报）', reported_in_progress:'报销中（本人填报）', unknown:'待填写', receipts:'整理票据', ready:'待提交报销', submitted:'已提交审核', returned:'退回补充', awaiting:'审核完成·待到账', partial:'部分到账', settled:'已报销到账', exempt:'无需报销'});
export class LedgerError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export function cents(value) {
  const text=String(value).trim();
  if(!/^\d{1,9}(\.\d{1,2})?$/.test(text)) throw new LedgerError('金额格式不正确，请最多保留两位小数。');
  const [whole,decimal='']=text.split('.');return Number(whole)*100+Number(decimal.padEnd(2,'0'));
}
export function csvRows(text) {
  if(typeof text!=='string'||text.length>2_000_000)throw new LedgerError('账单文件最大为 2 MB。',413);
  let row=[],cell='',quoted=false,rows=[];
  for(let i=0;i<text.length;i++) { const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell){quoted=!quoted;}else cell+=c;}
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted)throw new LedgerError('CSV 引号未闭合，请上传完整原文件。');
  if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
export function parseAlipay(text,people) {
  const rows=csvRows(text.replace(/^\uFEFF/,''));
  const h=rows.findIndex(r=>r[0]?.trim()==='交易时间'&&r.includes('交易订单号'));
  if(h<0)throw new LedgerError('未找到支付宝交易明细表头。请选择“用于个人对账”的 CSV。');
  const headers=rows[h].map(v=>v.trim());
  for(const field of ['交易时间','交易分类','交易对方','商品说明','收/支','金额','交易订单号','商家订单号','交易状态','收/付款方式']) if(!headers.includes(field))throw new LedgerError('账单缺少字段：'+field);
  const allowed=new Map(people.map(p=>[p.bill_name,p.id]));const selected=[],seen=new Map();let sourceCount=0,ignoredCount=0;
  for(let i=h+1;i<rows.length;i++) {
    const r=rows[i];if(!r.some(v=>v.trim()))continue;
    if(r.length!==headers.length)throw new LedgerError('第 '+(i+1)+' 行列数不正确，请上传未经修改的原文件。');
    const raw=Object.fromEntries(headers.filter(Boolean).map((key,j)=>[key,r[j].trim()]));sourceCount++;
    const personId=allowed.get(raw['交易对方']);
    const kind=raw['交易分类']==='亲友代付'&&raw['收/支']==='支出'?'payment':raw['交易分类']==='退款'&&['退款-亲情卡','退款-代付'].includes(raw['商品说明'])&&raw['交易状态']==='退款成功'?'refund':null;
    if(!personId||!kind){ignoredCount++;continue;}
    if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw['交易时间'])||!Number.isFinite(Date.parse(raw['交易时间'].replace(' ','T')+'+08:00')))throw new LedgerError('交易时间不正确。');
    if(!/^[\w-]{10,100}$/.test(raw['交易订单号']))throw new LedgerError('交易订单号不正确。');
    const entry={id:raw['交易订单号'],order_no:raw['交易订单号'],merchant_order_no:raw['商家订单号'],person_id:personId,kind,amount_cents:cents(raw['金额']),occurred_at:raw['交易时间'],description:raw['商品说明'],payment_method:raw['收/付款方式'],trade_status:raw['交易状态'],source_json:JSON.stringify(raw),source_line:i+1};
    if(seen.has(entry.id)){if(core(seen.get(entry.id))!==core(entry))throw new LedgerError('文件内同一交易号对应了不同记录。');continue;}
    seen.set(entry.id,entry);selected.push(entry);
  }
  if(!selected.length)throw new LedgerError('文件中没有已登记人员的亲情卡或代付记录。');
  if(selected.length>5000)throw new LedgerError('单次最多导入 5000 条记录，请缩短导出时间。');
  return {transactions:selected,sourceCount,ignoredCount};
}
export function core(t){return JSON.stringify([t.person_id,t.kind,t.amount_cents,t.occurred_at,t.order_no,t.merchant_order_no]);}
export function assemble(people,transactions,claims=[],today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})) {
  const payments=transactions.filter(t=>t.kind==='payment'),refunds=transactions.filter(t=>t.kind==='refund');
  const claimMap=new Map(claims.map(c=>[c.transaction_id,c]));const links=new Map();const unmatched=[];
  for(const r of refunds){const matches=payments.filter(p=>p.person_id===r.person_id&&p.occurred_at<=r.occurred_at&&((r.merchant_order_no&&r.merchant_order_no!=='/'&&r.merchant_order_no===p.merchant_order_no)||r.order_no.includes(p.order_no)));if(matches.length===1){const list=links.get(matches[0].id)||[];list.push(r);links.set(matches[0].id,list);}else unmatched.push(r);}
  const records=payments.map(p=>{const linked=links.get(p.id)||[];const refundCents=linked.reduce((s,r)=>s+r.amount_cents,0);const netCents=p.amount_cents-refundCents;const claim=claimMap.get(p.id)||{transaction_id:p.id,stage:'unknown',reimbursed_cents:0,project_name:'',approval_id:'',expected_date:'',submitted_date:'',received_date:'',reference:'',note:'',handler:'',confirmation_status:'pending',confirmed_at:'',confirmed_by:'',confirmed_net_cents:null,confirmation_note:''};const person=people.find(x=>x.id===p.person_id);const confirmed=claim.confirmation_status==='confirmed'&&claim.confirmed_by===person?.member_id&&claim.confirmed_net_cents===netCents;const completed=confirmed&&(claim.stage==='reported_settled'||claim.stage==='exempt'||netCents===0||(claim.stage==='settled'&&claim.reimbursed_cents===netCents));return {...p,refunds:linked,refundCents,netCents,claim,confirmed,completed,anomaly:netCents<0||claim.reimbursed_cents>netCents,overdue:!completed&&Boolean(claim.expected_date)&&claim.expected_date<today};});
  const summaries=people.map(person=>{const rows=records.filter(r=>r.person_id===person.id);const ref=refunds.filter(r=>r.person_id===person.id).reduce((s,r)=>s+r.amount_cents,0);const gross=rows.reduce((s,r)=>s+r.amount_cents,0);const active=rows.filter(r=>!r.completed);const dates=active.map(r=>r.claim.expected_date);return {...person,paymentCount:rows.length,grossCents:gross,refundCents:ref,netCents:gross-ref,reimbursedCents:rows.reduce((s,r)=>s+r.claim.reimbursed_cents,0),exemptCents:rows.filter(r=>r.claim.stage==='exempt').reduce((s,r)=>s+Math.max(0,r.netCents),0),openCount:active.length,unknownCount:active.filter(r=>r.claim.stage==='unknown').length,overdueCount:active.filter(r=>r.overdue).length,unmatchedRefundCount:unmatched.filter(r=>r.person_id===person.id).length,expectedDate:active.length&&dates.every(Boolean)?dates.sort().at(-1):'',missingDateCount:dates.filter(d=>!d).length};});
  for(const p of summaries){p.unconfirmedCount=records.filter(r=>r.person_id===p.id&&!r.confirmed).length;p.disputedCount=records.filter(r=>r.person_id===p.id&&r.claim.confirmation_status==='disputed').length;}
  return {people:summaries,records,unmatchedRefunds:unmatched};
}
export function validateClaim(input,netCents,today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new LedgerError('报销进度格式不正确。');
  const fields=['stage','project_name','approval_id','expected_date','submitted_date','received_date','reimbursed_cents','reference','note','handler'];
  if(Object.keys(input).some(k=>!fields.includes(k)))throw new LedgerError('存在不支持的报销字段。');
  if(!Object.hasOwn(STAGES,input.stage))throw new LedgerError('报销阶段不正确。');
  const out={stage:input.stage,reimbursed_cents:input.reimbursed_cents??0};
  if(!Number.isSafeInteger(out.reimbursed_cents)||out.reimbursed_cents<0||out.reimbursed_cents>netCents)throw new LedgerError('已到账金额不能超过扣除退款后的支出。');
  for(const key of fields.filter(k=>!['stage','reimbursed_cents'].includes(k))){if(typeof(input[key]??'')!=='string')throw new LedgerError('填写内容格式不正确。');out[key]=(input[key]??'').trim();if(out[key].length>(key==='note'?1500:200))throw new LedgerError('填写内容过长。');}
  for(const key of ['expected_date','submitted_date','received_date'])if(out[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(out[key])||!Number.isFinite(Date.parse(out[key]))||new Date(out[key]).toISOString().slice(0,10)!==out[key]))throw new LedgerError('请填写有效日期。');
  if(out.submitted_date>today||out.received_date>today)throw new LedgerError('实际提交和到账日期不能晚于今天。');
  if(out.received_date&&out.submitted_date&&out.received_date<out.submitted_date)throw new LedgerError('到账日期不能早于提交日期。');
  if(['submitted','returned','awaiting','partial','settled'].includes(out.stage)&&!out.submitted_date)throw new LedgerError('请填写实际提交报销日期。');
  if(['partial','settled'].includes(out.stage)&&(!out.received_date||!out.reference||out.reimbursed_cents<=0))throw new LedgerError('请填写到账金额、到账日期和报销单号或回单依据。');
  if(out.stage==='settled'&&out.reimbursed_cents!==netCents)throw new LedgerError('全部报完要求到账金额等于本笔净支出；否则请选择部分到账。');
  if(out.stage==='partial'&&out.reimbursed_cents>=netCents)throw new LedgerError('全部到账请选择已报销到账。');
  if(!['partial','settled'].includes(out.stage)&&out.reimbursed_cents!==0)throw new LedgerError('填写到账金额时请选择部分到账或已报销到账。');
  if(['returned','exempt'].includes(out.stage)&&!out.note)throw new LedgerError('请说明退回原因或无需报销的原因。');
  if(netCents<0)throw new LedgerError('退款超过原支出，请先核对账单。');return out;
}
