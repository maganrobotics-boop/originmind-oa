import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/newbie-village.js', import.meta.url), 'utf8');
function setup() {
  const nodes = new Map();
  const storage = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, {
      hidden: false, value: '', style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, append() {}, focus() {},
      replaceChildren(...items) { this.children = items; },
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelector: node, querySelectorAll: () => [],
      elements: { namedItem: node },
    });
    return nodes.get(key);
  }
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => node(Symbol()) },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    location: { hash: '' }, history: { replaceState() {} }, window: { addEventListener() {} },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, console,
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), node, storage };
}

test('all seven courses open without account, agreement, or backend', async () => {
  const app = setup();
  await app.run('loadDashboard()');
  assert.equal(app.node('.dashboard').hidden, false);
  assert.equal(app.node('.agreement-gate').hidden, true);
  assert.equal(app.run('state.dashboard.tasks.length'), 7);
  assert.equal(app.run('state.dashboard.tasks.every(t => t.unlocked && t.steps.length)'), true);
  app.run('openTask("graduation")');
  assert.equal(app.node('.task-dialog').open, true);
});

test('local completion survives reload and logout; formal submission opens login', async () => {
  const app = setup();
  await app.run('loadDashboard()');
  app.run('openTask("toolkit")');
  app.node('.task-evidence').value = 'Git and Python installed';
  await app.run('updateTask("completed")');
  await app.run('logout()');
  await app.run('loadDashboard()');
  assert.equal(app.run('state.dashboard.tasks[1].status'), 'completed');
  assert.equal(app.run('state.dashboard.tasks[1].evidence'), 'Git and Python installed');
  app.run('openLogin()');
  assert.equal(app.node('.login-dialog').open, true);
});

test('server failure never becomes successful submission or local agreement', async () => {
  const app = setup();
  await app.run('loadDashboard()');
  app.run('state.localGuest = false; state.dashboard.agreement.approved = true; openTask("toolkit")');
  await app.run('updateTask("completed")');
  assert.equal(app.storage.size, 0);
  assert.equal(app.node('.task-dialog').open, true);
  assert.ok(app.node('.task-status').textContent);
});

test('Python deep link opens current lesson while retaining saved progress', async () => {
  const app = setup();
  app.run('location.hash = "#python-basics"');
  await app.run('loadDashboard()');
  assert.equal(app.node('.task-dialog').open, true);
  assert.equal(app.node('.task-materials').hidden, false);
  app.run(`state.dashboard.tasks.find(t => t.id === 'python-basics').summary = 'old server text';
    state.dashboard.tasks.find(t => t.id === 'python-basics').status = 'completed';
    state.dashboard.tasks.find(t => t.id === 'python-basics').evidence = 'saved work';
    renderDashboard(); openTask('python-basics');`);
  assert.match(app.node('.task-summary-dialog').textContent, /模拟巡检日志/);
  assert.equal(app.run("state.dashboard.tasks.find(t => t.id === 'python-basics').status"), 'completed');
  assert.equal(app.node('.task-evidence').value, 'saved work');
  app.run('openTask("toolkit")');
  assert.equal(app.node('.task-materials').hidden, true);
});
