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
  // Check if this is a shared activity link
  if (window.location.hash.startsWith('#share/')) {
    showSharedActivity();
    return;
  }

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

  document.getElementById('dashGreeting').textContent = getGreeting() + ',';
  document.getElementById('profileEmail').textContent = currentUser.email;

  applyUserToUI(currentUser);
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

  // Update HUD pace label to match activity
  const paceLabel = document.getElementById('hudPaceLabel');
  if (paceLabel) {
    paceLabel.textContent = type === 'cycling' ? 'Speed' : 'Pace';
  }
  // Reset pace display
  const hudPace = document.getElementById('hudPace');
  if (hudPace) hudPace.textContent = type === 'cycling' ? '0.0' : '--:--';

  // Interval training: sembunyikan untuk walking (tidak relevan sprint jalan kaki)
  // Untuk cycling, interval masih bisa berguna (sprint bersepeda)
  const intervalSection = document.querySelector('.accordion-trigger');
  if (intervalSection) {
    if (type === 'walking') {
      intervalSection.style.display = 'none';
      // Tutup accordion & disable jika sedang aktif
      document.getElementById('intervalAccordion').classList.add('hidden');
      document.getElementById('accArrow').classList.remove('open');
      const intEnabled = document.getElementById('intEnabled');
      if (intEnabled) intEnabled.checked = false;
      document.getElementById('intervalInputs').classList.add('hidden');
    } else {
      intervalSection.style.display = '';
      // Update label target pace sesuai type
      const workPaceLabel = document.querySelector('.int-pace-wrap:first-child .int-pace-unit.muted');
      const restPaceLabel = document.querySelector('.int-pace-wrap:last-child .int-pace-unit.muted');
      if (type === 'cycling') {
        if (workPaceLabel) workPaceLabel.textContent = 'min/km (ekuivalen)';
        if (restPaceLabel) restPaceLabel.textContent = 'min/km (ekuivalen)';
        // Default values lebih cocok untuk cycling
        const workMin = document.getElementById('intWorkPaceMin');
        const restMin = document.getElementById('intRestPaceMin');
        if (workMin && workMin.value === '5') workMin.value = '3';
        if (restMin && restMin.value === '7') restMin.value = '5';
      } else {
        if (workPaceLabel) workPaceLabel.textContent = 'min/km';
        if (restPaceLabel) restPaceLabel.textContent = 'min/km';
        if (document.getElementById('intWorkPaceMin').value === '3') {
          document.getElementById('intWorkPaceMin').value = '5';
          document.getElementById('intRestPaceMin').value = '7';
        }
      }
    }
  }
}

// Helper: calories per km by activity type
function getCaloriesPerKm(type) {
  if (type === 'running') return 80;   // ~80 kal/km lari
  if (type === 'walking') return 50;   // ~50 kal/km jalan kaki
  if (type === 'cycling') return 30;   // ~30 kal/km bersepeda
  return 60;
}

