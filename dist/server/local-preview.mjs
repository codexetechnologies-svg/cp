const PREVIEW_ROLES = new Set(['admin', 'supplier', 'medical_shop']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalPreviewEnabled(environment = process.env) {
  return environment.LOCAL_ROLE_PREVIEW === 'true' && environment.NODE_ENV !== 'production';
}

export function getLocalPreviewRole({ enabled, remoteAddress, role }) {
  if (!enabled || !LOOPBACK_ADDRESSES.has(remoteAddress) || !PREVIEW_ROLES.has(role)) {
    return null;
  }
  return role;
}
