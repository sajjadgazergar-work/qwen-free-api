const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const provider = require('../dist/providers/gemini.js');

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
