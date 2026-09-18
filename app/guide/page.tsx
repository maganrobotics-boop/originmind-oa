import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ArrowUpRight, BookOpen, Bot, ClipboardCheck, PackageCheck, CircleDollarSign, GitBranch } from "lucide-react";
import "./guide.css";

export const metadata: Metadata = {
  title: "项目章程与使用指南｜OriginMind × ARTS Robotics 联合研发 OA",
  description: "成员上手指南：区分公开 Chat 与 OA 内部资料，学习 AI 问答、多格式上传、文档生成、归档送审、真人协作及项目审批。",
};

const scenarios = [
  { id: "circulation", icon: GitBranch, title: "需要自由流转或审批", entry: "流转审批", text: "分别选择流转对象和审批人，可只选其中一项。" },
  { id: "technical", icon: ClipboardCheck, title: "完成了一项研发成果", entry: "技术审核", text: "记录做了什么、由谁完成，以及如何验证。" },
  { id: "purchase", icon: PackageCheck, title: "需要买零件或设备", entry: "采购审核", text: "先说明用途、规格和预算，再按审核结果采购。" },
  { id: "labor", icon: CircleDollarSign, title: "申请本月劳务报酬", entry: "劳务报酬", text: "关联已归档成果，说明本月工作与个人贡献。" },
  { id: "assistant", icon: Bot, title: "问问题或处理一份材料", entry: "实验室大模型 → AI 助手", text: "在同一个聊天窗口内上传、处理、预览和下载。" },
  { id: "knowledge", icon: BookOpen, title: "把组会等资料留给团队", entry: "归档送审 / 上传资料", text: "先核对材料，再提交 OA 审核；组会等原则上选对内。" },
];
const roles = [
  ["项目成员", "完成分配任务，提交真实成果与工时，确认本人贡献，及时处理退回事项。"],
  ["技术顾问", "审查技术方案、验证结果和采购技术需求，提出修改意见。"],
  ["项目负责人", "明确任务和交付要求，审核成果，指定采购成员，提出劳务金额建议。"],
  ["OA 管理员", "处理需人工核验的成员事项、授予部门和角色权限，并处理相应归档和异常事项。"],
  ["经费负责人", "终审劳务报酬及其依据；项目负责人的建议金额不等于最终批准金额。"],
];
const examples = [
  ["知识问答", "实验室有哪些研究方向？", "查组会时说明项目、日期和问题；只以有权查看的已审核资料为依据。"],
  ["资料整理", "请把这份材料整理成结构清晰的 Word 文档，保留关键事实，缺失信息标注待补充。", "先上传材料，再发送要求。"],
  ["会议纪要", "请把这份材料整理成会议纪要，区分讨论、决定和待办，列出责任人、截止时间，未明确的信息标注待补充。", "不要让 AI 猜测责任人、日期或会议结论。"],
  ["项目总结", "请把材料整理成项目总结文档，列出已完成工作、主要成果、存在问题和下一步计划。", "计划、已完成和已验证成果要分别说明。"],
];

