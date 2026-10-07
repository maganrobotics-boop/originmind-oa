import Link from 'next/link';
import type { WorkItem } from '@/lib/project-work-items';
export function PersonnelTaskLink({item}:{item:WorkItem}){
  const self=item.id.startsWith('personnel-self-');
  const owner=item.id.startsWith('personnel-review-owner-');
  const finance=owner||item.id.startsWith('personnel-finance-');
  const work=item.id.startsWith('personnel-self-work-');
  const reimbursement=item.id.startsWith('personnel-self-reimbursement-');
  const href=finance?'/people-workbench':self?'/people-workbench?person='+encodeURIComponent(item.sourceId)+'&tab='+(work?'work':'expenses')+'&filter='+(reimbursement?'open':'pending'):'/people-workbench?disputes=1';
  const label=owner?'审核报销':finance?'财务台账':self?(work?'核对工作':reimbursement?'跟进报销':'确认账单'):'处理异议';
  return <article className="project-task urgent"><div><strong>{item.title}</strong><p>{item.assigneeName} · {self?'由本人处理':'由指定处理人处理'}</p>{(self||finance)&&<p>{item.detail}</p>}</div><Link href={href}>{label}</Link></article>;
}
