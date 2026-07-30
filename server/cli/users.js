#!/usr/bin/env node
/**
 * Desk account management.
 *
 *   node cli/users.js list
 *   node cli/users.js create <email> <password> [--admin] [--name "Full Name"]
 *   node cli/users.js passwd <email> <newPassword>
 *   node cli/users.js role   <email> admin|trader
 *   node cli/users.js enable|disable <email>
 *   node cli/users.js delete <email>
 *   node cli/users.js seed                # first admin, from SEED_ADMIN_* env vars
 */
import { closePool, query } from '../src/db.js';
import { t } from '../src/config.js';
import {
  countAdmins, countUsers, createUser, findUserByEmail, listUsers, updateUser,
} from '../src/auth.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = name => process.argv.includes(name);
const opt = name => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const positional = rest.filter(a => !a.startsWith('--')
  && a !== opt('--name') && a !== opt('--role'));

const die = msg => { console.error(msg); process.exitCode = 1; };

async function mustFind(email) {
  const u = await findUserByEmail(email);
  if (!u) throw new Error(`No account for ${email}`);
  return u;
}

try {
  switch (cmd) {
    case 'list': {
      const users = await listUsers();
      if (!users.length) {
        console.log('No accounts yet. Create one:\n  node cli/users.js create you@example.com "a strong password" --admin');
        break;
      }
      console.log(`${users.length} account(s):\n`);
      console.log('  ID   ROLE     ACTIVE  LAST LOGIN            EMAIL');
      for (const u of users) {
        console.log('  ' + String(u.id).padEnd(5)
          + u.role.padEnd(9)
          + (u.is_active ? 'yes' : 'NO ').padEnd(8)
          + (u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 16).replace('T', ' ') : '—').padEnd(22)
          + u.email + (u.name ? `  (${u.name})` : ''));
      }
      break;
    }

    case 'create': {
      const [email, password] = positional;
      if (!email || !password) { die('usage: create <email> <password> [--admin] [--name "X"]'); break; }
      const user = await createUser({
        email, password,
        name: opt('--name'),
        role: flag('--admin') ? 'admin' : (opt('--role') ?? 'trader'),
      });
      console.log(`created ${user.email} (${user.role}, id ${user.id})`);
      break;
    }

    case 'passwd': {
      const [email, password] = positional;
      if (!email || !password) { die('usage: passwd <email> <newPassword>'); break; }
      const u = await mustFind(email);
      await updateUser(u.id, { password });
      console.log(`password updated for ${u.email}`);
      break;
    }

    case 'role': {
      const [email, role] = positional;
      if (!email || !['admin', 'trader'].includes(role)) { die('usage: role <email> admin|trader'); break; }
      const u = await mustFind(email);
      if (u.role === 'admin' && role !== 'admin' && await countAdmins(u.id) === 0) {
        die('refusing: this is the only active administrator'); break;
      }
      await updateUser(u.id, { role });
      console.log(`${u.email} is now ${role}`);
      break;
    }

    case 'enable':
    case 'disable': {
      const [email] = positional;
      if (!email) { die(`usage: ${cmd} <email>`); break; }
      const u = await mustFind(email);
      const active = cmd === 'enable';
      if (!active && u.role === 'admin' && await countAdmins(u.id) === 0) {
        die('refusing: this is the only active administrator'); break;
      }
      await updateUser(u.id, { is_active: active });
      console.log(`${u.email} ${active ? 'enabled' : 'disabled'}`);
      break;
    }

    case 'delete': {
      const [email] = positional;
      if (!email) { die('usage: delete <email>'); break; }
      const u = await mustFind(email);
      if (u.role === 'admin' && await countAdmins(u.id) === 0) {
        die('refusing: this is the only active administrator'); break;
      }
      await query(`delete from ${t('users')} where id = $1`, [u.id]);
      console.log(`deleted ${u.email}`);
      break;
    }

    /**
     * Creates the first administrator. Idempotent: if the account already exists
     * its password is reset to the seed value, so this is also the recovery path
     * for a forgotten admin password.
     */
    case 'seed': {
      const email = process.env.SEED_ADMIN_EMAIL;
      const password = process.env.SEED_ADMIN_PASSWORD;
      if (!email || !password) {
        die('set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD first');
        break;
      }
      const existing = await findUserByEmail(email);
      if (existing) {
        await updateUser(existing.id, { password, role: 'admin', is_active: true });
        console.log(`reset password and admin role for ${email}`);
      } else {
        const u = await createUser({ email, password, role: 'admin', name: opt('--name') ?? 'Administrator' });
        console.log(`created administrator ${u.email} (id ${u.id})`);
      }
      console.log(`total accounts: ${await countUsers()}`);
      break;
    }

    default:
      console.log(`usage: node cli/users.js <command>

  list                              show every account
  create <email> <pw> [--admin]     add an account
  passwd <email> <newPw>            reset a password
  role   <email> admin|trader       change role
  enable|disable <email>            toggle access
  delete <email>                    remove an account
  seed                              create/reset the first admin from SEED_ADMIN_* env`);
      process.exitCode = 1;
  }
} catch (e) {
  die(e.message);
}

await closePool();
