const SERVERS = ['aliyun', 'tencent'];
export const ASSISTANT_CAPABILITIES = ['files', 'commands', 'services', 'web', 'ui'];
const SERVICES = { aliyun: ['nginx', 'originmind-oa', 'originmind-chat'], tencent: ['nginx', 'docker', 'originmind-arena', 'originmind-cloud-mcp'] };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, maximum, empty = false) => typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0) && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const path = value => text(value, 240) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || ['.', '..'].includes(part));
const server = { type: 'string', enum: SERVERS };
const spec = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
export function validCapabilities(value) { return Array.isArray(value) && value.length <= ASSISTANT_CAPABILITIES.length && new Set(value).size === value.length && value.every(item => ASSISTANT_CAPABILITIES.includes(item)); }
export function serviceAuthority(question) {
  const text=question.normalize('NFKC');
  if (/[?？“”"'「」『』]/u.test(text) || /不要|不用|禁止|停止|取消|怎么|如何|为什么|是否|能否|可以|会不会|吗/u.test(text)) return [];
  const verb=/重启|重新启动|restart/iu.test(text) ? 'restart' : /重载|reload/iu.test(text) ? 'reload' : /启动|开启|start/iu.test(text) ? 'start' : null;
  if (!verb) return [];
  const units=Object.values(SERVICES).flat().filter((unit,index,array)=>array.indexOf(unit)===index && (text.toLowerCase().includes(unit) || unit==='originmind-oa' && /\bOA\b/iu.test(text) || unit==='originmind-chat' && /\bChat\b|对外大模型/iu.test(text)));
  const selected=/两(?:台|个)|阿里[\s\S]*腾讯|腾讯[\s\S]*阿里/u.test(text) ? SERVERS : /阿里/u.test(text) ? ['aliyun'] : /腾讯/u.test(text) ? ['tencent'] : [];
  return units.flatMap(service => {
    const owners=SERVERS.filter(server=>SERVICES[server].includes(service));
    return (selected.length ? selected.filter(server=>owners.includes(server)) : owners.length===1 ? owners : []).map(server=>({server,service,verb}));
  });
}
export function operationTools(capabilities = []) {
  const has = name => capabilities.includes(name);
  return [
    ...(capabilities.length ? [spec('assistant_capabilities','查询当前管理员实际已启用的助手能力及执行范围。',{},[])] : []),
    ...(has('ui') ? [spec('ui_layout', '实际调整当前助手页面布局。expanded 铺满页面；compact 恢复窄版。浏览器级全屏请使用顶部全屏按钮。', { layout: { type: 'string', enum: ['expanded', 'compact'] } }, ['layout'])] : []),
    ...(has('web') ? [spec('web_search', '联网搜索公开信息，返回本次实际检索到的回答和来源。需要最新或外部资料时使用。', { query: { type: 'string', minLength: 2, maxLength: 500 } }, ['query'])] : []),
    ...(has('files') ? [spec('workspace_file', '管理指定服务器上当前管理员的持久工作区文件：list/read/write/mkdir/move/trash。相对路径，不能读取密钥或直接改生产文件。write 必须先 read 获得 sha256，创建时 expectedSha256="new"；trash 可恢复，不永久删除。', { server, operation: { type: 'string', enum: ['list', 'read', 'write', 'mkdir', 'move', 'trash'] }, path: { type: 'string', description: '工作区相对路径；列根目录使用空字符串。' }, content: { type: 'string', maxLength: 16000 }, expectedSha256: { type: 'string' }, destination: { type: 'string' } }, ['server', 'operation', 'path'])] : []),
    ...(has('commands') ? [
      spec('command_start', '在服务器管理员工作区启动真实 Bash 命令任务，可运行 Python/Node、构建代码或安装项目依赖。独立账户执行，工作区外只读且凭据不可见；不能 sudo/root 或直接改生产系统。返回 jobId 后调用 command_status 等待实际结果，不能把启动当成功。', { server, command: { type: 'string', minLength: 1, maxLength: 4000 }, timeoutSeconds: { type: 'integer', minimum: 10, maximum: 90 } }, ['server', 'command']),
      spec('command_status', '查询当前管理员此前启动的命令任务，读取真实退出码和受限输出。', { server, jobId: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['server', 'jobId']),
      spec('command_cancel', '取消当前管理员的一个命令任务。', { server, jobId: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['server', 'jobId']),
    ] : []),
    ...(has('services') ? [spec('service_control', '按用户要求启动、重启或重载已有业务服务，并核对服务状态。仅固定服务可用，不改权限、认证、防火墙或 systemd 定义。重启 OA/Chat 会中断当前对话，应说明并按具体指令执行。', { server, service: { type: 'string', description: '阿里：nginx、originmind-oa、originmind-chat；腾讯：nginx、docker、originmind-arena、originmind-cloud-mcp。' }, verb: { type: 'string', enum: ['start', 'restart', 'reload'] } }, ['server', 'service', 'verb'])] : []),
  ];
}
export function validOperationTool(name, args, capabilities = []) {
  const has = key => capabilities.includes(key);
  if (name === 'assistant_capabilities') return capabilities.length>0 && exact(args,[]) && Object.keys(args).length===0;
  if (name === 'ui_layout') return has('ui') && exact(args, ['layout']) && ['expanded', 'compact'].includes(args.layout);
  if (name === 'web_search') return has('web') && exact(args, ['query']) && text(args.query, 500) && args.query.trim().length >= 2;
  if (!record(args) || !SERVERS.includes(args.server)) return false;
  if (name === 'workspace_file') {
    if (!has('files') || !exact(args, ['server', 'operation', 'path', 'content', 'expectedSha256', 'destination'])) return false;
    const allowed = { list: ['server','operation','path'], read: ['server','operation','path'], mkdir: ['server','operation','path'], trash: ['server','operation','path'], move: ['server','operation','path','destination'], write: ['server','operation','path','content','expectedSha256'] }[args.operation];
    if (!allowed || Object.keys(args).length !== allowed.length || !allowed.every(key => Object.hasOwn(args, key)) || !(args.operation === 'list' && args.path === '' || path(args.path))) return false;
    if (args.operation === 'write') return text(args.content, 16000, true) && typeof args.expectedSha256 === 'string' && /^(?:new|[a-f0-9]{64})$/u.test(args.expectedSha256);
    return args.operation !== 'move' || path(args.destination);
  }
  if (name === 'command_start') return has('commands') && exact(args, ['server','command','timeoutSeconds']) && text(args.command,4000) && (args.timeoutSeconds === undefined || Number.isInteger(args.timeoutSeconds) && args.timeoutSeconds >= 10 && args.timeoutSeconds <= 90);
  if (['command_status','command_cancel'].includes(name)) return has('commands') && exact(args,['server','jobId']) && typeof args.jobId === 'string' && /^[a-f0-9]{32}$/u.test(args.jobId);
  if (name === 'service_control') return has('services') && exact(args,['server','service','verb']) && typeof args.service === 'string' && SERVICES[args.server].includes(args.service.replace(/\.service$/u,'')) && ['start','restart','reload'].includes(args.verb);
  return false;
}
