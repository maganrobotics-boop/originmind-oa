import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaCirculationTest";
globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false },
  plugins: [{ name: "circulation-test-fixtures", enforce: "pre",
    resolveId(source) {
      if (/(^|\/)_lib\/auth$/.test(source)) return "\0circulation-auth";
      if (/^(?:\.\.\/)+db$/.test(source)) return "\0circulation-db";
      return null;
    },
    load(id) {
      if (id === "\0circulation-db") return `export async function getDb() { return globalThis.${stateKey}.db; }`;
      if (id !== "\0circulation-auth") return null;
      return `import { sql } from "drizzle-orm";
        const state = () => globalThis.${stateKey};
        export async function getAuthorizedUser() { return state().actor; }
        export function authorizedMemberGuard(actor) { return sql\`EXISTS (SELECT 1 FROM members WHERE id=\${actor.memberId} AND account_user_id=\${actor.accountUserId} AND mutation_revision=\${actor.memberMutationRevision} AND status='active')\`; }
        export const getConfiguredAdministrators = () => [];
        export const getConfiguredFinanceOwners = () => [];
        export const getConfiguredProjectOwners = () => [];
        export async function getReviewerDirectory() { return []; }
        export function isNdaAdmittedMember(member) { return Boolean(member.accountUserId && member.ndaAcceptedAt); }
        export function isProjectOwner() { return false; }
        export function parseMemberPermissions() { return []; }
      `;
    },
  }],
});
const collection = await vite.ssrLoadModule("/app/api/approvals/route.ts");
const detail = await vite.ssrLoadModule("/app/api/approvals/[id]/route.ts");
const pdf = await vite.ssrLoadModule("/app/api/approvals/[id]/pdf/route.ts");
let sqlite;
let batchTail = Promise.resolve();
after(async () => { sqlite?.close(); delete globalThis[stateKey]; await vite.close(); });
function d1Adapter(database) {
  function prepare(query, params = []) {
    const execute = () => ({ success: true, results: database.prepare(query).all(...params), meta: { changes: Number(database.prepare("SELECT changes() n").get().n) } });
    return {
      bind(...values) { return prepare(query, values); }, async all() { return execute(); }, async run() { return execute(); },
      async raw() { const statement = database.prepare(query); statement.setReturnArrays(true); return statement.all(...params); },
    };
  }
  return { prepare, batch(statements) {
    const run = async () => {
      const hook = globalThis[stateKey].beforeBatch; globalThis[stateKey].beforeBatch = null; hook?.();
      database.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.all()); database.exec("COMMIT"); return results; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    };
    const result = batchTail.then(run, run); batchTail = result.then(() => undefined, () => undefined); return result;
  } };
}
const ids = ["author", "recipient1", "recipient2", "reviewer1", "reviewer2", "outsider"];
function setActor(id) {
  globalThis[stateKey].actor = { user: { email: `${id}@example.com`, displayName: id }, memberId: id, accountUserId: `email:${id}@example.com`, memberMutationRevision: "member-r1", role: "member", isAdmin: false, isFinanceOwner: false, ndaCompleted: true };
}
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:"); batchTail = Promise.resolve();
  const dir = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(dir).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    for (const sql of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint").filter(part => part.trim())) sqlite.exec(sql);
  }
  for (const id of ids) sqlite.prepare("INSERT INTO members(id,full_name,chatgpt_account,account_user_id,nda_accepted_at,nda_agreement_version,mutation_revision) VALUES(?,?,?,?,?,?,?)").run(id,id,`${id}@example.com`,`email:${id}@example.com`,"2026-09-01","TEST-NDA","member-r1");
  globalThis[stateKey] = { db: drizzle(d1Adapter(sqlite)) }; setActor("author");
});
const body = (recipients = ["recipient1","recipient2"], approvers = ["reviewer1","reviewer2"]) => ({ type: "流转审批", title: "仅本地测试流转", summary: "仅测试数据，不产生真实任务或付款", payload: { circulationContent: "请确认测试材料后审批，仅在本地数据库执行。", circulationRecipients: recipients, circulationApprovers: approvers } });
const request = (method, data) => new Request("https://oa.example.test/api/approvals", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
async function create(data = body()) { const response = await collection.POST(request("POST",data)); return { status: response.status, data: await response.json() }; }
async function patch(id, actor, action, extra = {}) { setActor(actor); const response = await detail.PATCH(request("PATCH",{action,...extra}), {params:Promise.resolve({id})}); return { status: response.status, data: await response.json() }; }
async function get(id, actor) { setActor(actor); const response = await detail.GET(new Request("https://oa.example.test/"), {params:Promise.resolve({id})}); return {status:response.status,data:await response.json()}; }
const row = id => sqlite.prepare("SELECT * FROM approvals WHERE id=?").get(id);
const events = id => sqlite.prepare("SELECT * FROM approval_events WHERE approval_id=? ORDER BY id").all(id);

for (const mode of ["flow_only", "approval_only", "both"]) test(`${mode}: all selected ordinary members can act in any order, then archive`, async () => {
  const c = await create(body(mode === "approval_only" ? [] : ["recipient1","recipient2"], mode === "flow_only" ? [] : ["reviewer1","reviewer2"]));
  assert.equal(c.status,201,JSON.stringify(c.data)); const id=c.data.approval.id;
  assert.equal(c.data.approval.step,mode === "approval_only" ? "指定审批" : "流转确认");
  if (mode !== "approval_only") {
    assert.equal((await patch(id,"reviewer1","approve")).status,404);
    assert.equal((await patch(id,"recipient2","confirm_circulation",{note:"第二位先完成"})).status,200);
    assert.equal(row(id).current_step,"流转确认");
    assert.equal((await patch(id,"recipient2","confirm_circulation")).status,404);
    assert.equal((await patch(id,"recipient1","confirm_circulation")).status,200);
  }
  if (mode !== "flow_only") {
    assert.equal((await patch(id,"reviewer2","approve",{note:"同意测试内容"})).status,200);
    assert.equal(row(id).current_step,"指定审批");
    assert.equal((await patch(id,"reviewer1","approve")).status,200);
  }
  assert.equal(row(id).status,"已归档");
  const check=await get(id,mode === "approval_only" ? "reviewer2" : "recipient2");
  assert.equal(check.status,200); assert.ok(check.data.approval.archiveHash); assert.equal(check.data.approval.archiveIntegrityError,undefined);
  assert.equal(events(id).length,mode === "both" ? 5 : 3);
  const response=await pdf.GET(new Request("https://oa.example.test/"),{params:Promise.resolve({id})});
  assert.equal(response.status,200); assert.equal(response.headers.get("content-type"),"application/pdf");
  const bytes=new Uint8Array(await response.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.slice(0,5)),"%PDF-");
});

