import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ArrowUpRight, BookOpen, Bot, ClipboardCheck, PackageCheck, CircleDollarSign, GitBranch } from "lucide-react";
import "./guide.css";

export const metadata: Metadata = {
  title: "项目章程与使用指南｜OriginMind × ARTS Robotics 联合研发 OA",
  description: "了解联合研发 OA 的用途、项目协作规则，以及成果、采购、保密协议、劳务申请和实验室 AI 内外可见范围的操作方法。",
};

const scenarios = [
  { id: "circulation", icon: GitBranch, title: "需要自由流转或审批", entry: "流转审批", text: "分别选择流转对象和审批人，可只选其中一项。" },
  { id: "technical", icon: ClipboardCheck, title: "完成了一项研发成果", entry: "技术审核", text: "记录做了什么、由谁完成，以及如何验证。" },
  { id: "purchase", icon: PackageCheck, title: "需要买零件或设备", entry: "采购审核", text: "先说明用途、规格和预算，再按审核结果采购。" },
  { id: "labor", icon: CircleDollarSign, title: "申请本月劳务报酬", entry: "劳务报酬", text: "关联已归档成果，说明本月工作与个人贡献。" },
  { id: "knowledge", icon: Bot, title: "分享或查询实验室知识", entry: "实验室 AI（内部）", text: "OA 内部提问；审核时明确选择对内或对外公开。" },
];

const roles = [
  ["项目成员", "完成分配任务，提交真实成果与工时，确认本人贡献，及时处理退回事项。"],
  ["技术顾问", "审查技术方案、验证结果和采购技术需求，提出修改意见。"],
  ["项目负责人", "明确任务和交付要求，审核成果，指定采购成员，提出劳务金额建议。"],
  ["OA 管理员", "处理需人工核验的成员事项、授予部门和角色权限，并处理相应归档和异常事项。"],
  ["经费负责人", "终审劳务报酬及其依据；项目负责人的建议金额不等于最终批准金额。"],
];

