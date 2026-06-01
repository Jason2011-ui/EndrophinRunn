// ============================================================
//   RunFun – db.js
//   Storage: Supabase (cloud utama) + IndexedDB (cache offline)
//
//   SETUP:
//   Ganti SUPABASE_KEY di bawah dengan Publishable key kamu
//   dari Supabase Dashboard → Settings → API Keys
// ============================================================

const SUPABASE_URL = 'https://ovnpchoizwkccsiempzg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4g_L2h0EcTsV2P7rp4IAkQ_8F50fjnM'; // sb_publishable_...

// ── Supabase REST helper ──────────────────────────────────────
const SB = {
  headers() {
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    };
  },
  async get(table, query = '') {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { ...this.headers(), 'Prefer': 'return=representation' }
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async post(table, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async patch(table, query, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async delete(table, query) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'DELETE',
      headers: this.headers()
    });
    if (!res.ok) throw new Error(await res.text());
    return true;
  }
};

// ── Status koneksi ────────────────────────────────────────────
let _isOnline = navigator.onLine;
window.addEventListener('online',  () => { _isOnline = true;  syncPendingQueue(); });
window.addEventListener('offline', () => { _isOnline = false; });
function isOnline() { return _isOnline; }

// ── IndexedDB (cache lokal + offline queue) ───────────────────
const DB_NAME = 'RunFunDB';
const DB_VERSION = 2;
let db = null;

function initDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('users')) {
        const us = idb.createObjectStore('users', { keyPath: 'id' });
        us.createIndex('email', 'email', { unique: true });
        us.createIndex('username', 'username', { unique: true });
      }
      if (!idb.objectStoreNames.contains('activities')) {
        const as = idb.createObjectStore('activities', { keyPath: 'id' });
        as.createIndex('userId', 'userId', { unique: false });
        as.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!idb.objectStoreNames.contains('syncQueue')) {
        idb.createObjectStore('syncQueue', { keyPath: 'qid', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ── IndexedDB helpers ─────────────────────────────────────────
function idbGetByIndex(store, index, value) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).index(index).get(value);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function idbGetAll(store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}
function idbPut(store, data) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(data);
    req.onsuccess = () => res(data);
    req.onerror   = e => rej(e.target.error);
  });
}
function idbDelete(store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => res(true);
    req.onerror   = e => rej(e.target.error);
  });
}
function idbAdd(store, data) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).add(data);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Offline queue ─────────────────────────────────────────────
async function queueOperation(op) {
  try { await idbAdd('syncQueue', { ...op, timestamp: new Date().toISOString() }); } catch(e) {}
}

async function syncPendingQueue() {
  if (!isOnline()) return;
  let queue = [];
  try { queue = await idbGetAll('syncQueue'); } catch(e) { return; }
  for (const op of queue) {
    try {
      if (op.type === 'saveActivity')  await SB.post('activities', op.data);
      if (op.type === 'deleteActivity') await SB.delete('activities', `id=eq.${op.id}`);
      if (op.type === 'updateUser')    await SB.patch('users', `id=eq.${op.data.id}`, op.data);
      await idbDelete('syncQueue', op.qid);
    } catch (e) {
      console.warn('[RunFun] Sync retry gagal:', e);
    }
  }
}

// ── Field mapping: app (camelCase) ↔ Supabase (snake_case) ───
function toSbUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name || u.username,
    password: u.password,
    bio: u.bio || null,
    avatar: u.avatar || null,
    avatar_color: u.avatarColor || '#3DD2CC',
    avatar_photo: u.avatarPhoto || null,
    favorite_activity: u.favoriteActivity || 'running',
    created_at: u.createdAt || new Date().toISOString()
  };
}
function fromSbUser(r) {
  return {
    id: r.id,
    email: r.email,
    username: r.username,
    name: r.name,
    password: r.password,
    bio: r.bio,
    avatar: r.avatar,
    avatarColor: r.avatar_color,
    avatarPhoto: r.avatar_photo,
    favoriteActivity: r.favorite_activity,
    createdAt: r.created_at
  };
}
function toSbActivity(a) {
  return {
    id: a.id,
    user_id: a.userId,
    type: a.type,
    distance: a.distance,
    duration: a.duration,
    calories: a.calories || 0,
    pace: a.pace || null,
    route: a.route || [],
    created_at: a.createdAt || new Date().toISOString()
  };
}
function fromSbActivity(r) {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    distance: r.distance,
    duration: r.duration,
    calories: r.calories,
    pace: r.pace,
    route: r.route || [],
    createdAt: r.created_at
  };
}