// Helper: format speed in km/h
function formatSpeed(durationSec, distKm) {
  if (durationSec <= 0 || distKm <= 0) return '0.0';
  const kmh = (distKm / (durationSec / 3600));
  return kmh.toFixed(1);
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
  document.getElementById('hudPace').textContent = currentActivityType === 'cycling' ? '0.0' : '--:--';
  document.getElementById('hudCalories').textContent = '0';

  // Update pace/speed label
  const paceLabel = document.getElementById('hudPaceLabel');
  if (paceLabel) {
    paceLabel.textContent = currentActivityType === 'cycling' ? 'Speed' : 'Pace';
  }

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

  // Average Pace / Speed — depends on activity type
  const totalSecs = Math.floor(elapsedMs / 1000);
  if (km > 0 && totalSecs > 0) {
    if (currentActivityType === 'cycling') {
      // Cycling → tampilkan kecepatan km/h
      document.getElementById('hudPace').textContent = formatSpeed(totalSecs, km);
    } else {
      // Running & Walking → tampilkan pace min/km
      const paceMins = (totalSecs / 60) / km;
      const pM = Math.floor(paceMins);
      const pS = String(Math.floor((paceMins - pM) * 60)).padStart(2, '0');
      // Batas pace: running 2-20, walking 3-30 min/km
      const maxPace = currentActivityType === 'walking' ? 30 : 20;
      document.getElementById('hudPace').textContent = (pM < 2 || pM > maxPace) ? '--:--' : `${pM}:${pS}`;
    }
  }

  // Calories — berbeda per activity type
  document.getElementById('hudCalories').textContent = Math.floor(km * getCaloriesPerKm(currentActivityType));
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
  const intEnabled = document.getElementById('intEnabled');
  if (intEnabled) intEnabled.checked = false;
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

function toggleIntervalEnabled() {
  const enabled = document.getElementById('intEnabled').checked;
  document.getElementById('intervalInputs').classList.toggle('hidden', !enabled);
}

// Legacy stub — no longer used but keep to avoid reference errors
function toggleIntervalFields() {}

function initIntervalTracking() {
  const enabled = document.getElementById('intEnabled') && document.getElementById('intEnabled').checked;
  if (!enabled) {
    intervalConfig.mode = 'none';
    return;
  }

  intervalConfig.mode = 'distance';
  intervalConfig.work = parseFloat(document.getElementById('intWorkDist').value) || 400;
  intervalConfig.rest = parseFloat(document.getElementById('intRestDist').value) || 200;
  intervalConfig.cycles = parseInt(document.getElementById('intCycles').value) || 5;

  // Target paces in seconds per km
  const workPaceMin = parseInt(document.getElementById('intWorkPaceMin').value) || 5;
  const workPaceSec = parseInt(document.getElementById('intWorkPaceSec').value) || 30;
  intervalConfig.workTargetPace = workPaceMin * 60 + workPaceSec; // s/km

  const restPaceMin = parseInt(document.getElementById('intRestPaceMin').value) || 7;
  const restPaceSec = parseInt(document.getElementById('intRestPaceSec').value) || 0;
  intervalConfig.restTargetPace = restPaceMin * 60 + restPaceSec; // s/km

  intervalState.currentCycle = 1;
  intervalState.phase = 'work';
  intervalState.phaseElapsed = 0;
  intervalState.phaseStartDist = totalDistance;
  intervalState.lastPaceWarnTime = 0;
  intervalState.paceWarnCooldown = 12; // seconds between pace warnings

  document.getElementById('intervalHUD').classList.remove('hidden');
  updateIntervalHUD();

  // Announce start
  setTimeout(() => playSequence('start'), 600);
}

function processIntervalTick() {
  if (intervalConfig.mode === 'none' || isPaused) return;

  intervalState.phaseElapsed += 1;
  const traveled = totalDistance - intervalState.phaseStartDist;
  const target = intervalState.phase === 'work' ? intervalConfig.work : intervalConfig.rest;

  if (traveled >= target) {
    switchIntervalPhase();
  } else {
    // Pace monitoring — check every second but warn max every cooldown seconds
    checkPaceWarning();
  }

  updateIntervalHUD();
}

function checkPaceWarning() {
  if (intervalState.phaseElapsed < 8) return; // wait 8s before first check
  intervalState.lastPaceWarnTime = (intervalState.lastPaceWarnTime || 0) + 1;
  if (intervalState.lastPaceWarnTime < intervalState.paceWarnCooldown) return;

  const targetPace = intervalState.phase === 'work'
    ? intervalConfig.workTargetPace
    : intervalConfig.restTargetPace;

  // Current live pace from HUD (seconds per km)
  const paceText = document.getElementById('hudPace').textContent;
  if (!paceText || paceText === '--:--') return;

  const parts = paceText.split(':');
  if (parts.length < 2) return;
  const currentPaceSec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  if (isNaN(currentPaceSec) || currentPaceSec <= 0) return;

  const diff = currentPaceSec - targetPace; // positive = too slow, negative = too fast
  const tolerance = targetPace * 0.15; // 15% tolerance

  if (Math.abs(diff) > tolerance) {
    intervalState.lastPaceWarnTime = 0;
    const tooSlow = diff > 0;
    if (intervalState.phase === 'work') {
      playSequence(tooSlow ? 'paceUpWork' : 'paceDownWork');
      showToast(tooSlow ? '🔴 Too slow! Push harder!' : '🟡 Ease up a bit!');
      document.getElementById('hudPaceStatus').textContent = tooSlow ? '🔴 Speed up!' : '🟡 Slow down';
      document.getElementById('hudPaceStatus').className = tooSlow ? 'iv-pace-warn' : 'iv-pace-fast';
    } else {
      playSequence(tooSlow ? 'paceUpRest' : 'paceDownRest');
      showToast(tooSlow ? '🟡 Recover pace too slow' : '⚠️ Too fast during rest!');
      document.getElementById('hudPaceStatus').textContent = tooSlow ? '🟡 Pick up pace' : '⚠️ Slow down!';
      document.getElementById('hudPaceStatus').className = 'iv-pace-warn';
    }
  } else {
    document.getElementById('hudPaceStatus').textContent = '🎯 On pace';
    document.getElementById('hudPaceStatus').className = 'iv-pace-ok';
  }
}

function switchIntervalPhase() {
  if (intervalState.phase === 'work') {
    intervalState.phase = 'rest';
    intervalState.phaseElapsed = 0;
    intervalState.phaseStartDist = totalDistance;
    intervalState.lastPaceWarnTime = 0;
    playSequence('workDone');
    showToast(`✅ Set ${intervalState.currentCycle} done! 🟢 Rest now`);
  } else {
    if (intervalState.currentCycle >= intervalConfig.cycles) {
      // All sets complete!
      playSequence('allDone');
      showToast('🏁 All sets complete! Amazing work!');
      setTimeout(() => stopTracking(), 1500);
      return;
    }
    intervalState.currentCycle += 1;
    intervalState.phase = 'work';
    intervalState.phaseElapsed = 0;
    intervalState.phaseStartDist = totalDistance;
    intervalState.lastPaceWarnTime = 0;
    playSequence('setStart');
    showToast(`⚡ Set ${intervalState.currentCycle} — GO HARD!`);
  }
  document.getElementById('hudPaceStatus').textContent = '🎯 On pace';
  document.getElementById('hudPaceStatus').className = 'iv-pace-ok';
}

function updateIntervalHUD() {
  const hud = document.getElementById('intervalHUD');
  if (!hud) return;
  const isRest = intervalState.phase === 'rest';
  hud.classList.toggle('rest-phase', isRest);

  document.getElementById('hudPhaseName').textContent = isRest ? '🟢 REST' : '⚡ WORK';
  document.getElementById('hudCycleProgress').textContent =
    `Set ${intervalState.currentCycle} / ${intervalConfig.cycles}`;

  const target = isRest ? intervalConfig.rest : intervalConfig.work;
  const done = totalDistance - intervalState.phaseStartDist;
  const remaining = Math.max(0, target - done);
  document.getElementById('hudPhaseTarget').textContent = `${remaining.toFixed(0)}m left`;

  // Progress bar
  const pct = Math.min(100, (done / target) * 100);
  document.getElementById('ivProgressBar').style.width = pct + '%';
}

// ==================== RICH AUDIO ENGINE ====================
function playSequence(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const now = ctx.currentTime;

    const sequences = {
      // Work phase done → rest: 2 medium tones going down
      workDone: [
        { freq: 880, start: 0,    dur: 0.18, vol: 0.18, type: 'sine' },
        { freq: 660, start: 0.22, dur: 0.28, vol: 0.16, type: 'sine' },
      ],
      // Rest done → new set: 3 ascending energetic tones
      setStart: [
        { freq: 523, start: 0,    dur: 0.12, vol: 0.15, type: 'square' },
        { freq: 659, start: 0.15, dur: 0.12, vol: 0.17, type: 'square' },
        { freq: 880, start: 0.30, dur: 0.25, vol: 0.20, type: 'square' },
      ],
      // All sets done: triumphant 4-note fanfare
      allDone: [
        { freq: 523, start: 0,    dur: 0.15, vol: 0.18, type: 'sine' },
        { freq: 659, start: 0.18, dur: 0.15, vol: 0.18, type: 'sine' },
        { freq: 784, start: 0.36, dur: 0.15, vol: 0.18, type: 'sine' },
        { freq: 1047,start: 0.54, dur: 0.40, vol: 0.22, type: 'sine' },
      ],
      // Activity start: quick double beep
      start: [
        { freq: 660, start: 0,    dur: 0.12, vol: 0.14, type: 'sine' },
        { freq: 880, start: 0.16, dur: 0.20, vol: 0.16, type: 'sine' },
      ],
      // Pace too slow during work: rapid urgent tones
      paceUpWork: [
        { freq: 1200, start: 0,    dur: 0.08, vol: 0.14, type: 'sawtooth' },
        { freq: 1200, start: 0.12, dur: 0.08, vol: 0.14, type: 'sawtooth' },
        { freq: 1200, start: 0.24, dur: 0.08, vol: 0.14, type: 'sawtooth' },
      ],
      // Too fast during work: 2 descending tones
      paceDownWork: [
        { freq: 880, start: 0,    dur: 0.15, vol: 0.12, type: 'sine' },
        { freq: 660, start: 0.18, dur: 0.15, vol: 0.12, type: 'sine' },
      ],
      // Too slow during rest
      paceUpRest: [
        { freq: 700, start: 0,    dur: 0.15, vol: 0.10, type: 'sine' },
        { freq: 700, start: 0.20, dur: 0.15, vol: 0.10, type: 'sine' },
      ],
      // Too fast during rest: warning single tone
      paceDownRest: [
        { freq: 440, start: 0,    dur: 0.30, vol: 0.12, type: 'sine' },
      ],
    };

    const notes = sequences[type] || [];
    notes.forEach(n => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type || 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.start);
      gain.gain.setValueAtTime(0, now + n.start);
      gain.gain.linearRampToValueAtTime(n.vol, now + n.start + 0.02);
      gain.gain.setValueAtTime(n.vol, now + n.start + n.dur - 0.04);
      gain.gain.linearRampToValueAtTime(0, now + n.start + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.05);
    });
  } catch (e) {}
}