export default function GuidePage() {
  return <div className="oa-guide" id="top">
    <a className="guide-skip" href="#guide-main">跳到指南正文</a>
    <header className="guide-header">
      <Link href="/" className="guide-brand" prefetch={false}><ArrowLeft size={18} aria-hidden="true" /><span>OriginMind × ARTS Robotics<small>联合研发 OA</small></span></Link>
      <Link href="/" className="guide-enter" prefetch={false}>进入 OA <ArrowUpRight size={16} aria-hidden="true" /></Link>
    </header>
    <main id="guide-main" className="guide-main">
      <div className="guide-heading"><span className="guide-kicker"><BookOpen size={18} aria-hidden="true" />新成员与老成员都从这里开始</span><h1>项目章程与使用指南</h1><p>先分清入口，再完成问答、资料处理、团队共享与审批。</p><p className="guide-version">使用指南更新：<time dateTime="2026-09-19">2026 年 9 月 19 日</time> · 项目章程仍为协作草案</p></div>
      <section className="guide-purpose" id="entry" aria-labelledby="purpose-title">
        <h2 id="purpose-title">先记住：公开聊天用 Chat，内部工作用 OA</h2>
        <p>OA 是实验室的<strong>内部协作、AI 助手、资料审核和成果归档平台</strong>。对外 Chat 面向公众聊天与公开知识问答；成员的资料处理、组会沉淀和审批统一在 OA 完成。</p>
        <div className="guide-entry-grid">
          <article><h3>OA：内部工作的主入口</h3><p><strong>oa.omindos.ai</strong></p><p>用本人账号登录，完成成员准入与保密签署后，按权限使用“实验室大模型”、处理资料、与成员聊天及办理申请。</p></article>
          <article><h3>Chat：对外公开聊天</h3><p><a href="https://chat.omindos.ai" target="_blank" rel="noreferrer">chat.omindos.ai <ArrowUpRight size={14} aria-hidden="true" /></a></p><p>公众无需 OA 登录。涉及实验室资料的回答，只使用经审核并明确标为“对外公开”的知识；不向公众提供内部组会、周报或未公开项目材料。</p></article>
        </div>
        <div className="guide-purpose-note"><strong>内部公开 ≠ 对外公开。</strong>组会、周报、实验记录、项目阶段总结等大部分资料，原则上仅在 OA 内部共享。不要把内部材料粘贴到对外 Chat，也不要因为“已经入库”就认为可以对外转发。</div>
      </section>
      <nav className="guide-contents" aria-label="指南目录"><a href="#getting-started">第一次使用</a><a href="#assistant">AI 助手怎么用</a><a href="#knowledge">资料归档与范围</a><a href="#collaboration">真人协作</a><a href="#tasks">办理审批</a><a href="#charter">项目章程</a><a href="#faq">常见问题</a></nav>

      <section className="guide-section" id="getting-started" aria-labelledby="start-title">
        <div className="guide-section-heading"><span>01</span><div><h2 id="start-title">第一次使用：完成这四步</h2><p>不要借用他人账号；登录并不等于拥有所有资料的访问权限。</p></div></div>
        <ol className="guide-start-steps">
          <li><strong>登录并确认本人身份</strong><p>使用登录页提供的方式进入 OA。系统提示绑定原账户时，只确认属于自己的账户；出现“人工审核中”时，等待管理员核验，不要反复注册。</p></li>
          <li><strong>签署对应保密文件</strong><p>完整阅读，用本人手写签名，预览后提交。普通成员签署后自动归档，项目负责人可查阅，无需另行审核；项目负责人承诺书由 OA 管理员确认归档，管理员本人签署时自动归档。</p></li>
          <li><strong>核对个人资料和角色</strong><p>打开侧栏底部的个人账户菜单，进入“个人设置”。核对姓名和联系方式范围；部门、顾问、负责人等权限由管理员设置。</p></li>
          <li><strong>找到两个日常区域</strong><p>问答和资料处理：侧栏“实验室大模型 → AI 助手”。申请和审核：侧栏“审批办公”，查看“待我审批”或点击“新建审核申请”。手机端先展开左侧栏。</p></li>
        </ol>
        <p className="guide-note">本指南在登录前也可阅读，但只介绍操作方法，不展示内部资料。阅读指南本身不代表已经完成保密协议签署。资料审核、知识资料管理等入口仅向有相应权限的人员显示。</p>
      </section>

      <section className="guide-section" id="assistant" aria-labelledby="assistant-title">
        <div className="guide-section-heading"><span>02</span><div><h2 id="assistant-title">实验室大模型能做什么</h2><p>知识问答、资料整理、会议纪要、项目总结等，都从“AI 助手”的同一个聊天窗口开始。</p></div></div>
        <article className="guide-task"><h3>问知识：直接在聊天框提问</h3><p>查已审核的实验室知识时，写清项目、主题、日期和要解决的问题。不需要先进入独立的 AI 工作台。首页四个功能提示会填入示例要求，确认后再发送，不会替你自动提交。</p><p>AI 回答是协作参考，不是审核结论。找不到依据、信息过期或结论不完整时，应核对来源或请负责人确认，不要把猜测当成事实。</p></article>
        <article className="guide-task" id="file-processing"><h3>处理材料：上传 → 看内容 → 提要求 → 打开或下载</h3>
          <ol><li>点击聊天框旁的“＋”，选择“上传文件 / 图片 / ZIP”或“上传文件夹”。支持 TXT、MD、PDF、DOCX、PNG、JPG、WebP；手机不支持文件夹选择时，改传 ZIP。</li><li>等待解析完成，在上方聊天中核对文件名和正文；长文可展开，单独附带的图片可查看原图。解析有警告时先核对，不把“选择了文件”当成“已经读完”。</li><li>确认“本次使用”的材料，再输入整理要求。要换材料，点击对应资料卡的“使用这份材料”；不要让不同项目的材料混在一起。</li><li>任务完成后会弹出文档预览；聊天里保留文档卡片，可“打开文档”“下载 Word”，预览中也可“下载 Markdown”。“继续修改”会把成果作为后续处理材料。</li><li>关闭预览即可返回聊天；刷新后通过“已保存文档”查看本人仍保留的任务。文档需要长期使用时及时下载，或按下一节归档送审。</li></ol>
          <p className="guide-note">每批最多 100 个文件。TXT/MD 须为 UTF-8；文档最多 10 MB、图片 8 MB、文本 5 MB，ZIP 最多 50 MB，总展开内容最多 100 MB；不支持加密包、嵌套 ZIP 或带宏的 Word。<strong>单次 AI 文档处理最多 20,000 字</strong>，超出需分批，不会自动截断；上传上限不等于模型能一次处理的长度。PDF、DOCX 和图片解析还取决于文件完整性、清晰度及解析服务是否可用。</p>
          <p>解析文字不保证还原原文档的全部版式、公式或内嵌图片。重要的图片应一并上传并核对引用；需要保留图文来源时，使用原始资料卡的“归档资料”，不能只保留 AI 生成的文字摘要。</p>
        </article>
        <div className="guide-examples" aria-label="四类提问示例">{examples.map(([title, prompt, note]) => <article className="guide-example" key={title}><h3>{title}</h3><p className="guide-prompt">{prompt}</p><p>{note}</p></article>)}</div>
      </section>

      <section className="guide-section" id="knowledge" aria-labelledby="knowledge-title">
        <div className="guide-section-heading"><span>03</span><div><h2 id="knowledge-title">资料怎么留存，谁能看到？</h2><p>上传不等于归档，归档送审不等于已入库，内部入库不等于对外公开。</p></div></div>
        <div className="guide-scope-grid">
          <article><h3>临时处理 / 本人成果</h3><p>上传材料和生成文档先用于当前任务，不会自动进入团队知识库。本人任务文件与知识库条目是两种不同记录。</p></article>
          <article><h3>对内：仅 OA 内部</h3><p>组会、周报、实验记录、阶段总结等，原则上走这一范围。批准入库后，已完成准入的成员登录 OA 才能按权限查阅或检索。</p></article>
          <article><h3>对外公开：公众可问</h3><p>只用于已获公开许可、核验且脱敏的介绍或成果。需审核者明确选择并再次确认，才供公开 Chat 检索。</p></article>
        </div>
        <p className="guide-note"><strong>“对内”也不等于“所有敏感内容都能全员看”。</strong>内部知识库用于获准在成员范围共享的资料。个人申请、财务信息、签名、客户保密材料和真人私聊仍受各自权限约束；不适合成员共享的内容不要提交到一般知识库。账号密码和访问密钥不得入库。</p>
        <article className="guide-task"><h3>两种上传方式，进入同一套 OA 审核流程</h3>
          <ol><li><strong>从聊天归档：</strong>在原始资料卡点击“归档资料”，或在生成文档卡/预览中点击“归档成果”。核对正文、图片、事实和脱敏情况，勾选确认，再点“确认归档并提交 OA”。原始资料与生成成果是不同内容，按留存目的选择，避免无意义的重复投稿。</li><li><strong>从侧栏上传：</strong>进入“实验室大模型 → 上传资料”，按页面支持的表单或图文包方式提交。侧栏上传与聊天的“＋”不是相同的文件选择器，格式要求以各自页面为准。</li><li><strong>查看接收结果：</strong>到“我的资料”核对条目编号、状态和审核意见。显示“已提交 OA，待审核”仅表示等待处理，不代表其他成员已经能检索。</li><li><strong>审核与范围：</strong>项目负责人或 OA 管理员在“资料审核”中检查正文与图片，并明确选择“对内”或“对外公开”。组会等日常内部材料原则上选择“对内”；<strong>对外公开必须再次输入指定确认文字</strong>。OA 管理员可以批准本人提交的知识；项目负责人仍需回避自己的投稿。</li><li><strong>确认入库：</strong>只有“已入库”的有效当前版本参与对应范围的问答。已退回的材料按意见修改后重提；已拒绝、已撤销的版本不能作为可用知识。已入库知识可在“知识资料管理”中重新调整范围，改为公开仍需二次确认，并保留审计记录。</li></ol>
          <p>对外发布前，应检查正文、图片、文件名和来源链接，删除不应公开的个人信息、评价、签名、联系方式及未公开项目细节。论文和学位材料保留技术正文；扫描件按公开脱敏要求处理，不能把含身份信息的原图直接公开。</p>
        </article>
        <article className="guide-task" id="meeting-example"><h3>组会资料的完整示例</h3><p className="guide-example-label">以下是操作示例，不含实际组会内容。</p><ol><li>在 OA 的 AI 助手中上传本次组会材料，核对日期、项目和解析内容。</li><li>要求“整理成会议纪要，区分进展、问题、决定与待办，缺失信息标注待补充”。</li><li>打开生成文档，人工核对事实、责任人和时间；有错误先继续修改。</li><li>需要团队长期检索的纪要点击“归档成果”；需要保留原始图文的材料另从资料卡“归档资料”。建议标题写清“项目名｜组会纪要｜日期”。</li><li>审核者选择“对内”。确认“已入库 / 仅 OA 内部”后，成员在 OA 提问，例如“某项目上次组会确定了哪些待办？”</li><li>不要把整份组会材料发布到公开 Chat。确有对外交流需要时，另行整理可公开摘要，脱敏并单独送审。</li></ol></article>
        <article className="guide-task" id="retention"><h3>临时材料、下载和归档的区别</h3><p>未提交的原始文件只用于当前页面，关闭页面会释放；重新使用时需重新上传。新生成且未归档的临时成果，按卡片所示时间到期后定期清理；“已保存文档”不是永久保留承诺。历史成果不追溯自动清理。</p><p>已进入归档保护或已提交 OA 的成果，不参与临时清理；“归档结果待核对”时先点击“核对归档状态”，不能当作审批成功。下载只是保留自己的副本；归档送审才是让团队知识库后续接收的流程。</p></article>
      </section>

      <section className="guide-section" id="collaboration" aria-labelledby="collaboration-title">
        <div className="guide-section-heading"><span>04</span><div><h2 id="collaboration-title">与真人聊天和转发内容</h2><p>先看当前会话标题，分清正在和 AI 助手还是某位成员沟通。</p></div></div>
        <article className="guide-task"><ol><li>打开聊天右上角“···”，选择“AI 助手”或具体成员姓名；选人后就在当前窗口聊天，对方可以在 OA 回复。</li><li>转发 AI 回答时，点击回答下方“转发”，选择成员，核对正文后“确认发送”。发送者是你本人，不是 AI；对方直接收到正文，而不是仅收到一个链接。</li><li>转发前确认对方有权知悉。转发正文不会自动授予原文件的访问权限；图片附件不随本条正文转发。真人私聊和转发消息不会自动进入知识库。</li><li>“清空聊天”或“清空本页显示”不能当作撤回已发送消息、删除已保存成果或撤销已入库知识。</li></ol></article>
      </section>

      <section className="guide-section" id="tasks" aria-labelledby="tasks-title">
        <div className="guide-section-heading"><span>05</span><div><h2 id="tasks-title">办理申请：我现在该用哪张表？</h2><p>从“审批办公 → 新建审核申请”选择类型。AI 生成的文档不能替代本人提交、贡献确认和正式审核。</p></div></div>
        <div className="guide-scenarios">{scenarios.map(({ id, icon: Icon, title, entry, text }) => <a href={`#${id}`} key={id}><Icon size={23} aria-hidden="true" /><h3>{title}</h3><p>{text}</p><span>{entry} <ArrowUpRight size={16} aria-hidden="true" /></span></a>)}</div>
        <article className="guide-task" id="circulation"><h3>流转审批：自由选择流转对象和审批人</h3><ol><li>选择“流转审批”，填写事项标题、内容和相关材料链接。</li><li>“流转给谁”和“给谁审批”分别选择，可搜索所有已完成准入的在用成员，支持多选；至少选择其中一项。</li><li>只流转：所选人员全部确认后归档。只审批：指定审批人全部同意后归档。两项都选：先由流转对象全部确认，再进入指定审批。</li><li>接收人在“待我审批”等待办入口中独立确认或审批；需要补充时填写原因并退回申请人。每一步保留处理意见、身份和时间，归档后可下载正式 PDF。</li></ol><p className="guide-note">申请人不能审批自己的申请；流转对象与审批人可以重叠。退回或撤回后重新提交，需要所有所选人员重新确认或审批，旧记录仍保留。</p></article>
        <article className="guide-task" id="technical"><h3>技术审核：把研发工作变成可验证的成果记录</h3><p><strong>什么时候提交：</strong>完成一个能够独立说明、演示或复现的阶段成果时，例如控制程序调通、结构设计完成或一轮测试结束。</p><ol><li>点击“新建审核申请”，选择“技术审核”，写清项目、任务、完成内容、总工时和验证结果。</li><li>选择实际参与的开发人，分别写明工作与贡献占比，合计为 100%。开发人需已激活并完成保密协议归档。</li><li>在表单允许的位置补充代码版本、图纸、测试记录、数据、视频或资料链接；确保审核人能访问。</li><li>提交后，由每位开发人用本人账号确认，再交技术顾问和项目负责人审核。按详情页状态跟进至归档。</li></ol><div className="guide-example"><strong>填写示例</strong><p>不要只写“调试机器人”。可以写：“完成底盘急停与恢复逻辑，提交代码版本和测试记录，说明测试条件、通过项及尚未解决的问题。”</p></div></article>
        <article className="guide-task" id="purchase"><h3>采购审核：先说明需求，再按批准内容执行</h3><ol><li>选择“采购审核”，填写物品、规格型号、数量、用途、预计金额和供应商，补充清单。</li><li>说明它用于哪项任务，以及为什么需要采购，提交技术顾问和项目负责人审核。</li><li>项目负责人从符合准入条件的成员中指定采购人；采购人按批准内容执行并完成采购确认。</li><li>实际金额不得超过批准金额，超额需要退回重审。按页面要求填写实际金额和采购说明。</li></ol><p className="guide-note">“已提交”表示申请已发出，不表示已经获准采购。采购审核记录用于记录项目需求与批准过程；涉及学校经费时，还需办理对应的学校采购和财务手续。</p></article>
        <article className="guide-task" id="nda"><h3>保密协议：本人阅读、本人签署</h3><p>首次加入或系统提示补签、重签时，打开保密协议待办，核对身份和文件类型，阅读、手写签名、预览后提交。普通成员签完后自动归档；负责人承诺书按页面提示提交管理员确认。归档后可在本人有权限的申请记录中查阅。</p><p>如果仍提示未完成，先刷新查看是否已成功提交；有错误提示时保留提示文字，联系管理员，避免反复新建同一份申请。</p></article>
        <article className="guide-task" id="labor"><h3>劳务报酬：按月说明工作和贡献依据</h3><ol><li>每月申请一次，选择“劳务报酬”，核对申请月份。</li><li>关联本人参与的已归档技术成果，填写月度工作总结；其他工时不得重复包含已选成果的工时。</li><li>系统按“成果总工时 × 个人贡献率”折算成果工时；项目负责人填写建议金额及依据，经费负责人终审。</li><li>查看审核结果与归档记录。申请提交、建议金额和归档记录均不等于实际款项已到账。</li></ol><div className="guide-example"><strong>工时示例</strong><p>一项成果总工时为 40 小时，你的贡献率为 25%，对应折算工时为 10 小时。已计入该成果的工作不要再重复填到“其他工时”。</p></div></article>
      </section>

      <section className="guide-section" id="charter" aria-labelledby="charter-title">
        <div className="guide-section-heading"><span>06</span><div><h2 id="charter-title">联合研发项目章程</h2><p>协作章程草案 · 待审阅 · 本次补充资料分级与 AI 协作规则</p></div></div>
        <div className="guide-charter-intro">适用于 OriginMind × ARTS Robotics 联合研发项目的参与成员。本草案说明项目协作方式；具体保密义务以本人签署的文件为准。各具体项目的任务、期限和验收要求由项目负责人明确。</div>
        <article className="guide-clause"><h3>一、项目目标与范围</h3><p>围绕机器人本体、控制与软件系统、应用及测试验证开展联合研发，形成能够检查、复现和交接的成果。任务按照 Agent Hardware、Agent OS、Agent Application 等方向分工；科研探索和公司产品交付分别标明目标及验收依据，不将科研计划直接作为产品交付承诺。</p></article>
        <article className="guide-clause"><h3>二、每项任务先说清交付</h3><p>任务按“人员—方向—当前任务—截止时间—预期产出—可验证结果”记录。开始前明确负责人、协作成员、需要完成的内容及验收方式；发现任务范围、时间或资源需要调整时，及时向项目负责人说明。</p></article>
        <article className="guide-clause"><h3>三、各角色负责什么</h3><div className="guide-table-wrap" role="region" aria-label="项目角色分工" tabIndex={0}><table><thead><tr><th scope="col">角色</th><th scope="col">主要职责</th></tr></thead><tbody>{roles.map(([role, duty]) => <tr key={role}><th scope="row">{role}</th><td>{duty}</td></tr>)}</tbody></table></div><p>顾问、负责人等权限以管理员授予的实际角色为准，不能通过自行修改个人资料获得。</p></article>
        <article className="guide-clause"><h3>四、成果、贡献与工时真实可核对</h3><p>成果记录应说明完成内容、参与人、贡献占比、工时和验证证据。每位开发人确认自己的实际贡献；尚未完成、未经验证或验证失败的部分应如实说明。需要补充时保留原记录与审核意见，按退回要求修改后重新提交。</p></article>
        <article className="guide-clause"><h3>五、资料能查阅，也能交接</h3><p>代码、图纸、数据和测试记录应保存在项目指定位置，在 OA 申请中注明对应版本或链接。周报用于交流进展，OA 用于记录需要确认、审核和归档的事项；已有资料可引用，避免反复抄写。实验室科研材料与公司材料应标明所属项目和用途。</p><p>组会和阶段总结需要团队检索时，在 OA 核对后归档送审；注明项目、日期、版本和来源。AI 整理稿不得冒充原始证据，不得以整理为由覆盖原文件。</p></article>
        <article className="guide-clause"><h3>六、按角色签署，按权限使用资料</h3><p>本人完成对应保密文件签署后，按获授权限参与项目和访问资料。资料共享、对外使用及退出时的交接，按本人已签署文件和项目要求办理；发现资料误发、丢失或账户异常时，及时报告负责人或管理员。</p></article>
        <article className="guide-clause"><h3>七、经费申请和记录修改有依据</h3><p>采购按批准用途、金额和指定人员执行；劳务按已归档成果、实际贡献及月度说明申请。未归档申请可按流程撤回修改；草稿和已撤回申请可作废。已归档记录保留原版本，只能追加更正或废止说明。</p></article>
        <article className="guide-clause"><h3>八、内部优先共享，对外另行审核</h3><p>组会、周报、实验数据和未公开项目进展原则上按内部资料管理，审核者仍需明确选择范围，不自动对外发布。公开 Chat 只承担面向公众的聊天与公开知识问答。确需公开的内容，应另行核验、脱敏并走公开审批；涉及限定知悉范围的敏感材料，不进入一般内部知识库。</p><p>AI 辅助起草与整理，提交人对事实、来源和共享范围负责；AI 不能代替本人签署、正式审批或未经确认地发送消息。知识入库也不代表技术成果已通过验收。</p></article>
      </section>

      <section className="guide-section" id="faq" aria-labelledby="faq-title">
        <div className="guide-section-heading"><span>07</span><div><h2 id="faq-title">常见问题</h2><p>点击问题展开。遇到异常，先核对状态，再决定是否重试。</p></div></div>
        <div className="guide-faq">
          <details><summary>内部公开是不是网上所有人都能看？</summary><p>不是。“对内 / 仅 OA 内部”供已完成准入的成员登录后使用，不供公开 Chat 检索。个人申请、私聊和限定范围的资料仍按各自权限处理。</p></details>
          <details><summary>在 Chat 问组会，为什么没有答案？</summary><p>组会属于内部协作资料，应登录 OA，在“实验室大模型 → AI 助手”中提问。只有相关资料已审核入库、处于有效状态且你有权限时，才有可用的知识依据。</p></details>
          <details><summary>上传了文件，为什么其他人还问不到？</summary><p>聊天上传只是当前材料处理。要供团队查询，需点击“归档资料”或“归档成果”送审，或从“上传资料”提交；在“我的资料”确认“已入库”和范围后才参与问答。仅下载或只显示“已保存文档”不算知识入库。</p></details>
          <details><summary>文件解析失败、太长或文档没有生成怎么办？</summary><p>查看文件类型、大小和报错；单次 AI 处理超过 20,000 字时分批。扫描件或图片先检查清晰度。任务显示“提交结果待核对”时用“核对提交”或“核对状态”，失败后再按页面入口重试，避免连续重复提交。</p></details>
          <details><summary>为什么刷新后原始上传材料不在了？</summary><p>未提交的原始文件属于当前页面临时材料，需重新上传；本人生成任务可在“已保存文档”中核对。未归档成果可能到期清理，需要长期保存时及时下载或归档送审。</p></details>
          <details><summary>资料误设成对外公开了怎么办？</summary><p>立即联系有权限的项目负责人或 OA 管理员，在“知识资料管理”中调整范围或撤销，并核查公开影响。范围调整不能收回别人已复制、下载或转发的内容。不要继续扩大传播。</p></details>
          <details><summary>被退回、填错或需要更正怎么办？</summary><p>先阅读审核意见；资料在“我的资料”修改并重提，多分片资料按页面提示在 OA 重新上传。申请未归档时按流程撤回修改；草稿和已撤回申请可作废，记录仍保留。已归档申请不能直接覆盖，只能追加更正或废止说明。</p></details>
          <details><summary>AI 生成文档、资料入库和技术审核是一回事吗？</summary><p>不是。文档生成是材料整理；资料入库是审核后的知识共享；技术审核是对具体成果、参与贡献和验证证据的正式确认。劳务关联以已归档技术成果为准，不能仅凭 AI 总结申请。</p></details>
          <details><summary>为什么看不到资料审核或别人的记录？</summary><p>先确认本人账号、成员状态、保密签署和角色。普通成员通过“我的资料”查看自己的投稿，不必能进入管理页；其他人的申请、私聊和文档并非登录后全部可见。权限需要调整时联系管理员。</p></details>
          <details><summary>是不是每天都要填 OA，申请怎样留存？</summary><p>有需要确认的成果、采购需求、月度劳务或待办时办理申请；日常进展仍按项目安排沟通。进入有权查看的申请详情可导出 PDF，最终存档材料应确认状态为“已归档”。审核通过、归档与实际款项到账是不同状态。</p></details>
          <details><summary>应该找谁解决问题？</summary><p>任务和验收找项目负责人，技术问题找技术顾问，身份、权限或系统异常找 OA 管理员，劳务金额和支付进度找经费负责人或财务。反馈时附条目/申请编号、报错文字和发生步骤，不发送密码或密钥。</p></details>
        </div>
      </section>
      <footer className="guide-footer"><p>日常问答与材料处理进入“AI 助手”；需要团队检索的资料，核对后归档送审，原则上选对内。</p><Link className="guide-enter" href="/" prefetch={false}>进入 OA <ArrowUpRight size={16} aria-hidden="true" /></Link><a href="#top">回到顶部</a></footer>
    </main>
  </div>;
}