// ── PUBLIC API ────────────────────────────────────────────────

async function dbCreateUser(userData) {
  const id = crypto.randomUUID();
  const user = { ...userData, id, createdAt: new Date().toISOString() };
  if (isOnline()) {
    const rows = await SB.post('users', toSbUser(user));
    const saved = fromSbUser(rows[0]);
    await idbPut('users', saved);
    return saved;
  }
  await idbPut('users', user);
  return user;
}

async function dbGetUserByEmail(email) {
  if (isOnline()) {
    try {
      const rows = await SB.get('users', `email=eq.${encodeURIComponent(email)}&limit=1`);
      if (!rows.length) return null;
      const user = fromSbUser(rows[0]);
      await idbPut('users', user);
      return user;
    } catch (e) { console.warn('[RunFun] Fallback ke IndexedDB:', e); }
  }
  return idbGetByIndex('users', 'email', email);
}

async function dbUpdateUser(userData) {
  await idbPut('users', userData);
  if (isOnline()) {
    try {
      await SB.patch('users', `id=eq.${userData.id}`, toSbUser(userData));
    } catch (e) { await queueOperation({ type: 'updateUser', data: userData }); }
  } else {
    await queueOperation({ type: 'updateUser', data: userData });
  }
  return userData;
}

async function dbSaveActivity(actData) {
  const id = actData.id || crypto.randomUUID();
  const act = { ...actData, id };
  await idbPut('activities', act);
  if (isOnline()) {
    try {
      const rows = await SB.post('activities', toSbActivity(act));
      const saved = fromSbActivity(rows[0]);
      await idbPut('activities', saved);
      return saved.id;
    } catch (e) { await queueOperation({ type: 'saveActivity', data: toSbActivity(act) }); }
  } else {
    await queueOperation({ type: 'saveActivity', data: toSbActivity(act) });
  }
  return id;
}

async function dbGetActivitiesByUser(userId) {
  if (isOnline()) {
    try {
      const rows = await SB.get('activities', `user_id=eq.${userId}&order=created_at.desc`);
      const acts = rows.map(fromSbActivity);
      for (const a of acts) await idbPut('activities', a);
      return acts;
    } catch (e) { console.warn('[RunFun] Fallback ke IndexedDB:', e); }
  }
  const all = await idbGetAll('activities');
  return all.filter(a => a.userId === userId)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function dbGetAllActivities() {
  if (isOnline()) {
    try {
      const rows = await SB.get('activities', 'order=created_at.desc');
      const acts = rows.map(fromSbActivity);
      for (const a of acts) await idbPut('activities', a);
      return acts;
    } catch (e) { console.warn('[RunFun] Fallback ke IndexedDB:', e); }
  }
  const all = await idbGetAll('activities');
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function dbDeleteActivity(actId) {
  await idbDelete('activities', actId);
  if (isOnline()) {
    try { await SB.delete('activities', `id=eq.${actId}`); }
    catch (e) { await queueOperation({ type: 'deleteActivity', id: actId }); }
  } else {
    await queueOperation({ type: 'deleteActivity', id: actId });
  }
  return true;
}

async function dbGetAllUsers() {
  if (isOnline()) {
    try {
      const rows = await SB.get('users', 'order=created_at.desc');
      return rows.map(fromSbUser);
    } catch (e) {}
  }
  return idbGetAll('users');
}

// ── Session ───────────────────────────────────────────────────
function sessionSet(user)  { localStorage.setItem('er_session', JSON.stringify(user)); }
function sessionGet()      { const d = localStorage.getItem('er_session'); return d ? JSON.parse(d) : null; }
function sessionClear()    { localStorage.removeItem('er_session'); }

// ── Hash password ─────────────────────────────────────────────
async function hashPassword(password) {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Sync offline queue saat app dibuka
document.addEventListener('DOMContentLoaded', () => {
  initDB().then(() => syncPendingQueue());
});