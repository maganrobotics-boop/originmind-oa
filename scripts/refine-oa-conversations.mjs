// Complete the explicitly reviewed merge with the concurrent #77/#78 main changes.
// Preserve the production model-binding fixes and the newer clear-chat browser tests.
import { readFile, writeFile } from 'node:fs/promises';
async function patch(path, before, after) {
  const source=await readFile(path,'utf8');
  if(source.includes(after))return;
  if(source.indexOf(before)<0 || source.indexOf(before)!==source.lastIndexOf(before))throw new Error(`Ambiguous refinement in ${path}: ${before}`);
  await writeFile(path,source.replace(before,after));
}
const context='components/knowledge/oa-conversation-context.tsx';
await patch(context,'  aiEpoch: number; dmClearEpoch:', '  aiEpoch: number; aiDirty: boolean; setAiDirty: (dirty: boolean) => void; dmClearEpoch:');
await patch(context,'clearCurrent: () => void;', 'clearCurrent: () => boolean;');
await patch(context,'  const [aiEpoch, setAiEpoch] = useState(0);','  const [aiEpoch, setAiEpoch] = useState(0);\n  const [aiDirty, setAiDirty] = useState(false);');
await patch(context,'setLastAnswer(null); setPeer(null); onOpenChat();','setLastAnswer(null); setAiDirty(false); setPeer(null); onOpenChat();');
await patch(context,'if (window.confirm(`清空与${peer.name}聊天的本页显示？不会删除双方消息记录，重新打开仍可查看。`)) setDmClearEpoch(value => value + 1);','if (window.confirm(`清空与${peer.name}聊天的本页显示？不会删除双方消息记录，重新打开仍可查看。`)) { setDmClearEpoch(value => value + 1); return true; }');
await patch(context,"} else if (window.confirm('清空当前 AI 聊天？不会删除资料、审批或真人消息。')) resetAi();","} else if (window.confirm('清空当前 AI 聊天？不会删除资料、审批或真人消息。')) { resetAi(); return true; }\n    return false;");
await patch(context,'user, peer, visible, aiEpoch, dmClearEpoch,','user, peer, visible, aiEpoch, aiDirty, setAiDirty, dmClearEpoch,');
await patch(context,'  const chat = useOaConversation();\n  return <DropdownMenu>','  const chat = useOaConversation();\n  const focusComposer = useRef(false);\n  return <DropdownMenu modal={false}>');
await patch(context,'className="oa-conversation-menu" aria-label="聊天更多操作"','className="oa-conversation-menu oa-chat-more-button" aria-label="聊天选项"');
await patch(context,'<DropdownMenuContent align="end" className="oa-conversation-popover">',`<DropdownMenuContent align="end" className="oa-conversation-popover oa-chat-clear-menu" onCloseAutoFocus={event => {
    if (focusComposer.current) {
      event.preventDefault(); focusComposer.current = false;
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(chat.peer ? '.oa-member-chat textarea' : '.oa-conversation-ai:not([hidden]) textarea')?.focus());
    }
  }}>`);
await patch(context,'<DropdownMenuItem onSelect={chat.clearCurrent}>','<DropdownMenuItem disabled={!chat.peer && !chat.aiDirty} onSelect={() => { focusComposer.current = chat.clearCurrent(); }}>');
const panel='components/knowledge/oa-chat-panel.tsx';
await patch(panel,'const { forward, setLastAnswer } = useOaConversation();','const { forward, setLastAnswer, setAiDirty } = useOaConversation();');
await patch(panel,'  const stickToEnd = useRef(true);','  const stickToEnd = useRef(true);\n  useEffect(() => { setAiDirty(Boolean(turns.length || question || asking || error)); }, [turns.length, question, asking, error, setAiDirty]);');
const memberTest='scripts/check-oa-member-chat-browser.mjs';
const browser=await readFile(memberTest,'utf8');
await writeFile(memberTest,browser.replaceAll('聊天更多操作','聊天选项'));
// The account is now the round footer avatar; opening it exposes the same identity.
await patch('scripts/check-oa-chat-browser.mjs', "      assert.equal(await nav.locator('.sidebar-user-name').innerText(), '测试成员');", "      assert.equal(await nav.getByRole('button',{name:'打开个人账户菜单',exact:true}).getAttribute('title'), '测试成员');");
console.log('Merged main model fixes retained; full clear-menu regressions and member forwarding are integrated.');
