// ============================================================
//   RunFun – db.js
//   Storage: Supabase ONLY (cloud)
//
//   WAJIB GANTI:
//   SUPABASE_KEY di bawah dengan Publishable key kamu
//   Supabase Dashboard → Settings → API Keys → Publishable key
// ============================================================

const SUPABASE_URL = 'https://ovnpchoizwkccsiempzg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4g_L2h0EcTsV2P7rp4IAkQ_8F50fjnM';

// ── Supabase fetch helper ─────────────────────────────────────
async function sbFetch(method, table, query = '', body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    console.error('[Supabase Error]', res.status, text);
    throw new Error(text);
  }
  return text ? JSON.parse(text) : [];
}

// ── Field mapping ─────────────────────────────────────────────
function toSbUser(u) {
  return {
    id:                u.id,
    email:             u.email,
    username:          u.username,
    name:              u.name || u.username,
    password:          u.password,
    bio:               u.bio               || null,
    avatar:            u.avatar            || null,
    avatar_color:      u.avatarColor       || '#3DD2CC',
    avatar_photo:      u.avatarPhoto       || null,
    favorite_activity: u.favoriteActivity  || 'running',
    created_at:        u.createdAt         || new Date().toISOString()
  };
}

function fromSbUser(r) {
  return {
    id:               r.id,
    email:            r.email,
    username:         r.username,
    name:             r.name,
    password:         r.password,
    bio:              r.bio,
    avatar:           r.avatar,
    avatarColor:      r.avatar_color,
    avatarPhoto:      r.avatar_photo,
    favoriteActivity: r.favorite_activity,
    createdAt:        r.created_at
  };
}

function toSbActivity(a) {
  return {
    id:         a.id,
    user_id:    a.userId,
    type:       a.type,
    distance:   a.distance,
    duration:   a.duration,
    calories:   a.calories  || 0,
    pace:       a.pace      || null,
    route:      a.route     || [],
    created_at: a.createdAt || new Date().toISOString()
  };
}

function fromSbActivity(r) {
  return {
    id:        r.id,
    userId:    r.user_id,
    type:      r.type,
    distance:  r.distance,
    duration:  r.duration,
    calories:  r.calories,
    pace:      r.pace,
    route:     r.route || [],
    createdAt: r.created_at
  };
}

// ── Init (tidak perlu apa-apa, langsung siap) ─────────────────
function initDB() {
  return Promise.resolve(true);
}

// ── Users ─────────────────────────────────────────────────────
async function dbCreateUser(userData) {
  const user = {
    ...userData,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };
  const rows = await sbFetch('POST', 'users', '', toSbUser(user));
  return fromSbUser(rows[0]);
}

async function dbGetUserByEmail(email) {
  const rows = await sbFetch('GET', 'users', `email=eq.${encodeURIComponent(email)}&limit=1`);
  return rows.length ? fromSbUser(rows[0]) : null;
}

async function dbUpdateUser(userData) {
  const rows = await sbFetch('PATCH', 'users', `id=eq.${userData.id}`, toSbUser(userData));
  return rows.length ? fromSbUser(rows[0]) : userData;
}

async function dbGetAllUsers() {
  const rows = await sbFetch('GET', 'users', 'order=created_at.desc');
  return rows.map(fromSbUser);
}

// ── Activities ────────────────────────────────────────────────
async function dbSaveActivity(actData) {
  const act = {
    ...actData,
    id: actData.id || crypto.randomUUID()
  };
  const rows = await sbFetch('POST', 'activities', '', toSbActivity(act));
  return rows[0] ? fromSbActivity(rows[0]).id : act.id;
}

async function dbGetActivitiesByUser(userId) {
  const rows = await sbFetch('GET', 'activities',
    `user_id=eq.${userId}&order=created_at.desc`
  );
  return rows.map(fromSbActivity);
}

async function dbGetAllActivities() {
  const rows = await sbFetch('GET', 'activities', 'order=created_at.desc');
  return rows.map(fromSbActivity);
}

async function dbDeleteActivity(actId) {
  await sbFetch('DELETE', 'activities', `id=eq.${actId}`);
  return true;
}

// ── Session (localStorage) ────────────────────────────────────
function sessionSet(user)  { localStorage.setItem('er_session', JSON.stringify(user)); }
function sessionGet()      { const d = localStorage.getItem('er_session'); return d ? JSON.parse(d) : null; }
function sessionClear()    { localStorage.removeItem('er_session'); }

// ── Hash password ─────────────────────────────────────────────
async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
