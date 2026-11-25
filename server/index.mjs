import express from 'express';
import postgres from 'postgres';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { deleteAccountKycObjects, validateAccountKycStorageKeys } from './account-deletion.mjs';
import { deleteSupabaseAuthUser, findSupabaseAuthUserIdByEmail } from './supabase-admin.mjs';
import { signInSupabaseUser, signupSupabaseUser } from './supabase-signup.mjs';
import {
  requestSupabasePasswordReset,
  resendSupabaseSignupEmail,
  SupabaseAuthError,
  updateSupabasePassword
} from './supabase-email.mjs';
import { statusAfterEmailVerification } from './account-status.mjs';
import { verifyCashfreeWebhookSignature } from './cashfree-webhook.mjs';
import { getLocalPreviewRole, isLocalPreviewEnabled } from './local-preview.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env.local loader (no dependency)
const envPath = join(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const databaseUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
if (!databaseUrl) {
  // Do not exit on serverless platforms: static pages should still render and
  // API routes should return errors instead of taking the whole function down.
  console.error('DATABASE_URL or NEON_DATABASE_URL is not configured; API routes will fail.');
}

const sql = postgres(databaseUrl || 'postgres://localhost:5432/connect_pharma_unconfigured', {
  max: 5,
  ssl: 'require',
  connect_timeout: 10,
  idle_timeout: 20
});
const app = express();
app.use(express.json({
  limit: '1mb',
  verify(req, _res, buffer) {
    if (req.path === '/api/webhooks/cashfree') req.rawBody = Buffer.from(buffer);
  }
}));

const PORT = Number(process.env.PORT || 4000);
const WEB_DIR = join(__dirname, '..', 'public');
// Supabase project URL and publishable key are public by design (they ship to
// browsers in Supabase client apps), so they are safe fallbacks. Env vars
// still take precedence for other environments.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://uijpwczjfbqobbgjthmb.supabase.co').replace(/\/+$/, '');
const SUPABASE_API_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_k0cKHDCN8cVAlmviXUmJmw_eOekY2B7';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasUpstashConfig = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://cashfree.com https://*.cashfree.com",
  "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com https://sdk.cashfree.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.cashfree.com",
  "frame-src 'self' https://cashfree.com https://*.cashfree.com",
  "worker-src 'self' blob:"
].join('; ');
let r2Client;
let supabaseAuthIdColumnAvailable;

if (process.env.TRUST_PROXY_HOPS) {
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(proxyHops) || proxyHops < 1) {
    throw new Error('TRUST_PROXY_HOPS must be a positive integer.');
  }
  app.set('trust proxy', proxyHops);
} else if (process.env.VERCEL === '1') {
  // Vercel fronts functions with a proxy; trust one hop so req.ip is the
  // real client IP and rate limiting keys per user, not per edge node.
  app.set('trust proxy', 1);
}

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  if (_req.path.startsWith('/api/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
  } else if (/^\/(admin|supplier|medical-shop)(\/|$)/.test(_req.path) || _req.path === '/dashboard.html') {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

// ---------- helpers ----------

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((error) => {
    console.error(`${req.method} ${req.path} failed:`, error);
    if (['22P02', '42P01', '42703', '42704', '42804'].includes(error?.code)) {
      return res.status(503).json({
        error: 'Required workflow schema is missing. Apply database/migrations/0003_admin_billing_kyc.sql after reviewing it and backing up the database.'
      });
    }
    res.status(500).json({ error: 'Something went wrong.' });
  });
}

const redis = hasUpstashConfig ? Redis.fromEnv() : null;
const localRateBuckets = new Map();
let warnedMissingRedis = false;

function requestLimiter(name, maxRequests, windowSeconds) {
  const distributedLimiter = redis
    ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
      prefix: `connect-pharma:${name}`,
      analytics: false
    })
    : null;
  return async (req, res, next) => {
    try {
      const key = req.ip || 'unknown';
      let success;
      let remaining;
      let reset;

      if (distributedLimiter) {
        ({ success, remaining, reset } = await distributedLimiter.limit(key));
      } else {
        if (process.env.NODE_ENV === 'production' && !warnedMissingRedis) {
          warnedMissingRedis = true;
          console.error('UPSTASH_REDIS_REST_URL/TOKEN not configured; rate limiting falls back to per-instance memory (weaker on serverless).');
        }
        const now = Date.now();
        const bucketKey = `${name}:${key}`;
        let bucket = localRateBuckets.get(bucketKey);
        if (!bucket || bucket.reset <= now) {
          bucket = { count: 0, reset: now + windowSeconds * 1000 };
          localRateBuckets.set(bucketKey, bucket);
        }
        bucket.count += 1;
        success = bucket.count <= maxRequests;
        remaining = Math.max(0, maxRequests - bucket.count);
        reset = bucket.reset;
        if (localRateBuckets.size > 10000) {
          for (const [storedKey, storedBucket] of localRateBuckets) {
            if (storedBucket.reset <= now) localRateBuckets.delete(storedKey);
          }
        }
      }

      res.setHeader('RateLimit-Limit', String(maxRequests));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(reset / 1000)));
      if (!success) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))));
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      next();
    } catch (error) {
      console.error(`Rate limiter ${name} failed:`, error);
      res.status(503).json({ error: 'Request protection is temporarily unavailable.' });
    }
  };
}

const apiRateLimit = requestLimiter('api', 300, 900);
const publicDataRateLimit = requestLimiter('public-data', 30, 60);
const loginRateLimit = requestLimiter('login', 8, 900);
const signupRateLimit = requestLimiter('signup', 5, 900);

function getCashfreeConfig() {
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const mode = process.env.CASHFREE_ENV || 'sandbox';
  const publicAppUrl = process.env.PUBLIC_APP_URL;
  if (!appId || !secretKey || !publicAppUrl || !['sandbox', 'production'].includes(mode)) return null;

  let baseUrl;
  try {
    baseUrl = new URL(publicAppUrl);
  } catch {
    return null;
  }
  if (mode === 'production' && baseUrl.protocol !== 'https:') return null;
  if (
    baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash ||
    baseUrl.pathname !== '/'
  ) return null;

  return {
    appId,
    secretKey,
    mode,
    apiUrl: mode === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg',
    publicAppUrl: baseUrl.origin
  };
}

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  if (!/^[a-f0-9]{32}$/i.test(accountId)) return null;
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }
    });
  }
  return { client: r2Client, bucket };
}

function validUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parsePlan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const tier = typeof body.tier === 'string' ? body.tier.trim() : '';
  if (
    !['number', 'string'].includes(typeof body.skuLimit) ||
    !String(body.skuLimit).trim() ||
    !['number', 'string'].includes(typeof body.monthlyFee) ||
    !String(body.monthlyFee).trim()
  ) return null;
  const skuLimit = Number(body.skuLimit);
  const monthlyFee = Number(body.monthlyFee);
  const features = body.features;
  if (
    !tier ||
    tier.length > 50 ||
    !Number.isInteger(skuLimit) ||
    skuLimit < 1 ||
    skuLimit > 1000000 ||
    !Number.isFinite(monthlyFee) ||
    monthlyFee < 0 ||
    monthlyFee > 10000000 ||
    !Array.isArray(features) ||
    features.length > 30 ||
    features.some((feature) => typeof feature !== 'string' || !feature.trim() || feature.length > 160) ||
    (body.isActive !== undefined && typeof body.isActive !== 'boolean')
  ) return null;
  return {
    tier,
    skuLimit,
    monthlyFee: monthlyFee.toFixed(2),
    features: features.map((feature) => feature.trim()),
    isActive: body.isActive ?? true
  };
}

async function writeAdminAudit(tx, req, actionType, entityType, entityId, details) {
  await tx`
    insert into admin_audit_logs (actor_id, action_type, entity_type, entity_id, details)
    values (${req.account.id}, ${actionType}, ${entityType}, ${entityId}, ${tx.json(details)})
  `;
}

class AccountDeletionFailure extends Error {
  constructor(message, publicMessage) {
    super(message);
    this.publicMessage = publicMessage;
  }
}

async function processAccountDeletion(jobId) {
  const [job] = await sql`
    select account_id as "accountId", requested_by as "requestedBy",
           supabase_auth_id as "supabaseAuthId", reason,
           storage_keys as "storageKeys"
    from account_deletion_jobs
    where id = ${jobId} and status = 'pending'
  `;
  if (!job) return false;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !job.supabaseAuthId) {
    throw new AccountDeletionFailure(
      'Supabase Auth deletion is not configured for this account.',
      'Server-side Supabase Auth deletion is not configured. Account deletion was not completed; contact an administrator.'
    );
  }
  let storageKeys;
  try {
    storageKeys = validateAccountKycStorageKeys({
      accountId: job.accountId,
      storageKeys: job.storageKeys
    });
  } catch (error) {
    throw new AccountDeletionFailure(
      `KYC storage metadata validation failed: ${error.message}`,
      'KYC storage metadata does not match this account. Deletion was paused; contact support.'
    );
  }
  const storage = storageKeys.length ? getR2Config() : null;
  if (storageKeys.length && !storage) {
    throw new AccountDeletionFailure(
      'R2 configuration is unavailable for account deletion.',
      'Private R2 storage must be configured before this account’s documents can be deleted. The account remains suspended; retry after setup.'
    );
  }

  try {
    await deleteSupabaseAuthUser({
      baseUrl: SUPABASE_URL,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      userId: job.supabaseAuthId
    });
  } catch (error) {
    throw new AccountDeletionFailure(
      `Supabase Auth cleanup failed: ${error.message}`,
      'Supabase Auth could not remove this account. The application account remains suspended; retry after checking Supabase admin access.'
    );
  }

  if (storageKeys.length) {
    try {
      await deleteAccountKycObjects({
        client: storage.client,
        bucket: storage.bucket,
        accountId: job.accountId,
        storageKeys
      });
    } catch (error) {
      const metadataMismatch = error.message === 'KYC storage metadata does not match the account.';
      throw new AccountDeletionFailure(
        `KYC object cleanup failed: ${error.message}`,
        metadataMismatch
          ? 'KYC storage metadata does not match this account. Deletion was paused; contact support.'
          : 'R2 could not remove this account’s KYC documents. The account remains suspended; retry after checking storage access.'
      );
    }
  }

  return sql.begin(async (tx) => {
    const [lockedJob] = await tx`
      select account_id as "accountId", requested_by as "requestedBy",
             supabase_auth_id as "supabaseAuthId", reason
      from account_deletion_jobs
      where id = ${jobId} and status = 'pending'
      for update
    `;
    if (!lockedJob) return false;

    const [account] = await tx`
      select role from users where id = ${lockedJob.accountId} for update
    `;
    if (account?.role === 'admin') {
      throw new AccountDeletionFailure(
        'An admin account was unexpectedly queued for deletion.',
        'Admin accounts cannot be deleted through this workflow.'
      );
    }
    if (account) {
      const [deleted] = await tx`
        delete from users where id = ${lockedJob.accountId} and role <> 'admin'
        returning id
      `;
      if (!deleted) throw new Error('The account could not be deleted.');
    }

    await tx`
      insert into admin_audit_logs (actor_id, action_type, entity_type, entity_id, details)
      values (
        ${lockedJob.requestedBy}, 'account.deleted', 'user', ${lockedJob.accountId},
        ${tx.json({ reason: lockedJob.reason })}
      )
    `;
    await tx`
      update account_deletion_jobs
      set status = 'completed', storage_keys = '[]'::jsonb,
          last_error = null, updated_at = now(), completed_at = now()
      where id = ${jobId}
    `;
    return true;
  });
}

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return null;
  }
}

