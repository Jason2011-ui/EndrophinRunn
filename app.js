// ============================================================
//   EndorphinRun – APP.JS
// ============================================================

let currentUser   = null;
let map           = null;
let routeLayer    = null;
let markerStart   = null;
let markerCurrent = null;
let watchId       = null;
let trackPoints   = [];
let elevPoints    = [];
let timerInterval = null;
let startTime     = null;
let elapsedMs     = 0;
let isPaused      = false;
let pausedAt      = 0;
let currentActivityType = 'running';
let lastPosition  = null;
let totalDistance = 0; // meters
let activityData  = null; // pending save

// ============================================================
//  BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  const session = sessionGet();
  if (session) {
    currentUser = session;
    launchApp();
  }
});

// ============================================================
//  AUTH
// ============================================================
function switchAuth(mode) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => {
    t.classList.toggle('active', (mode==='login' && i===0) || (mode==='register' && i===1));
  });
  document.getElementById('loginForm').classList.toggle('active', mode === 'login');
  document.getElementById('registerForm').classList.toggle('active', mode === 'register');
  document.getElementById('loginError').textContent = '';
  document.getElementById('regError').textContent   = '';
}

async function ensureDB() {
  if (!db) await initDB();
}

async function handleRegister() {
  const name     = document.getElementById('regName').value.trim();
  const username = document.getElementById('regUsername').value.trim().replace('@','');
  const email    = document.getElementById('regEmail').value.trim().toLowerCase();
  const password = document.getElementById('regPassword').value;
  const activity = document.getElementById('regActivity').value;
  const errEl    = document.getElementById('regError');

  errEl.textContent = '';

  if (!name || !username || !email || !password) return errEl.textContent = 'Semua field wajib diisi.';
  if (password.length < 6)                        return errEl.textContent = 'Password minimal 6 karakter.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errEl.textContent = 'Format email tidak valid.';
  if (!/^[a-zA-Z0-9_]+$/.test(username))          return errEl.textContent = 'Username hanya huruf, angka, dan underscore.';

  try {
    await ensureDB();

    const existing = await dbGetUserByEmail(email);
    if (existing) return errEl.textContent = 'Email sudah terdaftar. Silakan login.';

    const hashed = await hashPassword(password);
    const user   = await dbCreateUser({
      name, username, email,
      password: hashed,
      favoriteActivity: activity,
      avatar: name[0].toUpperCase()
    });
    currentUser = user;
    sessionSet(user);
    showToast('🎉 Akun berhasil dibuat! Selamat datang, ' + name + '!');
    launchApp();
  } catch (err) {
    console.error('Register error:', err);
    if (err && err.name === 'ConstraintError') {
      errEl.textContent = 'Email atau username sudah digunakan.';
    } else {
      errEl.textContent = 'Registrasi gagal. Coba lagi.';
    }
  }
}

async function handleLogin() {
  const email    = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');

  errEl.textContent = '';

  if (!email || !password) return errEl.textContent = 'Isi email dan password.';

  try {
    await ensureDB();

    const user = await dbGetUserByEmail(email);
    if (!user) return errEl.textContent = 'Email tidak ditemukan.';

    const hashed = await hashPassword(password);
    if (user.password !== hashed) return errEl.textContent = 'Password salah.';

    currentUser = user;
    sessionSet(user);
    showToast('👋 Selamat datang kembali, ' + user.name + '!');
    launchApp();
  } catch (err) {
    console.error('Login error:', err);
    errEl.textContent = 'Login gagal. Coba lagi.';
  }
}

function handleLogout() {
  stopTracking(true);
  sessionClear();
  currentUser = null;
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('authOverlay').classList.add('active');
  showToast('Sampai jumpa! 👋');
}