// Keep old playBeep for non-interval use
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

  // Tentukan metrik yang tampil sesuai activity type
  const isCycling = a.type === 'cycling';
  const metricVal = isCycling
    ? formatSpeed(a.duration, a.distance) + ' km/h'
    : formatPace(a.duration, a.distance) + '/km';
  const metricEmoji = isCycling ? '🚴' : a.type === 'walking' ? '🚶' : '🏃';

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
      <span>${metricEmoji} ${metricVal}</span>
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
    const isCycling = act.type === 'cycling';
    const isWalking = act.type === 'walking';
    const metricVal = isCycling
      ? formatSpeed(act.duration, act.distance)
      : (act.distance > 0 ? formatPace(act.duration, act.distance) : '--:--');
    const metricLbl = isCycling ? 'km/h' : 'pace';
    const dateStr = new Date(act.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    const typeEmoji = isCycling ? '🚴' : isWalking ? '🚶' : '🏃';

    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <div class="fc-header">
        <div>
          <div class="fc-type">${typeEmoji} ${act.type.charAt(0).toUpperCase() + act.type.slice(1)} Session</div>
          <div class="fc-date">${dateStr}</div>
        </div>
        <span class="fc-badge">${act.type}</span>
      </div>
      <div class="fc-stats">
        <div><div class="fc-stat-val">${act.distance.toFixed(2)}</div><div class="fc-stat-lbl">km</div></div>
        <div><div class="fc-stat-val">${mins}:${secs}</div><div class="fc-stat-lbl">time</div></div>
        <div><div class="fc-stat-val">${metricVal}</div><div class="fc-stat-lbl">${metricLbl}</div></div>
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

  _pendingShareActivity = { ...act, _username: currentUser.username };
  document.getElementById('shareModal').classList.remove('hidden');

  const mins = Math.floor(act.duration / 60);
  const secs = String(act.duration % 60).padStart(2, '0');
  const isCycling = act.type === 'cycling';
  const metricVal = isCycling
    ? formatSpeed(act.duration, act.distance)
    : (act.distance > 0 ? formatPace(act.duration, act.distance) : '--:--');
  const metricLbl = isCycling ? 'km/h' : 'Pace /km';

  const typeEmoji = act.type === 'cycling' ? '🚴' : act.type === 'walking' ? '🚶' : '🏃';
  const typeLabel = act.type.charAt(0).toUpperCase() + act.type.slice(1);
  const dateStr = new Date(act.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Populate new Strava-style card
  const typePill = document.getElementById('shareCardTypePill');
  if (typePill) typePill.textContent = `${typeEmoji} ${typeLabel}`;

  document.getElementById('shareCardTitle').textContent = `${typeLabel} Session`;
  document.getElementById('shareCardDate').textContent = `${dateStr} · by @${currentUser.username}`;
  document.getElementById('shareCardDist').textContent = act.distance.toFixed(2);
  document.getElementById('shareCardTime').textContent = `${mins}:${secs}`;
  document.getElementById('shareCardPace').textContent = metricVal;
  const paceLabel = document.getElementById('shareCardPaceLabel');
  if (paceLabel) paceLabel.textContent = metricLbl;

  // Generate shareable link
  const sharePayload = {
    u: currentUser.username,
    t: act.type,
    d: act.distance,
    dur: act.duration,
    cal: act.calories || 0,
    dt: act.createdAt,
    r: act.route && act.route.length > 0 ? act.route : []
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(sharePayload))));
  const shareURL = `${window.location.origin}${window.location.pathname}#share/${encoded}`;
  document.getElementById('shareLinkInput').value = shareURL;

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