function writeAuthCookies(res, session) {
  const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
  const accessMaxAge = Math.max(60, Number(session.expires_in) || 3600);
  const cookies = [
    `cp_access_token=${encodeURIComponent(session.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${accessMaxAge}${secure}`,
    `cp_refresh_token=${encodeURIComponent(session.refresh_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`
  ];
  res.setHeader('Set-Cookie', cookies);
}

function clearAuthCookies(res) {
  const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
  res.setHeader('Set-Cookie', [
    `cp_access_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    `cp_refresh_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    'cp_preview_role=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
  ]);
}

function getPreviewRole(req) {
  return getLocalPreviewRole({
    enabled: isLocalPreviewEnabled(),
    remoteAddress: req.socket?.remoteAddress,
    role: readCookie(req, 'cp_preview_role')
  });
}

function isLocalPreviewRequest(req) {
  return isLocalPreviewEnabled() &&
    getLocalPreviewRole({
      enabled: true,
      remoteAddress: req.socket?.remoteAddress,
      role: 'supplier'
    }) === 'supplier';
}

function writePreviewCookie(res, role) {
  const maxAge = 4 * 60 * 60;
  res.setHeader('Set-Cookie', [
    `cp_access_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `cp_refresh_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `cp_preview_role=${role}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  ]);
}

function hasSupabaseAuthConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_API_KEY);
}

function getAuthEmailRedirectUrl(path = '/login.html?verified=1') {
  if (!process.env.PUBLIC_APP_URL) return null;
  try {
    const appUrl = new URL(process.env.PUBLIC_APP_URL);
    if (
      appUrl.username || appUrl.password || appUrl.search || appUrl.hash ||
      appUrl.pathname !== '/' ||
      (process.env.NODE_ENV === 'production' && appUrl.protocol !== 'https:')
    ) return null;
    return new URL(path, appUrl).toString();
  } catch {
    return null;
  }
}

function normalizeSignupPhone(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return null;
}

async function removeSignupReservation(accountId) {
  await sql`
    delete from users
    where id = ${accountId} and supabase_auth_id is null and status = 'pending'
  `;
}

async function getSupabaseUser(accessToken) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_API_KEY,
      Authorization: `Bearer ${accessToken}`
    },
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Supabase user verification failed (${response.status}).`);
  return response.json();
}

async function refreshSupabaseSession(refreshToken) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 400 || response.status === 401) return null;
  if (!response.ok) throw new Error(`Supabase session refresh failed (${response.status}).`);
  return response.json();
}

async function findAccount(authUser) {
  if (!authUser?.email || !authUser.email_confirmed_at) return null;
  const [account] = await sql`
    select id, role, status, full_name as "fullName", email
    from users
    where lower(email) = ${authUser.email.toLowerCase()}
    limit 1
  `;
  if (!account) return null;

  if (supabaseAuthIdColumnAvailable === undefined) {
    const [schema] = await sql`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
          and column_name = 'supabase_auth_id'
      ) as available
    `;
    supabaseAuthIdColumnAvailable = Boolean(schema.available);
  }
  if (!supabaseAuthIdColumnAvailable) return account;
  if (!validUuid(authUser.id)) return null;

  const [linked] = await sql`
    update users
    set supabase_auth_id = coalesce(supabase_auth_id, ${authUser.id}),
        email_verified = true, updated_at = now()
    where id = ${account.id}
      and (supabase_auth_id is null or supabase_auth_id = ${authUser.id})
    returning id
  `;
  return linked ? account : null;
}

function requireAccount(...roles) {
  return async (req, res, next) => {
    const previewRole = getPreviewRole(req);
    if (previewRole) {
      if (roles.length && !roles.includes(previewRole)) {
        return res.status(403).json({ error: 'You do not have permission to access this resource.' });
      }
      req.previewOnly = true;
      req.account = {
        id: previewRole === 'supplier'
          ? '00000000-0000-4000-8000-000000000001'
          : '00000000-0000-4000-8000-000000000002',
        fullName: previewRole === 'supplier' ? 'Local Distributor Preview' : 'Local Retailer Preview',
        email: 'preview@localhost',
        role: previewRole,
        status: 'approved'
      };
      return next();
    }

    if (!hasSupabaseAuthConfig()) {
      return res.status(503).json({ error: 'Authentication is not configured.' });
    }

    try {
      let authUser = null;
      const accessToken = readCookie(req, 'cp_access_token');
      const refreshToken = readCookie(req, 'cp_refresh_token');
      if (accessToken) authUser = await getSupabaseUser(accessToken);

      if (!authUser && refreshToken) {
        const refreshed = await refreshSupabaseSession(refreshToken);
        if (refreshed?.access_token && refreshed?.refresh_token) {
          writeAuthCookies(res, refreshed);
          authUser = await getSupabaseUser(refreshed.access_token);
        }
      }

      if (!authUser) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Please sign in to continue.' });
      }

      const account = await findAccount(authUser);
      if (!account || account.status !== 'approved') {
        clearAuthCookies(res);
        return res.status(403).json({ error: 'This account is not approved for access.' });
      }
      if (roles.length && !roles.includes(account.role)) {
        return res.status(403).json({ error: 'You do not have permission to access this resource.' });
      }

      req.account = account;
      next();
    } catch (error) {
      console.error(`Authentication failed for ${req.method} ${req.path}:`, error);
      res.status(503).json({ error: 'Authentication service is temporarily unavailable.' });
    }
  };
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
  }
  next();
}

app.use('/api', apiRateLimit);
app.use('/api', (req, res, next) => {
  // Surface a clear configuration error instead of a generic 500 when the
  // deployment is missing DATABASE_URL (e.g. env vars not yet added on Vercel).
  if (!databaseUrl && req.path !== '/health') {
    return res.status(503).json({
      error: 'Database is not configured on this deployment. Set DATABASE_URL in the hosting environment and redeploy.'
    });
  }
  next();
});
app.use('/api', (req, res, next) => {
  const previewRole = getPreviewRole(req);
  const readOnlyMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!previewRole || readOnlyMethod || req.path === '/auth/preview' || req.path === '/auth/logout') {
    return next();
  }
  return res.status(403).json({ error: 'Local role preview is read-only. Sign out of preview to continue.' });
});

// ---------- config / health ----------

app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
    localRolePreview: isLocalPreviewRequest(req)
  });
});

app.post('/api/auth/preview', requireSameOrigin, (req, res) => {
  if (!isLocalPreviewRequest(req)) {
    return res.status(404).json({ error: 'Local role preview is not enabled for this request.' });
  }
  const role = req.body?.role;
  if (!['supplier', 'medical_shop'].includes(role)) {
    return res.status(400).json({ error: 'Choose a distributor or retailer preview.' });
  }
  writePreviewCookie(res, role);
  res.json({
    user: {
      fullName: role === 'supplier' ? 'Local Distributor Preview' : 'Local Retailer Preview',
      role
    },
    previewOnly: true
  });
});

app.post('/api/auth/login', loginRateLimit, requireSameOrigin, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!hasSupabaseAuthConfig()) {
    return res.status(503).json({ error: 'Authentication is not configured.' });
  }
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email.trim() ||
    !password ||
    email.length > 320 ||
    password.length > 1024
  ) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password }),
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 400 || response.status === 401) {
    return res.status(401).json({ error: 'Email or password is incorrect, or the account is not approved.' });
  }
  if (!response.ok) throw new Error(`Supabase sign-in failed (${response.status}).`);

  const session = await response.json();
  const account = await findAccount(session.user);
  if (!account || account.status !== 'approved') {
    return res.status(403).json({ error: 'Email or password is incorrect, or the account is not approved.' });
  }

  writeAuthCookies(res, session);
  res.json({ user: { fullName: account.fullName, role: account.role } });
}));

