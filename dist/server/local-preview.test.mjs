import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalPreviewRole, isLocalPreviewEnabled } from './local-preview.mjs';

test('local role preview requires an explicit non-production setting', () => {
  assert.equal(isLocalPreviewEnabled({ LOCAL_ROLE_PREVIEW: 'true', NODE_ENV: 'development' }), true);
  assert.equal(isLocalPreviewEnabled({ LOCAL_ROLE_PREVIEW: 'true', NODE_ENV: 'production' }), false);
  assert.equal(isLocalPreviewEnabled({ NODE_ENV: 'development' }), false);
});

test('local role preview allows only supported roles from loopback requests', () => {
  const options = { enabled: true, remoteAddress: '127.0.0.1' };
  assert.equal(getLocalPreviewRole({ ...options, role: 'supplier' }), 'supplier');
  assert.equal(getLocalPreviewRole({ ...options, role: 'medical_shop' }), 'medical_shop');
  assert.equal(getLocalPreviewRole({ ...options, role: 'admin' }), 'admin');
  assert.equal(getLocalPreviewRole({ ...options, remoteAddress: '192.168.1.20', role: 'supplier' }), null);
  assert.equal(getLocalPreviewRole({ ...options, enabled: false, role: 'supplier' }), null);
});