test("selected participants see their list and detail; an unrelated member cannot read or act",async()=>{
  const c=await create();const id=c.data.approval.id;
  for(const actor of ["recipient2","reviewer2"]){setActor(actor);const list=await collection.GET();assert.equal((await list.json()).approvals.length,1);assert.equal((await get(id,actor)).status,200);}
  setActor("outsider");assert.equal((await (await collection.GET()).json()).approvals.length,0);
  assert.equal((await get(id,"outsider")).status,404);assert.equal((await patch(id,"outsider","confirm_circulation")).status,404);
  const response=await pdf.GET(new Request("https://oa.example.test/"),{params:Promise.resolve({id})});assert.equal(response.status,404);
});

test("draft selections do not disclose the draft to recipients or reviewers",async()=>{
  const c=await create({...body(),saveAsDraft:true});const id=c.data.approval.id;
  assert.equal(c.status,201);for(const actor of ["recipient1","reviewer1"]){assert.equal((await get(id,actor)).status,404);setActor(actor);assert.equal((await (await collection.GET()).json()).approvals.length,0);}
  assert.equal((await get(id,"author")).status,200);
});

for(const [name,recipients,approvers] of [["both empty",[],[]],["self approval",[],["author"]],["duplicate recipient",["recipient1","recipient1"],[]],["unknown person",["missing"],[]],["too many recipients",Array(51).fill("recipient1"),[]]])test(`rejects ${name}`,async()=>{assert.equal((await create(body(recipients,approvers))).status,400);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM approvals").get().n,0);});

test("submitted identity and completed-decision fields cannot be forged",async()=>{
  const data=body([{memberId:"recipient1",email:"outsider@example.com",accountUserId:"attacker",name:"forged"}],[]);
  data.payload.circulationConfirmations=[{memberId:"recipient1",accountUserId:"email:recipient1@example.com",email:"recipient1@example.com"}];
  const c=await create(data);assert.equal(c.status,201);assert.deepEqual(c.data.approval.payload.circulationConfirmations,[]);
  assert.equal(c.data.approval.payload.circulationRecipients[0].email,"recipient1@example.com");
  assert.equal((await patch(c.data.approval.id,"outsider","confirm_circulation")).status,404);
});

test("overlapping recipient and reviewer requires two separate actions",async()=>{
  const c=await create(body(["recipient1"],["recipient1"]));const id=c.data.approval.id;
  assert.equal((await patch(id,"recipient1","approve")).status,409);
  assert.equal((await patch(id,"recipient1","confirm_circulation")).status,200);assert.equal(row(id).status,"审批中");
  assert.equal((await patch(id,"recipient1","approve")).status,200);assert.equal(events(id).length,3);
});

test("return and resubmit clear current decisions while retaining immutable history",async()=>{
  const c=await create();const id=c.data.approval.id;
  assert.equal((await patch(id,"recipient1","confirm_circulation")).status,200);
  assert.equal((await patch(id,"recipient2","return",{note:"请补充测试材料"})).status,200);
  assert.equal((await patch(id,"author","resubmit",{note:"已补充测试材料"})).status,200);
  assert.deepEqual(JSON.parse(row(id).payload_json).circulationConfirmations,[]);
  assert.equal((await patch(id,"recipient1","confirm_circulation")).status,200);
  assert.equal(events(id).filter(e=>e.action==="confirm_circulation").length,2);
  assert.equal((await patch(id,"reviewer1","approve")).status,404);
});

test("withdrawn approval can be edited to skip circulation and resets the workflow",async()=>{
  const c=await create();const id=c.data.approval.id;
  assert.equal((await patch(id,"author","withdraw",{note:"修改处理对象"})).status,200);
  setActor("author");const updated=await create({...body([],["reviewer2"]),id});assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.equal(row(id).current_step,"指定审批");assert.equal((await patch(id,"recipient1","confirm_circulation")).status,404);
  assert.equal((await patch(id,"reviewer2","approve")).status,200);
});

test("stored identity replacement fails closed",async()=>{
  const c=await create(body(["recipient1"],[]));const id=c.data.approval.id;
  sqlite.prepare("UPDATE members SET account_user_id='new-subject' WHERE id='recipient1'").run();
  setActor("recipient1");globalThis[stateKey].actor.accountUserId="new-subject";
  const r=await detail.PATCH(request("PATCH",{action:"confirm_circulation"}),{params:Promise.resolve({id})});assert.equal(r.status,404);
  assert.equal(events(id).length,1);
});

test("member deactivation during a write is caught by the transactional member guard",async()=>{
  const c=await create(body(["recipient1"],[]));const id=c.data.approval.id;
  globalThis[stateKey].beforeBatch=()=>sqlite.prepare("UPDATE members SET status='departed' WHERE id='recipient1'").run();
  assert.equal((await patch(id,"recipient1","confirm_circulation")).status,409);assert.equal(events(id).length,1);
});

test("concurrent confirmations do not lose another person's decision or audit event",async()=>{
  const c=await create(body(["recipient1","recipient2"],[]));const id=c.data.approval.id;
  const results=await Promise.all([patch(id,"recipient1","confirm_circulation"),patch(id,"recipient2","confirm_circulation")]);
  for(let i=0;i<results.length;i++){assert.ok([200,409].includes(results[i].status),JSON.stringify(results[i]));if(results[i].status===409)assert.equal((await patch(id,`recipient${i+1}`,"confirm_circulation")).status,200);}
  assert.equal(row(id).status,"已归档");assert.equal(JSON.parse(row(id).payload_json).circulationConfirmations.length,2);assert.equal(events(id).length,3);
});
