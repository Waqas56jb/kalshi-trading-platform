import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { t } from './config.js';
import { query } from './db.js';

const scrypt = promisify(crypto.scrypt);

/* scrypt cost. N=16384 keeps a hash around 50-80ms on Vercel's 1 vCPU, which is
   slow enough to punish guessing without stalling a login. */
const N = 16384, R = 8, P = 1, KEYLEN = 64;

/* ------------------------------------------------------------- passwords --- */

/** Self-describing digest: scrypt$N$r$p$salt$hash — cost can change later. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, salt, expected.length, { N: +n, r: +r, p: +p });
    // constant-time compare so a wrong password cannot be timed byte by byte
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Rejects the passwords that actually get people breached. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) return 'Password must be under 200 characters.';
  if (/^\d+$/.test(password)) return 'Password cannot be only digits.';
  if (['password', '12345678', 'qwerty123', 'admin123'].includes(password.toLowerCase())) {
    return 'That password is too common.';
  }
  return null;
}

export const normaliseEmail = e => String(e ?? '').trim().toLowerCase();

export function emailProblem(email) {
  const e = normaliseEmail(email);
  if (!e) return 'Email is required.';
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Enter a valid email address.';
  return null;
}

/* ---------------------------------------------------------------- tokens --- */

const b64url = buf => Buffer.from(buf).toString('base64url');
const TOKEN_TTL_SECONDS = 60 * 60 * 12;                 // 12h

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 24) {
    const e = new Error('AUTH_SECRET is not set (or is too short) — sign-in is disabled');
    e.code = 'auth_not_configured';
    throw e;
  }
  return s;
}

export const authConfigured = () =>
  Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 24);

/** Standard HS256 JWT, built with node crypto so there is no extra dependency. */
export function signToken(payload, ttl = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;

  const expected = b64url(crypto.createHmac('sha256', secret()).update(`${head}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

/* ----------------------------------------------------------------- users --- */

const PUBLIC_COLUMNS = 'id, email, name, role, is_active, last_login_at, created_at, updated_at';

export async function findUserByEmail(email) {
  const r = await query(
    `select id, email, name, role, is_active, password_hash
     from ${t('users')} where lower(email) = $1`,
    [normaliseEmail(email)],
  );
  return r.rows[0] ?? null;
}

export async function getUser(id) {
  const r = await query(`select ${PUBLIC_COLUMNS} from ${t('users')} where id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function listUsers() {
  const r = await query(`select ${PUBLIC_COLUMNS} from ${t('users')} order by created_at`);
  return r.rows;
}

export async function countUsers() {
  const r = await query(`select count(*)::int n from ${t('users')}`);
  return r.rows[0].n;
}

export async function createUser({ email, password, name, role = 'trader' }) {
  const ep = emailProblem(email);
  if (ep) throw Object.assign(new Error(ep), { code: 'invalid_email', status: 400 });
  const pp = passwordProblem(password);
  if (pp) throw Object.assign(new Error(pp), { code: 'weak_password', status: 400 });
  if (!['admin', 'trader'].includes(role)) {
    throw Object.assign(new Error('Role must be admin or trader.'), { code: 'invalid_role', status: 400 });
  }

  try {
    const r = await query(
      `insert into ${t('users')} (email, password_hash, name, role)
       values ($1, $2, $3, $4) returning ${PUBLIC_COLUMNS}`,
      [normaliseEmail(email), await hashPassword(password), name?.trim() || null, role],
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505' || /duplicate key/i.test(e.message)) {
      throw Object.assign(new Error('An account with that email already exists.'),
        { code: 'email_taken', status: 409 });
    }
    throw e;
  }
}

export async function updateUser(id, { email, password, name, role, is_active }) {
  const sets = [];
  const vals = [];
  const push = (frag, v) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };

  if (email !== undefined) {
    const ep = emailProblem(email);
    if (ep) throw Object.assign(new Error(ep), { code: 'invalid_email', status: 400 });
    push('email', normaliseEmail(email));
  }
  if (password !== undefined) {
    const pp = passwordProblem(password);
    if (pp) throw Object.assign(new Error(pp), { code: 'weak_password', status: 400 });
    push('password_hash', await hashPassword(password));
  }
  if (name !== undefined) push('name', name?.trim() || null);
  if (role !== undefined) {
    if (!['admin', 'trader'].includes(role)) {
      throw Object.assign(new Error('Role must be admin or trader.'), { code: 'invalid_role', status: 400 });
    }
    push('role', role);
  }
  if (is_active !== undefined) push('is_active', Boolean(is_active));

  if (!sets.length) return getUser(id);

  vals.push(id);
  try {
    const r = await query(
      `update ${t('users')} set ${sets.join(', ')} where id = $${vals.length}
       returning ${PUBLIC_COLUMNS}`, vals);
    return r.rows[0] ?? null;
  } catch (e) {
    if (e.code === '23505' || /duplicate key/i.test(e.message)) {
      throw Object.assign(new Error('An account with that email already exists.'),
        { code: 'email_taken', status: 409 });
    }
    throw e;
  }
}

export async function deleteUser(id) {
  const r = await query(`delete from ${t('users')} where id = $1 returning id`, [id]);
  return r.rowCount > 0;
}

export async function countAdmins(excludeId = null) {
  const r = await query(
    `select count(*)::int n from ${t('users')}
     where role = 'admin' and is_active and ($1::bigint is null or id <> $1)`,
    [excludeId],
  );
  return r.rows[0].n;
}

/* ----------------------------------------------------------------- audit --- */

export async function logAuthEvent({ userId, email, event, detail, req }) {
  try {
    await query(
      `insert into ${t('auth_events')} (user_id, email, event, detail, ip, user_agent)
       values ($1,$2,$3,$4,$5,$6)`,
      [userId ?? null, email ?? null, event, detail ?? null,
        req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ?? null,
        req?.headers?.['user-agent']?.slice(0, 300) ?? null],
    );
  } catch { /* auditing must never break the request */ }
}

/**
 * Authenticates a credential pair.
 *
 * The same generic message is returned whether the email is unknown or the
 * password is wrong, so the response cannot be used to enumerate accounts.
 */
export async function authenticate(email, password, req) {
  const user = await findUserByEmail(email);
  const ok = user && user.is_active && await verifyPassword(password, user.password_hash);

  if (!ok) {
    await logAuthEvent({
      userId: user?.id, email: normaliseEmail(email), event: 'login_failed',
      detail: !user ? 'no such account' : !user.is_active ? 'account disabled' : 'bad password',
      req,
    });
    return null;
  }

  await query(`update ${t('users')} set last_login_at = now() where id = $1`, [user.id]);
  await logAuthEvent({ userId: user.id, email: user.email, event: 'login_ok', req });

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token: signToken({ sub: String(user.id), email: user.email, role: user.role }),
  };
}
