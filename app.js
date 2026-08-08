// ---------------- config ----------------
// Replace with your own project's values (Settings > API in the Supabase dashboard).
const SUPABASE_URL = "https://esltdwmzcpulytqcfmlx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_0qXemKbL6Z9bX7Hoc__nYQ_dIt0Hgbv";

// Shared Supabase client, used for both the edge function calls and auth
// (relies on the supabase-js UMD build loaded in index.html before this file).
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// ---------------- history (Supabase-backed) ----------------
// Sessions are stored per-user in the `sessions` table (see README for the
// SQL / RLS policies). Since generating a quiz already requires login, every
// saved session is guaranteed to have a user attached.

function mapRow(row){
  return {
    id: row.id,
    topic: row.topic,
    timestamp: new Date(row.created_at).getTime(),
    total: row.total,
    correctCount: row.correct_count,
    blindspots: row.blindspots,
    answers: row.answers
  };
}

async function refreshHistory(){
  if(!state.user){
    state.history = [];
    return;
  }
  state.historyLoading = true;
  state.historyError = null;
  try{
    const { data, error } = await supabaseClient
      .from('sessions')
      .select('id, topic, total, correct_count, blindspots, answers, created_at')
      .order('created_at', { ascending: false });
    if(error) throw error;
    state.history = (data || []).map(mapRow);
  }catch(e){
    console.error('Failed to load history:', e.message);
    state.historyError = e.message || 'Failed to load history.';
    state.history = [];
  }
  state.historyLoading = false;
}

async function saveSession(){
  const total = state.answers.length;
  const correctCount = state.answers.filter(a => a.correct).length;
  const blindspots = state.answers.filter(a => !a.correct && a.confidence >= 4).length;
  const topic = state.source.length > 48 ? state.source.slice(0,48) + '\u2026' : state.source;

  state.historyError = null;
  try{
    const { error } = await supabaseClient.from('sessions').insert({
      user_id: state.user.id,
      topic,
      total,
      correct_count: correctCount,
      blindspots,
      answers: state.answers
    });
    if(error) throw error;
  }catch(e){
    console.error('Failed to save session:', e.message);
    state.historyError = e.message || 'Failed to save this session.';
  }
  await refreshHistory();
}

async function clearHistory(){
  if(!state.user) return;
  try{
    const { error } = await supabaseClient.from('sessions').delete().eq('user_id', state.user.id);
    if(error) throw error;
  }catch(e){
    console.error('Failed to clear history:', e.message);
  }
  await refreshHistory();
  renderSidebar();
}

function getViewingSession(){
  return state.history.find(h => h.id === state.viewingSessionId);
}

