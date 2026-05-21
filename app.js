// ============================================================
//   RunFun 2.0 – Mobile-First Engine
//   All features: Auth, GPS Track, Intervals, Dashboard,
//   History Feed, Share Card, Profile
// ============================================================

let currentUser = null;
let map = null;
let routeLayer = null;
let markerStart = null;
let markerCurrent = null;
let watchId = null;
let trackPoints = [];
let timerInterval = null;
let startTime = null;
let elapsedMs = 0;
let isPaused = false;
let pausedAt = 0;
let currentActivityType = 'running';
let lastPosition = null;
let totalDistance = 0;
let _pendingShareActivity = null;
let shareMapInstance = null;
let shareRouteLayer = null;

// Interval Training State
let intervalConfig = { mode: 'none', work: 0, rest: 0, cycles: 0 };
let intervalState = { currentCycle: 1, phase: 'work', phaseElapsed: 0, phaseStartDist: 0 };
let audioCtx = null;

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  const session = sessionGet();
  if (session) {
    currentUser = session;
    launchApp();
  }
});

// ==================== AUTH ====================
function switchAuth(mode) {
  document.querySelectorAll('.tab-pill').forEach((t, i) => {
    t.classList.toggle('active', (mode === 'login' && i === 0) || (mode === 'register' && i === 1));
  });
  document.getElementById('loginForm').classList.toggle('active', mode === 'login');
  document.getElementById('registerForm').classList.toggle('active', mode === 'register');
  document.getElementById('loginError').textContent = '';
  document.getElementById('registerError').textContent = '';
}

async function handleRegister() {
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const password = document.getElementById('regPassword').value;
  const errEl = document.getElementById('registerError');
  errEl.textContent = '';

  if (!username || !email || !password) return errEl.textContent = 'Please fill all fields.';
  if (password.length < 6) return errEl.textContent = 'Password must be at least 6 characters.';

  try {
    const existing = await dbGetUserByEmail(email);
    if (existing) return errEl.textContent = 'Email already registered.';
    const hashed = await hashPassword(password);
    const user = await dbCreateUser({
      name: username, username, email,
      password: hashed,
      favoriteActivity: 'running',
      avatar: username.charAt(0).toUpperCase()
    });
    currentUser = user;
    sessionSet(user);
    showToast('✅ Account created. Let\'s go!');
    launchApp();
  } catch (err) {
    errEl.textContent = 'Registration failed. Try again.';
  }
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (!email || !password) return errEl.textContent = 'Enter email and password.';

  try {
    const user = await dbGetUserByEmail(email);
    if (!user) return errEl.textContent = 'Email not found.';
    const hashed = await hashPassword(password);
    if (user.password !== hashed) return errEl.textContent = 'Incorrect password.';
    currentUser = user;
    sessionSet(user);
    showToast('⚡ Welcome back!');
    launchApp();
  } catch (err) {
    errEl.textContent = 'Login failed.';
  }
}

function handleLogout() {
  if (watchId) stopTracking();
  sessionClear();
  currentUser = null;
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('authScreen').classList.add('active');
  showToast('Logged out.');
}

function launchApp() {
  document.getElementById('authScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');

  const initial = currentUser.avatar || currentUser.username.charAt(0).toUpperCase();
  const uname = currentUser.username;

  document.getElementById('dashName').textContent = uname;
  document.getElementById('dashAvatar').textContent = initial;
  document.getElementById('dashGreeting').textContent = getGreeting() + ',';
  document.getElementById('profileName').textContent = uname;
  document.getElementById('profileEmail').textContent = currentUser.email;
  document.getElementById('profileAvatar').textContent = initial;

  initLiveMap();
  switchTab('dashboard');
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ==================== NAVIGATION ====================
function switchTab(tabId) {
  // Update bubble nav
  document.querySelectorAll('.nav-bubble').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === tabId);
  });

  // Switch pages
  document.querySelectorAll('.page').forEach(p => {
    const id = p.id.replace('page', '').toLowerCase();
    p.classList.toggle('active', id === tabId);
  });

  // Load data
  if (tabId === 'dashboard') loadDashboardData();
  if (tabId === 'history') loadHistoryFeed();
  if (tabId === 'profile') loadProfileData();
  if (tabId === 'track' && map) {
    setTimeout(() => map.invalidateSize(), 250);
  }
}

