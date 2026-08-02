const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const provider = require('../dist/providers/deepseek.js');

test('defaults DeepSeek to the host development endpoint', () => {
  delete process.env.DEEPSEEK_BASE_URL;
  assert.equal(provider.deepSeekBaseUrl(), 'http://127.0.0.1:22217');
});

test('routes explicit and model-selected DeepSeek requests', () => {
  assert.equal(provider.isDeepSeekRequest({ model: 'deepseek-expert' }), true);
  assert.equal(provider.isDeepSeekRequest({ provider: 'deepseek', model: 'custom' }), true);
  assert.equal(provider.isDeepSeekRequest({ model: 'qwen3.7-max' }), false);
});

test('exposes the default DeepSeek model set', () => {
  const ids = provider.deepSeekModels().map(model => model.id);
  assert.deepEqual(ids, ['deepseek-default', 'deepseek-expert', 'deepseek-vision']);
});

test('proxies non-streaming chat and removes provider hint', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl-ds', choices: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;

  const req = {
    body: { provider: 'deepseek', model: 'deepseek-default', messages: [], stream: false },
    headers: {},
    on() {},
  };
  let status;
  let headers = {};
  let output;
  const res = {
    status(value) { status = value; return this; },
    setHeader(key, value) { headers[key.toLowerCase()] = value; },
    send(value) { output = value; return value; },
    json(value) { output = value; return value; },
  };
  await provider.proxyDeepSeekChat(req, res, () => assert.fail('must proxy'));
  assert.equal(status, 200);
  assert.equal(headers['x-conduit-provider'], 'deepseek');
  assert.equal(output.id, 'chatcmpl-ds');
  assert.equal(received.provider, undefined);
  server.close();
});