function renderSidebar(){
  const toggle = document.getElementById('sidebar-toggle');
  const overlay = document.getElementById('history-overlay');
  const panel = document.getElementById('history-panel');
  if(!toggle || !overlay || !panel) return;

  const hideOnScreens = ['home', 'login', 'signup', 'forgot'];
  const onHiddenScreen = hideOnScreens.includes(state.screen);
  toggle.style.display = onHiddenScreen ? 'none' : 'flex';
  if(onHiddenScreen){
    overlay.classList.remove('open');
    panel.classList.remove('open');
    toggle.classList.remove('shifted');
    document.body.classList.remove('sidebar-open');
    return;
  }

  toggle.classList.toggle('shifted', state.sidebarOpen);
  overlay.classList.toggle('open', state.sidebarOpen);
  panel.classList.toggle('open', state.sidebarOpen);
  document.body.classList.toggle('sidebar-open', state.sidebarOpen);

  panel.innerHTML = `
    <div class="hist-head">History</div>
    <div class="hist-sub">${state.historyLoading ? 'Loading\u2026' : `${state.history.length} saved session${state.history.length===1?'':'s'}`}</div>
    ${state.historyError ? `<div class="hist-empty" style="color:var(--rust);">Couldn't sync history: ${state.historyError}</div>` : ''}
    <button class="hist-new" id="hist-new-btn">+ New session</button>
    <div class="hist-list">
      ${state.historyLoading
        ? `<div class="hist-empty">Loading your saved sessions\u2026</div>`
        : state.history.length === 0
          ? `<div class="hist-empty">Finish a quiz and it'll show up here, so you can revisit past blind spots.</div>`
          : state.history.map(h => `
            <button class="hist-item" data-session="${h.id}">
              <div class="h-topic">${h.topic || 'Untitled session'}</div>
              <div class="h-meta">
                <span>${h.correctCount}/${h.total} correct</span>
                <span class="${h.blindspots ? 'h-flag' : ''}">${h.blindspots} blind spot${h.blindspots===1?'':'s'}</span>
              </div>
            </button>
          `).join('')
      }
    </div>
    ${!state.historyLoading && state.history.length ? `<button class="hist-clear" id="clear-history-btn">Clear history</button>` : ''}
  `;

  toggle.onclick = () => { state.sidebarOpen = !state.sidebarOpen; renderSidebar(); };
  overlay.onclick = () => { state.sidebarOpen = false; renderSidebar(); };

  const newBtn = document.getElementById('hist-new-btn');
  if(newBtn) newBtn.onclick = () => {
    Object.assign(state, {
      source:'', count:6, attachments:[], questions:[], current:0,
      answers:[], selectedOpt:null, selectedConf:null, revealed:false, error:null,
      sidebarOpen: window.innerWidth > 900
    });
    requireAuthThen('setup');
    render();
  };

  panel.querySelectorAll('.hist-item').forEach(btn => {
    btn.onclick = () => {
      state.viewingSessionId = btn.dataset.session;
      state.screen = 'session';
      state.sidebarOpen = window.innerWidth > 900;
      render();
    };
  });
  const clearBtn = document.getElementById('clear-history-btn');
  if(clearBtn) clearBtn.onclick = () => { clearHistory(); };
}
// ---------------- state ----------------
const MAX_ATTACHMENTS = 6;

const state = {
  screen: 'home', // home | login | signup | forgot | update-password | setup | loading | quiz | results | session
  user: null,          // set by auth.js once a session is known
  authChecked: false,  // true once the initial session check has resolved
  authError: null,
  authLoading: false,
  signupConfirmMessage: null,
  resetSentMessage: null,
  redirectAfterAuth: null, // screen to jump to once login/signup succeeds
  source: '',
  count: 6,
  attachments: [],
  questions: [],
  current: 0,
  answers: [],
  selectedOpt: null,
  selectedConf: null,
  revealed: false,
  error: null,
  sidebarOpen: false,
  history: [],           // loaded from Supabase once a user is known, see history.js
  historyLoading: false,
  historyError: null,
  viewingSessionId: null
};
// ---------------- auth ----------------
// Thin wrapper around Supabase Auth. Keeps state.user (and the per-user
// history list) in sync, and re-renders whenever auth state changes
// (login, logout, token refresh, password recovery).

async function initAuth(){
  const { data } = await supabaseClient.auth.getSession();
  state.user = data.session ? data.session.user : null;
  state.authChecked = true;
  if(state.user) await refreshHistory();

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if(event === 'PASSWORD_RECOVERY'){
      // User followed the reset-password link from their email.
      state.screen = 'update-password';
      render();
      return;
    }
    const nextUser = session ? session.user : null;
    const userChanged = (nextUser && nextUser.id) !== (state.user && state.user.id);
    state.user = nextUser;
    if(userChanged) await refreshHistory();
    render();
  });
}

async function signUp(email, password){
  state.authLoading = true;
  state.authError = null;
  render();
  try{
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if(error) throw error;
    state.authLoading = false;
    if(!data.session){
      // Email confirmation is on for this project — no session yet.
      state.authError = null;
      state.screen = 'login';
      state.signupConfirmMessage = 'Check your inbox to confirm your email, then log in.';
    } else {
      state.user = data.session.user;
      await refreshHistory();
      goToPostAuthScreen();
    }
  }catch(e){
    state.authLoading = false;
    state.authError = e.message || 'Could not sign up. Try again.';
  }
  render();
}

async function signIn(email, password){
  state.authLoading = true;
  state.authError = null;
  render();
  try{
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error) throw error;
    state.user = data.session.user;
    state.authLoading = false;
    await refreshHistory();
    goToPostAuthScreen();
  }catch(e){
    state.authLoading = false;
    state.authError = e.message || 'Could not log in. Check your details and try again.';
  }
  render();
}

async function signOut(){
  await supabaseClient.auth.signOut();
  state.user = null;
  state.history = [];
  state.screen = 'home';
  render();
}

async function requestPasswordReset(email){
  state.authLoading = true;
  state.authError = null;
  state.resetSentMessage = null;
  render();
  try{
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.href.split('#')[0]
    });
    if(error) throw error;
    state.resetSentMessage = 'If that email has an account, a reset link is on its way.';
  }catch(e){
    state.authError = e.message || 'Could not send reset email. Try again.';
  }
  state.authLoading = false;
  render();
}

async function updatePassword(newPassword){
  state.authLoading = true;
  state.authError = null;
  render();
  try{
    const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
    if(error) throw error;
    state.authLoading = false;
    state.screen = 'home';
    render();
  }catch(e){
    state.authLoading = false;
    state.authError = e.message || 'Could not update password. Try again.';
    render();
  }
}

function goToPostAuthScreen(){
  state.screen = state.redirectAfterAuth || 'setup';
  state.redirectAfterAuth = null;
  state.authError = null;
}

function requireAuthThen(nextScreen){
  if(state.user){
    state.screen = nextScreen;
  } else {
    state.redirectAfterAuth = nextScreen;
    state.screen = 'login';
  }
}
// ---------------- edge function call ----------------
async function generateQuestions(source, count, attachments){
  // images are sent as data URLs; the edge function needs a vision-capable
  // model call to actually read them alongside the typed notes/topic.
  const images = (attachments || [])
    .filter(a => a.type === 'image')
    .map(a => a.dataUrl);

  // The edge function requires a real logged-in user's access token — it
  // rejects the anon key on its own (see supabase/functions/generate-questions).
  const { data: { session } } = await supabaseClient.auth.getSession();
  if(!session){
    throw new Error('You need to be logged in to generate questions.');
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-questions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ source, count, images })
  });
  if(!response.ok){
    let message = `Edge function error: ${response.status}`;
    try{
      const errBody = await response.json();
      if(errBody && errBody.error) message = errBody.error;
    }catch(e){ /* non-JSON error body, keep default message */ }
    throw new Error(message);
  }
  const data = await response.json();
  return data.questions;
}
// ---------------- chart ----------------
function drawChart(answers){
  const ctx = document.getElementById('chart');
  if(!ctx) return;
  const points = answers.map((a,i) => ({
    x: a.confidence + (Math.random()-0.5)*0.25,
    y: a.correct ? 1 : 0,
    label: a.question,
    correct: a.correct,
    confidence: a.confidence
  }));
  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        data: points,
        pointRadius: 8,
        pointHoverRadius: 10,
        backgroundColor: points.map(p => {
          if(!p.correct && p.confidence >= 4) return '#DC9A34';
          return p.correct ? '#3E8C79' : '#B34A36';
        }),
        pointBorderColor: points.map(p => {
          if(!p.correct && p.confidence >= 4) return '#8A5A16';
          return p.correct ? '#1F4A40' : '#6E2A1D';
        }),
        pointBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: 20 },
      scales: {
        x: {
          min: 0.5, max: 5.5,
          title: { display: true, text: 'Confidence (1\u20135)', color: '#736A55', font:{family:'IBM Plex Mono', size:11} },
          ticks: { stepSize: 1, color: '#736A55', font:{family:'IBM Plex Mono'} },
          grid: { color: '#C9BF9E' }
        },
        y: {
          min: -0.5, max: 1.5,
          ticks: {
            stepSize: 1,
            color: '#736A55',
            font:{family:'IBM Plex Mono'},
            callback: v => v === 1 ? 'Correct' : v === 0 ? 'Wrong' : ''
          },
          grid: { color: '#C9BF9E' }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          bodyFont:{family:'Source Serif 4'},
          titleFont:{family:'Fraunces'},
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.correct ? 'Correct' : 'Wrong'}, confidence ${p.confidence}/5`;
            },
            title: (items) => {
              const p = items[0].raw;
              return p.label.length > 60 ? p.label.slice(0,60)+'\u2026' : p.label;
            }
          }
        }
      }
    }
  });
}
// ---------------- nav ----------------
function renderNav(){
  const authLinks = state.user
    ? `
      <div class="nav-user">
        <span class="nav-email">${state.user.email}</span>
        <button class="nav-cta" id="nav-logout">Log out</button>
      </div>
      <button class="nav-cta" id="nav-open">Start the test</button>
    `
    : `
      <div class="nav-right">
        <button class="nav-cta ghost-link" id="nav-login">Log in</button>
        <button class="nav-cta" id="nav-signup">Sign up</button>
      </div>
    `;

  return `
    <nav class="wrap">
      <button class="mark" id="logo-home">
        <div class="mark-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 0c.9 3.6 1.9 6.1 3.4 7.6C16.9 9.1 19.4 10.1 23 11c-3.6.9-6.1 1.9-7.6 3.4C13.9 15.9 12.9 18.4 12 22c-.9-3.6-1.9-6.1-3.4-7.6C7.1 12.9 4.6 11.9 1 11c3.6-.9 6.1-1.9 7.6-3.4C9.1 6.1 10.1 3.6 11 0c.3 0 .7 0 1 0z" transform="translate(0.5 1)"/>
          </svg>
        </div>
        <div class="mark-word">Confidence AI</div>
      </button>
      ${authLinks}
    </nav>
  `;
}