app.post('/api/auth/signup', signupRateLimit, requireSameOrigin, asyncRoute(async (req, res) => {
  const { fullName, email, phone, password, role, consentAccepted } = req.body || {};
  const normalizedName = typeof fullName === 'string' ? fullName.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedPhone = phone === undefined || phone === null || phone === ''
    ? null
    : normalizeSignupPhone(phone);
  if (
    normalizedName.length < 2 || normalizedName.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 320 ||
    (phone !== undefined && phone !== null && phone !== '' && !normalizedPhone) ||
    typeof password !== 'string' || password.length < 8 || password.length > 1024 ||
    !['supplier', 'medical_shop'].includes(role) ||
    consentAccepted !== true
  ) {
    return res.status(400).json({ error: 'Complete the required fields, choose an account type, and accept the terms.' });
  }
  if (!hasSupabaseAuthConfig()) {
    return res.status(503).json({ error: 'Authentication is not configured.' });
  }

  const emailRedirectTo = getAuthEmailRedirectUrl();
  if (!emailRedirectTo) {
    return res.status(503).json({ error: 'Account sign-up needs a valid PUBLIC_APP_URL for email verification.' });
  }

  const [schema] = await sql`
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'users'
        and column_name = 'supabase_auth_id'
    ) as auth_id_available
  `;
  if (!schema.auth_id_available) {
    return res.status(503).json({
      error: 'Account sign-up is unavailable until database migration 0003_admin_billing_kyc.sql has been applied.'
    });
  }
  supabaseAuthIdColumnAvailable = true;

  const [reservation] = await sql`
    insert into users (
      role, email, phone, full_name, status, email_verified, phone_verified, consent_accepted_at
    )
    values (${role}, ${normalizedEmail}, ${normalizedPhone}, ${normalizedName},
            'pending', false, false, now())
    on conflict do nothing
    returning id
  `;
  if (!reservation) {
    return res.status(202).json({
      message: 'If registration can proceed, check your email for next steps. Email verification is required before portal access.'
    });
  }

  let authUser;
  let authUserCreated = false;
  try {
    authUser = await signupSupabaseUser({
      baseUrl: SUPABASE_URL,
      apiKey: SUPABASE_API_KEY,
      email: normalizedEmail,
      password,
      fullName: normalizedName,
      phone: normalizedPhone,
      redirectTo: emailRedirectTo
    });
    if (authUser) {
      authUserCreated = true;
    } else {
      authUser = await signInSupabaseUser({
        baseUrl: SUPABASE_URL,
        apiKey: SUPABASE_API_KEY,
        email: normalizedEmail,
        password
      });
    }
  } catch (error) {
    console.error('Supabase account sign-up failed:', error);
    try {
      await removeSignupReservation(reservation.id);
    } catch (cleanupError) {
      console.error('Could not remove the pending account reservation after sign-up failed:', cleanupError);
      return res.status(503).json({ error: 'Account registration could not be completed. Contact support before trying again.' });
    }
    if (error instanceof SupabaseAuthError && /email/i.test(error.providerMessage || '')) {
      return res.status(503).json({
        error: 'Supabase could not send the confirmation email. Please try again later or contact support.'
      });
    }
    return res.status(503).json({ error: 'Account registration is temporarily unavailable. Please try again later.' });
  }

  if (!authUser) {
    try {
      await removeSignupReservation(reservation.id);
    } catch (error) {
      console.error('Could not remove a duplicate sign-up reservation:', error);
      return res.status(503).json({ error: 'Account registration could not be completed. Contact support before trying again.' });
    }
    return res.status(202).json({
      message: 'If registration can proceed, check your email for next steps. Email verification is required before portal access.'
    });
  }

  const accountStatus = authUser.email_confirmed_at
    ? statusAfterEmailVerification('pending', role)
    : 'pending';
  try {
    const [linked] = await sql`
      update users
      set supabase_auth_id = coalesce(supabase_auth_id, ${authUser.id}),
          email_verified = ${Boolean(authUser.email_confirmed_at)},
          status = ${accountStatus},
          updated_at = now()
      where id = ${reservation.id}
        and (supabase_auth_id is null or supabase_auth_id = ${authUser.id})
      returning id
    `;
    if (!linked) throw new Error('Pending account could not be linked to Supabase Auth.');
  } catch (error) {
    console.error('Could not link the new Supabase identity to its account record:', error);
    if (authUserCreated && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await deleteSupabaseAuthUser({
          baseUrl: SUPABASE_URL,
          serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
          userId: authUser.id
        });
        await removeSignupReservation(reservation.id);
      } catch (cleanupError) {
        console.error('Could not roll back an unlinked Supabase sign-up:', cleanupError);
      }
    } else if (!authUserCreated) {
      try {
        await removeSignupReservation(reservation.id);
      } catch (cleanupError) {
        console.error('Could not remove the pending account reservation after linking failed:', cleanupError);
      }
    }
    return res.status(503).json({
      error: 'Account setup could not be completed. Check your email and contact support before registering again.'
    });
  }

  res.status(202).json({
    message: authUser.email_confirmed_at
      ? 'Account created and activated. You can sign in.'
      : 'Account created. Check your email to verify it; portal access is enabled after verification.'
  });
}));

app.post('/api/auth/resend-verification', signupRateLimit, requireSameOrigin, asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!hasSupabaseAuthConfig()) {
    return res.status(503).json({ error: 'Authentication is not configured.' });
  }
  const redirectTo = getAuthEmailRedirectUrl('/login.html?verified=1');
  if (!redirectTo) {
    return res.status(503).json({ error: 'Email verification needs a valid PUBLIC_APP_URL.' });
  }

  try {
    await resendSupabaseSignupEmail({
      baseUrl: SUPABASE_URL,
      apiKey: SUPABASE_API_KEY,
      email,
      redirectTo
    });
  } catch (error) {
    console.error('Supabase verification email resend failed:', error);
    return res.status(503).json({
      error: 'The verification email could not be sent. Please try again later or contact support.'
    });
  }
  res.status(202).json({
    message: 'If this address has an unverified account, a verification email has been sent.'
  });
}));

app.post('/api/auth/password-reset', signupRateLimit, requireSameOrigin, asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!hasSupabaseAuthConfig()) {
    return res.status(503).json({ error: 'Authentication is not configured.' });
  }
  const redirectTo = getAuthEmailRedirectUrl('/login.html?mode=reset-password');
  if (!redirectTo) {
    return res.status(503).json({ error: 'Password reset needs a valid PUBLIC_APP_URL.' });
  }

  try {
    await requestSupabasePasswordReset({
      baseUrl: SUPABASE_URL,
      apiKey: SUPABASE_API_KEY,
      email,
      redirectTo
    });
  } catch (error) {
    console.error('Supabase password reset email request failed:', error);
    return res.status(503).json({
      error: 'The password reset email could not be sent. Please try again later or contact support.'
    });
  }
  res.status(202).json({
    message: 'If an account exists for this address, a password reset email has been sent.'
  });
}));

app.post('/api/auth/update-password', signupRateLimit, requireSameOrigin, asyncRoute(async (req, res) => {
  const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!accessToken || accessToken.length > 4096 || password.length < 8 || password.length > 1024) {
    return res.status(400).json({ error: 'Use a valid reset link and a password of at least 8 characters.' });
  }
  if (!hasSupabaseAuthConfig()) {
    return res.status(503).json({ error: 'Authentication is not configured.' });
  }

  try {
    await updateSupabasePassword({
      baseUrl: SUPABASE_URL,
      apiKey: SUPABASE_API_KEY,
      accessToken,
      password
    });
  } catch (error) {
    console.error('Supabase password update failed:', error);
    if (error instanceof SupabaseAuthError && [400, 401, 403].includes(error.status)) {
      return res.status(400).json({ error: 'The password reset link is invalid or expired. Request a new one.' });
    }
    return res.status(503).json({ error: 'Your password could not be updated. Please try again later.' });
  }
  res.json({ message: 'Your password has been updated. You can now sign in.' });
}));

app.post('/api/auth/confirm-email', signupRateLimit, requireSameOrigin, asyncRoute(async (req, res) => {
  const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken : '';
  if (!accessToken || accessToken.length > 4096 || !hasSupabaseAuthConfig()) {
    return res.status(400).json({ error: 'The email verification link is invalid or expired.' });
  }
  const authUser = await getSupabaseUser(accessToken);
  if (!validUuid(authUser?.id) || !authUser.email || !authUser.email_confirmed_at) {
    return res.status(400).json({ error: 'The email verification link is invalid or expired.' });
  }
  const account = await sql.begin(async (tx) => {
    const [existing] = await tx`
      select id, role, status
      from users
      where lower(email) = ${authUser.email.toLowerCase()}
        and (supabase_auth_id is null or supabase_auth_id = ${authUser.id})
      for update
    `;
    if (!existing) return null;

    const status = statusAfterEmailVerification(existing.status, existing.role);
    const [updated] = await tx`
      update users
      set supabase_auth_id = coalesce(supabase_auth_id, ${authUser.id}),
          email_verified = true, status = ${status}, updated_at = now()
      where id = ${existing.id}
      returning id, status
    `;
    return updated || null;
  });
  if (!account) {
    return res.status(404).json({ error: 'Could not match this verified email to an account request. Contact support.' });
  }
  res.json({ verified: true, status: account.status });
}));

app.get('/api/auth/session', requireAccount(), (req, res) => {
  res.json({
    user: { fullName: req.account.fullName, role: req.account.role, previewOnly: req.previewOnly === true }
  });
});

app.post('/api/auth/logout', requireSameOrigin, (_req, res) => {
  clearAuthCookies(res);
  res.json({ success: true });
});

app.get('/api/health', asyncRoute(async (_req, res) => {
  let database = false;
  const missingAdminWorkflowObjects = [];
  try {
    await sql`select 1`;
    database = true;
  } catch (error) {
    console.error('Database health check failed:', error);
  }
  if (database) {
    try {
      const [schema] = await sql`
        select to_regclass('public.admin_audit_logs') is not null as audit_logs,
               to_regclass('public.billing_payments') is not null as billing_payments,
               to_regclass('public.account_deletion_jobs') is not null as deletion_jobs,
               exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'users'
                   and column_name = 'supabase_auth_id'
               ) as supabase_auth_id,
               exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'account_deletion_jobs'
                   and column_name = 'supabase_auth_id'
               ) as deletion_auth_id,
               exists (
                 select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'kyc_document_status'
               ) as kyc_status_enum,
               (
                 select count(*) = 3 from information_schema.columns
                 where table_schema = 'public' and table_name = 'kyc_documents'
                   and column_name in ('review_notes', 'reviewed_at', 'upload_expires_at')
               ) as kyc_review_columns
      `;
      if (!schema.audit_logs) missingAdminWorkflowObjects.push('admin_audit_logs');
      if (!schema.billing_payments) missingAdminWorkflowObjects.push('billing_payments');
      if (!schema.deletion_jobs) missingAdminWorkflowObjects.push('account_deletion_jobs');
      if (!schema.supabase_auth_id) missingAdminWorkflowObjects.push('users.supabase_auth_id');
      if (!schema.deletion_auth_id) missingAdminWorkflowObjects.push('account_deletion_jobs.supabase_auth_id');
      if (!schema.kyc_status_enum) missingAdminWorkflowObjects.push('kyc_document_status');
      if (!schema.kyc_review_columns) missingAdminWorkflowObjects.push('kyc_documents review columns');
    } catch (error) {
      console.error('Admin workflow schema check failed:', error);
      missingAdminWorkflowObjects.push('schema verification');
    }
  }
  const adminWorkflows = database && missingAdminWorkflowObjects.length === 0;
  res.status(database ? 200 : 503).json({
    status: database ? 'ready' : 'not_ready',
    checks: {
      database: database ? 'connected' : 'unavailable',
      adminWorkflows: adminWorkflows ? 'ready' : 'migration_required',
      missingAdminWorkflowObjects,
      billing: getCashfreeConfig() ? 'configured' : 'not_configured',
      privateStorage: getR2Config() ? 'configured' : 'not_configured',
      identityCleanup: SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'not_configured'
    }
  });
}));

// ---------- search ----------