// ==================== MAP ====================
function initLiveMap() {
  if (map) return;
  map = L.map('liveMap', { zoomControl: false }).setView([-6.2, 106.816], 13);
  L.control.zoom({ position: 'topright' }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap & CARTO'
  }).addTo(map);

  routeLayer = L.polyline([], { color: '#3DD2CC', weight: 5, opacity: 0.9 }).addTo(map);
}

// ==================== ACTIVITY TYPE ====================
function setActivityType(type) {
  currentActivityType = type;
  document.querySelectorAll('.pill').forEach(p => {
    p.classList.toggle('active', p.id === `pill${type.charAt(0).toUpperCase() + type.slice(1)}`);
  });
}

// ==================== TRACKING ====================
function startTracking() {
  if (watchId) return;

  trackPoints = [];
  totalDistance = 0;
  elapsedMs = 0;
  isPaused = false;
  lastPosition = null;
  startTime = Date.now();

  document.getElementById('hudDistance').textContent = '0.00';
  document.getElementById('hudTimer').textContent = '00:00:00';
  document.getElementById('hudPace').textContent = '--:--';
  document.getElementById('hudCalories').textContent = '0';

  // Init interval if configured
  initIntervalTracking();

  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(onGpsUpdate, onGpsError, {
      enableHighAccuracy: true, maximumAge: 1000
    });
  }

  timerInterval = setInterval(updateTimer, 1000);

  // UI: hide setup sheet, show HUD
  document.getElementById('trackSetup').classList.add('slide-away');
  document.getElementById('trackHUD').classList.remove('hidden');
  document.getElementById('btnPause').classList.remove('hidden');
  document.getElementById('btnResume').classList.add('hidden');

  showToast('⚡ Tracking started!');
}