// ---------------- home screen ----------------
function renderHome(){
  return `
  <header class="hero wrap">
    <div>
      <div class="eyebrow">A study tool with one job</div>
      <h1>Know what you <em>actually</em> know.</h1>
      <p class="lede">Most quiz apps hand you a score. This one catches the specific moment you felt sure &mdash; and were wrong. That's the blind spot that turns "I studied this" into a bad exam surprise.</p>
      <div class="cta-row">
        <button class="btn primary" id="hero-cta">Try it on your notes</button>
        <a class="btn secondary" href="#how">See how it works</a>
      </div>
    </div>

    <div class="quad-card">
      <div class="quad-label">Every answer, plotted</div>
      <div class="quad-grid">
        <div class="q underselling"><div class="qn">Underselling</div><div class="qd">Unsure, but right</div></div>
        <div class="q locked"><div class="qn">Locked in</div><div class="qd">Sure, and right</div></div>
        <div class="q fair"><div class="qn">Fair enough</div><div class="qd">Unsure, and wrong</div></div>
        <div class="q blind"><div class="qn">Blind spot</div><div class="qd">Sure, but wrong</div></div>
      </div>
      <div class="axis-x"><span>&larr; less sure</span><span>more sure &rarr;</span></div>
    </div>
  </header>

  <section class="rule" id="how">
    <div class="wrap">
      <div class="section-head">
        <div class="eyebrow">How it works</div>
        <h2>Three steps, no grading required</h2>
      </div>
      <div class="steps">
        <div class="step">
          <div class="n">01</div>
          <h3>Paste your notes</h3>
          <p>Or just name a topic. Questions get generated straight from what you give it &mdash; multiple choice, so scoring is automatic.</p>
        </div>
        <div class="step">
          <div class="n">02</div>
          <h3>Rate your certainty first</h3>
          <p>Before you see if you're right, say how sure you are on a scale of 1 to 5. That number is the whole point.</p>
        </div>
        <div class="step">
          <div class="n">03</div>
          <h3>Read your blind spots</h3>
          <p>After a handful of questions, every answer lands on a grid. The top-left corner is where confident wrong answers live.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="rule">
    <div class="wrap">
      <div class="callout">
        <p>A test score tells you what you missed. It doesn't tell you which of your "I've got this" moments were lies.</p>
        <p>Confidence AI is built around that gap &mdash; the answers you got wrong while feeling ready are the ones most likely to repeat themselves on exam day.</p>
      </div>
    </div>
  </section>

  <footer class="wrap">
    <span>Confidence AI</span>
  </footer>
  `;
}
// ---------------- auth screens ----------------
function renderLogin(){
  const msg = state.signupConfirmMessage;
  state.signupConfirmMessage = null;
  return `
    <h1>Log in</h1>
    <div class="app-sub">Log in to save quizzes to your account and pick up your blind-spot history anywhere.</div>
    <div class="card">
      <form id="login-form">
        <div class="auth-field">
          <label for="login-email">Email</label>
          <input type="email" id="login-email" autocomplete="email" required>
        </div>
        <div class="auth-field">
          <label for="login-password">Password</label>
          <input type="password" id="login-password" autocomplete="current-password" required>
        </div>
        ${msg ? `<div class="success-msg">${msg}</div>` : ''}
        ${state.authError ? `<div class="err">${state.authError}</div>` : ''}
        <div class="auth-submit-row">
          <button type="submit" id="login-submit" ${state.authLoading ? 'disabled' : ''}>${state.authLoading ? 'Logging in\u2026' : 'Log in'}</button>
        </div>
      </form>
      <div class="auth-switch">
        <button id="go-forgot">Forgot password?</button>
      </div>
      <div class="auth-switch">
        Don't have an account? <button id="go-signup">Sign up</button>
      </div>
    </div>
  `;
}