app.get('/api/search', publicDataRateLimit, asyncRoute(async (req, res) => {
  const { query = '', brand = 'all', pack = 'all' } = req.query;
  const searchQuery = String(query).trim();
  if (searchQuery.length > 100) {
    return res.status(400).json({ error: 'Search query must be 100 characters or fewer.' });
  }
  const term = `%${searchQuery.replace(/[\\%_]/g, '\\$&')}%`;
  const hasQuery = searchQuery.length > 0;

  const rows = await sql`
    select
      sl.id,
      sl.medicine_id as "medicineId",
      sl.supplier_id as "supplierId",
      s.business_name as "supplierName",
      s.business_name as name,
      s.district as "city",
      s.state,
      0 as "distanceKm",
      coalesce(s.delivery_radius_km, 25) as "deliveryRadiusKm",
      case sl.stock_status
        when 'in_stock' then 'In Stock'
        when 'low_stock' then 'Low Stock'
        else 'Out of Stock'
      end as "stock",
      sl.wholesale_price::float as "price",
      sl.mrp::float as "mrp",
      sl.gst_percentage::float as "gst",
      coalesce(sl.schemes, 'N/A') as "scheme",
      coalesce(sl.last_updated_at, now()) as "lastUpdatedAt",
      true as "verified",
      coalesce(mm.brand_name, 'Generic') as "brand",
      mm.pack_size as "pack",
      mm.medicine_name as "medicineName",
      mm.generic_name as "composition",
      mm.strength,
      mm.dosage_form as "dosageForm",
      mm.manufacturer
    from supplier_listings sl
    join master_medicines mm on sl.medicine_id = mm.id
    join suppliers s on sl.supplier_id = s.user_id
    join users u on s.user_id = u.id
    where sl.is_active = true
      and u.status = 'approved'
      and sl.is_quarantined = false
      and sl.is_recalled = false
      and (${hasQuery} = false or (
        mm.medicine_name ilike ${term}
        or mm.generic_name ilike ${term}
        or mm.brand_name ilike ${term}
        or mm.strength ilike ${term}
        or mm.dosage_form ilike ${term}
        or mm.pack_size ilike ${term}
        or mm.manufacturer ilike ${term}
        or s.business_name ilike ${term}
        or s.district ilike ${term}
      ))
      and (${brand} = 'all' or (${brand} = 'generic' and mm.medicine_type = 'generic') or (${brand} = 'branded' and mm.medicine_type in ('branded_generic', 'innovator_brand')))
      and (${pack} = 'all' or mm.pack_size = ${pack})
    limit 200
  `;

  const results = rows.map((r) => {
    const discount = schemeDiscount(r.scheme);
    const netPrice = Math.max(0, r.price * (1 - discount.percent / 100) - discount.flat);
    return {
      ...r,
      netPrice: Math.round(netPrice * 100) / 100,
      lastUpdated: r.lastUpdatedAt ? new Date(r.lastUpdatedAt).toISOString() : new Date().toISOString(),
      coordinates: { lat: 0, lng: 0 }
    };
  });
  results.sort((a, b) => a.netPrice - b.netPrice || a.price - b.price || a.supplierName.localeCompare(b.supplierName));
  res.json(results.slice(0, 50));
}));

// Extracts an indicative discount from free-text scheme notes, e.g.
// "10% off", "Flat ₹50 off on 10+ strips". Returns zeros when unclear.
function schemeDiscount(schemes) {
  if (!schemes || schemes === 'N/A') return { percent: 0, flat: 0 };
  const text = String(schemes);
  const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const flatMatch = text.match(/flat\s*(?:rs\.?|₹)?\s*(\d+(?:\.\d+)?)/i)
    || text.match(/₹\s*(\d+(?:\.\d+)?)\s*off/i)
    || text.match(/rs\.?\s*(\d+(?:\.\d+)?)\s*off/i);
  const flat = flatMatch ? Number(flatMatch[1]) : 0;
  // "10+1" / "10 + 1" means buy 10, get 1 free → effective discount of 1/11.
  const bonusMatch = text.match(/(\d+)\s*\+\s*(\d+)/);
  const bonusPercent = bonusMatch
    ? (Number(bonusMatch[2]) / (Number(bonusMatch[1]) + Number(bonusMatch[2]))) * 100
    : 0;
  const percent = Math.max(percentMatch ? Math.min(Number(percentMatch[1]), 100) : 0, bonusPercent);
  return { percent, flat };
}

app.post('/api/enquiries', requireAccount('medical_shop'), requireSameOrigin, asyncRoute(async (req, res) => {
  const { listingId, quantity, message } = req.body || {};
  if (typeof listingId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(listingId)) {
    return res.status(400).json({ error: 'Select a valid supplier offer.' });
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
    return res.status(400).json({ error: 'Quantity must be a positive whole number.' });
  }
  if (message !== undefined && message !== null && (typeof message !== 'string' || message.length > 1000)) {
    return res.status(400).json({ error: 'Message must be 1,000 characters or fewer.' });
  }

  const [enquiry] = await sql`
    insert into enquiries (supplier_id, medical_shop_id, medicine_id, quantity, message)
    select sl.supplier_id, ${req.account.id}, sl.medicine_id, ${quantity}, ${typeof message === 'string' && message.trim() ? message.trim() : null}
    from supplier_listings sl
    join users supplier on supplier.id = sl.supplier_id
    where sl.id = ${listingId}
      and sl.is_active = true
      and sl.is_quarantined = false
      and sl.is_recalled = false
      and supplier.role = 'supplier'
      and supplier.status = 'approved'
    returning id, status, created_at as "createdAt"
  `;
  if (!enquiry) return res.status(404).json({ error: 'This supplier offer is no longer available.' });
  res.status(201).json(enquiry);
}));

app.get('/api/enquiries/mine', requireAccount('medical_shop'), asyncRoute(async (req, res) => {
  const rows = await sql`
    select
      e.id,
      s.business_name as "supplierName",
      mm.medicine_name as "medicineName",
      mm.generic_name as "composition",
      mm.strength,
      mm.pack_size as "packSize",
      e.quantity,
      e.status,
      e.message,
      e.supplier_response as "supplierResponse",
      e.created_at as "createdAt",
      e.updated_at as "updatedAt"
    from enquiries e
    join suppliers s on e.supplier_id = s.user_id
    join master_medicines mm on e.medicine_id = mm.id
    where e.medical_shop_id = ${req.account.id}
    order by e.created_at desc
    limit 200
  `;
  res.json(rows);
}));

// ---------- map ----------

const cityCoordinates = {
  'Madurai': { lat: 9.939, lng: 78.1445 },
  'Tirunelveli': { lat: 8.7139, lng: 77.7567 },
  'Coimbatore': { lat: 11.0168, lng: 76.9558 },
  'Chennai': { lat: 13.0827, lng: 80.2707 },
  'Salem': { lat: 11.6643, lng: 78.1460 },
  'Erode': { lat: 11.3410, lng: 77.7173 },
  'Tiruchirappalli': { lat: 10.7905, lng: 78.7047 },
  'Vellore': { lat: 12.9165, lng: 79.1325 },
  'Thanjavur': { lat: 10.7870, lng: 79.1378 },
  'Dindigul': { lat: 10.3630, lng: 77.9580 }
};

app.get('/api/map/suppliers', publicDataRateLimit, asyncRoute(async (_req, res) => {
  const rows = await sql`
    select s.id, s.business_name as name, s.district as city, s.state,
           coalesce(s.delivery_radius_km, 25) as "deliveryRadiusKm"
    from suppliers s
    join users u on s.user_id = u.id
    where u.status = 'approved' and u.role = 'supplier'
    limit 50
  `;

  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    state: r.state,
    distanceKm: 0,
    deliveryRadiusKm: r.deliveryRadiusKm,
    stock: 'In Stock',
    price: 0,
    gst: 12,
    scheme: 'N/A',
    lastUpdated: new Date().toISOString(),
    verified: true,
    brand: 'Various',
    pack: 'Various',
    coordinates: cityCoordinates[r.city] || { lat: 10.0, lng: 78.0 }
  })));
}));

// ---------- protected account APIs ----------

app.use('/api/supplier', requireAccount('supplier'));
app.use('/api/admin', requireAccount('admin'));

// ---------- supplier catalogue ----------

const DEFAULT_SKU_LIMIT = 100;
const MAX_IMPORT_ROWS = 500;

async function getSkuAllowance(db, userId) {
  const [subscription] = await db`
    select p.tier, p.sku_limit as "skuLimit"
    from user_subscriptions s
    join subscription_plans p on p.id = s.plan_id
    where s.user_id = ${userId}
      and s.status in ('active', 'trial', 'grace')
      and (s.end_date is null or s.end_date > now())
    order by s.created_at desc
    limit 1
  `;
  return {
    tier: subscription?.tier || 'Basic',
    skuLimit: subscription?.skuLimit ?? DEFAULT_SKU_LIMIT
  };
}

async function countActiveSkus(db, supplierId, extraMedicineIds = []) {
  const rows = await db`
    select distinct medicine_id from supplier_listings
    where supplier_id = ${supplierId} and is_active = true
  `;
  const ids = new Set(rows.map((r) => r.medicine_id));
  for (const id of extraMedicineIds) ids.add(id);
  return ids;
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLength ? null : trimmed;
}

function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const CATALOGUE_STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'];
const CATALOGUE_MEDICINE_TYPES = ['generic', 'branded_generic', 'innovator_brand'];
const CATALOGUE_DISPENSING_TYPES = ['otc', 'prescription'];

