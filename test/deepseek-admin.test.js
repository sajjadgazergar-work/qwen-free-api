const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const provider = require('../dist/providers/deepseek.js');

const baseConfig = {
  server: { host: '0.0.0.0', port: 22217, cors_origins: [] },
  ds_core: { accounts: [], model_types: ['default'], max_input_tokens: [100], max_output_tokens: [100], input_character_limits: [100], model_aliases: [] },
  proxy: {}, admin: { password_set: false, jwt_issued_at: 1 }, api_keys: [],
};

test('automatically initializes DeepSeek management and adds a website account', async t => {
  let config = structuredClone(baseConfig);
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/admin/api/login') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Admin password is not set' })); }
      if (req.url === '/admin/api/setup') return res.end(JSON.stringify({ token: 'internal-jwt' }));
      assert.equal(req.headers.authorization, 'Bearer internal-jwt');
      if (req.method === 'GET' && req.url === '/admin/api/config') return res.end(JSON.stringify(config));
      if (req.method === 'PUT' && req.url === '/admin/api/config') { config = body; return res.end(JSON.stringify({ ok: true })); }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DEEPSEEK_ADMIN_PASSWORD = 'conduit-internal-secret';

  await provider.addDeepSeekAccount({ email: 'user@example.com', password: 'website-password' });

  assert.deepEqual(config.ds_core.accounts, [{ email: 'user@example.com', mobile: '', area_code: '', password: 'website-password' }]);
  assert.equal(requests.some(r => r.url === '/admin/api/setup'), true);
  assert.equal(config.admin.password_hash, '');
});