function updateTimer() {
  if (isPaused) return;
  elapsedMs = Date.now() - startTime;

  const t = Math.floor(elapsedMs / 1000);
  const hh = String(Math.floor(t / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  document.getElementById('hudTimer').textContent = `${hh}:${mm}:${ss}`;

  processIntervalTick();
}

function onGpsUpdate(position) {
  if (isPaused) return;
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  const ll = [lat, lng];

  trackPoints.push(ll);
  routeLayer.setLatLngs(trackPoints);

  if (!markerStart && trackPoints.length > 0) {
    markerStart = L.circleMarker(trackPoints[0], { color: '#CBF9DA', radius: 6 }).addTo(map);
  }
  if (!markerCurrent) {
    markerCurrent = L.circleMarker(ll, { color: '#3DD2CC', radius: 8, fillOpacity: 0.9 }).addTo(map);
  } else {
    markerCurrent.setLatLng(ll);
  }
  map.setView(ll, 16);

  if (lastPosition) {
    const delta = map.distance(lastPosition, ll);
    if (delta > 2 && delta < 50) totalDistance += delta;
  }
  lastPosition = ll;

  const km = totalDistance / 1000;
  document.getElementById('hudDistance').textContent = km.toFixed(2);

  // Average Pace
  const totalSecs = Math.floor(elapsedMs / 1000);
  if (km > 0 && totalSecs > 0) {
    const paceMins = (totalSecs / 60) / km;
    const pM = Math.floor(paceMins);
    const pS = String(Math.floor((paceMins - pM) * 60)).padStart(2, '0');
    document.getElementById('hudPace').textContent = pM < 2 ? '--:--' : `${pM}:${pS}`;
  }

  // Calories estimate
  const burnRate = currentActivityType === 'cycling' ? 12 : 16;
  document.getElementById('hudCalories').textContent = Math.floor(km * burnRate);
}

function onGpsError(err) { console.warn('GPS:', err); }

function pauseTracking() {
  isPaused = true;
  pausedAt = Date.now();
  document.getElementById('btnPause').classList.add('hidden');
  document.getElementById('btnResume').classList.remove('hidden');
  showToast('⏸ Paused');
}

function resumeTracking() {
  isPaused = false;
  startTime += (Date.now() - pausedAt);
  document.getElementById('btnResume').classList.add('hidden');
  document.getElementById('btnPause').classList.remove('hidden');
  showToast('🏃 Resumed');
}

async function stopTracking() {
  clearInterval(timerInterval);
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }

  if (markerStart) { map.removeLayer(markerStart); markerStart = null; }
  if (markerCurrent) { map.removeLayer(markerCurrent); markerCurrent = null; }
  routeLayer.setLatLngs([]);

  const km = totalDistance / 1000;
  const durSec = Math.floor(elapsedMs / 1000);

  if (km > 0.02) {
    await dbSaveActivity({
      userId: currentUser.id,
      type: currentActivityType,
      distance: parseFloat(km.toFixed(2)),
      duration: durSec,
      calories: parseInt(document.getElementById('hudCalories').textContent) || 0,
      route: trackPoints,
      createdAt: new Date().toISOString()
    });
    showToast('✅ Activity saved!');
  } else {
    showToast('⚠️ Too short. Discarded.');
  }

  // Reset UI
  document.getElementById('trackSetup').classList.remove('slide-away');
  document.getElementById('trackHUD').classList.add('hidden');
  document.getElementById('intervalHUD').classList.add('hidden');
  document.getElementById('intMode').value = 'none';
  document.getElementById('intervalInputs').classList.add('hidden');
  intervalConfig.mode = 'none';

  switchTab('history');
}

// ==================== INTERVAL TRAINING ====================
function toggleIntervalAccordion() {
  const body = document.getElementById('intervalAccordion');
  const arrow = document.getElementById('accArrow');
  body.classList.toggle('hidden');
  arrow.classList.toggle('open');
}

function toggleIntervalFields() {
  const mode = document.getElementById('intMode').value;
  const inputs = document.getElementById('intervalInputs');
  if (mode === 'none') {
    inputs.classList.add('hidden');
  } else {
    inputs.classList.remove('hidden');
    document.getElementById('lblWork').textContent = mode === 'time' ? 'Work (s)' : 'Work (m)';
    document.getElementById('lblRest').textContent = mode === 'time' ? 'Rest (s)' : 'Rest (m)';
  }
}

function initIntervalTracking() {
  const mode = document.getElementById('intMode').value;
  intervalConfig.mode = mode;
  if (mode !== 'none') {
    intervalConfig.work = parseFloat(document.getElementById('intWork').value) || 60;
    intervalConfig.rest = parseFloat(document.getElementById('intRest').value) || 90;
    intervalConfig.cycles = parseInt(document.getElementById('intCycles').value) || 5;
    intervalState.currentCycle = 1;
    intervalState.phase = 'work';
    intervalState.phaseElapsed = 0;
    intervalState.phaseStartDist = totalDistance;
    document.getElementById('intervalHUD').classList.remove('hidden');
    updateIntervalHUD();
  }
}

function processIntervalTick() {
  if (intervalConfig.mode === 'none' || isPaused) return;

  if (intervalConfig.mode === 'time') {
    intervalState.phaseElapsed += 1;
    const target = intervalState.phase === 'work' ? intervalConfig.work : intervalConfig.rest;
    if (intervalState.phaseElapsed >= target) switchIntervalPhase();
  } else if (intervalConfig.mode === 'distance') {
    const traveled = totalDistance - intervalState.phaseStartDist;
    const target = intervalState.phase === 'work' ? intervalConfig.work : intervalConfig.rest;
    if (traveled >= target) switchIntervalPhase();
  }
  updateIntervalHUD();
}

function switchIntervalPhase() {
  if (intervalState.phase === 'work') {
    intervalState.phase = 'rest';
    playBeep(440);
    showToast('🟢 Recovery! Slow down.');
  } else {
    if (intervalState.currentCycle >= intervalConfig.cycles) {
      playBeep(880);
      showToast('🏁 Intervals complete!');
      stopTracking();
      return;
    }
    intervalState.currentCycle += 1;
    intervalState.phase = 'work';
    playBeep(880);
    showToast(`⚡ Set ${intervalState.currentCycle}: Go hard!`);
  }
  intervalState.phaseElapsed = 0;
  intervalState.phaseStartDist = totalDistance;
}

function updateIntervalHUD() {
  const hud = document.getElementById('intervalHUD');
  if (!hud) return;
  hud.classList.toggle('rest-phase', intervalState.phase === 'rest');
  document.getElementById('hudPhaseName').textContent =
    intervalState.phase === 'work' ? '⚡ WORK' : '🟢 REST';
  document.getElementById('hudCycleProgress').textContent =
    `Set ${intervalState.currentCycle} / ${intervalConfig.cycles}`;

  const el = document.getElementById('hudPhaseTarget');
  if (intervalConfig.mode === 'time') {
    const max = intervalState.phase === 'work' ? intervalConfig.work : intervalConfig.rest;
    el.textContent = `${Math.max(0, max - intervalState.phaseElapsed)}s left`;
  } else {
    const max = intervalState.phase === 'work' ? intervalConfig.work : intervalConfig.rest;
    const done = totalDistance - intervalState.phaseStartDist;
    el.textContent = `${Math.max(0, max - done).toFixed(0)}m left`;
  }
}

function playBeep(freq) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  } catch (e) {}
}