// ============================================================
//  APP LAUNCH
// ============================================================
function launchApp() {
  document.getElementById('authOverlay').classList.remove('active');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('navUsername').textContent = '@' + currentUser.username;
  document.getElementById('navAvatar').textContent   = currentUser.avatar || currentUser.name[0].toUpperCase();
  document.getElementById('heroName').textContent    = currentUser.name.toUpperCase();
  showPage('dashboard');
  initMap();
}

// ============================================================
//  NAVIGATION
// ============================================================
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const link = document.querySelector(`[data-page="${page}"]`);
  if (link) link.classList.add('active');

  if (page === 'dashboard')    loadDashboard();
  if (page === 'activities')   loadActivities('all');
  if (page === 'leaderboard')  loadLeaderboard('km');
  if (page === 'community')    loadCommunity();
}

function toggleMenu() {
  document.getElementById('mobileMenu').classList.toggle('open');
}

// ============================================================
//  MAP INIT (Leaflet + OpenStreetMap)
// ============================================================
function initMap() {
  if (map) return;
  // Default: Bandung
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([-6.9175, 107.6191], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  L.control.attribution({ prefix: false }).addTo(map);

  routeLayer = L.polyline([], {
    color: '#FF4D00',
    weight: 4,
    opacity: 0.9,
    lineJoin: 'round'
  }).addTo(map);

  // Try to center on user
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 16);
      updateMapOverlay(pos.coords);
    }, () => {}, { enableHighAccuracy: true });
  }
}

