import assert from 'node:assert/strict';
import { createCorsMiddleware, createRateLimiter, isOriginAllowed, parseAllowedOrigins } from '../src/security.js';

const tests = [
  ['parseAllowedOrigins trims comma-separated origins', testParseAllowedOrigins],
  ['isOriginAllowed accepts explicit and same-host origins in production', testOriginAllowList],
  ['isOriginAllowed accepts localhost during development', testLocalhostDevelopment],
  ['createCorsMiddleware rejects untrusted preflight requests', testRejectedPreflight],
  ['createRateLimiter blocks after the configured request count', testRateLimiter]
];

for (const [name, run] of tests) {
  run();
  console.log(`ok - ${name}`);
}

function testParseAllowedOrigins() {
  assert.deepEqual([...parseAllowedOrigins('https://a.example, https://b.example ,,')], [
    'https://a.example',
    'https://b.example'
  ]);
}

function testOriginAllowList() {
  const allowed = parseAllowedOrigins('https://app.example');

  assert.equal(isOriginAllowed('https://app.example', 'api.example', allowed, true), true);
  assert.equal(isOriginAllowed('https://api.example', 'api.example', allowed, true), true);
  assert.equal(isOriginAllowed('https://evil.example', 'api.example', allowed, true), false);
}

function testLocalhostDevelopment() {
  assert.equal(isOriginAllowed('http://localhost:5173', '127.0.0.1:3001', new Set(), false), true);
}

function testRejectedPreflight() {
  const cors = createCorsMiddleware({ allowedOrigins: 'https://app.example', nodeEnv: 'production' });
  const res = mockResponse();

  cors({ method: 'OPTIONS', headers: { origin: 'https://evil.example', host: 'api.example' } }, res, () => {
    throw new Error('next should not be called for rejected preflight');
  });

  assert.equal(res.statusCode, 403);
}

function testRateLimiter() {
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, keyGenerator: () => 'same-user' });
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  let passed = 0;

  limiter(req, mockResponse(), () => {
    passed += 1;
  });
  limiter(req, mockResponse(), () => {
    passed += 1;
  });

  const blocked = mockResponse();
  limiter(req, blocked, () => {
    throw new Error('next should not be called after rate limit is exceeded');
  });

  assert.equal(passed, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.message, 'Too many attempts. Please try again later.');
}

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    sendStatus(statusCode) {
      this.statusCode = statusCode;
      this.body = null;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
    }
  };
}
