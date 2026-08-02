const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const provider = require('../dist/providers/gemini.js');

test('defaults Gemini to the non-conflicting host development endpoint', () => {
  delete process.env.GEMINI_BASE_URL;
  assert.equal(provider.geminiBaseUrl(), 'http://127.0.0.1:18000');
});

test('routes explicit and model-selected Gemini requests', () => {
  assert.equal(provider.isGeminiRequest({ model: 'gemini-3-pro' }), true);
  assert.equal(provider.isGeminiRequest({ provider: 'gemini', model: 'custom' }), true);
  assert.equal(provider.isGeminiRequest({ model: 'qwen3.7-max' }), false);
});

test('exposes safe fallback Gemini models', () => {
  delete process.env.GEMINI_MODELS;
  const ids = provider.fallbackGeminiModels().map(model => model.id);
  assert.deepEqual(ids, ['gemini-3-pro', 'gemini-3-flash']);
});

test('proxies non-streaming Gemini chat and removes provider hint', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl-gemini', choices: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}`;

  const req = { body: { provider: 'gemini', model: 'gemini-3-pro', messages: [], stream: false }, headers: {}, on() {} };
  let status;
  const headers = {};
  let output;
  const res = {
    status(value) { status = value; return this; },
    setHeader(key, value) { headers[key.toLowerCase()] = value; },
    send(value) { output = value; return value; },
    json(value) { output = value; return value; },
  };
  await provider.proxyGeminiChat(req, res, () => assert.fail('must proxy'));
  assert.equal(status, 200);
  assert.equal(headers['x-conduit-provider'], 'gemini');
  assert.equal(output.id, 'chatcmpl-gemini');
  assert.equal(received.provider, undefined);
  await new Promise(resolve => server.close(resolve));
});

test('extracts Gemini session values from a complete Cookie header', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ account: { id: 'personal', proxy: null, healthy: true } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const account = await provider.addGeminiAccount({ id: 'personal', cookie: 'NID=abc; __Secure-1PSID=primary; __Secure-1PSIDTS=rotating; other=value' });
  assert.equal(account.healthy, true);
  assert.equal(received.secure_1psid, 'primary');
  assert.equal(received.secure_1psidts, 'rotating');
  await new Promise(resolve => server.close(resolve));
});

test('reads live Gemini models when available', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemini-live', object: 'model', created: 1, owned_by: 'gemini-web' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
  const models = await provider.geminiModels();
  assert.deepEqual(models.map(model => model.id), ['gemini-live']);
  await new Promise(resolve => server.close(resolve));
});