// Normalizes one catalogue row (single add or bulk import). Returns
// { item } on success or { errors } listing every validation problem.
function validateCatalogueItem(input) {
  const errors = [];
  const item = {};
  const text = (key, field, max, required = false) => {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors.push(`${field} is required.`);
      return '';
    }
    const value = cleanText(raw, max);
    if (value === null) errors.push(`${field} must be ${max} characters or fewer.`);
    else if (required && !value) errors.push(`${field} is required.`);
    item[key] = value ?? '';
  };

  text('medicineName', 'Product name', 200, true);
  text('brandName', 'Brand name', 200);
  text('manufacturer', 'Manufacturer', 200, true);
  text('composition', 'Composition/Salt', 300, true);
  text('strength', 'Strength', 100, true);
  text('dosageForm', 'Dosage form', 40, true);
  text('dosageSubForm', 'Dosage sub-form', 40);
  text('packSize', 'Pack size', 100, true);
  text('unitOfMeasure', 'Unit of measure', 40);
  text('schemes', 'Scheme/Discount', 500);
  text('estimatedDelivery', 'Estimated delivery', 100);
  text('drugSchedule', 'Drug schedule', 20);
  text('routeOfAdministration', 'Route of administration', 100);
  text('storageConditions', 'Storage conditions', 30);
  text('therapeuticCategory', 'Therapeutic category', 100);
  text('subcategory', 'Subcategory', 100);
  text('batchNumber', 'Batch number', 100, true);

  for (const [key, field, required] of [
    ['mrp', 'MRP', true],
    ['sellingPrice', 'Selling price', true],
    ['gstPercentage', 'GST %', true],
    ['availableQuantity', 'Available quantity', false],
    ['minimumOrderQuantity', 'Minimum order quantity', false],
    ['deliveryCharges', 'Delivery charges', false]
  ]) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors.push(`${field} is required.`);
      item[key] = key === 'gstPercentage' ? 0 : 0;
      continue;
    }
    const n = parseAmount(raw);
    const isIntField = ['availableQuantity', 'minimumOrderQuantity'].includes(key);
    const maxOk = key === 'gstPercentage' ? n <= 100 : true;
    const minOk = key === 'gstPercentage' || key === 'deliveryCharges' ? n >= 0 : n > 0;
    if (n === null || !Number.isFinite(n) || (isIntField && !Number.isInteger(n)) || !minOk || !maxOk) {
      errors.push(`${field} is invalid.`);
      item[key] = 0;
    } else {
      item[key] = n;
    }
  }

  const expiry = cleanText(input?.batchExpiryDate, 20);
  if (!expiry) {
    errors.push('Expiry date is required.');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(expiry)) || new Date(expiry).toISOString().slice(0, 10) !== expiry) {
    errors.push('Expiry date must be a valid YYYY-MM-DD date.');
  } else if (expiry < new Date().toISOString().slice(0, 10)) {
    errors.push('Expiry date cannot be in the past.');
  }
  item.batchExpiryDate = expiry || '';

  const stock = cleanText(input?.stockStatus, 20) || 'in_stock';
  if (!CATALOGUE_STOCK_STATUSES.includes(stock)) errors.push('Stock availability is invalid.');
  item.stockStatus = stock;

  const mtype = cleanText(input?.medicineType, 30) || (item.brandName ? 'branded_generic' : 'generic');
  if (!CATALOGUE_MEDICINE_TYPES.includes(mtype)) errors.push('Medicine type is invalid.');
  item.medicineType = mtype;

  const dispensing = cleanText(input?.dispensingType, 20) || 'prescription';
  if (!CATALOGUE_DISPENSING_TYPES.includes(dispensing)) errors.push('Dispensing type is invalid.');
  item.dispensingType = dispensing;

  item.isActive = input?.isActive === undefined ? true : input.isActive === true || input.isActive === 'true' || input.isActive === 'active' || input.isActive === 'Active';

  item.dosageSubForm = item.dosageSubForm || 'Standard';
  item.unitOfMeasure = item.unitOfMeasure || 'units';
  item.drugSchedule = item.drugSchedule || 'H';
  item.routeOfAdministration = item.routeOfAdministration || 'Oral';
  item.storageConditions = item.storageConditions || 'Store below 30°C';

  if (item.sellingPrice > 0 && item.mrp > 0 && item.sellingPrice > item.mrp) {
    errors.push('Selling price cannot exceed MRP.');
  }

  return errors.length ? { errors } : { item };
}

async function resolveMedicineId(tx, item) {
  const [existing] = await tx`
    select id from master_medicines
    where lower(generic_name) = lower(${item.composition})
      and lower(strength) = lower(${item.strength})
      and lower(dosage_form) = lower(${item.dosageForm})
      and lower(pack_size) = lower(${item.packSize})
    limit 1
  `;
  if (existing) return existing.id;
  const [created] = await tx`
    insert into master_medicines (
      medicine_name, generic_name, brand_name, active_ingredients, manufacturer,
      strength, dosage_form, dosage_sub_form, pack_size, unit_of_measure,
      therapeutic_category, subcategory, drug_schedule, dispensing_type,
      medicine_type, route_of_administration, storage_conditions
    ) values (
      ${item.medicineName}, ${item.composition}, ${item.brandName || null},
      ${tx.json([{ name: item.composition, strength: item.strength }])}, ${item.manufacturer},
      ${item.strength}, ${item.dosageForm}, ${item.dosageSubForm}, ${item.packSize}, ${item.unitOfMeasure},
      ${item.therapeuticCategory || null}, ${item.subcategory || null}, ${item.drugSchedule}, ${item.dispensingType},
      ${item.medicineType}, ${item.routeOfAdministration}, ${item.storageConditions}
    )
    returning id
  `;
  return created.id;
}

async function insertListing(tx, supplierId, item, medicineId) {
  const [listing] = await tx`
    insert into supplier_listings (
      supplier_id, medicine_id, mrp, wholesale_price, gst_percentage, schemes,
      batch_number, batch_expiry_date, stock_status, available_quantity,
      minimum_order_quantity, delivery_charges, estimated_delivery, is_active,
      last_updated_at
    ) values (
      ${supplierId}, ${medicineId}, ${item.mrp}, ${item.sellingPrice}, ${item.gstPercentage},
      ${item.schemes || null}, ${item.batchNumber}, ${item.batchExpiryDate}, ${item.stockStatus},
      ${Math.trunc(item.availableQuantity)}, ${Math.max(1, Math.trunc(item.minimumOrderQuantity))},
      ${item.deliveryCharges}, ${item.estimatedDelivery || null}, ${item.isActive}, now()
    )
    returning id, medicine_id as "medicineId", is_active as "isActive"
  `;
  return listing;
}

app.get('/api/supplier/catalogue', asyncRoute(async (req, res) => {
  const rows = await sql`
    select
      sl.id,
      sl.medicine_id as "medicineId",
      mm.medicine_name as "medicineName",
      mm.generic_name as "genericName",
      mm.brand_name as "brandName",
      mm.manufacturer,
      mm.strength,
      mm.dosage_form as "dosageForm",
      mm.pack_size as "packSize",
      sl.mrp,
      sl.wholesale_price as "wholesalePrice",
      sl.gst_percentage as "gstPercentage",
      sl.schemes,
      sl.batch_number as "batchNumber",
      sl.batch_expiry_date as "batchExpiryDate",
      sl.stock_status as "stockStatus",
      sl.available_quantity as "availableQuantity",
      sl.minimum_order_quantity as "minimumOrderQuantity",
      sl.delivery_charges as "deliveryCharges",
      sl.estimated_delivery as "estimatedDelivery",
      sl.is_active as "isActive",
      sl.last_updated_at as "lastUpdatedAt"
    from supplier_listings sl
    join master_medicines mm on sl.medicine_id = mm.id
    where sl.supplier_id = ${req.account.id}
    order by sl.last_updated_at desc
  `;
  res.json(rows);
}));

app.get('/api/supplier/catalogue/usage', asyncRoute(async (req, res) => {
  const activeSkus = await countActiveSkus(sql, req.account.id);
  const allowance = await getSkuAllowance(sql, req.account.id);
  res.json({ activeSkus: activeSkus.size, skuLimit: allowance.skuLimit, tier: allowance.tier });
}));

app.post('/api/supplier/catalogue', requireSameOrigin, asyncRoute(async (req, res) => {
  const { item, errors } = validateCatalogueItem(req.body || {});
  if (errors) return res.status(400).json({ error: errors.join(' '), fields: errors });

  const outcome = await sql.begin(async (tx) => {
    await tx`select id from users where id = ${req.account.id} for update`;
    const medicineId = await resolveMedicineId(tx, item);
    const [duplicate] = await tx`
      select id from supplier_listings
      where supplier_id = ${req.account.id} and medicine_id = ${medicineId}
        and batch_number = ${item.batchNumber}
      limit 1
    `;
    if (duplicate) return { conflict: true };

    if (item.isActive) {
      const activeSkus = await countActiveSkus(tx, req.account.id);
      if (!activeSkus.has(medicineId)) {
        const allowance = await getSkuAllowance(tx, req.account.id);
        if (activeSkus.size >= allowance.skuLimit) {
          return { limit: allowance };
        }
      }
    }
    const listing = await insertListing(tx, req.account.id, item, medicineId);
    return { listing };
  });

  if (outcome.conflict) {
    return res.status(409).json({ error: 'This medicine and batch is already in your catalogue.' });
  }
  if (outcome.limit) {
    return res.status(403).json({
      error: `Your ${outcome.limit.tier} plan allows ${outcome.limit.skuLimit} active SKUs. Upgrade your plan or deactivate an existing item first.`
    });
  }
  res.status(201).json(outcome.listing);
}));

app.post('/api/supplier/catalogue/import', requireSameOrigin, asyncRoute(async (req, res) => {
  const rows = req.body?.items;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'Send an items array with at least one catalogue row.' });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ error: `Imports are limited to ${MAX_IMPORT_ROWS} rows per request.` });
  }

  const validated = rows.map((input, index) => {
    const { item, errors } = validateCatalogueItem(input || {});
    return { index, item, errors };
  });
  const valid = validated.filter((v) => !v.errors);
  const failed = validated
    .filter((v) => v.errors)
    .map((v) => ({ row: v.index + 1, errors: v.errors }));

  const outcome = await sql.begin(async (tx) => {
    await tx`select id from users where id = ${req.account.id} for update`;
    const existingPairs = await tx`
      select sl.medicine_id, sl.batch_number
      from supplier_listings sl
      where sl.supplier_id = ${req.account.id}
    `;
    const existingSet = new Set(existingPairs.map((p) => `${p.medicine_id}:${p.batch_number}`));
    const activeSkus = await countActiveSkus(tx, req.account.id);
    const allowance = await getSkuAllowance(tx, req.account.id);
    const batchAdded = new Set();
    const created = [];
    const rowFailures = [...failed];

    for (const v of valid) {
      try {
        const medicineId = await resolveMedicineId(tx, v.item);
        if (existingSet.has(`${medicineId}:${v.item.batchNumber}`)) {
          rowFailures.push({ row: v.index + 1, errors: ['This medicine and batch is already in your catalogue.'] });
          continue;
        }
        const isNewSku = v.item.isActive && !activeSkus.has(medicineId) && !batchAdded.has(medicineId);
        if (isNewSku && activeSkus.size + batchAdded.size >= allowance.skuLimit) {
          rowFailures.push({
            row: v.index + 1,
            errors: [`SKU limit reached (${allowance.skuLimit} on the ${allowance.tier} plan).`]
          });
          continue;
        }
        const listing = await insertListing(tx, req.account.id, v.item, medicineId);
        existingSet.add(`${medicineId}:${v.item.batchNumber}`);
        if (v.item.isActive) {
          activeSkus.add(medicineId);
          batchAdded.add(medicineId);
        }
        created.push({ row: v.index + 1, id: listing.id });
      } catch (error) {
        console.error(`Catalogue import row ${v.index + 1} failed:`, error);
        rowFailures.push({ row: v.index + 1, errors: ['Could not save this row.'] });
      }
    }
    return { created, rowFailures, allowance };
  });

  res.status(outcome.created.length ? 201 : 200).json({
    created: outcome.created.length,
    failed: outcome.rowFailures.length,
    results: outcome.created,
    errors: outcome.rowFailures.slice(0, 100),
    skuLimit: outcome.allowance.skuLimit,
    tier: outcome.allowance.tier
  });
}));

