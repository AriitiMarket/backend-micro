'use strict';
// Architecture guard.
//
// These tests assert the RULES of the service-to-service design, not the
// behaviour of one module. They are what stops the patterns this refactor
// removed (gateway hops for internal traffic, hard-coded peer addresses, a
// committed cluster secret, a single shared credential) from creeping back in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVICES = ['identity-service', 'commerce-service', 'delivery-service'];

/** Recursively collect source files, skipping build output and vendored code. */
function sourceFiles(dir, extensions) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'uploads', 'coverage', 'dist', 'build']);
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_err) { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function relative(fullPath) {
  return path.relative(ROOT, fullPath);
}

test('the shared service-communication modules are byte-identical in every component', () => {
  // There is no shared workspace package in this repo; identical copies are what
  // make the trust boundary auditable from a single file (same convention as
  // middleware/authorize.js). These assertions keep them identical.
  const groups = [
    {
      name: 'internal-auth.js',
      copies: [
        'api-gateway/src/shared/internal-auth.js',
        'identity-service/src/shared/internal-auth.js',
        'commerce-service/src/shared/internal-auth.js',
        'delivery-service/src/shared/internal-auth.js',
      ],
    },
    {
      name: 'request-context.js',
      copies: [
        'identity-service/src/shared/request-context.js',
        'commerce-service/src/shared/request-context.js',
        'delivery-service/src/shared/request-context.js',
      ],
    },
    {
      name: 'internal-client.js',
      copies: [
        'commerce-service/src/shared/internal-client.js',
        'delivery-service/src/shared/internal-client.js',
      ],
    },
    {
      name: 'middleware/gatewayOnly.js',
      copies: [
        'commerce-service/src/app/middleware/gatewayOnly.js',
        'delivery-service/src/app/middleware/gatewayOnly.js',
      ],
    },
  ];

  for (const group of groups) {
    const copies = group.copies.map((copy) => ({ copy, content: read(copy) }));
    for (let index = 1; index < copies.length; index += 1) {
      assert.equal(
        copies[index].content,
        copies[0].content,
        `${group.name} drifted: ${copies[0].copy} and ${copies[index].copy} must stay byte-identical`
      );
    }
  }
});


test('no cluster credential is committed anywhere in the repository', () => {
  // The previous deployment committed a real shared secret in docker-compose.yml
  // and in every .env.example, which made every /internal/* endpoint forgeable.
  const templates = [
    '.env.example',
    'api-gateway/.env.example',
    'identity-service/.env.example',
    'commerce-service/.env.example',
    'delivery-service/.env.example',
  ];

  for (const file of templates) {
    if (!exists(file)) continue;
    for (const line of read(file).split('\n')) {
      const match = /^\s*INTERNAL_SERVICE_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
      if (match) assert.equal(match[1], '', `${file} must not ship a concrete INTERNAL_SERVICE_TOKEN`);
    }
  }

  const compose = read('docker-compose.yml');
  assert.match(
    compose,
    /INTERNAL_SERVICE_TOKENS:\s*'\$\{INTERNAL_SERVICE_TOKENS:\?/,
    'docker-compose.yml must take the credential map from the environment and fail closed when it is missing'
  );
  assert.doesNotMatch(
    compose,
    /INTERNAL_SERVICE_TOKEN:\s*[A-Za-z0-9_-]{16,}/,
    'docker-compose.yml must not contain a literal credential'
  );
});

test('peer addresses come from configuration, never from source', () => {
  const allowed = new Set([
    'api-gateway/src/config/services.js',
    'commerce-service/src/app/config/services.js',
    'delivery-service/src/app/config/services.js',
  ]);

  const offenders = [];
  for (const dir of ['api-gateway/src', ...SERVICES.map((s) => `${s}/src`)]) {
    for (const file of sourceFiles(path.join(ROOT, dir), ['.js'])) {
      const rel = relative(file);
      if (allowed.has(rel)) continue;
      const content = fs.readFileSync(file, 'utf8');
      // A peer address in code: a literal host:port for one of our own services.
      if (/\b(identity|commerce|delivery|api-gateway)(-service)?:800[0-9]\b/.test(content)) {
        offenders.push(rel);
      }
    }
  }
  assert.deepEqual(offenders, [], 'peer service addresses must be resolved from the environment');
});

test('the services do not route inter-service traffic back through the public gateway', () => {
  // The gateway is only legitimate for the endpoints it uniquely owns (the
  // Socket.IO fan-out); everything else must call the owning service directly.
  const offenders = [];
  for (const service of SERVICES) {
    for (const file of sourceFiles(path.join(ROOT, `${service}/src`), ['.js'])) {
      const rel = relative(file);
      if (rel.includes('__tests__')) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (/\/api\/internal\//.test(content)) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'service-to-service calls must target the owning service, not the gateway'
  );
});

test('every service exposes liveness, readiness and a backwards-compatible probe', () => {
  for (const service of SERVICES) {
    const files = sourceFiles(path.join(ROOT, `${service}/src`), ['.js']).filter(
      (file) => !relative(file).includes('__tests__')
    );
    const content = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.match(content, /'\/health\/live'/, `${service} must expose /health/live`);
    assert.match(content, /'\/health\/ready'/, `${service} must expose /health/ready`);
    assert.match(content, /'\/health'/, `${service} must keep /health for existing probes`);
  }
});

test('docker-compose keeps the backend private and only the gateway public', () => {
  const compose = read('docker-compose.yml');

  // Anchored on the 2-space service keys so a URL that merely contains a service
  // name (e.g. http://identity:8001) cannot be mistaken for a service block.
  const blockFor = (name) => {
    const match = new RegExp(`(?:^|\\n)  ${name}:\\n([\\s\\S]*?)(?=\\n  \\S|\\nnetworks:)`).exec(compose);
    assert.ok(match, name + ' service block not found');
    return match[0];
  };

  const gateway = blockFor('api-gateway');
  assert.match(gateway, /\n    ports:/, 'the gateway is the only published entry point');

  for (const service of ['identity', 'commerce-service', 'delivery-service']) {
    const block = blockFor(service);
    assert.match(block, /\n    expose:/, service + ' should declare expose');
    assert.doesNotMatch(block, /\n    ports:/, service + ' must not publish a port');
  }
});

test('the gateway never trusts a client-supplied service or identity header', () => {
  const forward = read('api-gateway/src/proxies/forward.js');
  assert.match(forward, /headers\['X-Internal-Service'\] = outbound\.service/, 'the gateway signs as itself');
  assert.match(forward, /headers\['X-Internal-Token'\] = outbound\.token/);
  assert.doesNotMatch(
    forward,
    /req\.headers\['x-internal-service'\]/,
    'a client-supplied x-internal-service must never be forwarded'
  );
  assert.doesNotMatch(
    forward,
    /headers\['x-user-id'\] = req\.headers/,
    'client-supplied identity headers must never be forwarded'
  );
});