// ==================== DASHBOARD ====================
async function loadDashboardData() {
  const acts = await dbGetActivitiesByUser(currentUser.id);
  let distSum = 0, timeSum = 0, calSum = 0;
  acts.forEach(a => {
    distSum += a.distance;
    timeSum += a.duration;
    calSum += (a.calories || 0);
  });

  document.getElementById('dashDist').textContent = distSum.toFixed(2);
  document.getElementById('dashCount').textContent = acts.length;
  document.getElementById('dashCals').textContent = calSum;

  const h = Math.floor(timeSum / 3600);
  const m = Math.floor((timeSum % 3600) / 60);
  document.getElementById('dashTime').textContent =
    h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`;

  // Weekly chart
  renderWeeklyChart(acts);

  // Recent activity
  renderRecentActivity(acts);
}

function renderWeeklyChart(acts) {
  const chart = document.getElementById('weeklyChart');
  const labels = document.getElementById('weeklyLabels');
  chart.innerHTML = '';
  labels.innerHTML = '';

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const dayData = Array(7).fill(0);

  // Fill last 7 days
  acts.forEach(a => {
    const d = new Date(a.createdAt);
    const diff = Math.floor((today - d) / 86400000);
    if (diff >= 0 && diff < 7) {
      dayData[6 - diff] += a.distance;
    }
  });

  const maxVal = Math.max(...dayData, 1);

  for (let i = 0; i < 7; i++) {
    const dayIndex = (today.getDay() - 6 + i + 7) % 7;
    const pct = (dayData[i] / maxVal) * 100;

    const bar = document.createElement('div');
    bar.style.cssText = `
      flex:1; border-radius:6px 6px 0 0;
      background: ${dayData[i] > 0 ? 'linear-gradient(180deg, #3DD2CC, #2bb8b3)' : 'rgba(62,107,137,0.2)'};
      height: ${Math.max(4, pct)}%;
      transition: height 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
      min-height: 4px;
    `;
    bar.title = `${dayData[i].toFixed(2)} km`;
    chart.appendChild(bar);

    const lbl = document.createElement('span');
    lbl.textContent = dayNames[dayIndex];
    lbl.style.flex = '1';
    lbl.style.textAlign = 'center';
    labels.appendChild(lbl);
  }
}

function renderRecentActivity(acts) {
  const el = document.getElementById('recentActivity');
  if (acts.length === 0) {
    el.innerHTML = '<span class="empty-icon">🏃</span><p>No activities yet. Lace up and start running!</p>';
    el.className = 'recent-empty';
    return;
  }

  const a = acts[0]; // most recent
  const mins = Math.floor(a.duration / 60);
  const secs = String(a.duration % 60).padStart(2, '0');
  const pace = a.distance > 0 ? formatPace(a.duration, a.distance) : '--:--';
  const dateStr = new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  el.className = '';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div>
        <div style="font-weight:700;font-size:1rem">${a.type.charAt(0).toUpperCase() + a.type.slice(1)}</div>
        <div style="font-size:0.78rem;color:var(--muted)">${dateStr}</div>
      </div>
      <span style="font-family:var(--mono);font-size:1.3rem;font-weight:700;color:var(--neon)">${a.distance.toFixed(2)} km</span>
    </div>
    <div style="display:flex;gap:16px;font-size:0.82rem;color:var(--muted)">
      <span>⏱ ${mins}:${secs}</span>
      <span>🏃 ${pace}/km</span>
      <span>🔥 ${a.calories || 0} cal</span>
    </div>
  `;
}