function renderForgotPassword(){
  const msg = state.resetSentMessage;
  return `
    <h1>Reset your password</h1>
    <div class="app-sub">Enter the email on your account and we'll send you a link to set a new password.</div>
    <div class="card">
      <form id="forgot-form">
        <div class="auth-field">
          <label for="forgot-email">Email</label>
          <input type="email" id="forgot-email" autocomplete="email" required>
        </div>
        ${msg ? `<div class="success-msg">${msg}</div>` : ''}
        ${state.authError ? `<div class="err">${state.authError}</div>` : ''}
        <div class="auth-submit-row">
          <button type="submit" id="forgot-submit" ${state.authLoading ? 'disabled' : ''}>${state.authLoading ? 'Sending\u2026' : 'Send reset link'}</button>
        </div>
      </form>
      <div class="auth-switch">
        <button id="go-login-from-forgot">Back to log in</button>
      </div>
    </div>
  `;
}

function renderUpdatePassword(){
  return `
    <h1>Choose a new password</h1>
    <div class="app-sub">You followed a password reset link. Set a new password below to finish.</div>
    <div class="card">
      <form id="update-password-form">
        <div class="auth-field">
          <label for="update-password">New password</label>
          <input type="password" id="update-password" autocomplete="new-password" minlength="6" required>
        </div>
        <div class="auth-field">
          <label for="update-password-confirm">Confirm new password</label>
          <input type="password" id="update-password-confirm" autocomplete="new-password" minlength="6" required>
        </div>
        ${state.authError ? `<div class="err">${state.authError}</div>` : ''}
        <div class="auth-submit-row">
          <button type="submit" id="update-password-submit" ${state.authLoading ? 'disabled' : ''}>${state.authLoading ? 'Saving\u2026' : 'Save new password'}</button>
        </div>
      </form>
    </div>
  `;
}