// ============================================================
//  GPS TRACKER
// ============================================================
function selectActivity(btn, type) {
  document.querySelectorAll('.act-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentActivityType = type;
}

// Smoothing buffer untuk Kalman-like filter
let smoothLat = null, smoothLng = null;
let lastGpsSpeed = 0;
let lastElevation = 0;
const SMOOTH_FACTOR = 0.3; // 0=no smooth, 1=no update

function startTracking() {
  if (!navigator.geolocation) {
    showToast('⚠️ GPS tidak tersedia di perangkat ini.');
    return;
  }

  trackPoints   = [];
  elevPoints    = [];
  totalDistance = 0;
  lastPosition  = null;
  smoothLat     = null;
  smoothLng     = null;
  lastGpsSpeed  = 0;
  lastElevation = 0;
  isPaused      = false;
  startTime     = Date.now();
  elapsedMs     = 0;

  routeLayer.setLatLngs([]);
  if (markerStart)   { map.removeLayer(markerStart);   markerStart   = null; }
  if (markerCurrent) { map.removeLayer(markerCurrent); markerCurrent = null; }

  updateGpsStatus('searching', 'Mencari sinyal GPS…');
  document.getElementById('btnStart').classList.add('hidden');
  document.getElementById('btnPause').classList.remove('hidden');
  document.getElementById('btnStop').classList.remove('hidden');

  // Timer update setiap detik — juga update pace/speed terus menerus
  timerInterval = setInterval(() => {
    updateTimer();
    updateLiveStats(); // update pace & speed tiap detik
  }, 1000);

  const gpsOptions = {
    enableHighAccuracy: true,
    maximumAge:         1000,  // terima cache max 1 detik
    timeout:            20000  // lebih toleran
  };

  watchId = navigator.geolocation.watchPosition(onGpsUpdate, onGpsError, gpsOptions);
}

function onGpsUpdate(position) {
  const { latitude: lat, longitude: lng, accuracy, altitude, speed } = position.coords;

  // Selalu update overlay dan status meskipun sedang pause
  updateMapOverlay(position.coords);
  updateGpsStatus('active', `Akurasi ±${Math.round(accuracy)}m`);

  if (isPaused) return;

  // Simpan kecepatan GPS mentah (m/s → km/h)
  if (speed != null && speed >= 0) {
    lastGpsSpeed = speed * 3.6;
  }
  if (altitude != null) lastElevation = Math.round(altitude);

  // --- SMOOTHING: exponential moving average ---
  if (smoothLat === null) {
    smoothLat = lat;
    smoothLng = lng;
  } else {
    smoothLat = smoothLat * SMOOTH_FACTOR + lat * (1 - SMOOTH_FACTOR);
    smoothLng = smoothLng * SMOOTH_FACTOR + lng * (1 - SMOOTH_FACTOR);
  }

  const latlng = [smoothLat, smoothLng];

  // Toleransi akurasi lebih longgar: 100m
  // Tapi semakin buruk akurasi, semakin besar threshold jarak minimum
  const minDist = accuracy > 30 ? 5 : 3; // meter

  if (lastPosition === null) {
    // Titik pertama
    trackPoints.push(latlng);
    elevPoints.push(altitude || 0);
    lastPosition = latlng;

    markerStart = L.circleMarker(latlng, {
      radius: 9, color: '#00FF87', fillColor: '#00FF87', fillOpacity: 1, weight: 2
    }).bindPopup('🚦 Start').addTo(map);
    map.setView(latlng, 17);
    return;
  }

  const d = haversine(lastPosition[0], lastPosition[1], smoothLat, smoothLng);

  if (d >= minDist) {
    // Cek kecepatan tidak realistis (max 60 km/h untuk lari/trail)
    // untuk cycling boleh sampai 80 km/h
    const maxSpeedKmh = ['cycling'].includes(currentActivityType) ? 80 : 30;
    const timeSinceLast = (Date.now() - startTime - elapsedMs); // kasar
    const impliedSpeed  = (d / 1000) / ((1 / 3600)); // sangat kasar, skip check ini
    // Hanya tolak jika akurasi sangat buruk DAN jarak loncat sangat jauh
    if (accuracy > 80 && d > 100) {
      console.warn('GPS spike diabaikan: d=' + d.toFixed(0) + 'm, acc=' + accuracy.toFixed(0) + 'm');
      return;
    }

    totalDistance += d;
    trackPoints.push(latlng);
    elevPoints.push(altitude || lastElevation);
    lastPosition = latlng;

    routeLayer.addLatLng(latlng);
    map.panTo(latlng, { animate: true, duration: 0.5 });

    // Update marker posisi
    if (markerCurrent) map.removeLayer(markerCurrent);
    markerCurrent = L.circleMarker(latlng, {
      radius: 10, color: '#FF4D00', fillColor: '#FF4D00', fillOpacity: 1, weight: 2
    }).addTo(map);

    drawElevationChart();
    updateLiveStats();
  }
}

function updateLiveStats() {
  if (!startTime || isPaused) return;
  const km   = totalDistance / 1000;
  const secs = elapsedMs / 1000;

  // Speed: prioritaskan GPS speed, fallback ke average speed
  let spd = lastGpsSpeed > 0 ? lastGpsSpeed : (secs > 0 ? km / (secs / 3600) : 0);

  // Pace: dari speed langsung (lebih akurat daripada avg)
  let pace = spd > 0.5 ? 60 / spd : 0; // min/km

  const cal  = estimateCalories(km, currentActivityType);

  document.getElementById('lsDistance').textContent  = km.toFixed(2);
  document.getElementById('lsSpeed').textContent     = spd.toFixed(1);
  document.getElementById('lsPace').textContent      = pace > 0 ? formatPace(pace) : '--:--';
  document.getElementById('lsCalories').textContent  = Math.round(cal);
  document.getElementById('lsElevation').textContent = lastElevation;
}

function onGpsError(err) {
  const msgs = {
    1: 'Izin GPS ditolak. Aktifkan lokasi di browser.',
    2: 'Posisi tidak tersedia. Pastikan GPS aktif.',
    3: 'GPS timeout. Mencoba ulang…'
  };
  const msg = msgs[err.code] || 'GPS Error: ' + err.message;
  updateGpsStatus('error', msg);
  showToast('⚠️ ' + msg);
}

function pauseTracking() {
  isPaused = !isPaused;
  const btn = document.getElementById('btnPause');
  if (isPaused) {
    pausedAt = Date.now();
    btn.textContent = '▶ Lanjut';
    updateGpsStatus('paused', 'Dijeda');
    clearInterval(timerInterval);
  } else {
    elapsedMs += (Date.now() - pausedAt);
    startTime  = Date.now() - elapsedMs;
    btn.textContent = '⏸ Pause';
    updateGpsStatus('active', 'Berjalan…');
    timerInterval = setInterval(updateTimer, 1000);
  }
}

async function stopTracking(silent = false) {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  clearInterval(timerInterval);

  document.getElementById('btnStart').classList.remove('hidden');
  document.getElementById('btnPause').classList.add('hidden');
  document.getElementById('btnStop').classList.add('hidden');
  document.getElementById('btnPause').textContent = '⏸ Pause';

  updateGpsStatus('idle', 'GPS Siap');
  isPaused = false;

  if (silent || totalDistance < 10) {
    resetTrackerUI();
    return;
  }

  const km  = totalDistance / 1000;
  const cal = estimateCalories(km, currentActivityType);
  const dur = formatDuration(elapsedMs);

  activityData = {
    userId:       currentUser.id,
    type:         currentActivityType,
    distance:     parseFloat(km.toFixed(3)),
    duration:     elapsedMs,
    durationFmt:  dur,
    calories:     Math.round(cal),
    route:        trackPoints,
    elevations:   elevPoints,
    avgSpeed:     elapsedMs > 0 ? parseFloat((km / (elapsedMs / 3600000)).toFixed(2)) : 0,
  };

  document.getElementById('saveDist').textContent = km.toFixed(2);
  document.getElementById('saveTime').textContent = dur;
  document.getElementById('saveCal').textContent  = Math.round(cal);
  document.getElementById('activityTitle').value  = defaultTitle(currentActivityType);
  document.getElementById('activityNote').value   = '';
  document.getElementById('saveModal').classList.remove('hidden');
}

async function saveActivity() {
  const title = document.getElementById('activityTitle').value.trim() || defaultTitle(currentActivityType);
  const note  = document.getElementById('activityNote').value.trim();

  activityData.title = title;
  activityData.note  = note;

  const saved = await dbSaveActivity(activityData);

  // Update user totals
  const updUser = await dbUpdateUser(currentUser.id, {
    totalKm:         (currentUser.totalKm         || 0) + activityData.distance,
    totalActivities: (currentUser.totalActivities || 0) + 1,
    totalCalories:   (currentUser.totalCalories   || 0) + activityData.calories
  });
  currentUser = updUser;
  sessionSet(updUser);

  document.getElementById('saveModal').classList.add('hidden');
  showToast('✅ Aktivitas "' + title + '" berhasil disimpan!');
  resetTrackerUI();
  showPage('activities');
}

function discardActivity() {
  activityData = null;
  document.getElementById('saveModal').classList.add('hidden');
  resetTrackerUI();
  showToast('Aktivitas dibuang.');
}

function resetTrackerUI() {
  document.getElementById('lsDistance').textContent  = '0.00';
  document.getElementById('lsDuration').textContent  = '00:00:00';
  document.getElementById('lsPace').textContent      = '--:--';
  document.getElementById('lsSpeed').textContent     = '0.0';
  document.getElementById('lsCalories').textContent  = '0';
  document.getElementById('lsElevation').textContent = '0';
  totalDistance = 0;
  elapsedMs     = 0;
  startTime     = null;
  trackPoints   = [];
  elevPoints    = [];
  smoothLat     = null;
  smoothLng     = null;
  lastGpsSpeed  = 0;
  lastElevation = 0;
  lastPosition  = null;
  routeLayer.setLatLngs([]);
  if (markerStart)   { map.removeLayer(markerStart);   markerStart   = null; }
  if (markerCurrent) { map.removeLayer(markerCurrent); markerCurrent = null; }
  clearElevCanvas();
}

// ============================================================
//  TIMER
// ============================================================
function updateTimer() {
  elapsedMs = Date.now() - startTime;
  document.getElementById('lsDuration').textContent = formatDuration(elapsedMs);
}

// ============================================================
//  DASHBOARD
// ============================================================
async function loadDashboard() {
  const activities = await dbGetActivitiesByUser(currentUser.id);

  const totalKm  = activities.reduce((s, a) => s + (a.distance || 0), 0);
  const totalCal = activities.reduce((s, a) => s + (a.calories || 0), 0);

  document.getElementById('hsTotalKm').textContent  = totalKm.toFixed(1);
  document.getElementById('hsTotalAct').textContent = activities.length;
  document.getElementById('hsTotalCal').textContent = Math.round(totalCal);

  renderWeekChart(activities);
  renderRecentActivities(activities.slice(0, 5));
  renderAchievements(activities, totalKm);
}

function renderWeekChart(activities) {
  const days = ['Sen','Sel','Rab','Kam','Jum','Sab','Min'];
  const now  = new Date();
  const weekKm = Array(7).fill(0);

  activities.forEach(a => {
    const d    = new Date(a.createdAt);
    const diff = Math.floor((now - d) / 86400000);
    if (diff < 7) {
      const dayIdx = (d.getDay() + 6) % 7; // Mon=0
      weekKm[dayIdx] += a.distance || 0;
    }
  });

  const maxKm = Math.max(...weekKm, 1);
  const chart = document.getElementById('weekChart');
  chart.innerHTML = weekKm.map((km, i) => {
    const h = Math.max((km / maxKm) * 100, 2);
    return `<div class="bar-wrap">
      <div class="bar-val">${km.toFixed(1)}</div>
      <div class="bar" style="height:${h}%" title="${days[i]}: ${km.toFixed(1)}km">
        <div class="bar-inner"></div>
      </div>
    </div>`;
  }).join('');
}

function renderRecentActivities(activities) {
  const el = document.getElementById('recentActivities');
  if (!activities.length) {
    el.innerHTML = '<div class="empty-state">Belum ada aktivitas. Ayo mulai track pertamamu! 🚀</div>';
    return;
  }
  el.innerHTML = activities.map(a => activityCard(a, false)).join('');
}

function renderAchievements(activities, totalKm) {
  const badges = [
    { icon:'🥉', name:'First Step',      desc:'Selesaikan 1 aktivitas',   done: activities.length >= 1 },
    { icon:'🥈', name:'Getting Started', desc:'Selesaikan 5 aktivitas',   done: activities.length >= 5 },
    { icon:'🥇', name:'Dedicated',       desc:'Selesaikan 10 aktivitas',  done: activities.length >= 10 },
    { icon:'🌟', name:'Marathon Ready',  desc:'Selesaikan 20 aktivitas',  done: activities.length >= 20 },
    { icon:'🏃', name:'5K Club',         desc:'Total 5km',                done: totalKm >= 5 },
    { icon:'🔥', name:'10K Club',        desc:'Total 10km',               done: totalKm >= 10 },
    { icon:'💪', name:'Half Century',    desc:'Total 50km',               done: totalKm >= 50 },
    { icon:'🏆', name:'Century Rider',   desc:'Total 100km',              done: totalKm >= 100 },
    { icon:'⛰️', name:'Trail Blazer',    desc:'Lakukan trail run',        done: activities.some(a => a.type === 'trail') },
    { icon:'🚴', name:'Cyclist',         desc:'Lakukan cycling',          done: activities.some(a => a.type === 'cycling') },
  ];

  document.getElementById('achievementsGrid').innerHTML = badges.map(b => `
    <div class="badge-item ${b.done ? 'earned' : 'locked'}">
      <div class="badge-icon">${b.done ? b.icon : '🔒'}</div>
      <div class="badge-name">${b.name}</div>
      <div class="badge-desc">${b.desc}</div>
    </div>
  `).join('');
}

// ============================================================
//  ACTIVITIES PAGE
// ============================================================
async function loadActivities(filter) {
  const activities = await dbGetActivitiesByUser(currentUser.id);
  filterActivities(filter, document.querySelector('.filter-btn.active'), activities);
}

async function filterActivities(type, btn, preloaded) {
  if (btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  const activities = preloaded || await dbGetActivitiesByUser(currentUser.id);
  const filtered   = type === 'all' ? activities : activities.filter(a => a.type === type);
  const el         = document.getElementById('allActivitiesList');

  if (!filtered.length) {
    el.innerHTML = '<div class="empty-state">Tidak ada aktivitas untuk filter ini.</div>';
    return;
  }
  el.innerHTML = filtered.map(a => activityCard(a, true)).join('');
}

async function deleteActivity(id) {
  if (!confirm('Hapus aktivitas ini?')) return;
  await dbDeleteActivity(id);

  // Recalculate user totals
  const allActs = await dbGetActivitiesByUser(currentUser.id);
  const totalKm  = allActs.reduce((s, a) => s + (a.distance || 0), 0);
  const totalCal = allActs.reduce((s, a) => s + (a.calories || 0), 0);
  const updUser  = await dbUpdateUser(currentUser.id, {
    totalKm, totalActivities: allActs.length, totalCalories: totalCal
  });
  currentUser = updUser;
  sessionSet(updUser);

  showToast('🗑️ Aktivitas dihapus.');
  loadActivities('all');
}

function activityCard(a, showDelete) {
  const icons = { running:'🏃', cycling:'🚴', trail:'⛰️', hiking:'🥾', walking:'🚶' };
  const icon  = icons[a.type] || '🏅';
  const date  = new Date(a.createdAt).toLocaleDateString('id-ID', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  return `
    <div class="activity-card">
      <div class="ac-icon">${icon}</div>
      <div class="ac-body">
        <div class="ac-title">${a.title || defaultTitle(a.type)}</div>
        <div class="ac-meta">
          <span>📅 ${date}</span>
          <span>🛣️ ${(a.distance||0).toFixed(2)} km</span>
          <span>⏱ ${a.durationFmt || '--'}</span>
          <span>🔥 ${a.calories || 0} kkal</span>
          ${a.avgSpeed ? `<span>💨 ${a.avgSpeed} km/h</span>` : ''}
        </div>
        ${a.note ? `<div class="ac-note">"${a.note}"</div>` : ''}
      </div>
      ${showDelete ? `<button class="btn-delete" onclick="deleteActivity(${a.id})">🗑️</button>` : ''}
    </div>`;
}

// ============================================================
//  LEADERBOARD
// ============================================================
async function loadLeaderboard(metric, btn) {
  if (btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  const users = await dbGetAllUsers();
  const acts  = await dbGetAllActivities();

  // Compute per-user stats
  const stats = users.map(u => {
    const uActs = acts.filter(a => a.userId === u.id);
    return {
      name:       u.name,
      username:   u.username,
      avatar:     u.avatar || u.name[0].toUpperCase(),
      km:         parseFloat(uActs.reduce((s,a) => s + (a.distance||0), 0).toFixed(2)),
      activities: uActs.length,
      calories:   Math.round(uActs.reduce((s,a) => s + (a.calories||0), 0))
    };
  });

  stats.sort((a, b) => b[metric] - a[metric]);

  const medals = ['🥇','🥈','🥉'];
  document.getElementById('leaderboardList').innerHTML = stats.map((s, i) => `
    <div class="lb-item ${s.username === currentUser.username ? 'me' : ''}">
      <div class="lb-rank">${medals[i] || '#' + (i+1)}</div>
      <div class="lb-avatar">${s.avatar}</div>
      <div class="lb-info">
        <div class="lb-name">${s.name} ${s.username === currentUser.username ? '(Kamu)' : ''}</div>
        <div class="lb-meta">@${s.username} · ${s.activities} aktivitas</div>
      </div>
      <div class="lb-val">
        ${metric === 'km'         ? s.km + ' km' : ''}
        ${metric === 'activities' ? s.activities + ' aktivitas' : ''}
        ${metric === 'calories'   ? s.calories + ' kkal' : ''}
      </div>
    </div>
  `).join('') || '<div class="empty-state">Belum ada data.</div>';
}

// ============================================================
//  COMMUNITY
// ============================================================
async function loadCommunity() {
  const users = await dbGetAllUsers();
  const acts  = await dbGetAllActivities();

  const totalKm  = acts.reduce((s,a) => s + (a.distance||0), 0);
  const totalCal = acts.reduce((s,a) => s + (a.calories||0), 0);

  document.getElementById('csMembers').textContent  = users.length;
  document.getElementById('csTotalKm').textContent  = totalKm.toFixed(0);
  document.getElementById('csTotalAct').textContent = acts.length;
  document.getElementById('csTotalCal').textContent = Math.round(totalCal);

  const recent = [...users].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,8);
  const actIcons = { running:'🏃', cycling:'🚴', trail:'⛰️', hiking:'🥾', walking:'🚶' };
  document.getElementById('membersList').innerHTML = recent.map(u => `
    <div class="member-item">
      <div class="member-avatar">${u.avatar || u.name[0].toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">${u.name}</div>
        <div class="member-sub">@${u.username} · ${actIcons[u.favoriteActivity]||'🏅'} ${u.favoriteActivity}</div>
      </div>
      <div class="member-km">${(u.totalKm||0).toFixed(1)} km</div>
    </div>
  `).join('') || '<div class="empty-state">Jadilah yang pertama bergabung!</div>';
}

// ============================================================
//  GPS HELPERS
// ============================================================
function updateGpsStatus(state, text) {
  const dot = document.getElementById('gpsDot');
  dot.className = 'gps-dot ' + state;
  document.getElementById('gpsText').textContent = text;
}

function updateMapOverlay(coords) {
  document.getElementById('mapLat').textContent = coords.latitude.toFixed(6);
  document.getElementById('mapLng').textContent = coords.longitude.toFixed(6);
  document.getElementById('mapAcc').textContent = Math.round(coords.accuracy || 0);
}

// Haversine formula – returns distance in meters
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function toRad(d) { return d * Math.PI / 180; }

// ============================================================
//  ELEVATION CHART
// ============================================================
function drawElevationChart() {
  const canvas = document.getElementById('elevCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (elevPoints.length < 2) return;

  const min = Math.min(...elevPoints);
  const max = Math.max(...elevPoints, min + 1);
  const range = max - min;
  const pts = elevPoints.map((e, i) => ({
    x: (i / (elevPoints.length - 1)) * w,
    y: h - ((e - min) / range) * (h - 10) - 5
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, h);
  ctx.lineTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length-1].x, h);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,77,0,0.7)');
  grad.addColorStop(1, 'rgba(255,77,0,0.05)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = '#FF4D00';
  ctx.lineWidth   = 2;
  ctx.stroke();
}

function clearElevCanvas() {
  const canvas = document.getElementById('elevCanvas');
  if (canvas) canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
}

// ============================================================
//  UTILITIES
// ============================================================
function estimateCalories(km, type) {
  const mets = { running:9, cycling:6, trail:10, hiking:7, walking:4 };
  const met  = mets[type] || 7;
  const weightKg = 65; // default
  return (met * weightKg * (km / 10));
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function formatPace(paceMinPerKm) {
  const m = Math.floor(paceMinPerKm);
  const s = Math.round((paceMinPerKm - m) * 60);
  return `${m}:${pad(s)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function defaultTitle(type) {
  const hour = new Date().getHours();
  const time = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const labels = { running:'Run', cycling:'Ride', trail:'Trail Run', hiking:'Hike', walking:'Walk' };
  return `${time} ${labels[type] || 'Activity'}`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 400); }, 3000);
}
