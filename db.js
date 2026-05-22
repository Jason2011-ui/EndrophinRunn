const DB_NAME = 'EndorphinRunDB';
const DB_VERSION = 1;
let db = null;

function initDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('users')) {
        const us = idb.createObjectStore('users', { keyPath: 'id', autoIncrement: true });
        us.createIndex('email', 'email', { unique: true });
        us.createIndex('username', 'username', { unique: true });
      }
      if (!idb.objectStoreNames.contains('activities')) {
        const as = idb.createObjectStore('activities', { keyPath: 'id', autoIncrement: true });
        as.createIndex('userId', 'userId', { unique: false });
        as.createIndex('type', 'type', { unique: false });
        as.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbCreateUser(userData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const user = { ...userData, createdAt: new Date().toISOString() };
    const req = store.add(user);
    req.onsuccess = (e) => { user.id = e.target.result; resolve(user); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbGetUserByEmail(email) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const idx = tx.objectStore('users').index('email');
    const req = idx.get(email);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbGetAllUsers() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const req = tx.objectStore('users').getAll();
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbSaveActivity(actData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('activities', 'readwrite');
    const store = tx.objectStore('activities');
    const req = store.add(actData);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbGetActivitiesByUser(userId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('activities', 'readonly');
    const store = tx.objectStore('activities');
    const req = store.getAll();
    req.onsuccess = (e) => {
      const filtered = (e.target.result || []).filter(a => a.userId === userId);
      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      resolve(filtered);
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
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbUpdateUser(userData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const req = store.put(userData);
    req.onsuccess = () => resolve(userData);
    req.onerror = (e) => reject(e.target.error);
  });
}

function sessionSet(user) { localStorage.setItem('er_session', JSON.stringify(user)); }
function sessionGet() { const d = localStorage.getItem('er_session'); return d ? JSON.parse(d) : null; }
function sessionClear() { localStorage.removeItem('er_session'); }

async function hashPassword(password) {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}