function renderSignup(){
  return `
    <h1>Create an account</h1>
    <div class="app-sub">Sign up to save your quizzes and revisit your blind spots later.</div>
    <div class="card">
      <form id="signup-form">
        <div class="auth-field">
          <label for="signup-email">Email</label>
          <input type="email" id="signup-email" autocomplete="email" required>
        </div>
        <div class="auth-field">
          <label for="signup-password">Password</label>
          <input type="password" id="signup-password" autocomplete="new-password" minlength="6" required>
        </div>
        <div class="auth-field">
          <label for="signup-password-confirm">Confirm password</label>
          <input type="password" id="signup-password-confirm" autocomplete="new-password" minlength="6" required>
        </div>
        ${state.authError ? `<div class="err">${state.authError}</div>` : ''}
        <div class="auth-submit-row">
          <button type="submit" id="signup-submit" ${state.authLoading ? 'disabled' : ''}>${state.authLoading ? 'Creating account\u2026' : 'Sign up'}</button>
        </div>
      </form>
      <div class="auth-switch">
        Already have an account? <button id="go-login">Log in</button>
      </div>
    </div>
  `;
}
// ---------------- app shell ----------------
function renderAppShell(inner){
  return `<div class="app-wrap">${inner}</div>`;
}

function renderSetup(){
  return `
    <h1>Find your blind spots</h1>
    <div class="app-sub">Paste your notes, name a topic, or add a photo of your notes &mdash; you'll rate how sure you are before each answer is revealed, that's what catches the moments you feel ready but aren't.</div>
    <div class="card">
      <label for="source">Notes or topic</label>
      <textarea id="source" placeholder="Paste study notes, or type a topic like &quot;the French Revolution&quot; or &quot;React hooks&quot;">${state.source}</textarea>

      <div class="attach-row">
        <label class="attach-btn" for="camera-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"></path><circle cx="12" cy="14" r="3.4"></circle></svg>
          Take a photo
        </label>
        <input type="file" id="camera-input" accept="image/*" capture="environment" hidden>

        <label class="attach-btn" for="file-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path></svg>
          Scan a document
        </label>
        <input type="file" id="file-input" accept="image/*,application/pdf" multiple hidden>
      </div>
      <div class="attach-hint">Photos and scans get read alongside your notes to build questions.</div>

      ${state.attachments.length ? `
        <div class="attach-previews">
          ${state.attachments.map(a => `
            <div class="attach-thumb ${a.type === 'image' ? '' : 'file'}">
              ${a.type === 'image'
                ? `<img src="${a.dataUrl}" alt="${a.name}">`
                : `<div>&#128196;</div><div class="fname">${a.name}</div>`
              }
              <button class="attach-remove" data-remove="${a.id}" aria-label="Remove attachment">&times;</button>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="row">
        <div>
          <label for="count">Questions</label>
          <select id="count">
            ${[4,6,8].map(n => `<option value="${n}" ${n===state.count?'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
      </div>
      ${state.error ? `<div class="err">${state.error}</div>` : ''}
      <div class="actions">
        <button id="start-btn">Generate questions</button>
      </div>
    </div>
  `;
}

function renderLoading(){
  const hasPhotos = state.attachments.some(a => a.type === 'image');
  const msg = hasPhotos ? 'Reading your photos and notes\u2026' : 'Writing questions from what you gave me\u2026';
  return `
    <h1>Building your quiz</h1>
    <div class="card">
      <div class="loading">
        <div class="loading-quad"><span></span><span></span><span></span><span></span></div>
        <div class="loading-text">${msg}</div>
      </div>
    </div>
  `;
}
function renderQuiz(){
  const q = state.questions[state.current];
  const total = state.questions.length;
  return `
    <div class="progress">Question ${state.current + 1} / ${total}</div>
    <div class="card">
      <div class="qtext">${q.question}</div>
      <label>Pick an answer</label>
      ${q.options.map((opt, i) => {
        let cls = 'opt';
        if(state.revealed){
          if(i === q.correctIndex) cls += ' correct';
          else if(i === state.selectedOpt) cls += ' wrong';
        } else if(i === state.selectedOpt){
          cls += ' selected';
        }
        return `<button class="${cls}" data-opt="${i}" ${state.revealed?'disabled':''}>${opt}</button>`;
      }).join('')}

      <label style="margin-top:22px;">How sure are you?</label>
      <div class="conf-scale">
        ${[1,2,3,4,5].map(n => `<div class="conf-btn ${state.selectedConf===n?'selected':''}" data-conf="${n}">${n}</div>`).join('')}
      </div>
      <div class="conf-labels"><span>Just guessing</span><span>Dead certain</span></div>

      ${state.revealed ? renderVerdict(q) : ''}

      <div class="actions">
        ${!state.revealed
          ? `<button id="reveal-btn" ${(state.selectedOpt===null||state.selectedConf===null)?'disabled':''}>Reveal answer</button>`
          : `<button id="next-btn">${state.current === total-1 ? 'See results' : 'Next question'}</button>`
        }
      </div>
    </div>
  `;
}

function renderVerdict(q){
  const correct = state.selectedOpt === q.correctIndex;
  const blindspot = !correct && state.selectedConf >= 4;
  let cls = correct ? 'verdict correct' : 'verdict wrong';
  let head = correct ? 'Correct.' : 'Not quite.';
  if(blindspot) { cls = 'verdict blindspot'; head = 'Confidently wrong \u2014 that\u2019s a blind spot.'; }
  return `<div class="${cls}"><div>${head}</div><div class="explain">${q.explanation}</div></div>`;
}
function renderResults(answers, archived){
  const total = answers.length;
  const correctCount = answers.filter(a => a.correct).length;
  const blindspots = answers.filter(a => !a.correct && a.confidence >= 4);
  const avgConf = (answers.reduce((s,a)=>s+a.confidence,0)/total).toFixed(1);
  return `
    <h1>${archived ? 'Past session' : 'Your calibration'}</h1>
    <div class="app-sub">Confidence on the horizontal axis, correctness on the vertical. Top-left is where exams go wrong.</div>
    <div class="card">
      <div class="stat-row">
        <div class="stat"><div class="num">${correctCount}/${total}</div><div class="lbl">Correct</div></div>
        <div class="stat"><div class="num">${avgConf}</div><div class="lbl">Avg confidence</div></div>
        <div class="stat"><div class="num" style="color:var(--amber-dark)">${blindspots.length}</div><div class="lbl">Blind spots</div></div>
      </div>
      <div class="grid-wrap">
        <canvas id="chart" height="360" role="img" aria-label="Scatter plot of confidence versus correctness for each answered question"></canvas>
      </div>
      ${blindspots.length ? `
        <div class="flag-list">
          <label>Where you were sure &mdash; and wrong</label>
          ${blindspots.map(b => `<div class="flag-item"><b>${b.question}</b>You said ${b.confidence}/5 sure. Correct answer: ${b.correctText}</div>`).join('')}
        </div>
      ` : `<div class="flag-item" style="border-color:var(--teal-dark)">No confident-wrong answers this round. Your confidence tracked your knowledge well.</div>`}
      <div class="actions">
        ${archived
          ? `<button class="ghost" id="back-home-btn">Back to home</button>`
          : `<button class="ghost" id="restart-btn">Start over</button>`
        }
      </div>
    </div>
  `;
}

function renderSessionView(){
  const s = getViewingSession();
  if(!s) return `<h1>Session not found</h1>`;
  return renderResults(s.answers, true);
}
// Screens that belong to the "ask questions" flow — generating and taking a
// quiz requires a logged-in user. Enforced here, not just at the buttons that
// lead here, so there's a single place this rule can't be bypassed from.
const QUESTION_FLOW_SCREENS = ['setup', 'loading', 'quiz', 'results'];

function render(){
  const root = document.getElementById('root');

  if(QUESTION_FLOW_SCREENS.includes(state.screen) && !state.user){
    state.redirectAfterAuth = state.screen;
    state.screen = 'login';
  }

  const navHtml = renderNav();

  if(state.screen === 'home') root.innerHTML = navHtml + renderHome();
  else if(state.screen === 'login') root.innerHTML = navHtml + renderAppShell(renderLogin());
  else if(state.screen === 'signup') root.innerHTML = navHtml + renderAppShell(renderSignup());
  else if(state.screen === 'forgot') root.innerHTML = navHtml + renderAppShell(renderForgotPassword());
  else if(state.screen === 'update-password') root.innerHTML = navHtml + renderAppShell(renderUpdatePassword());
  else if(state.screen === 'setup') root.innerHTML = navHtml + renderAppShell(renderSetup());
  else if(state.screen === 'loading') root.innerHTML = navHtml + renderAppShell(renderLoading());
  else if(state.screen === 'quiz') root.innerHTML = navHtml + renderAppShell(renderQuiz());
  else if(state.screen === 'results') root.innerHTML = navHtml + renderAppShell(renderResults(state.answers, false));
  else if(state.screen === 'session') root.innerHTML = navHtml + renderAppShell(renderSessionView());

  document.body.classList.toggle('is-home', state.screen === 'home');
  if(state.screen === 'home') state.sidebarOpen = false;

  attachHandlers();
  renderSidebar();
  if(state.screen === 'results' || state.screen === 'session') drawChart(state.screen === 'session' ? getViewingSession().answers : state.answers);
}
// ---------------- handlers ----------------
function attachHandlers(){
  const logoHome = document.getElementById('logo-home');
  if(logoHome) logoHome.onclick = () => { state.screen = 'home'; render(); };

  const navOpen = document.getElementById('nav-open');
  if(navOpen) navOpen.onclick = () => { requireAuthThen('setup'); render(); };

  const navLogin = document.getElementById('nav-login');
  if(navLogin) navLogin.onclick = () => { state.authError = null; state.screen = 'login'; render(); };

  const navSignup = document.getElementById('nav-signup');
  if(navSignup) navSignup.onclick = () => { state.authError = null; state.screen = 'signup'; render(); };

  const navLogout = document.getElementById('nav-logout');
  if(navLogout) navLogout.onclick = () => { signOut(); };

  const heroCta = document.getElementById('hero-cta');
  if(heroCta) heroCta.onclick = () => { requireAuthThen('setup'); render(); };

  // ---- auth forms ----
  const loginForm = document.getElementById('login-form');
  if(loginForm) loginForm.onsubmit = (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    signIn(email, password);
  };

  const signupForm = document.getElementById('signup-form');
  if(signupForm) signupForm.onsubmit = (e) => {
    e.preventDefault();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirm = document.getElementById('signup-password-confirm').value;
    if(password !== confirm){
      state.authError = "Passwords don't match.";
      render();
      return;
    }
    signUp(email, password);
  };

  const goSignup = document.getElementById('go-signup');
  if(goSignup) goSignup.onclick = () => { state.authError = null; state.screen = 'signup'; render(); };

  const goLogin = document.getElementById('go-login');
  if(goLogin) goLogin.onclick = () => { state.authError = null; state.screen = 'login'; render(); };

  const goForgot = document.getElementById('go-forgot');
  if(goForgot) goForgot.onclick = () => { state.authError = null; state.resetSentMessage = null; state.screen = 'forgot'; render(); };

  const goLoginFromForgot = document.getElementById('go-login-from-forgot');
  if(goLoginFromForgot) goLoginFromForgot.onclick = () => { state.authError = null; state.screen = 'login'; render(); };

  const forgotForm = document.getElementById('forgot-form');
  if(forgotForm) forgotForm.onsubmit = (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    requestPasswordReset(email);
  };

  const updatePasswordForm = document.getElementById('update-password-form');
  if(updatePasswordForm) updatePasswordForm.onsubmit = (e) => {
    e.preventDefault();
    const password = document.getElementById('update-password').value;
    const confirm = document.getElementById('update-password-confirm').value;
    if(password !== confirm){
      state.authError = "Passwords don't match.";
      render();
      return;
    }
    updatePassword(password);
  };

  // ---- quiz setup ----
  const startBtn = document.getElementById('start-btn');
  if(startBtn) startBtn.onclick = async () => {
    state.source = document.getElementById('source').value.trim();
    state.count = parseInt(document.getElementById('count').value, 10);
    if(!state.source && state.attachments.length === 0){
      state.error = 'Give me something to work with \u2014 notes, a topic, or a photo of your notes.';
      render();
      return;
    }
    state.error = null;
    state.screen = 'loading';
    render();
    try{
      const qs = await generateQuestions(state.source, state.count, state.attachments);
      state.questions = qs;
      state.current = 0;
      state.answers = [];
      state.selectedOpt = null;
      state.selectedConf = null;
      state.revealed = false;
      state.screen = 'quiz';
    }catch(e){
      state.screen = 'setup';
      state.error = e.message || 'Something went wrong generating questions. Try again.';
    }
    render();
  };

  const cameraInput = document.getElementById('camera-input');
  if(cameraInput) cameraInput.onchange = (e) => { handleFiles(e.target.files); };

  const fileInput = document.getElementById('file-input');
  if(fileInput) fileInput.onchange = (e) => { handleFiles(e.target.files); };

  document.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => {
      state.attachments = state.attachments.filter(a => a.id !== btn.dataset.remove);
      render();
    };
  });

  document.querySelectorAll('.opt').forEach(btn => {
    btn.onclick = () => { if(!state.revealed){ state.selectedOpt = parseInt(btn.dataset.opt,10); render(); } };
  });
  document.querySelectorAll('.conf-btn').forEach(btn => {
    btn.onclick = () => { if(!state.revealed){ state.selectedConf = parseInt(btn.dataset.conf,10); render(); } };
  });

  const revealBtn = document.getElementById('reveal-btn');
  if(revealBtn) revealBtn.onclick = () => {
    const q = state.questions[state.current];
    state.revealed = true;
    state.answers.push({
      question: q.question,
      confidence: state.selectedConf,
      correct: state.selectedOpt === q.correctIndex,
      correctText: q.options[q.correctIndex]
    });
    render();
  };

  const nextBtn = document.getElementById('next-btn');
  if(nextBtn) nextBtn.onclick = async () => {
    if(state.current === state.questions.length - 1){
      state.screen = 'results';
      render();
      await saveSession(); // persists to Supabase, then refreshes the sidebar list
      renderSidebar();
    } else {
      state.current += 1;
      state.selectedOpt = null;
      state.selectedConf = null;
      state.revealed = false;
      render();
    }
  };

  const backHomeBtn = document.getElementById('back-home-btn');
  if(backHomeBtn) backHomeBtn.onclick = () => { state.screen = 'home'; render(); };

  const restartBtn = document.getElementById('restart-btn');
  if(restartBtn) restartBtn.onclick = () => {
    Object.assign(state, {
      source:'', count:6, attachments:[], questions:[], current:0,
      answers:[], selectedOpt:null, selectedConf:null, revealed:false, error:null
    });
    requireAuthThen('setup');
    render();
  };
}

// ---------------- attachments (camera / scan) ----------------
function handleFiles(fileList){
  // preserve in-progress typing before we re-render for each file
  const srcEl = document.getElementById('source');
  if(srcEl) state.source = srcEl.value;
  const countEl = document.getElementById('count');
  if(countEl) state.count = parseInt(countEl.value, 10);

  const files = Array.from(fileList || []).slice(0, MAX_ATTACHMENTS - state.attachments.length);
  if(files.length === 0) return;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      state.attachments.push({
        id: 'a' + Date.now() + Math.random().toString(36).slice(2, 7),
        name: file.name,
        type: file.type.startsWith('image/') ? 'image' : 'file',
        dataUrl: reader.result
      });
      render();
    };
    reader.readAsDataURL(file);
  });
}
// ---------------- entry point ----------------
const MIN_SPLASH_MS = 700;

function hideSplash(){
  const splash = document.getElementById('splash');
  const root = document.getElementById('root');
  if(splash) splash.classList.add('hide');
  if(root) root.classList.add('ready');
}

async function init(){
  const started = Date.now();

  await initAuth();  // resolves state.user (and history, if logged in) from any existing session
  render();

  // Keep the splash up for a minimum stretch so it doesn't just flicker on
  // fast connections, but never block longer than necessary.
  const elapsed = Date.now() - started;
  setTimeout(hideSplash, Math.max(0, MIN_SPLASH_MS - elapsed));
}

// Wait for the full page load (fonts, Chart.js, etc.) before kicking off
// auth resolution and the first real render.
window.addEventListener('load', init);