app.delete('/api/supplier/catalogue/:id', requireSameOrigin, asyncRoute(async (req, res) => {
  const [deleted] = await sql`
    delete from supplier_listings
    where id = ${req.params.id} and supplier_id = ${req.account.id}
    returning id
  `;
  if (!deleted) return res.status(404).json({ error: 'Catalogue item not found.' });
  res.json({ success: true });
}));

// ---------- enquiries ----------

app.get('/api/supplier/enquiries', asyncRoute(async (req, res) => {
  const rows = await sql`
    select
      e.id,
      e.medical_shop_id as "medicalShopId",
      u.full_name as "medicalShopName",
      e.medicine_id as "medicineId",
      mm.medicine_name as "medicineName",
      e.quantity,
      e.status,
      e.message,
      e.supplier_response as "supplierResponse",
      e.created_at as "createdAt",
      e.updated_at as "updatedAt"
    from enquiries e
    join master_medicines mm on e.medicine_id = mm.id
    join users u on e.medical_shop_id = u.id
    where e.supplier_id = ${req.account.id}
    order by e.created_at desc
  `;
  res.json(rows);
}));

app.post('/api/enquiries/:id/respond', requireAccount('supplier'), requireSameOrigin, asyncRoute(async (req, res) => {
  const { status = 'quoted', response } = req.body || {};
  if (!['quoted', 'follow_up', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid enquiry status.' });
  }
  if (response !== undefined && (typeof response !== 'string' || response.length > 2000)) {
    return res.status(400).json({ error: 'Response must be 2,000 characters or fewer.' });
  }
  const [row] = await sql`
    update enquiries
    set status = ${status},
        supplier_response = coalesce(${response ?? null}, supplier_response),
        updated_at = now()
    where id = ${req.params.id} and supplier_id = ${req.account.id}
    returning id
  `;
  if (!row) return res.status(404).json({ error: 'Enquiry not found' });
  res.json({ success: true });
}));

// ---------- admin: approvals ----------

app.get('/api/admin/accounts', asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'all');
  const statuses = ['all', 'pending', 'approved', 'rejected', 'suspended'];
  if (!statuses.includes(status)) return res.status(400).json({ error: 'Invalid account status filter.' });
  const rows = status === 'all'
    ? await sql`
      select id, full_name as "fullName", email, role, status,
             email_verified as "emailVerified", created_at as "createdAt"
      from users where role <> 'admin'
      order by created_at desc limit 200
    `
    : await sql`
      select id, full_name as "fullName", email, role, status,
             email_verified as "emailVerified", created_at as "createdAt"
      from users where role <> 'admin' and status = ${status}
      order by created_at desc limit 200
    `;
  res.json(rows);
}));

app.get('/api/admin/accounts/pending', asyncRoute(async (_req, res) => {
  const rows = await sql`
    select id, full_name as "fullName", email, role, email_verified as "emailVerified", created_at as "createdAt"
    from users
    where status = 'pending'
    order by created_at desc
  `;
  res.json(rows);
}));

app.post('/api/admin/accounts/:id/approve', requireSameOrigin, asyncRoute(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid account ID.' });
  if (!reason || reason.length > 500) {
    return res.status(400).json({ error: 'Provide an approval reason of 1–500 characters.' });
  }
  const approved = await sql.begin(async (tx) => {
    const [row] = await tx`
      update users
      set status = 'approved', updated_at = now(), session_version = session_version + 1
      where id = ${req.params.id} and status = 'pending' and email_verified = true and role <> 'admin'
      returning id
    `;
    if (!row) return false;
    await writeAdminAudit(tx, req, 'account.approved', 'user', row.id, {
      from: 'pending', to: 'approved', reason
    });
    return true;
  });
  res.json({ approved });
}));

app.post('/api/admin/accounts/:id/status', requireSameOrigin, asyncRoute(async (req, res) => {
  const { status, reason } = req.body || {};
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid account ID.' });
  if (!['approved', 'rejected', 'suspended'].includes(status) || !normalizedReason || normalizedReason.length > 500) {
    return res.status(400).json({ error: 'Choose a valid status and provide a reason of 1–500 characters.' });
  }
  if (req.params.id === req.account.id) {
    return res.status(400).json({ error: 'You cannot change your own account status.' });
  }

  const result = await sql.begin(async (tx) => {
    const [account] = await tx`
      select id, role, status from users where id = ${req.params.id} for update
    `;
    if (!account || account.role === 'admin') return { error: 'Account not found or cannot be managed.' };
    const [deletionJob] = await tx`
      select id from account_deletion_jobs
      where account_id = ${account.id} and status in ('pending', 'failed')
      limit 1 for update
    `;
    if (deletionJob) return { error: 'Account deletion is already in progress; it cannot be reinstated or changed.' };

    const allowed = account.status === 'pending' && status === 'rejected' ||
      account.status === 'approved' && status === 'suspended' ||
      account.status === 'suspended' && status === 'approved';
    if (!allowed) return { error: `Cannot change an account from ${account.status} to ${status}.` };

    await tx`
      update users
      set status = ${status}, updated_at = now(), session_version = session_version + 1
      where id = ${account.id}
    `;
    await writeAdminAudit(tx, req, `account.${status}`, 'user', account.id, {
      from: account.status, to: status, reason: normalizedReason
    });
    return { status };
  });

  if (result.error) return res.status(409).json({ error: result.error });
  res.json(result);
}));

app.post('/api/admin/accounts/:id/delete', requireSameOrigin, asyncRoute(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid account ID.' });
  if (!reason || reason.length > 500) {
    return res.status(400).json({ error: 'Provide a deletion reason of 1–500 characters.' });
  }
  if (req.params.id === req.account.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({
      error: 'Configure the server-only SUPABASE_SERVICE_ROLE_KEY before deleting accounts.'
    });
  }

  const [target] = await sql`
    select id, role, email, supabase_auth_id as "supabaseAuthId"
    from users where id = ${req.params.id}
  `;
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (target.role === 'admin') {
    return res.status(409).json({ error: 'Admin accounts cannot be deleted through this workflow.' });
  }

  let supabaseAuthId = target.supabaseAuthId;
  if (!supabaseAuthId) {
    try {
      supabaseAuthId = await findSupabaseAuthUserIdByEmail({
        baseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
        email: target.email
      });
    } catch (error) {
      console.error(`Supabase Auth lookup failed for account ${target.id}:`, error);
      return res.status(503).json({ error: 'Could not verify this account’s Supabase Auth identity. No deletion was started.' });
    }
    if (!supabaseAuthId) {
      return res.status(409).json({ error: 'No matching Supabase Auth account was found. No deletion was started.' });
    }
    if (!validUuid(supabaseAuthId)) {
      return res.status(503).json({ error: 'The Supabase Auth account ID is invalid. No deletion was started.' });
    }
  }

  const jobId = await sql.begin(async (tx) => {
    const [account] = await tx`
      select id, role, status, email, supabase_auth_id as "supabaseAuthId"
      from users where id = ${req.params.id} for update
    `;
    if (!account) return { error: 'Account not found.' };
    if (account.role === 'admin') return { error: 'Admin accounts cannot be deleted through this workflow.' };
    if (
      account.email.toLowerCase() !== target.email.toLowerCase() ||
      (account.supabaseAuthId && account.supabaseAuthId !== supabaseAuthId)
    ) return { error: 'The account identity changed during deletion setup. Retry the request.' };
    if (!account.supabaseAuthId) {
      await tx`
        update users set supabase_auth_id = ${supabaseAuthId} where id = ${account.id}
      `;
    }

    const [existingJob] = await tx`
      select id, supabase_auth_id as "supabaseAuthId" from account_deletion_jobs
      where account_id = ${account.id} and status in ('pending', 'failed')
      limit 1 for update
    `;
    let activeJobId;
    if (existingJob) {
      if (existingJob.supabaseAuthId !== supabaseAuthId) {
        return { error: 'The deletion job is linked to a different Auth identity. Contact support.' };
      }
      activeJobId = existingJob.id;
      await tx`
        update account_deletion_jobs
        set status = 'pending', last_error = null, updated_at = now()
        where id = ${activeJobId}
      `;
      await writeAdminAudit(tx, req, 'account.deletion_retry_requested', 'user', account.id, {
        reason
      });
    } else {
      const documents = await tx`
        select storage_key as key from kyc_documents where account_id = ${account.id}
      `;
      const [job] = await tx`
        insert into account_deletion_jobs (
          account_id, supabase_auth_id, requested_by, reason, storage_keys
        )
        values (
          ${account.id}, ${supabaseAuthId}, ${req.account.id}, ${reason},
          ${tx.json(documents.map((document) => document.key))}
        )
        returning id
      `;
      activeJobId = job.id;
      await writeAdminAudit(tx, req, 'account.deletion_requested', 'user', account.id, {
        role: account.role,
        reason
      });
    }

    await tx`
      update users
      set status = 'suspended', session_version = session_version + 1, updated_at = now()
      where id = ${account.id}
    `;
    return activeJobId;
  });
  if (jobId?.error) return res.status(409).json({ error: jobId.error });

  try {
    await processAccountDeletion(jobId);
  } catch (error) {
    const publicMessage = error instanceof AccountDeletionFailure
      ? error.publicMessage
      : 'Account cleanup failed. The account remains suspended; retry after checking database and storage health.';
    console.error(`Account deletion job ${jobId} failed:`, error);
    await sql`
      update account_deletion_jobs
      set status = 'failed', last_error = ${publicMessage}, updated_at = now()
      where id = ${jobId} and status = 'pending'
    `;
    return res.status(503).json({ deleted: false, status: 'failed', error: publicMessage });
  }

  res.json({ deleted: true });
}));

app.get('/api/admin/audit-logs', asyncRoute(async (_req, res) => {
  const rows = await sql`
    select l.id, l.action_type as "actionType", l.entity_type as "entityType",
           l.entity_id as "entityId", l.details, l.created_at as "createdAt",
           u.full_name as "actorName"
    from admin_audit_logs l
    left join users u on u.id = l.actor_id
    order by l.created_at desc
    limit 100
  `;
  res.json(rows);
}));

// ---------- admin: revenue ----------

