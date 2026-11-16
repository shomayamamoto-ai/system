'use strict';
// 担当者アカウント（ログイン）と操作履歴。
// パスワードは元に戻せない形（scrypt）に変換して保存し、そのままの文字では残さない。

const crypto = require('node:crypto');
const { AppError, clean, newId } = require('./core');

const ROLES = { owner: '管理者', staff: '担当者' };
const BUILTIN = { id: 'admin', loginId: 'admin', name: '管理者', role: 'owner' }; // 環境変数 ADMIN_PASSWORD でログインする人

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}
function checkPassword(user, password) {
  const given = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  return crypto.timingSafeEqual(given, Buffer.from(user.hash, 'hex'));
}
function validPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new AppError('パスワードは8文字以上で入力してください。');
  }
  return password;
}
const publicUser = (u) => ({ id: u.id, name: u.name, loginId: u.loginId, role: u.role });

// パスワードの照合は計算が重いので、ほかの利用者を待たせないよう裏で行う
function checkPasswordAsync(salt, hash, password) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, (err, key) => (err ? reject(err) : resolve(crypto.timingSafeEqual(key, Buffer.from(hash, 'hex')))));
  });
}

// ログインIDとパスワードが合っていれば、その人の情報を返す。違えば null
async function authenticate(db, loginId, password, adminPassword) {
  if (typeof loginId !== 'string' || typeof password !== 'string') return null;
  if (loginId === BUILTIN.loginId) {
    const sha = (v) => crypto.createHash('sha256').update(v).digest();
    return adminPassword && crypto.timingSafeEqual(sha(password), sha(adminPassword)) ? BUILTIN : null;
  }
  const user = db.users.find((u) => u.loginId === loginId);
  if (!user) { await checkPasswordAsync('00', '00'.repeat(32), password); return null; } // IDの有無で応答時間が変わらないよう、同じ計算をしておく
  return (await checkPasswordAsync(user.salt, user.hash, password)) ? publicUser(user) : null;
}

function addUser(db, input, { needOwner } = {}) {
  const name = clean(input.name, 40);
  const loginId = clean(input.loginId, 30);
  if (!name) throw new AppError('名前を入力してください。');
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(loginId)) throw new AppError('ログインIDは、半角の英数字と . _ - を使って3〜30文字で入力してください。');
  if (loginId === BUILTIN.loginId || db.users.some((u) => u.loginId === loginId)) throw new AppError('そのログインIDはすでに使われています。');
  if (typeof input.role !== 'string' || !Object.hasOwn(ROLES, input.role)) throw new AppError('権限を選んでください。');
  if (needOwner && input.role !== 'owner') throw new AppError('最初のアカウントは、権限を「管理者」にしてください。設定を変更できる人がいなくなるのを防ぐためです。');
  if (db.users.length >= 100) throw new AppError('アカウントは100件までです。');
  const user = Object.assign({ id: newId('u'), name, loginId, role: input.role }, hashPassword(validPassword(input.password)));
  db.users.push(user);
  return publicUser(user);
}
function removeUser(db, id, { keepOwner } = {}) {
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new AppError('アカウントが見つかりません。', 404);
  if (keepOwner && user.role === 'owner' && db.users.filter((u) => u.role === 'owner').length === 1) {
    throw new AppError('最後の管理者アカウントは削除できません。');
  }
  db.users = db.users.filter((u) => u.id !== id);
  return publicUser(user);
}
function resetPassword(db, id, password) {
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new AppError('アカウントが見つかりません。', 404);
  Object.assign(user, hashPassword(validPassword(password)));
  return publicUser(user);
}

// 本人によるパスワード変更（いまのパスワードが合っているときだけ）
function changeOwnPassword(db, id, current, next) {
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new AppError('このアカウントのパスワードは、サーバーの設定（ADMIN_PASSWORD）で変更します。');
  if (typeof current !== 'string' || !checkPassword(user, current)) throw new AppError('いまのパスワードが違います。', 403);
  Object.assign(user, hashPassword(validPassword(next)));
  return publicUser(user);
}

// 操作履歴に1行足す（直近2000件を残す）
function audit(db, user, action, detail, now = new Date()) {
  db.audit.push({ at: now.toISOString(), user: user ? user.name : '（ログインなし）', action, detail: clean(detail, 300) });
  if (db.audit.length > 2000) db.audit.splice(0, db.audit.length - 2000);
}

module.exports = { ROLES, BUILTIN, authenticate, addUser, removeUser, resetPassword, changeOwnPassword, publicUser, audit };
