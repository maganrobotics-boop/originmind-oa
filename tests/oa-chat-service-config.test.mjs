import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildStandaloneConfig, PRODUCTION_CHAT_SERVICE, validateProductionChatServiceBindings } from '../lib/standalone-config.mjs';

const production = {
  OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  OA_PRODUCTION_WORKER_NAME: 'legacy-worker-name',
  OA_PRODUCTION_D1_DATABASE_NAME: 'originmind-oa-production',
  OA_PRODUCTION_D1_DATABASE_ID: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME: 'website-visits',
  OA_PRODUCTION_WEBSITE_D1_DATABASE_ID: '68f91d4c-0b3a-4a92-b879-f355177a67f8',
  OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME: 'originmind-oa-knowledge-assets-production',
  OA_PRODUCTION_PUBLIC_ORIGIN: 'https://oa.example.com',
  OA_PRODUCTION_CRON: '* * * * *',
};

test('production OA explicitly binds the existing Chat Worker without changing routes or secrets', async () => {
  const config = buildStandaloneConfig('production',production);
  validateProductionChatServiceBindings(config.services);
  assert.deepEqual(config.services,[{binding:'CHAT_SERVICE',service:'originmind-public-chat-production'}]);
  const release = await readFile(new URL('../chat-cloudflare/scripts/release-support.mjs',import.meta.url),'utf8');
  assert.equal(release.match(/^export const WORKER_NAME = "([^"]+)";/mu)?.[1],PRODUCTION_CHAT_SERVICE.service);
  assert.equal(config.keep_vars,true); assert.equal(config.workers_dev,false);
  assert.equal(config.routes,undefined); assert.equal(config.route,undefined);
  assert.deepEqual(config.vars,{OA_PUBLIC_ORIGIN:production.OA_PRODUCTION_PUBLIC_ORIGIN});
  assert.deepEqual(config.secrets.required,['GITHUB_OAUTH_CLIENT_SECRET','FEISHU_LOGIN_APP_SECRET','PUBLIC_LAB_AI_SERVICE_TOKEN']);
});

test('the compiled output gate rejects a missing, duplicate or redirected Chat capability', () => {
  for (const services of [undefined,null,{},[],[null],[PRODUCTION_CHAT_SERVICE,PRODUCTION_CHAT_SERVICE],
    [{...PRODUCTION_CHAT_SERVICE,binding:'WRONG'}],
    [{...PRODUCTION_CHAT_SERVICE,service:'untrusted-worker'}],
    [{...PRODUCTION_CHAT_SERVICE,environment:'staging'}],
    [{...PRODUCTION_CHAT_SERVICE,entrypoint:'OtherEntrypoint'}]]) {
    assert.throws(() => validateProductionChatServiceBindings(services),/CHAT_SERVICE/u);
  }
  validateProductionChatServiceBindings([{service:PRODUCTION_CHAT_SERVICE.service,binding:PRODUCTION_CHAT_SERVICE.binding}]);
});

test('isolated staging receives no production Chat service capability', () => {
  const config = buildStandaloneConfig('staging',{
    OA_STAGING_CLOUDFLARE_ACCOUNT_ID: production.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
    OA_STAGING_WORKER_NAME: 'originmind-isolated-staging',
    OA_STAGING_D1_DATABASE_NAME: 'originmind-isolated-staging',
    OA_STAGING_D1_DATABASE_ID: production.OA_PRODUCTION_D1_DATABASE_ID,
    OA_STAGING_PUBLIC_ORIGIN: 'https://originmind-isolated-staging.example.workers.dev',
    GITHUB_OAUTH_CLIENT_ID: 'test_client_id_123456',
    FEISHU_LOGIN_APP_ID: 'cli_test1234', FEISHU_LOGIN_TENANT_KEY: 'tenant_test1234',
    OA_ADMIN_EMAILS: 'admin@example.com', OA_ADMIN_NAMES: 'Test Admin',
  });
  assert.equal(config.services,undefined);
});