app.get('/api/admin/revenue', asyncRoute(async (_req, res) => {
  const [suppliers] = await sql`
    select count(*)::int as count from suppliers s join users u on s.user_id = u.id where u.status = 'approved'
  `;
  const [shops] = await sql`
    select count(*)::int as count from medical_shops m join users u on m.user_id = u.id where u.status = 'approved'
  `;
  const [listings] = await sql`select count(*)::int as count from supplier_listings where is_active = true`;
  const [enquiries] = await sql`select count(*)::int as count from enquiries`;
  const [subscriptions] = await sql`
    select count(*)::int as count from user_subscriptions
    where status in ('active', 'trial', 'grace') and (end_date is null or end_date > now())
  `;
  const [renewals] = await sql`
    select count(*)::int as count from user_subscriptions
    where status in ('active', 'trial', 'grace')
      and end_date >= now() and end_date < now() + interval '7 days'
  `;
  const [billingSchema] = await sql`
    select to_regclass('public.billing_payments') is not null as available
  `;
  const billingSchemaAvailable = Boolean(billingSchema.available);
  const monthlyRevenueRows = billingSchemaAvailable ? await sql`
    select to_char(months.month_start, 'Mon') as month,
           coalesce(sum(p.amount), 0)::numeric(12, 2) as value
    from (
      select date_trunc('month', now()) - (n * interval '1 month') as month_start
      from generate_series(5, 0, -1) as series(n)
    ) as months
    left join billing_payments p
      on date_trunc('month', p.paid_at) = months.month_start
      and p.status = 'paid' and p.currency = 'INR'
    group by months.month_start
    order by months.month_start
  ` : [];
  const monthlyRevenue = monthlyRevenueRows.map((row) => ({
    month: row.month,
    value: Number(row.value)
  }));
  const currentMonthRevenue = billingSchemaAvailable
    ? monthlyRevenue[monthlyRevenue.length - 1]?.value || 0
    : null;

  res.json({
    activeSuppliers: suppliers.count,
    activeMedicalShops: shops.count,
    totalListings: listings.count,
    totalEnquiries: enquiries.count,
    activeSubscriptions: subscriptions.count,
    monthlyRevenue,
    currentMonthRevenue,
    billingSchemaAvailable,
    pendingRenewals: renewals.count
  });
}));

// ---------- admin: subscription plans ----------

app.get('/api/admin/subscriptions', asyncRoute(async (_req, res) => {
  const rows = await sql`
    select id, tier, sku_limit as "skuLimit", monthly_fee as "monthlyFee",
           features, is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"
    from subscription_plans
    order by monthly_fee
  `;
  res.json(rows);
}));

app.post('/api/admin/subscriptions', requireSameOrigin, asyncRoute(async (req, res) => {
  const plan = parsePlan(req.body);
  if (!plan) return res.status(400).json({ error: 'Enter a plan name, valid SKU limit, monthly fee, and feature list.' });
  const created = await sql.begin(async (tx) => {
    const [duplicate] = await tx`
      select id from subscription_plans where lower(tier) = lower(${plan.tier}) limit 1
    `;
    if (duplicate) return null;
    const [row] = await tx`
      insert into subscription_plans (tier, sku_limit, monthly_fee, features, is_active)
      values (${plan.tier}, ${plan.skuLimit}, ${plan.monthlyFee}, ${tx.json(plan.features)}, ${plan.isActive})
      returning id, tier, sku_limit as "skuLimit", monthly_fee as "monthlyFee",
                features, is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"
    `;
    await writeAdminAudit(tx, req, 'subscription_plan.created', 'subscription_plan', row.id, {
      tier: row.tier, monthlyFee: row.monthlyFee
    });
    return row;
  });
  if (!created) return res.status(409).json({ error: 'A plan with that name already exists.' });
  res.status(201).json(created);
}));

app.put('/api/admin/subscriptions/:id', requireSameOrigin, asyncRoute(async (req, res) => {
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid plan ID.' });
  const plan = parsePlan(req.body);
  if (!plan) return res.status(400).json({ error: 'Enter a plan name, valid SKU limit, monthly fee, and feature list.' });
  const [duplicate] = await sql`
    select id from subscription_plans
    where lower(tier) = lower(${plan.tier}) and id <> ${req.params.id}
    limit 1
  `;
  if (duplicate) return res.status(409).json({ error: 'A plan with that name already exists.' });
  const result = await sql.begin(async (tx) => {
    const [updated] = await tx`
      update subscription_plans
      set tier = ${plan.tier}, sku_limit = ${plan.skuLimit}, monthly_fee = ${plan.monthlyFee},
          features = ${tx.json(plan.features)}, is_active = ${plan.isActive}, updated_at = now()
      where id = ${req.params.id}
      returning id, tier, sku_limit as "skuLimit", monthly_fee as "monthlyFee",
                features, is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"
    `;
    if (!updated) return null;
    await writeAdminAudit(tx, req, 'subscription_plan.updated', 'subscription_plan', updated.id, {
      tier: updated.tier, monthlyFee: updated.monthlyFee, isActive: updated.isActive
    });
    return updated;
  });
  if (!result) return res.status(404).json({ error: 'Subscription plan not found.' });
  res.json(result);
}));

app.get('/api/billing/plans', requireAccount('supplier', 'medical_shop'), asyncRoute(async (_req, res) => {
  const rows = await sql`
    select id, tier, sku_limit as "skuLimit", monthly_fee as "monthlyFee", features
    from subscription_plans where is_active = true
    order by monthly_fee
  `;
  res.json(rows);
}));

app.get('/api/billing/subscription', requireAccount('supplier', 'medical_shop'), asyncRoute(async (req, res) => {
  const [subscription] = await sql`
    select p.tier, p.sku_limit as "skuLimit", s.status,
           s.start_date as "startDate", s.end_date as "endDate"
    from user_subscriptions s join subscription_plans p on p.id = s.plan_id
    where s.user_id = ${req.account.id}
      and s.status in ('active', 'trial', 'grace')
      and (s.end_date is null or s.end_date > now())
    order by s.created_at desc
    limit 1
  `;
  res.json(subscription || null);
}));

app.post('/api/billing/orders', requireAccount('supplier', 'medical_shop'), requireSameOrigin, asyncRoute(async (req, res) => {
  const planId = req.body?.planId;
  const phone = typeof req.body?.customerPhone === 'string'
    ? req.body.customerPhone.replace(/\D/g, '')
    : '';
  if (!validUuid(planId)) return res.status(400).json({ error: 'Choose a valid subscription plan.' });

  const [plan] = await sql`
    select id, tier, monthly_fee as "monthlyFee" from subscription_plans
    where id = ${planId} and is_active = true limit 1
  `;
  if (!plan) return res.status(404).json({ error: 'Subscription plan is not available.' });
  const amount = Number(plan.monthlyFee);
  if (amount > 0 && !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid contact phone number for checkout.' });
  }
  const cashfree = amount > 0 ? getCashfreeConfig() : null;
  if (amount > 0 && !cashfree) return res.status(503).json({ error: 'Cashfree billing is not configured.' });

  const orderId = `cp_${randomUUID().replace(/-/g, '')}`;
  const inserted = await sql.begin(async (tx) => {
    const [account] = await tx`
      select id from users where id = ${req.account.id} and status = 'approved' for update
    `;
    if (!account) return { error: 'Your account is not approved for billing.' };
    await tx`
      update billing_payments set status = 'failed'
      where account_id = ${req.account.id} and status = 'pending'
        and created_at <= now() - interval '15 minutes'
    `;
    const [active] = await tx`
      select id from user_subscriptions
      where user_id = ${req.account.id} and status in ('active', 'trial', 'grace')
        and (end_date is null or end_date > now())
      limit 1
    `;
    if (active) return { error: 'An active subscription already exists for this account.' };
    const [pending] = await tx`
      select id from billing_payments
      where account_id = ${req.account.id} and status = 'pending'
        and created_at > now() - interval '30 minutes'
      limit 1
    `;
    if (pending) return { error: 'A checkout is already in progress. Complete it or try again later.' };
    if (amount === 0) {
      const [subscription] = await tx`
        insert into user_subscriptions (user_id, plan_id, status, start_date, end_date)
        values (${req.account.id}, ${plan.id}, 'active', now(), now() + interval '30 days')
        returning id
      `;
      await tx`
        insert into admin_audit_logs (actor_id, action_type, entity_type, entity_id, details)
        values (
          null, 'billing.free_subscription_activated', 'user_subscription', ${subscription.id},
          ${tx.json({ accountId: req.account.id, planId: plan.id })}
        )
      `;
      return { free: true };
    }
    const [payment] = await tx`
      insert into billing_payments (account_id, plan_id, cashfree_order_id, amount, currency)
      values (${req.account.id}, ${plan.id}, ${orderId}, ${plan.monthlyFee}, 'INR')
      returning id
    `;
    return { paymentId: payment.id };
  });
  if (inserted.error) return res.status(409).json({ error: inserted.error });
  if (inserted.free) return res.status(201).json({ free: true });

  const providerResponse = await fetch(`${cashfree.apiUrl}/orders`, {
    method: 'POST',
    headers: {
      'x-client-id': cashfree.appId,
      'x-client-secret': cashfree.secretKey,
      'x-api-version': '2026-01-01',
      'x-idempotency-key': randomUUID(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_id: orderId,
      order_amount: Number(plan.monthlyFee),
      order_currency: 'INR',
      customer_details: {
        customer_id: req.account.id,
        customer_name: req.account.fullName,
        customer_email: req.account.email,
        customer_phone: phone
      },
      order_meta: {
        return_url: `${cashfree.publicAppUrl}/payment.html?order_id={order_id}`
      },
      order_expiry_time: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      order_note: `Connect Pharma ${plan.tier} subscription`
    }),
    signal: AbortSignal.timeout(12000)
  });
  const providerResult = await providerResponse.json().catch(() => ({}));
  if (!providerResponse.ok || typeof providerResult.payment_session_id !== 'string') {
    if (providerResponse.status >= 400 && providerResponse.status < 500) {
      await sql`update billing_payments set status = 'failed' where id = ${inserted.paymentId} and status = 'pending'`;
    }
    console.error(`Cashfree order creation failed (${providerResponse.status}).`);
    return res.status(502).json({ error: 'Cashfree could not start checkout. Please try again.' });
  }
  res.status(201).json({
    orderId,
    paymentSessionId: providerResult.payment_session_id,
    mode: cashfree.mode
  });
}));

