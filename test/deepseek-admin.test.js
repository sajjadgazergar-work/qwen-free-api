const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const provider = require('../dist/providers/deepseek.js');

async function mockDeepSeek(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => handler(req, res, body ? JSON.parse(body) : undefined));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  return server;
}

const baseConfig = {
  server: { host: '0.0.0.0', port: 22217, cors_origins: [] },
  ds_core: {
    accounts: [], api_base: 'https://chat.deepseek.com/api/v0', wasm_url: '', user_agent: '',
    client_version: '', client_platform: 'android', client_locale: 'en_US',
    model_types: ['default'], max_input_tokens: [100], max_output_tokens: [100],
    input_character_limits: [100], model_aliases: [], tool_call: { extra_starts: [], extra_ends: [] },
  },
  proxy: { url: null }, admin: { password_set: true, jwt_issued_at: 1 }, api_keys: [],
};

test('connects to an existing DeepSeek admin service', async t => {
  const server = await mockDeepSeek((req, res, body) => {
    assert.equal(req.url, '/admin/api/login');
    assert.deepEqual(body, { password: 'secret1' });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token: 'jwt-test' }));
  });
  t.after(() => server.close());
  assert.deepEqual(await provider.deepSeekAdminLogin('secret1'), { token: 'jwt-test', setup: false });
});

test('initializes DeepSeek admin on first connection', async t => {
  const server = await mockDeepSeek((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/admin/api/login') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Admin password is not set' })); }
    assert.equal(req.url, '/admin/api/setup');
    res.end(JSON.stringify({ token: 'jwt-new' }));
  });
  t.after(() => server.close());
  assert.deepEqual(await provider.deepSeekAdminLogin('secret1'), { token: 'jwt-new', setup: true });
});

test('adds a DeepSeek email account through config hot reload', async t => {
  let config = structuredClone(baseConfig);
  const server = await mockDeepSeek((req, res, body) => {
    res.setHeader('content-type', 'application/json');
    assert.equal(req.headers.authorization, 'Bearer jwt-test');
    if (req.method === 'GET') return res.end(JSON.stringify(config));
    config = body;
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => server.close());
  await provider.addDeepSeekAccount('jwt-test', { email: 'user@example.com', password: 'pass' });
  assert.deepEqual(config.ds_core.accounts, [{ email: 'user@example.com', mobile: '', area_code: '', password: 'pass' }]);
  assert.equal(config.admin.password_hash, '');
});