// ==================== HISTORY ====================
async function loadHistoryFeed() {
  const feed = document.getElementById('historyFeed');
  feed.innerHTML = '';
  const acts = await dbGetActivitiesByUser(currentUser.id);

  if (acts.length === 0) {
    feed.innerHTML = `
      <div class="recent-empty" style="padding:48px 0">
        <span class="empty-icon">📜</span>
        <p>No activities yet. Start your first session!</p>
      </div>`;
    return;
  }

  acts.forEach(act => {
    const mins = Math.floor(act.duration / 60);
    const secs = String(act.duration % 60).padStart(2, '0');
    const pace = act.distance > 0 ? formatPace(act.duration, act.distance) : '--:--';
    const dateStr = new Date(act.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <div class="fc-header">
        <div>
          <div class="fc-type">${act.type.charAt(0).toUpperCase() + act.type.slice(1)} Session</div>
          <div class="fc-date">${dateStr}</div>
        </div>
        <span class="fc-badge">${act.type}</span>
      </div>
      <div class="fc-stats">
        <div><div class="fc-stat-val">${act.distance.toFixed(2)}</div><div class="fc-stat-lbl">km</div></div>
        <div><div class="fc-stat-val">${mins}:${secs}</div><div class="fc-stat-lbl">time</div></div>
        <div><div class="fc-stat-val">${pace}</div><div class="fc-stat-lbl">pace</div></div>
      </div>
      <div class="fc-actions">
        <button class="fc-btn share" onclick="openShareModal(${act.id})">🔗 Share</button>
        <button class="fc-btn delete" onclick="deleteAct(${act.id})">🗑 Delete</button>
      </div>
    `;
    feed.appendChild(card);
  });
}

async function deleteAct(id) {
  if (confirm('Delete this activity permanently?')) {
    await dbDeleteActivity(id);
    showToast('🗑 Deleted');
    loadHistoryFeed();
  }
}

// ==================== PROFILE ====================
async function loadProfileData() {
  const acts = await dbGetActivitiesByUser(currentUser.id);
  let dist = 0, cals = 0;
  acts.forEach(a => { dist += a.distance; cals += (a.calories || 0); });

  document.getElementById('profDist').textContent = dist.toFixed(2);
  document.getElementById('profRuns').textContent = acts.length;
  document.getElementById('profCals').textContent = cals;
}

// ==================== SHARE MODAL ====================
async function openShareModal(actId) {
  const acts = await dbGetActivitiesByUser(currentUser.id);
  const act = acts.find(a => a.id === actId);
  if (!act) return;

  _pendingShareActivity = act;
  document.getElementById('shareModal').classList.remove('hidden');

  const mins = Math.floor(act.duration / 60);
  const secs = String(act.duration % 60).padStart(2, '0');
  const pace = act.distance > 0 ? formatPace(act.duration, act.distance) : '--:--';

  document.getElementById('shareCardTitle').textContent =
    `${act.type.charAt(0).toUpperCase() + act.type.slice(1)} Session`;
  document.getElementById('shareCardDate').textContent =
    new Date(act.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('shareCardDist').textContent = act.distance.toFixed(2);
  document.getElementById('shareCardTime').textContent = `${mins}:${secs}`;
  document.getElementById('shareCardPace').textContent = pace;

  setTimeout(() => {
    if (!shareMapInstance) {
      shareMapInstance = L.map('shareLeafletMap', { zoomControl: false, attributionControl: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(shareMapInstance);
      shareRouteLayer = L.polyline([], { color: '#3DD2CC', weight: 6 }).addTo(shareMapInstance);
    }
    if (act.route && act.route.length > 0) {
      shareRouteLayer.setLatLngs(act.route);
      shareMapInstance.fitBounds(shareRouteLayer.getBounds(), { padding: [20, 20] });
    } else {
      shareMapInstance.setView([-6.2, 106.816], 13);
    }
    shareMapInstance.invalidateSize();
  }, 200);
}

function closeShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
}

async function downloadShareCard() {
  const card = document.getElementById('shareCard');
  showToast('⏳ Rendering card...');
  try {
    const canvas = await html2canvas(card, {
      useCORS: true, backgroundColor: '#0c1b26', scale: 2
    });
    const link = document.createElement('a');
    link.download = `RunFun_${_pendingShareActivity.id}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('✅ Downloaded!');
  } catch (err) {
    showToast('❌ Render failed.');
  }
}

// ==================== UTILITIES ====================
function formatPace(durationSec, distKm) {
  const paceMin = (durationSec / 60) / distKm;
  if (paceMin < 2 || paceMin > 30) return '--:--';
  const m = Math.floor(paceMin);
  const s = String(Math.floor((paceMin - m) * 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => toast.classList.add('hidden'), 3200);
}