export default function GuidePage() {
  return <div className="oa-guide" id="top">
    <a className="guide-skip" href="#guide-main">跳到指南正文</a>
    <header className="guide-header">
      <Link href="/" className="guide-brand" prefetch={false}><ArrowLeft size={18} aria-hidden="true" /><span>OriginMind × ARTS Robotics<small>联合研发 OA</small></span></Link>
      <Link href="/" className="guide-enter" prefetch={false}>进入 OA <ArrowUpRight size={16} aria-hidden="true" /></Link>
    </header>
    <main id="guide-main" className="guide-main">
      <div className="guide-heading"><span className="guide-kicker"><BookOpen size={18} aria-hidden="true" />新同学从这里开始</span><h1>项目章程与使用指南</h1><p>先了解为什么用，再找到你要办的事。</p></div>
      <section className="guide-purpose" aria-labelledby="purpose-title">
        <h2 id="purpose-title">OA 是什么？</h2>
        <p>OA 是 Office Automation（办公自动化）的简称。在我们的项目里，它是一个<strong>研发协作、申请审核和成果归档平台</strong>。</p>
        <p>你在这里记录研发贡献、申请采购和劳务报酬、签署保密协议、沉淀实验室知识，并查看谁在处理、还缺什么材料、最后的结果是什么。</p>
        <div className="guide-purpose-note">对同学：工作和贡献有据可查，申请进度看得见。对团队：任务责任、审核意见和最终材料放在一起，交接时找得到。</div>
      </section>
      <nav className="guide-contents" aria-label="指南目录"><a href="#getting-started">第一次使用</a><a href="#tasks">我要办什么事</a><a href="#charter">项目章程</a><a href="#faq">常见问题</a></nav>

      <section className="guide-section" id="getting-started" aria-labelledby="start-title">
        <div className="guide-section-heading"><span>01</span><div><h2 id="start-title">第一次使用：完成这四步</h2><p>使用本人账户，按页面提示完成身份确认和保密签署。</p></div></div>
        <ol className="guide-start-steps">
          <li><strong>登录并确认身份</strong><p>按登录页提供的方式确认企业身份。如系统提示绑定原 OA 账户，只确认属于自己的账户；出现“人工审核中”时，等待管理员核验并刷新状态。</p></li>
          <li><strong>签署对应保密文件</strong><p>完整阅读文件，用本人手写签名，预览确认后提交。普通成员签署后自动归档，项目负责人可查阅，无需另行审核；项目负责人承诺书由 OA 管理员确认归档，管理员本人签署时自动归档。</p></li>
          <li><strong>检查个人资料</strong><p>进入“个人设置”核对姓名和资料，按需要设置联系方式的公开范围。部门和顾问、负责人等权限由管理员设置；显示不正确时联系管理员处理。</p></li>
          <li><strong>查看“待我处理”</strong><p>这里集中显示需要你确认贡献、审核或补充材料的事项。需要提出新申请时，点击“新建审核”，选择对应类型。</p></li>
        </ol>
        <p className="guide-note">登录和准入页面也能打开本指南。阅读指南本身不代表已经完成保密协议签署。</p>
      </section>

      <section className="guide-section" id="tasks" aria-labelledby="tasks-title">
        <div className="guide-section-heading"><span>02</span><div><h2 id="tasks-title">我现在该用哪张表？</h2><p>日常只需选择技术审核、采购审核、劳务报酬或流转审批。保密签署在首次进入系统时完成。</p></div></div>
        <div className="guide-scenarios">{scenarios.map(({ id, icon: Icon, title, entry, text }) => <a href={`#${id}`} key={id}><Icon size={23} aria-hidden="true" /><h3>{title}</h3><p>{text}</p><span>{entry} <ArrowUpRight size={16} aria-hidden="true" /></span></a>)}</div>
        <article className="guide-task" id="circulation"><h3>流转审批：自由选择流转对象和审批人</h3><ol><li>选择“流转审批”，填写事项标题、内容和相关材料链接。</li><li>“流转给谁”和“给谁审批”分别选择，可搜索所有已完成准入的在用成员，支持多选；至少选择其中一项。</li><li>只流转：所选人员全部确认后归档。只审批：指定审批人全部同意后归档。两项都选：先由流转对象全部确认，再进入指定审批。</li><li>接收人在“待我处理”中独立确认或审批；需要补充时填写原因并退回申请人。每一步保留处理意见、身份和时间，归档后可下载正式 PDF。</li></ol><p className="guide-note">申请人不能审批自己的申请；流转对象与审批人可以重叠。退回或撤回后重新提交，需要所有所选人员重新确认或审批，旧记录仍保留。</p></article>
        <article className="guide-task" id="technical"><h3>技术审核：把研发工作变成可验证的成果记录</h3><p><strong>什么时候提交：</strong>完成一个能够独立说明、演示或复现的阶段成果时，例如控制程序调通、结构设计完成或一轮测试结束。</p><ol><li>点击“新建审核”，选择“技术审核”，写清项目、任务、完成内容、总工时和验证结果。</li><li>选择实际参与的开发人，分别写明工作与贡献占比，合计为 100%。开发人需已激活并完成保密协议归档。</li><li>在表单允许的位置补充代码版本、图纸、测试记录、数据、视频或资料链接；确保审核人能访问。</li><li>提交后，由每位开发人用本人账号确认，再交技术顾问和项目负责人审核。按详情页状态跟进至归档。</li></ol><div className="guide-example"><strong>填写示例</strong><p>不要只写“调试机器人”。可以写：“完成底盘急停与恢复逻辑，提交代码版本和测试记录，说明测试条件、通过项及尚未解决的问题。”</p></div></article>
        <article className="guide-task" id="purchase"><h3>采购审核：先说明需求，再按批准内容执行</h3><ol><li>选择“采购审核”，填写物品、规格型号、数量、用途、预计金额和供应商，补充清单。</li><li>说明它用于哪项任务，以及为什么需要采购，提交技术顾问和项目负责人审核。</li><li>项目负责人从符合准入条件的成员中指定采购人；采购人按批准内容执行并完成采购确认。</li><li>实际金额不得超过批准金额，超额需要退回重审。按页面要求填写实际金额和采购说明。</li></ol><p className="guide-note">“已提交”表示申请已发出，不表示已经获准采购。采购审核记录用于记录项目需求与批准过程；涉及学校经费时，还需办理对应的学校采购和财务手续。</p></article>
        <article className="guide-task" id="nda"><h3>保密协议：本人阅读、本人签署</h3><p>首次加入或系统提示补签、重签时，打开保密协议待办，核对身份和文件类型，阅读、手写签名、预览后提交。普通成员签完后自动归档；负责人承诺书按页面提示提交管理员确认。归档后可在本人有权限的申请记录中查阅。</p><p>如果仍提示未完成，先刷新查看是否已成功提交；有错误提示时保留提示文字，联系管理员，避免反复新建同一份申请。</p></article>
        <article className="guide-task" id="labor"><h3>劳务报酬：按月说明工作和贡献依据</h3><ol><li>每月申请一次，选择“劳务报酬”，核对申请月份。</li><li>关联本人参与的已归档技术成果，填写月度工作总结；其他工时不得重复包含已选成果的工时。</li><li>系统按“成果总工时 × 个人贡献率”折算成果工时；项目负责人填写建议金额及依据，经费负责人终审。</li><li>查看审核结果与归档记录。申请提交、建议金额和归档记录均不等于实际款项已到账。</li></ol><div className="guide-example"><strong>工时示例</strong><p>一项成果总工时为 40 小时，你的贡献率为 25%，对应折算工时为 10 小时。已计入该成果的工作不要再重复填到“其他工时”。</p></div></article>
        <article className="guide-task" id="knowledge"><h3>实验室 AI：内部在 OA 问，公开知识供 ARTS Robotics AI assistant 使用</h3><ol><li><strong>对内问答在 OA。</strong>只有已登录并完成准入与保密签署的成员，才会看到“实验室 AI（内部）”并在 OA 里提问。</li><li>需要补充时选择“提交知识”，写清标题、分类、摘要和完整正文；有原始记录时可附来源名称和 HTTP/HTTPS 链接。</li><li>提交后在“我的提交”查看状态。被退回时按审核意见修改并重新提交；被拒绝的版本不会进入知识库。</li><li>项目负责人或 OA 管理员批准时必须选择“对内”或“对外公开”。OA 管理员可以批准本人提交的知识；项目负责人仍需回避自己的投稿。对内知识仅供 OA 成员检索；对外公开必须再次输入指定确认文字，随后供 <a href="https://chat.omindos.ai" target="_blank" rel="noreferrer">chat.omindos.ai</a> 上的 ARTS Robotics AI assistant 检索，公众无需 OA 登录。</li><li>已入库知识可在“知识库管理”中重新调整范围；改为公开仍需二次确认，每次调整都会保留审计记录。</li></ol><p className="guide-note">不要提交账号密码、访问密钥或个人隐私。选择“对外公开”前，应再次核对内容是否允许离开 OA 内部范围。AI 回答用于协作参考，关键操作仍应回看引用原文并按负责人要求执行。</p></article>
      </section>

      <section className="guide-section" id="charter" aria-labelledby="charter-title">
        <div className="guide-section-heading"><span>03</span><div><h2 id="charter-title">联合研发项目章程</h2><p>协作章程草案 · 2026 年 9 月 5 日 · 待审阅</p></div></div>
        <div className="guide-charter-intro">适用于 OriginMind × ARTS Robotics 联合研发项目的参与成员。本草案说明项目协作方式；具体保密义务以本人签署的文件为准。各具体项目的任务、期限和验收要求由项目负责人明确。</div>
        <article className="guide-clause"><h3>一、项目目标与范围</h3><p>围绕机器人本体、控制与软件系统、应用及测试验证开展联合研发，形成能够检查、复现和交接的成果。任务按照 Agent Hardware、Agent OS、Agent Application 等方向分工；科研探索和公司产品交付分别标明目标及验收依据，不将科研计划直接作为产品交付承诺。</p></article>
        <article className="guide-clause"><h3>二、每项任务先说清交付</h3><p>任务按“人员—方向—当前任务—截止时间—预期产出—可验证结果”记录。开始前明确负责人、协作成员、需要完成的内容及验收方式；发现任务范围、时间或资源需要调整时，及时向项目负责人说明。</p></article>
        <article className="guide-clause"><h3>三、各角色负责什么</h3><div className="guide-table-wrap" role="region" aria-label="项目角色分工" tabIndex={0}><table><thead><tr><th scope="col">角色</th><th scope="col">主要职责</th></tr></thead><tbody>{roles.map(([role, duty]) => <tr key={role}><th scope="row">{role}</th><td>{duty}</td></tr>)}</tbody></table></div><p>顾问、负责人等权限以管理员授予的实际角色为准，不能通过自行修改个人资料获得。</p></article>
        <article className="guide-clause"><h3>四、成果、贡献与工时真实可核对</h3><p>成果记录应说明完成内容、参与人、贡献占比、工时和验证证据。每位开发人确认自己的实际贡献；尚未完成、未经验证或验证失败的部分应如实说明。需要补充时保留原记录与审核意见，按退回要求修改后重新提交。</p></article>
        <article className="guide-clause"><h3>五、资料能查阅，也能交接</h3><p>代码、图纸、数据和测试记录应保存在项目指定位置，在 OA 申请中注明对应版本或链接。周报用于交流进展，OA 用于记录需要确认、审核和归档的事项；已有资料可引用，避免反复抄写。实验室科研材料与公司材料应标明所属项目和用途。</p></article>
        <article className="guide-clause"><h3>六、按角色签署，按权限使用资料</h3><p>本人完成对应保密文件签署后，按获授权限参与项目和访问资料。资料共享、对外使用及退出时的交接，按本人已签署文件和项目要求办理；发现资料误发、丢失或账户异常时，及时报告负责人或管理员。</p></article>
        <article className="guide-clause"><h3>七、经费申请和记录修改有依据</h3><p>采购按批准用途、金额和指定人员执行；劳务按已归档成果、实际贡献及月度说明申请。未归档申请可按流程撤回修改；草稿和已撤回申请可作废。已归档记录保留原版本，只能追加更正或废止说明。</p></article>
      </section>

      <section className="guide-section" id="faq" aria-labelledby="faq-title">
        <div className="guide-section-heading"><span>04</span><div><h2 id="faq-title">常见问题</h2><p>先查看申请详情中的状态、当前处理人和审核意见。</p></div></div>
        <div className="guide-faq">
          <article><h3>是不是每天都要填 OA？</h3><p>有需要确认的成果、采购需求、月度劳务或待办时使用。日常进展仍按项目安排沟通和写周报，阶段成果形成后再提交相应申请。</p></article>
          <article><h3>被退回了怎么办？</h3><p>打开申请详情，先读退回原因，按要求补充或修改后重新提交。对审核意见有疑问，联系当前审核人或项目负责人。</p></article>
          <article><h3>填错了，能不能撤回或删除？</h3><p>未归档申请可由申请人撤回，修改后重提；草稿和已撤回申请可以作废，记录仍保留。已归档申请不能直接覆盖或作废，只能追加更正或废止说明。</p></article>
          <article><h3>“已通过”和“已归档”一样吗？</h3><p>“已通过”表示审核已通过；“已归档”表示记录已形成保留版本。采购确认、签署或其他环节是否已完成，要看详情页；关联劳务成果时以已归档记录为准。</p></article>
          <article><h3>为什么看不到别人的申请或某个审核按钮？</h3><p>申请和操作入口按本人参与情况与权限显示。先确认登录账户和自己的角色；需要调整时联系管理员。</p></article>
          <article><h3>怎么保存自己的申请材料？</h3><p>进入有权查看的申请详情，使用 PDF 导出入口。需要最终存档材料时，先确认申请状态为“已归档”。</p></article>
          <article><h3>为什么我提交的知识还不能被问到？</h3><p>新投稿需要先由项目负责人或 OA 管理员审核。请到“实验室 AI（内部）—我的提交”查看状态；只有显示“已入库”且未被撤销的当前版本会按所选范围参与问答。</p></article>
          <article><h3>对内和对外公开有什么区别？</h3><p>“对内”只允许已完成准入的成员登录 OA 后检索；“对外公开”会在二次确认后供 chat.omindos.ai 上的 ARTS Robotics AI assistant 检索。投稿本身不会自动公开；已入库知识可由项目负责人或 OA 管理员在“知识库管理”中调整范围。</p></article>
          <article><h3>应该找谁解决问题？</h3><p>任务和验收问题找项目负责人，技术问题找技术顾问，身份、权限或系统异常找 OA 管理员，劳务金额和支付进度找经费负责人或财务。反馈时带上申请编号、报错文字和发生步骤。</p></article>
        </div>
      </section>
      <footer className="guide-footer"><p>准备好后，进入 OA 查看“待我处理”或新建申请。</p><Link className="guide-enter" href="/" prefetch={false}>进入 OA <ArrowUpRight size={16} aria-hidden="true" /></Link><a href="#top">回到顶部</a></footer>
    </main>
  </div>;
}
