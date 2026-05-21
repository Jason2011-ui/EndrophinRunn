// ============================================================
//   EndorphinRun – LOCAL DATABASE (IndexedDB + LocalStorage)
// ============================================================

const DB_NAME    = 'EndorphinRunDB';
const DB_VERSION = 1;
let   db         = null;

// ---------- Open / Init ----------
function initDB() {
  if (db) return Promise.resolve(db); // sudah terbuka, langsung return

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;

      // Users store
      if (!idb.objectStoreNames.contains('users')) {
        const us = idb.createObjectStore('users', { keyPath: 'id', autoIncrement: true });
        us.createIndex('email',    'email',    { unique: true });
        us.createIndex('username', 'username', { unique: true });
      }

      // Activities store
      if (!idb.objectStoreNames.contains('activities')) {
        const as = idb.createObjectStore('activities', { keyPath: 'id', autoIncrement: true });
        as.createIndex('userId',    'userId',    { unique: false });
        as.createIndex('type',      'type',      { unique: false });
        as.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = (e) => { db = e.target.result; console.log('✅ IndexedDB ready'); resolve(db); };
    req.onerror   = (e) => { console.error('❌ IndexedDB error:', e.target.error); reject(e.target.error); };
  });
}

// ---------- USERS ----------
function dbCreateUser(userData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const user = {
      ...userData,
      createdAt: new Date().toISOString(),
      totalKm: 0,
      totalActivities: 0,
      totalCalories: 0
    };
    const req = store.add(user);
    req.onsuccess = (e) => resolve({ ...user, id: e.target.result });
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbGetUserByEmail(email) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const idx = tx.objectStore('users').index('email');
    const req = idx.get(email);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbGetAllUsers() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const req = tx.objectStore('users').getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbUpdateUser(userId, updates) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(userId);
    getReq.onsuccess = (e) => {
      const user = e.target.result;
      if (!user) return reject(new Error('User not found'));
      const updated = { ...user, ...updates };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror   = (e) => reject(e.target.error);
    };
  });
}

// ---------- ACTIVITIES ----------
function dbSaveActivity(activityData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('activities', 'readwrite');
    const store = tx.objectStore('activities');
    const activity = {
      ...activityData,
      createdAt: new Date().toISOString()
    };
    const req = store.add(activity);
    req.onsuccess = (e) => resolve({ ...activity, id: e.target.result });
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbGetActivitiesByUser(userId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('activities', 'readonly');
    const idx = tx.objectStore('activities').index('userId');
    const req = idx.getAll(userId);
    req.onsuccess = (e) => {
      const arr = e.target.result || [];
      arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      resolve(arr);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbGetAllActivities() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('activities', 'readonly');
    const req = tx.objectStore('activities').getAll();
    req.onsuccess = (e) => {
      const arr = e.target.result || [];
      arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      resolve(arr);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbDeleteActivity(actId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('activities', 'readwrite');
    const req = tx.objectStore('activities').delete(actId);
    req.onsuccess = () => resolve(true);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ---------- SESSION (LocalStorage) ----------
function sessionSet(user)   { localStorage.setItem('er_session', JSON.stringify(user)); }
function sessionGet()       { const d = localStorage.getItem('er_session'); return d ? JSON.parse(d) : null; }
function sessionClear()     { localStorage.removeItem('er_session'); }

// ---------- Password (simple hash) ----------
async function hashPassword(pw) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
