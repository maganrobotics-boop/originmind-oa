import { createHash, randomBytes } from 'node:crypto';

const fileOperations = { list: 'file_list', read: 'file_read', write: 'file_write', mkdir: 'file_mkdir', move: 'file_move', trash: 'file_trash' };
const mutating = new Set(['file_write','file_mkdir','file_move','file_trash','command_start','job_cancel','service']);
const pause = (ms, signal) => new Promise((resolve,reject) => {
  signal?.throwIfAborted();
  const finish = () => { signal?.removeEventListener('abort',abort); resolve(); };
  const timer = setTimeout(finish,ms);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); reject(new Error('OPERATION_CANCELLED')); };
  signal?.addEventListener('abort',abort,{once:true});
});

export async function executeAssistantOperation(name, args, { state, call, webSearch, signal, cache, capabilities, serviceGrants }) {
  if (name === 'assistant_capabilities') return {ok:true,action:'assistant_capabilities',capabilities,scope:'当前已激活的OA管理员；命令和文件在服务器独立工作区运行，服务管理按当前明确指令执行，凭据由系统保管。',productionSourceEditing:false,productionDeployTool:false};
  if (name === 'ui_layout') {
    const action = args.layout === 'expanded' ? 'expand_layout' : 'compact_layout';
    return { ok:true, action:'ui_layout',layout:args.layout,uiAction:action,appliesInBrowser:true };
  }
  if (name === 'web_search') {
    if (typeof webSearch !== 'function') throw new Error('WEB_SEARCH_NOT_CONFIGURED');
    const result=await webSearch(args.query,{signal});
    if (result.searched !== true || !Array.isArray(result.sources) || !result.sources.length) throw new Error('WEB_SEARCH_NOT_CONFIRMED');
    return { ok:true,action:'web_search',answer:result.answer,sources:result.sources,searched:true,untrusted:true };
  }
  let parameters;
  if (name === 'workspace_file') {
    parameters={operation:fileOperations[args.operation],path:args.path || '.'};
    for (const key of ['content','expectedSha256','destination']) if (Object.hasOwn(args,key)) parameters[key]=args[key];
  } else if (name === 'command_start') parameters={operation:'command_start',command:args.command,timeoutSeconds:args.timeoutSeconds ?? 60};
  else if (name === 'command_status') parameters={operation:'job_status',jobId:args.jobId};
  else if (name === 'command_cancel') parameters={operation:'job_cancel',jobId:args.jobId};
  else if (name === 'service_control') {
    if (!serviceGrants.some(grant=>grant.server===args.server && grant.service===args.service.replace(/\.service$/u,'') && grant.verb===args.verb)) throw Object.assign(new Error('CURRENT_SERVICE_INSTRUCTION_REQUIRED'),{operationError:'current_service_instruction_required'});
    parameters={operation:'service',service:args.service.endsWith('.service') ? args.service : `${args.service}.service`,verb:args.verb};
  }
  else return null;
  const key=createHash('sha256').update(JSON.stringify([args.server,parameters])).digest('hex');
  if (mutating.has(parameters.operation)) {
    if (cache.has(key)) return cache.get(key);
    parameters.requestId=state.pendingOperations[key] ??= randomBytes(16).toString('hex');
  }
  let result=await call(args.server,'operations',parameters,{signal});
  if (result.operation !== parameters.operation) throw new Error('INVALID_OPERATION_RECEIPT');
  if (parameters.operation === 'command_start' && result.state === 'running') {
    for (let attempt=0;attempt<6 && result.state==='running';attempt++) {
      await pause(500,signal);
      const status=await call(args.server,'operations',{operation:'job_status',jobId:result.jobId},{signal});
      if (status.operation!=='job_status' || status.jobId!==result.jobId) throw new Error('INVALID_JOB_RECEIPT');
      result={...result,...status,operation:'command_start'};
    }
  }
  if (mutating.has(parameters.operation)) { cache.set(key,result);delete state.pendingOperations[key]; }
  return result;
}

export function operationSummary(data) {
  if (data.action === 'assistant_capabilities') return '已核对当前助手授权';
  if (data.action === 'ui_layout') return data.layout === 'expanded' ? '当前助手页面已铺满' : '当前助手页面已切换窄版';
  if (data.action === 'web_search') return `已联网检索 ${data.sources.length} 个来源`;
  if (data.operation?.startsWith('file_')) return ({file_list:'已列出工作区文件',file_read:'已读取工作区文件',file_write:'工作区文件已保存',file_mkdir:'工作区目录已创建',file_move:'工作区文件已移动',file_trash:'工作区文件已移入回收站'})[data.operation];
  if (data.operation === 'service') return `${data.service}：${data.verb} 已执行，${data.statusVerified ? '状态已核对' : '状态待核对'}`;
  return `命令任务 ${data.jobId}：${({running:'运行中',succeeded:'成功',failed:'失败',cancelled:'已取消',uncertain:'结果待核对'})[data.state] || '状态待核对'}${Number.isInteger(data.exitCode) ? `，退出码 ${data.exitCode}` : ''}`;
}
