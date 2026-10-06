import React from 'react';
import {createRoot} from 'react-dom/client';
import Page from '../../app/people-workbench/page';
import {PersonnelTaskLink} from '../../components/personnel-task-link';
const task={id:'personnel-self-expenses-member',sourceId:'member',title:'确认本人消费账单（1 笔）',assigneeName:'测试成员',detail:'核对原账单',project:'合成测试',kind:'task' as const,status:'open' as const,priority:'normal' as const,assigneeEmail:'member@test.invalid',sourceType:'manual' as const,createdByName:'测试成员',createdByEmail:'member@test.invalid',createdAt:'',updatedAt:'',completedAt:null,dueAt:null};
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('fixture')==='todo'?<PersonnelTaskLink item={task}/>:<Page/>);