app.get('/api/billing/orders/:orderId', requireAccount('supplier', 'medical_shop'), asyncRoute(async (req, res) => {
  const [payment] = await sql`
    select cashfree_order_id as "orderId", amount, currency, status, paid_at as "paidAt"
    from billing_payments
    where cashfree_order_id = ${req.params.orderId} and account_id = ${req.account.id}
    limit 1
  `;
  if (!payment) return res.status(404).json({ error: 'Payment order not found.' });
  res.json(payment);
}));

app.post('/api/webhooks/cashfree', asyncRoute(async (req, res) => {
  const secret = process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY;
  const signature = req.get('x-webhook-signature') || '';
  const timestamp = req.get('x-webhook-timestamp') || '';
  const rawBody = req.rawBody;
  if (!secret) {
    return res.status(503).json({ error: 'Cashfree webhook verification is not configured.' });
  }
  if (!verifyCashfreeWebhookSignature(rawBody, signature, timestamp, secret)) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  const event = req.body;
  if (event?.type !== 'PAYMENT_SUCCESS_WEBHOOK') return res.status(200).json({ received: true });
  const orderId = event?.data?.order?.order_id;
  const amount = Number(event?.data?.order?.order_amount);
  const currency = event?.data?.order?.order_currency;
  const paymentId = String(event?.data?.payment?.cf_payment_id || '');
  if (!orderId || !paymentId || !Number.isFinite(amount) || !currency) {
    return res.status(400).json({ error: 'Malformed Cashfree payment event.' });
  }
  if (event?.data?.payment?.payment_status !== 'SUCCESS') {
    return res.status(200).json({ received: true });
  }

  const applied = await sql.begin(async (tx) => {
    const [payment] = await tx`
      select id, account_id as "accountId", plan_id as "planId", amount, currency, status
      from billing_payments where cashfree_order_id = ${orderId} for update
    `;
    if (!payment || payment.status === 'paid') return false;
    if (
      Math.round(Number(payment.amount) * 100) !== Math.round(amount * 100) ||
      payment.currency !== currency
    ) {
      throw new Error('Cashfree webhook amount or currency does not match the stored order.');
    }

    const [account] = await tx`
      select status from users where id = ${payment.accountId} for update
    `;
    const [updatedPayment] = await tx`
      update billing_payments
      set status = 'paid', cashfree_payment_id = ${paymentId}, paid_at = now(),
          provider_payload = ${tx.json({ type: event.type, paymentStatus: 'SUCCESS' })}
      where id = ${payment.id} and status in ('pending', 'failed')
      returning id
    `;
    if (!updatedPayment) return false;
    const [subscription] = await tx`
      insert into user_subscriptions (user_id, plan_id, status, start_date, end_date)
      values (
        ${payment.accountId}, ${payment.planId},
        ${account?.status === 'approved' ? 'active' : 'suspended'},
        now(), now() + interval '30 days'
      )
      returning id
    `;
    await tx`
      update billing_payments set subscription_id = ${subscription.id} where id = ${payment.id}
    `;
    await tx`
      insert into admin_audit_logs (actor_id, action_type, entity_type, entity_id, details)
      values (
        null, 'billing.payment_settled', 'billing_payment', ${payment.id},
        ${tx.json({
          accountId: payment.accountId,
          orderId,
          amount: payment.amount,
          currency: payment.currency,
          subscriptionStatus: account?.status === 'approved' ? 'active' : 'suspended'
        })}
      )
    `;
    return true;
  });
  res.status(200).json({ received: true, applied });
}));

app.get('/api/kyc/documents', requireAccount('supplier', 'medical_shop'), asyncRoute(async (req, res) => {
  const rows = await sql`
    select id, document_type as "documentType", status, review_notes as "reviewNotes",
           created_at as "createdAt", reviewed_at as "reviewedAt"
    from kyc_documents where account_id = ${req.account.id}
      and status <> 'pending_upload'
    order by created_at desc
  `;
  res.json(rows);
}));

app.post('/api/kyc/documents', requireAccount('supplier', 'medical_shop'), requireSameOrigin, asyncRoute(async (req, res) => {
  const storage = getR2Config();
  if (!storage) return res.status(503).json({ error: 'Private KYC document storage is not configured.' });
  const { documentType, mimeType, size } = req.body || {};
  const allowedTypes = req.account.role === 'supplier'
    ? ['wholesale_license', 'gst_certificate']
    : ['retail_license', 'gst_certificate'];
  if (!allowedTypes.includes(documentType)) return res.status(400).json({ error: 'Choose a document type for your account.' });
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
    return res.status(400).json({ error: 'Upload a PDF, JPG, or PNG document.' });
  }
  if (!Number.isInteger(size) || size < 1 || size > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Document size must be 10 MB or less.' });
  }

  const id = randomUUID();
  const key = `${req.account.id}/${id}`;
  const created = await sql.begin(async (tx) => {
    const [account] = await tx`
      select status from users where id = ${req.account.id} for update
    `;
    if (!account || account.status !== 'approved') return false;
    await tx`
      insert into kyc_documents (id, account_id, document_type, storage_key, mime_type, status, upload_expires_at)
      values (${id}, ${req.account.id}, ${documentType}, ${key}, ${mimeType},
              'pending_upload', now() + interval '15 minutes')
    `;
    return true;
  });
  if (!created) return res.status(403).json({ error: 'Your account is no longer approved to upload documents.' });
  res.status(201).json({ documentId: id });
}));

app.put(
  '/api/kyc/documents/:id/upload',
  requireAccount('supplier', 'medical_shop'),
  requireSameOrigin,
  express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '10mb' }),
  asyncRoute(async (req, res) => {
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid document ID.' });
  const storage = getR2Config();
  if (!storage) return res.status(503).json({ error: 'Private KYC document storage is not configured.' });
  const [document] = await sql`
    select storage_key as "storageKey", mime_type as "mimeType"
    from kyc_documents
    where id = ${req.params.id} and account_id = ${req.account.id}
      and status = 'pending_upload' and upload_expires_at > now()
    limit 1
  `;
  if (!document) return res.status(404).json({ error: 'Upload was not found or has expired.' });
  const file = req.body;
  const contentType = req.get('content-type');
  if (!Buffer.isBuffer(file) || !file.length || file.length > 10 * 1024 * 1024 || contentType !== document.mimeType) {
    return res.status(400).json({ error: 'Uploaded document type or size is invalid.' });
  }
  const validFileSignature = document.mimeType === 'application/pdf'
    ? file.subarray(0, 5).toString() === '%PDF-'
    : document.mimeType === 'image/jpeg'
      ? file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff
      : file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!validFileSignature) return res.status(400).json({ error: 'The file contents do not match the selected document format.' });

  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: document.storageKey,
    Body: file,
    ContentLength: file.length,
    ContentType: document.mimeType
  }));

  const [updated] = await sql`
    update kyc_documents set status = 'pending_review', upload_expires_at = null
    where id = ${req.params.id} and account_id = ${req.account.id} and status = 'pending_upload'
      and exists (
        select 1 from users
        where users.id = kyc_documents.account_id and users.status = 'approved'
      )
    returning id
  `;
  if (!updated) {
    try {
      await storage.client.send(new DeleteObjectCommand({
        Bucket: storage.bucket,
        Key: document.storageKey
      }));
    } catch (error) {
      console.error(`Could not clean up an unsubmitted KYC object for account ${req.account.id}:`, error);
      return res.status(503).json({ error: 'The account changed during upload and the document could not be cleaned up. Contact support.' });
    }
    return res.status(409).json({ error: 'The account changed during upload; the document was not submitted.' });
  }
  res.status(200).json({ submitted: true });
  })
);

app.get('/api/admin/kyc/pending', asyncRoute(async (_req, res) => {
  const rows = await sql`
    select d.id, d.document_type as "documentType", d.mime_type as "mimeType",
           d.created_at as "createdAt", u.id as "accountId", u.full_name as "fullName",
           u.email, u.role
    from kyc_documents d join users u on u.id = d.account_id
    where d.status = 'pending_review'
    order by d.created_at asc
    limit 200
  `;
  res.json(rows);
}));

app.post('/api/admin/kyc/:id/download-url', requireSameOrigin, asyncRoute(async (req, res) => {
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid document ID.' });
  const storage = getR2Config();
  if (!storage) return res.status(503).json({ error: 'Private KYC document storage is not configured.' });
  const [document] = await sql`
    select storage_key as "storageKey", document_type as "documentType", mime_type as "mimeType"
    from kyc_documents where id = ${req.params.id} and status <> 'pending_upload'
    limit 1
  `;
  if (!document) return res.status(404).json({ error: 'KYC document not found.' });
  const fileName = `${document.documentType}.${document.mimeType === 'application/pdf' ? 'pdf' : 'image'}`;
  const downloadUrl = await getSignedUrl(storage.client, new GetObjectCommand({
    Bucket: storage.bucket,
    Key: document.storageKey,
    ResponseContentType: document.mimeType,
    ResponseContentDisposition: `attachment; filename="${fileName}"`
  }), { expiresIn: 300 });
  res.json({ downloadUrl });
}));

app.post('/api/admin/kyc/:id/review', requireSameOrigin, asyncRoute(async (req, res) => {
  const { status, reason } = req.body || {};
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid document ID.' });
  if (!['approved', 'rejected'].includes(status) || !normalizedReason || normalizedReason.length > 500) {
    return res.status(400).json({ error: 'Choose approve or reject and provide a reason of 1–500 characters.' });
  }
  const reviewed = await sql.begin(async (tx) => {
    const [document] = await tx`
      update kyc_documents
      set status = ${status}, reviewed_by = ${req.account.id},
          review_notes = ${normalizedReason}, reviewed_at = now()
      where id = ${req.params.id} and status = 'pending_review'
      returning id, account_id as "accountId"
    `;
    if (!document) return false;
    await writeAdminAudit(tx, req, `kyc_document.${status}`, 'kyc_document', document.id, {
      accountId: document.accountId, reason: normalizedReason
    });
    return true;
  });
  if (!reviewed) return res.status(409).json({ error: 'Document is no longer waiting for review.' });
  res.json({ reviewed: true });
}));

// ---------- static frontend ----------

app.use(express.static(WEB_DIR));

// Fallback: unknown non-API GET paths get the landing page. Guarded because
// the static bundle may not be traced into the serverless function.
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(join(WEB_DIR, 'index.html'), (error) => {
      if (error && !res.headersSent) next(error);
    });
    return;
  }
  next();
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  console.error(`${req.method} ${req.path} failed:`, error);
  res.status(500).json({ error: 'Something went wrong.' });
});

export default app;

// Vercel imports this module as a serverless function (api/index.mjs) and
// provides its own listener; only bind a port for local/standalone runs.
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Connect Pharma HTML app → http://localhost:${PORT}`);
  });
}