function copyShareLink() {
  const input = document.getElementById('shareLinkInput');
  input.select();
  input.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('🔗 Link copied to clipboard!');
  }).catch(() => {
    document.execCommand('copy');
    showToast('🔗 Link copied!');
  });
}

async function shareActivity() {
  const url = document.getElementById('shareLinkInput').value;
  const act = _pendingShareActivity;
  if (!act) return;
  const text = `Check out my ${act.type} on RunFun! ${act.distance.toFixed(2)} km in ${Math.floor(act.duration/60)}:${String(act.duration%60).padStart(2,'0')} ⚡`;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'RunFun Activity', text, url });
    } catch (e) {
      if (e.name !== 'AbortError') copyShareLink();
    }
  } else {
    copyShareLink();
  }
}

// ==================== SHARED ACTIVITY VIEW ====================
function showSharedActivity() {
  try {
    const hash = window.location.hash.replace('#share/', '');
    const data = JSON.parse(decodeURIComponent(escape(atob(hash))));

    // Hide normal app screens
    document.getElementById('authScreen').classList.remove('active');
    document.getElementById('appScreen').classList.remove('active');

    const mins = Math.floor(data.dur / 60);
    const secs = String(data.dur % 60).padStart(2, '0');
    const isCycling = data.t === 'cycling';
    const metricVal = isCycling
      ? formatSpeed(data.dur, data.d)
      : (data.d > 0 ? formatPace(data.dur, data.d) : '--:--');
    const metricLbl = isCycling ? 'km/h' : 'pace /km';
    const dateStr = new Date(data.dt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const typeLabel = data.t.charAt(0).toUpperCase() + data.t.slice(1);
    const typeEmoji = data.t === 'cycling' ? '🚴' : data.t === 'walking' ? '🚶' : '🏃';

    const view = document.getElementById('sharedActivityView');
    view.classList.remove('hidden');

    document.getElementById('sharedType').textContent = `${typeEmoji} ${typeLabel} Session`;
    document.getElementById('sharedUser').textContent = `by @${data.u}`;
    document.getElementById('sharedDate').textContent = dateStr;
    document.getElementById('sharedDist').textContent = data.d.toFixed(2);
    document.getElementById('sharedTime').textContent = `${mins}:${secs}`;
    document.getElementById('sharedPace').textContent = metricVal;
    document.getElementById('sharedCal').textContent = data.cal;
    // Update label
    const sharedPaceLbl = document.getElementById('sharedPaceLabel');
    if (sharedPaceLbl) sharedPaceLbl.textContent = metricLbl;

    // Init map for shared view
    setTimeout(() => {
      const sharedMap = L.map('sharedMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(sharedMap);
      const routeLayer = L.polyline([], { color: '#3DD2CC', weight: 5 }).addTo(sharedMap);

      if (data.r && data.r.length > 1) {
        routeLayer.setLatLngs(data.r);
        L.circleMarker(data.r[0], { color: '#CBF9DA', radius: 6, fillOpacity: 1 }).addTo(sharedMap);
        L.circleMarker(data.r[data.r.length - 1], { color: '#3DD2CC', radius: 6, fillOpacity: 1 }).addTo(sharedMap);
        sharedMap.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
      } else {
        sharedMap.setView([-6.2, 106.816], 13);
        document.getElementById('sharedMapWrap').innerHTML = '<div class="shared-no-route">📍 Route not available</div>';
      }
    }, 300);
  } catch (e) {
    document.getElementById('sharedActivityView').classList.remove('hidden');
    document.getElementById('sharedActivityView').innerHTML = `
      <div class="shared-error">
        <span style="font-size:3rem">⚠️</span>
        <h2>Invalid Link</h2>
        <p>This share link appears to be broken or expired.</p>
        <a href="${window.location.pathname}" class="btn-neon" style="display:block;margin-top:20px;text-align:center;padding:14px;border-radius:14px;color:#0c1b26;font-weight:700;background:linear-gradient(135deg,#3DD2CC,#2ec4be);text-decoration:none">Open RunFun</a>
      </div>
    `;
  }
}

function closeShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
}

async function downloadShareCard() {
  const act = _pendingShareActivity;
  if (!act) return;
  showToast('⏳ Generating card...');

  try {
    const W = 800, H = 600;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // ── Background ──
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, W, H);

    // ── Map screenshot (if route exists) ──
    let mapImgDrawn = false;
    if (act.route && act.route.length > 1) {
      try {
        // Render map to canvas using Leaflet map element
        const mapEl = document.getElementById('shareLeafletMap');
        const mapCanvas = await html2canvas(mapEl, {
          useCORS: true, allowTaint: true, backgroundColor: '#0a0f14',
          scale: 1, logging: false
        });
        // Draw map in top portion (56%)
        const mapH = Math.round(H * 0.56);
        ctx.drawImage(mapCanvas, 0, 0, W, mapH);

        // Gradient overlay bottom of map
        const grad = ctx.createLinearGradient(0, mapH - 80, 0, mapH);
        grad.addColorStop(0, 'rgba(26,26,26,0)');
        grad.addColorStop(1, 'rgba(26,26,26,1)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, mapH - 80, W, 80);
        mapImgDrawn = true;
      } catch (e) { /* fall through to no-map design */ }
    }

    // If no map, draw a pattern background
    if (!mapImgDrawn) {
      ctx.fillStyle = '#111111';
      ctx.fillRect(0, 0, W, H * 0.56);
      // grid lines
      ctx.strokeStyle = 'rgba(61,210,204,0.05)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H * 0.56); ctx.stroke(); }
      for (let y = 0; y <= H * 0.56; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      // "No Route" label
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.font = '700 14px DM Sans, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('📍 Route not recorded', W / 2, H * 0.28);
      ctx.textAlign = 'left';

      const grad = ctx.createLinearGradient(0, H * 0.46, 0, H * 0.56);
      grad.addColorStop(0, 'rgba(26,26,26,0)');
      grad.addColorStop(1, 'rgba(26,26,26,1)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, H * 0.46, W, H * 0.1);
    }

    // ── Info area ──
    const infoY = Math.round(H * 0.56);
    const pad = 48;

    // Activity type pill
    const typeEmoji = act.type === 'cycling' ? '🚴' : act.type === 'walking' ? '🚶' : '🏃';
    const typeLabel = act.type.charAt(0).toUpperCase() + act.type.slice(1);
    ctx.save();
    ctx.fillStyle = 'rgba(61,210,204,0.12)';
    const pillW = 120, pillH = 28, pillR = 14;
    ctx.beginPath();
    ctx.roundRect(pad, infoY + 18, pillW, pillH, pillR);
    ctx.fill();
    ctx.strokeStyle = 'rgba(61,210,204,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#3DD2CC';
    ctx.font = '700 12px DM Sans, sans-serif';
    ctx.fillText(`${typeEmoji} ${typeLabel.toUpperCase()}`, pad + 14, infoY + 18 + 18);
    ctx.restore();

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 30px DM Sans, sans-serif';
    ctx.fillText(`${typeLabel} Session`, pad, infoY + 78);

    // Date + username
    const dateStr = new Date(act.createdAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '400 14px DM Sans, sans-serif';
    ctx.fillText(`${dateStr}  ·  @${_pendingShareActivity._username || 'athlete'}`, pad, infoY + 104);

    // Divider
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, infoY + 120);
    ctx.lineTo(W - pad, infoY + 120);
    ctx.stroke();

    // Stats - three columns
    const statsY = infoY + 150;
    const colW = (W - pad * 2) / 3;
    const isCycling = act.type === 'cycling';
    const mins = Math.floor(act.duration / 60);
    const secs = String(act.duration % 60).padStart(2, '0');
    const paceVal = isCycling ? formatSpeed(act.duration, act.distance) : (act.distance > 0 ? formatPace(act.duration, act.distance) : '--:--');
    const paceLbl = isCycling ? 'SPEED' : 'PACE /km';

    const stats = [
      { val: act.distance.toFixed(2), lbl: 'DISTANCE (KM)', neon: true },
      { val: `${mins}:${secs}`, lbl: 'TIME', neon: false },
      { val: paceVal, lbl: paceLbl, neon: false }
    ];

    stats.forEach((s, i) => {
      const x = pad + i * colW;
      // Value
      ctx.fillStyle = s.neon ? '#3DD2CC' : '#ffffff';
      ctx.font = '700 36px "Space Mono", monospace';
      ctx.fillText(s.val, x, statsY);
      // Label
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '600 11px DM Sans, sans-serif';
      ctx.letterSpacing = '1px';
      ctx.fillText(s.lbl, x, statsY + 22);
    });

    // Divider before brand
    const brandY = H - 52;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, brandY - 10);
    ctx.lineTo(W - pad, brandY - 10);
    ctx.stroke();

    // Brand logo box
    ctx.fillStyle = '#3DD2CC';
    ctx.beginPath();
    ctx.roundRect(pad, brandY, 28, 28, 6);
    ctx.fill();
    ctx.fillStyle = '#0c1b26';
    ctx.font = '900 13px DM Sans, sans-serif';
    ctx.fillText('R', pad + 9, brandY + 19);

    // Brand name
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 15px DM Sans, sans-serif';
    ctx.fillText('RunFun', pad + 38, brandY + 19);

    // Tagline right
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '400 12px DM Sans, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Push Your Limits', W - pad, brandY + 19);
    ctx.textAlign = 'left';

    // ── Download ──
    const link = document.createElement('a');
    link.download = `RunFun_${act.type}_${new Date(act.createdAt).toISOString().slice(0,10)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('✅ Card downloaded!');
  } catch (err) {
    console.error(err);
    showToast('❌ Download failed. Try again.');
  }
}

function formatPace(durationSec, distKm) {
  const paceMin = (durationSec / 60) / distKm;
  if (paceMin < 2 || paceMin > 30) return '--:--';
  const m = Math.floor(paceMin);
  const s = String(Math.floor((paceMin - m) * 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// ==================== EDIT PROFILE ====================
let _epSelectedColor = null;
let _epPhotoDataUrl = null;

function openEditProfile() {
  const u = currentUser;
  document.getElementById('epUsername').value = u.username || '';
  document.getElementById('epName').value = u.name || u.username || '';
  document.getElementById('epBio').value = u.bio || '';
  document.getElementById('epCurrentPw').value = '';
  document.getElementById('epNewPw').value = '';
  document.getElementById('epConfirmPw').value = '';
  document.getElementById('epError').textContent = '';
  document.getElementById('epPwSection').classList.add('hidden');
  document.getElementById('epPwArrow').classList.remove('open');

  // Reset photo upload state
  _epPhotoDataUrl = u.avatarPhoto || null;
  _epSelectedColor = u.avatarColor || '#3DD2CC';

  // Sync color picker selection
  document.querySelectorAll('.ep-color-dot').forEach(dot => {
    dot.classList.toggle('selected', dot.dataset.color === _epSelectedColor);
  });

  // Update preview
  refreshEpPreview();

  document.getElementById('editProfileModal').classList.remove('hidden');
}

function closeEditProfile() {
  document.getElementById('editProfileModal').classList.add('hidden');
  _epPhotoDataUrl = null;
}

function selectAvatarColor(btn) {
  _epSelectedColor = btn.dataset.color;
  _epPhotoDataUrl = null; // clear photo when picking color
  document.querySelectorAll('.ep-color-dot').forEach(d => d.classList.remove('selected'));
  btn.classList.add('selected');
  refreshEpPreview();
}

function handleAvatarPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('⚠️ Photo too large (max 2MB)');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    _epPhotoDataUrl = e.target.result;
    document.querySelectorAll('.ep-color-dot').forEach(d => d.classList.remove('selected'));
    refreshEpPreview();
  };
  reader.readAsDataURL(file);
}

function refreshEpPreview() {
  const preview = document.getElementById('epAvatarPreview');
  const initial = (document.getElementById('epUsername').value || currentUser.username || 'A').charAt(0).toUpperCase();

  if (_epPhotoDataUrl) {
    preview.style.backgroundImage = `url(${_epPhotoDataUrl})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.textContent = '';
  } else {
    preview.style.backgroundImage = '';
    preview.style.color = _epSelectedColor || '#3DD2CC';
    preview.textContent = initial;
  }
}

// Live preview initial letter as user types
document.addEventListener('DOMContentLoaded', () => {
  const usernameInput = document.getElementById('epUsername');
  if (usernameInput) {
    usernameInput.addEventListener('input', () => {
      if (!_epPhotoDataUrl) refreshEpPreview();
    });
  }
});

function toggleChangePassword() {
  const section = document.getElementById('epPwSection');
  const arrow = document.getElementById('epPwArrow');
  section.classList.toggle('hidden');
  arrow.classList.toggle('open');
}

async function saveProfile() {
  const errEl = document.getElementById('epError');
  errEl.textContent = '';

  const newUsername = document.getElementById('epUsername').value.trim();
  const newName = document.getElementById('epName').value.trim();
  const bio = document.getElementById('epBio').value.trim();

  if (!newUsername) return errEl.textContent = 'Username cannot be empty.';
  if (newUsername.length < 3) return errEl.textContent = 'Username must be at least 3 characters.';

  // Handle password change
  const currentPw = document.getElementById('epCurrentPw').value;
  const newPw = document.getElementById('epNewPw').value;
  const confirmPw = document.getElementById('epConfirmPw').value;
  const isPwSectionOpen = !document.getElementById('epPwSection').classList.contains('hidden');

  if (isPwSectionOpen && (currentPw || newPw || confirmPw)) {
    if (!currentPw) return errEl.textContent = 'Enter your current password.';
    const hashedCurrent = await hashPassword(currentPw);
    if (hashedCurrent !== currentUser.password) return errEl.textContent = 'Current password is incorrect.';
    if (newPw.length < 6) return errEl.textContent = 'New password must be at least 6 characters.';
    if (newPw !== confirmPw) return errEl.textContent = 'Passwords do not match.';
  }

  // Build updated user object
  const updatedUser = {
    ...currentUser,
    username: newUsername,
    name: newName || newUsername,
    bio,
    avatar: newUsername.charAt(0).toUpperCase(),
    avatarColor: _epSelectedColor || currentUser.avatarColor || '#3DD2CC',
    avatarPhoto: _epPhotoDataUrl || null,
  };

  if (isPwSectionOpen && newPw && newPw === confirmPw) {
    updatedUser.password = await hashPassword(newPw);
  }

  // Save to IndexedDB (update user record)
  try {
    await dbUpdateUser(updatedUser);
    currentUser = updatedUser;
    sessionSet(updatedUser);

    // Refresh all UI
    applyUserToUI(updatedUser);
    closeEditProfile();
    showToast('✅ Profile updated!');
  } catch (e) {
    errEl.textContent = 'Failed to save. Try again.';
  }
}

function applyUserToUI(u) {
  const initial = u.avatar || u.username.charAt(0).toUpperCase();
  const color = u.avatarColor || '#3DD2CC';

  // Helper to set avatar element
  function setAvatar(el) {
    if (!el) return;
    if (u.avatarPhoto) {
      el.style.backgroundImage = `url(${u.avatarPhoto})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.color = 'transparent';
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      el.style.color = color;
      el.textContent = initial;
    }
  }

  setAvatar(document.getElementById('dashAvatar'));
  setAvatar(document.getElementById('profileAvatar'));

  document.getElementById('dashName').textContent = u.username;
  document.getElementById('profileName').textContent = u.username;
  document.getElementById('profileEmail').textContent = u.email;

  if (u.bio) {
    let bioEl = document.getElementById('profileBio');
    if (bioEl) bioEl.textContent = u.bio;
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