/**
 * La Rambla — Restaurant Admin Hub
 *
 * Single-page app controlling all admin tabs: Dashboard, Employees,
 * Import, Time-Off, Requests, Accounts, Reports, and Settings.
 */

// ── State ───────────────────────────────────────────────────────────
let currentUser = null;
let summaryData = [];
let reconReportsList = [];
let employeeData = [];
let currentTempFile = null;
let currentDetailId = null;
let sortColumn = 'name';
let sortDir = 'asc';
let ptoConcernIds = new Set();
let ptoConcernsFilterActive = false;
let dismissedAlerts = new Set(JSON.parse(sessionStorage.getItem('dismissedAlerts') || '[]'));
let notificationsRead = sessionStorage.getItem('notificationsRead') === 'true';
let lastNotifCount = parseInt(sessionStorage.getItem('lastNotifCount')) || 0;

// ── Safe fetch wrapper ───────────────────────────────────────────────
async function safeFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { msg = JSON.parse(text).error; } catch { msg = text; }
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return res.json();
}

// ── Initialization ──────────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login.html'; return; }
    currentUser = await res.json();
    if (currentUser.role !== 'admin') { window.location.href = '/employee.html'; return; }
    document.getElementById('userInfo').textContent = currentUser.username;
    // Gastos tab is always visible to admin users
    var gastosBtn = document.getElementById('tabBtnGastos');
    if (gastosBtn) gastosBtn.style.display = '';
    // Restore tab from URL hash, default to dashboard
    var hash = window.location.hash.replace('#', '');
    if (hash === 'import' || hash === 'timeoff') hash = 'employees'; // Import + Record Time-Off merged into Employees tab
    if (hash === 'tardiness' || hash === 'mealpenalty') { var _compMode = hash; hash = 'compliance'; setTimeout(function(){ compSwitchMode(_compMode); }, 50); }
    if (hash && document.getElementById('tab-' + hash)) {
      switchTab(hash);
    } else {
      loadDashboard();
    }
  } catch { window.location.href = '/login.html'; }
})();

// ── Mobile Menu ─────────────────────────────────────────────────────
function toggleUserMenu() {
  document.getElementById('userMenuDropdown').classList.toggle('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu-wrapper')) {
    document.getElementById('userMenuDropdown')?.classList.remove('open');
  }
});

// ── Tab Menu Toggle ─────────────────────────────────────────────────
function toggleTabMenu() {
  document.querySelector('.tab-nav').classList.toggle('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tab-nav')) {
    document.querySelector('.tab-nav')?.classList.remove('open');
  }
});

const tabLabels = {
  dashboard: '📊 Dashboard',
  employees: '👥 Employees',
  requests: '📅 Time-Off Requests',
  compliance: '⚠️ Tardiness & Meals',
  reconciliation: '💰 Reconciliation',
  performance: '⭐ Performance Reviews',
  'ac-evals': '✅ Hospitality Evaluations',
  leadership: '🎓 Leadership Academy',
  scorecard: '📈 Executive Scorecard',
  accounts: '🔒 User Accounts',
  apprenticeship: '🎓 Apprenticeship'
};

// ── Tab Navigation ──────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelector('.header-actions')?.classList.remove('mobile-open');
  document.querySelector('.tab-nav')?.classList.remove('open');
  document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
  // Support both .tab (employee portal) and .tab-nav-item (admin)
  document.querySelectorAll('.tab, .tab-nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).style.display = '';
  const activeBtn = document.querySelector(`[data-tab="${tab}"]`);
  if (activeBtn) activeBtn.classList.add('active');
  // Update hamburger label (if present)
  const label = document.getElementById('currentTabLabel');
  if (label) label.textContent = tabLabels[tab] || tab;

  // Save current tab to URL hash so refresh stays on same tab
  window.location.hash = tab;

  if (tab === 'dashboard') loadDashboard();
  if (tab === 'employees') loadEmployees();
  if (tab === 'requests') loadRequests();
  if (tab === 'compliance') { loadTardinessHistory(); loadMealPenaltyHistory(); }
  if (tab === 'reconciliation') { loadReconHistory(); loadCachedStatements(); }
  if (tab === 'performance') loadPerformanceReviews();
  if (tab === 'ac-evals') loadACEvals();
  if (tab === 'leadership') loadLACandidates();
  if (tab === 'scorecard') loadScorecard();
  if (tab === 'social-posts') spInit();
  if (tab === 'gastos') gastosInit();
  if (tab === 'apprenticeship') apprInit();
  if (tab === 'accounts') loadAccounts();
}

// ── Compliance toggle (Tardiness / Meal Penalties) ──────────────────
function compSwitchMode(mode) {
  document.getElementById('comp-tardiness').style.display = mode === 'tardiness' ? '' : 'none';
  document.getElementById('comp-mealpenalty').style.display = mode === 'mealpenalty' ? '' : 'none';
  document.getElementById('compToggleTardiness').classList.toggle('active', mode === 'tardiness');
  document.getElementById('compToggleMealpenalty').classList.toggle('active', mode === 'mealpenalty');
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

// ── Dashboard ───────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [statsRes, summaryRes] = await Promise.all([
      fetch('/api/dashboard/stats'),
      fetch('/api/accruals/summary')
    ]);

    const stats = await statsRes.json();
    summaryData = await summaryRes.json();

    document.getElementById('statActive').textContent = stats.totalActive;
    document.getElementById('statInactive').textContent = stats.totalInactive;
    document.getElementById('statPending').textContent = stats.pendingRequests;
    document.getElementById('statRange').textContent = stats.dataRange;

    // Pending requests alert + badge
    if (stats.pendingRequests > 0 && !dismissedAlerts.has('pendingRequestsAlert')) {
      document.getElementById('pendingRequestsAlert').classList.remove('hidden');
      document.getElementById('pendingRequestCount').textContent = stats.pendingRequests;
    } else {
      document.getElementById('pendingRequestsAlert').classList.add('hidden');
    }
    if (stats.pendingRequests > 0) {
      const badge = document.getElementById('reqBadge');
      badge.textContent = stats.pendingRequests;
      badge.classList.remove('hidden');
    } else {
      document.getElementById('reqBadge').classList.add('hidden');
    }

    // Flagged employees alert
    if (stats.flaggedCount > 0 && !dismissedAlerts.has('flaggedAlert')) {
      document.getElementById('flaggedAlert').classList.remove('hidden');
      document.getElementById('flaggedCount').textContent = stats.flaggedCount;
    } else {
      document.getElementById('flaggedAlert').classList.add('hidden');
    }

    // Stale data warning (>45 days since last import)
    if (stats.daysSinceImport !== null && stats.daysSinceImport > 45 && !dismissedAlerts.has('staleDataAlert')) {
      document.getElementById('staleDataAlert').classList.remove('hidden');
      document.getElementById('staleDataDays').textContent = stats.daysSinceImport;
    } else {
      document.getElementById('staleDataAlert').classList.add('hidden');
    }

    // PTO cap concern tracking
    ptoConcernIds = new Set((stats.ptoConcernsList || []).map(e => e.id));

    // Last backup display
    if (stats.lastBackup) {
      const d = new Date(stats.lastBackup);
      document.getElementById('statBackup').textContent =
        d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      document.getElementById('statBackup').textContent = 'Never';
    }

    buildNotifList(stats);
    renderSummaryTable();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

// ── Summary Table (Dashboard) ───────────────────────────────────────
function sortBy(col) {
  if (sortColumn === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortColumn = col;
    sortDir = 'asc';
  }
  renderSummaryTable();
}

function sortArrow(col) {
  if (sortColumn !== col) return '';
  return sortDir === 'asc' ? ' &#9650;' : ' &#9660;';
}

function renderSummaryTable() {
  const search = (document.getElementById('searchInput').value || '').toLowerCase();
  const status = document.getElementById('statusFilter').value;
  const type = document.getElementById('typeFilter').value;

  const filtered = summaryData.filter(r => {
    if (ptoConcernsFilterActive && !ptoConcernIds.has(r.id)) return false;
    if (search && !r.full_name.toLowerCase().includes(search) &&
        !r.first_name.toLowerCase().includes(search) &&
        !r.last_name.toLowerCase().includes(search)) return false;
    if (status && r.status !== status) return false;
    if (type && r.employee_type !== type) return false;
    return true;
  });

  // PTO concerns filter banner
  const filterBanner = document.getElementById('ptoConcernsFilterBanner');
  if (filterBanner) {
    if (ptoConcernsFilterActive) {
      filterBanner.classList.remove('hidden');
      filterBanner.querySelector('span').textContent =
        `Showing ${filtered.length} employee(s) approaching PTO balance limits`;
    } else {
      filterBanner.classList.add('hidden');
    }
  }

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let va, vb;
    switch (sortColumn) {
      case 'name':       va = (a.first_name + ' ' + a.last_name).toLowerCase(); vb = (b.first_name + ' ' + b.last_name).toLowerCase(); break;
      case 'type':       va = a.employee_type; vb = b.employee_type; break;
      case 'status':     va = a.status; vb = b.status; break;
      case 'tenure':     va = a.tenure_days || 0; vb = b.tenure_days || 0; break;
      case 'sick_earned': va = a.total_sick_earned; vb = b.total_sick_earned; break;
      case 'sick_taken': va = a.total_sick_taken; vb = b.total_sick_taken; break;
      case 'sick_bal':   va = a.sick_balance; vb = b.sick_balance; break;
      case 'vac_earned': va = a.total_vacation_earned; vb = b.total_vacation_earned; break;
      case 'vac_taken':  va = a.total_vacation_taken; vb = b.total_vacation_taken; break;
      case 'vac_bal':    va = a.vacation_balance; vb = b.vacation_balance; break;
      default:           va = a.full_name; vb = b.full_name;
    }
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  // Update header sort arrows
  document.querySelectorAll('#tab-dashboard thead th[data-sort]').forEach(th => {
    th.innerHTML = th.dataset.label + sortArrow(th.dataset.sort);
  });

  const tbody = document.getElementById('summaryBody');
  tbody.innerHTML = sorted.map(r => {
    const nearCap = ptoConcernIds.has(r.id);
    const toggleTo = r.status === 'active' ? 'inactive' : 'active';
    return `
    <tr class="${nearCap ? 'row-pto-warning' : ''}">
      <td data-label="Name"><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong></td>
      <td data-label="Type"><span class="badge badge-${esc(r.employee_type)}">${esc(r.employee_type)}</span></td>
      <td data-label="Status"><span class="badge badge-${esc(r.status)}" style="cursor:pointer;" onclick="toggleStatus(${Number(r.id)}, '${esc(toggleTo)}', 'dashboard')" title="Click to toggle status">${esc(r.status)}</span></td>
      <td data-label="Tenure">${esc(r.tenure_display)}</td>
      <td data-label="Sick Earned" class="text-right">${r.total_sick_earned.toFixed(1)}</td>
      <td data-label="Sick Taken" class="text-right">${r.total_sick_taken.toFixed(1)}</td>
      <td data-label="Sick Bal" class="text-right ${r.sick_balance < 0 ? 'negative' : 'positive'}">${r.sick_balance.toFixed(1)}</td>
      <td data-label="Vac Earned" class="text-right">${r.total_vacation_earned.toFixed(2)}</td>
      <td data-label="Vac Taken" class="text-right">${r.total_vacation_taken.toFixed(1)}</td>
      <td data-label="Vac Bal" class="text-right ${r.vacation_balance < 0 ? 'negative' : 'positive'}">${r.vacation_balance.toFixed(2)}</td>
      <td><button class="btn btn-sm" onclick="viewDetail(${Number(r.id)})">Detail</button></td>
    </tr>`;
  }).join('');
}

function filterTable() { renderSummaryTable(); }

function showPtoConcerns() {
  ptoConcernsFilterActive = true;
  document.getElementById('searchInput').value = '';
  document.getElementById('statusFilter').value = '';
  document.getElementById('typeFilter').value = '';
  switchTab('dashboard');
  document.getElementById('summaryBody')?.closest('.table-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearPtoConcernsFilter() {
  ptoConcernsFilterActive = false;
  renderSummaryTable();
}

// ── Employee Status Toggle (shared by dashboard & employees tab) ────
async function toggleStatus(id, newStatus, source) {
  const action = newStatus === 'inactive' ? 'deactivate' : 'reactivate';
  if (!confirm(`Are you sure you want to ${action} this employee?`)) return;

  await fetch(`/api/employees/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus })
  });

  // Refresh the appropriate views
  if (source === 'dashboard') {
    loadDashboard();
  } else {
    loadEmployees();
    loadDashboard();
  }
}

// ── Employee Detail Modal ───────────────────────────────────────────
const MONTH_NAMES_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function viewDetail(id) {
  currentDetailId = id;
  try {
    const res = await fetch(`/api/accruals/detail/${id}`);
    const data = await res.json();
    const emp = data.employee;

    document.getElementById('detailName').textContent = `${emp.first_name} ${emp.last_name}`;

    const totalSick = data.months.reduce((s, m) => s + (m.sick_days_earned || 0), 0);
    const totalVac = data.months.reduce((s, m) => s + (m.vacation_days_earned || 0), 0);
    const sickTaken = data.timeOff.filter(t => t.type === 'sick').reduce((s, t) => s + t.days_taken, 0);
    const vacTaken = data.timeOff.filter(t => t.type === 'vacation').reduce((s, t) => s + t.days_taken, 0);

    document.getElementById('detailStats').innerHTML = `
      <div class="stat-card"><div class="label">Type</div><div class="value" style="font-size:1rem;">${esc(emp.employee_type)}</div></div>
      <div class="stat-card"><div class="label">Start Date</div><div class="value" style="font-size:1rem;">${esc(emp.first_clock_in || 'N/A')}</div></div>
      <div class="stat-card"><div class="label">Sick Balance</div><div class="value" style="font-size:1.25rem;">${(totalSick - sickTaken).toFixed(1)} days</div></div>
      <div class="stat-card"><div class="label">Vacation Balance</div><div class="value" style="font-size:1.25rem;">${(totalVac - vacTaken).toFixed(2)} days</div></div>
    `;

    document.getElementById('detailBody').innerHTML = data.months.map(m => {
      const qualified = m.sick_days_earned > 0;
      let vacRate = '-';
      if (m.vacation_days_earned === 1.25) vacRate = '10 hrs (15+yr)';
      else if (m.vacation_days_earned === 1.00) vacRate = '8 hrs (5-15yr)';
      else if (m.vacation_days_earned === 0.75) vacRate = '6 hrs (1-5yr)';
      else if (m.vacation_days_earned === 0.50) vacRate = '4 hrs (0-1yr)';
      return `
        <tr>
          <td>${MONTH_NAMES_SHORT[m.month]} ${m.year}</td>
          <td class="text-right">${m.total_hours.toFixed(1)}</td>
          <td class="text-center">${qualified ? '<span class="badge badge-active">Yes</span>' : '<span class="badge badge-inactive">No</span>'}</td>
          <td class="text-right">${(m.sick_days_earned || 0).toFixed(0)}</td>
          <td class="text-right">${(m.vacation_days_earned || 0).toFixed(2)}</td>
          <td>${qualified ? vacRate : '-'}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('detailTimeOff').innerHTML = data.timeOff.length ?
      data.timeOff.map(t => `
        <tr>
          <td>${esc(t.date_taken)}</td>
          <td><span class="badge badge-${t.type === 'sick' ? 'inactive' : 'active'}">${esc(t.type)}</span></td>
          <td class="text-right">${t.days_taken}</td>
          <td>${esc(t.notes || '')}</td>
          <td><button class="btn btn-sm btn-danger" onclick="removeTimeOff(${t.id})">Remove</button></td>
        </tr>
      `).join('') :
      '<tr><td colspan="5" style="text-align:center; color:var(--text-light);">No time-off recorded</td></tr>';

    document.getElementById('detailModal').classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load employee detail:', err);
  }
}

function closeDetail() { document.getElementById('detailModal').classList.add('hidden'); }

async function removeTimeOff(id) {
  if (!confirm('Remove this time-off record? The employee\'s balance will be restored.')) return;
  try {
    const res = await fetch(`/api/accruals/time-off/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      viewDetail(currentDetailId);
      loadDashboard();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Failed to remove time-off record');
  }
}

// ── Employees Tab ───────────────────────────────────────────────────
async function loadEmployees() {
  try {
    const res = await fetch('/api/employees');
    employeeData = await res.json();
    renderEmployeeTable();
    loadFlaggedEmployees();
  } catch (err) {
    console.error('Failed to load employees:', err);
  }
}

function renderEmployeeTable() {
  const search = (document.getElementById('empSearch').value || '').toLowerCase();
  const typeFilter = document.getElementById('empTypeFilter').value;
  const deptFilter = document.getElementById('empDeptFilter').value;
  const roleFilter = document.getElementById('empRoleFilter').value;
  const statusFilter = document.getElementById('empStatusFilter').value;

  const filtered = employeeData.filter(e => {
    if (search && !e.full_name.toLowerCase().includes(search) &&
        !e.first_name.toLowerCase().includes(search) &&
        !e.last_name.toLowerCase().includes(search)) return false;
    if (typeFilter && e.employee_type !== typeFilter) return false;
    if (deptFilter && e.department !== deptFilter && !(deptFilter !== 'BOH/FOH' && (e.department || '').includes(deptFilter))) return false;
    if (roleFilter && e.role !== roleFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });

  const roleColors = {
    'Team Member': '#6B7280',
    'Senior Team Member': '#0E7490',
    'Trainer': '#7C3AED',
    'Shift Leader': '#B45309',
    'Director': '#DC2626',
    'Senior Director': '#991B1B'
  };

  document.getElementById('employeeBody').innerHTML = filtered.map(e => {
    const toggleTo = e.status === 'active' ? 'inactive' : 'active';
    const dept = e.department || 'FOH';
    const deptClass = dept === 'BOH/FOH' ? 'badge-bothdept' : (dept === 'BOH' ? 'badge-boh' : 'badge-foh');
    const role = e.role || 'Team Member';
    const roleColor = roleColors[role] || '#6B7280';
    return `
    <tr>
      <td data-label="Name">${esc(e.first_name)} ${esc(e.last_name)}</td>
      <td data-label="Role"><span class="badge" style="background:${roleColor}15; color:${roleColor}; font-weight:600;">${esc(role)}</span></td>
      <td data-label="Dept"><span class="badge ${deptClass}">${esc(dept)}</span></td>
      <td data-label="Type"><span class="badge badge-${esc(e.employee_type)}">${esc(e.employee_type)}</span></td>
      <td data-label="Status"><span class="badge badge-${esc(e.status)}" style="cursor:pointer;" onclick="toggleStatus(${Number(e.id)}, '${esc(toggleTo)}', 'employees')" title="Click to toggle status">${esc(e.status)}</span></td>
      <td data-label="First Clock-In">${esc(e.first_clock_in || 'N/A')}</td>
      <td data-label="Flagged">${e.needs_setup ? '<span class="badge badge-rejected" style="cursor:pointer;" onclick="editEmployee(${Number(e.id)})" title="Click to set up portal access">⚠️ Setup Required</span>' : ''}${e.flagged_for_review ? '<span class="badge badge-pending">Review</span>' : ''}</td>
      <td><button class="btn btn-sm" onclick="editEmployee(${Number(e.id)})">Edit</button></td>
    </tr>`;
  }).join('');
}

function filterEmployeeTable() { renderEmployeeTable(); }

async function loadFlaggedEmployees() {
  try {
    const res = await fetch('/api/employees/flagged');
    const flagged = await res.json();

    const container = document.getElementById('flaggedList');
    if (flagged.length === 0) { container.innerHTML = ''; return; }

    container.innerHTML = `
      <div class="alert-banner" style="margin-bottom:1rem; flex-direction:column; align-items:stretch;">
        <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.75rem;">
          <span class="alert-icon">&#9888;</span>
          <strong>Employees flagged for review (${flagged.length})</strong>
        </div>
        ${flagged.map(e => `
          <div style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem 0; border-top:1px solid #f59e0b33;">
            <span>${esc(e.first_name)} ${esc(e.last_name)} - ${e.consecutive_empty_months} months with no hours</span>
            <div style="display:flex; gap:0.5rem;">
              <button class="btn btn-sm btn-danger" onclick="resolveFlag(${Number(e.id)}, 'deactivate')">Mark Inactive</button>
              <button class="btn btn-sm btn-success" onclick="resolveFlag(${Number(e.id)}, 'keep_active')">Keep Active</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    console.error('Failed to load flagged employees:', err);
  }
}

function filterFlagged() {
  document.getElementById('empSearch').value = '';
  renderEmployeeTable();
}

async function resolveFlag(id, action) {
  await fetch(`/api/employees/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  loadEmployees();
  loadDashboard();
}

function editEmployee(id) {
  const emp = employeeData.find(e => e.id === id);
  if (!emp) return;
  document.getElementById('editId').value = emp.id;
  document.getElementById('editName').value = `${emp.first_name} ${emp.last_name}`;
  document.getElementById('editRole').value = emp.role || 'Team Member';
  document.getElementById('editDept').value = emp.department || 'FOH';
  document.getElementById('editType').value = emp.employee_type;
  document.getElementById('editStatus').value = emp.status;
  document.getElementById('editEmail').value = emp.email || '';
  document.getElementById('editSlackId').value = emp.slack_user_id || '';
  // Show setup section if employee needs portal setup
  const setupSection = document.getElementById('editSetupSection');
  const pinInput = document.getElementById('editPin');
  if (emp.needs_setup) {
    setupSection.style.display = '';
    pinInput.required = true;
    pinInput.value = '';
  } else {
    setupSection.style.display = 'none';
    pinInput.required = false;
    pinInput.value = '';
  }
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEdit() { document.getElementById('editModal').classList.add('hidden'); }

async function saveEmployee(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const pin = document.getElementById('editPin').value;
  const body = {
    role: document.getElementById('editRole').value,
    department: document.getElementById('editDept').value,
    employee_type: document.getElementById('editType').value,
    status: document.getElementById('editStatus').value,
    email: document.getElementById('editEmail').value,
    slack_user_id: document.getElementById('editSlackId').value
  };
  if (pin) body.pin = pin;

  const res = await fetch(`/api/employees/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) {
    alert('Error: ' + data.error);
    return;
  }
  if (data.account_created) {
    alert(`Portal account created!\nPIN: ${pin}\nWelcome Slack DM sent ✓`);
  }
  closeEdit();
  loadEmployees();
}

// ── Add Employee ────────────────────────────────────────────────────
function showAddEmployee() {
  document.getElementById('addEmployeeForm').reset();
  document.getElementById('addEmployeeModal').classList.remove('hidden');
}

function closeAddEmployee() {
  document.getElementById('addEmployeeModal').classList.add('hidden');
}

async function submitAddEmployee(e) {
  e.preventDefault();
  const body = {
    first_name: document.getElementById('addFirstName').value,
    last_name: document.getElementById('addLastName').value,
    role: document.getElementById('addRole').value,
    department: document.getElementById('addDept').value,
    employee_type: document.getElementById('addType').value,
    first_clock_in: document.getElementById('addStartDate').value,
    pin: document.getElementById('addPin').value,
    slack_user_id: document.getElementById('addSlackId').value || null
  };

  const res = await fetch('/api/employees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  if (data.success) {
    closeAddEmployee();
    loadEmployees();
    // Exempt employees need accrual recalculation to populate their months
    if (body.employee_type === 'exempt') {
      await fetch('/api/accruals/recalculate', { method: 'POST' });
    }
    alert(`Employee added successfully!\n\nPIN: ${body.pin}\nPortal account created (must change password on first login)${body.slack_user_id ? '\nSlack welcome DM sent ✓' : ''}`);
  } else {
    alert('Error: ' + data.error);
  }
}

// ── Import ──────────────────────────────────────────────────────────
function handleFileSelect(input) {
  if (!input.files[0]) return;
  uploadFile(input.files[0]);
}

// Drag-and-drop support
const uploadArea = document.getElementById('uploadArea');
if (uploadArea) {
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/import/preview', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.success) { alert('Error: ' + data.error); return; }

    const p = data.preview;

    document.getElementById('previewStats').innerHTML = `
      <div class="stat-card"><div class="label">Total Rows</div><div class="value">${p.totalRows.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Employees</div><div class="value">${p.employeeCount}</div></div>
      <div class="stat-card"><div class="label">Date Range</div><div class="value" style="font-size:1rem;">${esc(p.monthRange.earliest)} to ${esc(p.monthRange.latest)}</div></div>
    `;

    document.getElementById('previewBody').innerHTML = p.employees.map(e => `
      <tr>
        <td>${esc(e.firstName)} ${esc(e.lastName)}</td>
        <td>${e.monthCount}</td>
        <td class="text-right">${e.totalHours.toFixed(1)}</td>
        <td>${esc(e.firstMonth)} to ${esc(e.lastMonth)}</td>
      </tr>
    `).join('');

    // ── Clear prior warnings ────────────────────────────────────────
    document.querySelectorAll('.import-warning-box').forEach(el => el.remove());

    const warningContainer = document.createElement('div');
    warningContainer.className = 'import-warning-box';

    // ── Name quality warnings ───────────────────────────────────────
    if (p.nameIssues) {
      const ni = p.nameIssues;

      // Near-duplicates (imported name ≈ existing DB name)
      if (ni.nearDuplicates && ni.nearDuplicates.length > 0) {
        const reasonLabels = { spacing: 'Missing/extra space', case: 'Case mismatch', accents: 'Accent difference', 'spacing+accents': 'Spacing + accents', similar: 'Similar name' };
        const ndHtml = document.createElement('div');
        ndHtml.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:1rem;margin:1rem 0;color:#856404;';
        ndHtml.innerHTML = `
          <strong>🔤 Name Mismatch Detected — Auto-Correction Will Apply</strong>
          <p style="margin:0.5rem 0 0;">${ni.nearDuplicates.length} imported name${ni.nearDuplicates.length > 1 ? 's' : ''} look like existing employees but don't match exactly.
          These will be <strong>automatically corrected</strong> to match the existing records on import:</p>
          <ul style="margin:0.5rem 0;padding-left:1.5rem;max-height:150px;overflow-y:auto;">
            ${ni.nearDuplicates.map(nd =>
              `<li><strong>${esc(nd.importedName)}</strong> → ${esc(nd.existingName)} <span style="opacity:0.7">(${reasonLabels[nd.reason] || nd.reason})</span></li>`
            ).join('')}
          </ul>
        `;
        warningContainer.appendChild(ndHtml);
      }

      // Intra-import duplicates (multiple variants of same name in the file)
      if (ni.importDuplicates && ni.importDuplicates.length > 0) {
        const idHtml = document.createElement('div');
        idHtml.style.cssText = 'background:#f8d7da;border:1px solid #f5c6cb;border-radius:8px;padding:1rem;margin:1rem 0;color:#721c24;';
        idHtml.innerHTML = `
          <strong>⚠️ Duplicate Names Within Import File</strong>
          <p style="margin:0.5rem 0 0;">The file contains ${ni.importDuplicates.length} name${ni.importDuplicates.length > 1 ? 's' : ''} with multiple spelling variants — hours may be split:</p>
          <ul style="margin:0.5rem 0;padding-left:1.5rem;">
            ${ni.importDuplicates.map(d =>
              `<li>${d.variants.map(v => `<strong>${esc(v)}</strong>`).join(' vs ')}</li>`
            ).join('')}
          </ul>
        `;
        warningContainer.appendChild(idHtml);
      }
    }

    // ── Duplicate data warning ─────────────────────────────────────
    if (p.duplicates && p.duplicates.count > 0) {
      const dupeNames = [...new Set(p.duplicates.details.map(d => d.name))];
      const dupeWarning = document.createElement('div');
      dupeWarning.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:1rem;margin:1rem 0;color:#856404;';
      dupeWarning.innerHTML = `
        <strong>⚠️ Duplicate Data Detected</strong>
        <p style="margin:0.5rem 0 0;">${p.duplicates.count} month record${p.duplicates.count > 1 ? 's' : ''} already exist for ${dupeNames.length} employee${dupeNames.length > 1 ? 's' : ''}.
        Importing will <strong>overwrite</strong> the existing hours for these months:</p>
        <ul style="margin:0.5rem 0;padding-left:1.5rem;max-height:150px;overflow-y:auto;">
          ${p.duplicates.details.slice(0, 20).map(d =>
            `<li>${esc(d.name)} — ${esc(d.month)} (existing: ${d.existingHours.toFixed(1)}h)</li>`
          ).join('')}
          ${p.duplicates.details.length > 20 ? `<li><em>...and ${p.duplicates.details.length - 20} more</em></li>` : ''}
        </ul>
      `;
      warningContainer.appendChild(dupeWarning);
    }

    // ── Active employees with no hours in import ────────────────────
    if (p.activeNoHours && p.activeNoHours.length > 0) {
      const noHoursHtml = document.createElement('div');
      noHoursHtml.style.cssText = 'background:#d4edda;border:1px solid #c3e6cb;border-radius:8px;padding:1rem;margin:1rem 0;color:#155724;';
      noHoursHtml.innerHTML = `
        <strong>📋 Active Employees Not In This Import</strong>
        <p style="margin:0.5rem 0 0;">${p.activeNoHours.length} active hourly employee${p.activeNoHours.length > 1 ? 's' : ''} have no hours in this file.
        If they no longer work here, consider marking them inactive:</p>
        <ul style="margin:0.5rem 0;padding-left:1.5rem;max-height:200px;overflow-y:auto;">
          ${p.activeNoHours.map(e =>
            `<li>${esc(e.fullName)}${e.hasExistingHours ? ' <span style="opacity:0.7">(has prior hours in this period)</span>' : ''}</li>`
          ).join('')}
        </ul>
      `;
      warningContainer.appendChild(noHoursHtml);
    }

    // Insert all warnings before the button bar
    if (warningContainer.children.length > 0) {
      const previewSection = document.getElementById('previewSection');
      // Find the div that contains the Confirm/Cancel buttons
      const btnBar = previewSection.querySelector('.btn-primary')?.closest('div');
      if (btnBar && btnBar.parentNode === previewSection) {
        previewSection.insertBefore(warningContainer, btnBar);
      } else {
        previewSection.appendChild(warningContainer);
      }
    }

    currentTempFile = data.tempFile;
    document.getElementById('previewSection').style.display = '';
    document.getElementById('importResult').style.display = 'none';
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
}

async function commitImport() {
  if (!currentTempFile) return;

  try {
    const res = await fetch('/api/import/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempFile: currentTempFile })
    });
    const data = await res.json();

    document.getElementById('previewSection').style.display = 'none';
    const resultEl = document.getElementById('importResult');
    resultEl.style.display = '';

    if (data.success) {
      let resultHtml = `
        <h3 style="color:var(--success); margin-bottom:0.75rem;">Import Successful</h3>
        <p>New employees created: <strong>${data.employeesCreated}</strong></p>
        <p>New month records: <strong>${data.monthsInserted}</strong></p>
        ${data.monthsUpdated > 0 ? `<p style="color:var(--warning);">Overwritten month records: <strong>${data.monthsUpdated}</strong></p>` : ''}
        <p>Accruals processed: <strong>${data.accrualsProcessed}</strong></p>
        ${data.flaggedForReview > 0 ? `<p style="color:var(--warning);">Employees flagged for review: <strong>${data.flaggedForReview}</strong></p>` : ''}
      `;

      // Show name corrections applied
      if (data.namesCorrected > 0 && data.correctedNames) {
        resultHtml += `
          <div style="background:#d4edda;border:1px solid #c3e6cb;border-radius:8px;padding:0.75rem;margin:0.75rem 0;color:#155724;">
            <strong>🔤 ${data.namesCorrected} name${data.namesCorrected > 1 ? 's' : ''} auto-corrected:</strong>
            <ul style="margin:0.25rem 0 0;padding-left:1.5rem;">
              ${data.correctedNames.map(c => `<li>${esc(c.from)} → <strong>${esc(c.to)}</strong></li>`).join('')}
            </ul>
          </div>
        `;
      }

      // Show active employees missing from import
      if (data.activeNoHours && data.activeNoHours.length > 0) {
        resultHtml += `
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:0.75rem;margin:0.75rem 0;color:#856404;">
            <strong>📋 ${data.activeNoHours.length} active employee${data.activeNoHours.length > 1 ? 's' : ''} not in this import:</strong>
            <ul style="margin:0.25rem 0 0;padding-left:1.5rem;max-height:200px;overflow-y:auto;">
              ${data.activeNoHours.map(e => `<li>${esc(e.fullName)}</li>`).join('')}
            </ul>
            <p style="margin:0.5rem 0 0;font-size:0.85rem;">If these employees no longer work here, consider marking them inactive in the Employees tab.</p>
          </div>
        `;
      }

      resultEl.innerHTML = resultHtml;
    } else {
      resultEl.innerHTML = `<h3 style="color:var(--danger);">Import Failed</h3><p>${esc(data.error)}</p>`;
    }

    currentTempFile = null;
    document.getElementById('fileInput').value = '';
  } catch (err) {
    alert('Commit failed: ' + err.message);
  }
}

function cancelImport() {
  document.getElementById('previewSection').style.display = 'none';
  currentTempFile = null;
  document.getElementById('fileInput').value = '';
}

// ── Requests Tab ────────────────────────────────────────────────────
async function loadRequests() {
  try {
    const status = document.getElementById('reqStatusFilter').value;
    const url = status ? `/api/requests?status=${encodeURIComponent(status)}` : '/api/requests';
    const res = await fetch(url);
    const requests = await res.json();

    document.getElementById('requestsBody').innerHTML = requests.length ?
      requests.map(r => {
        const isPunch = r.type === 'punch_adjustment';
        const typeBadge = isPunch ? 'punch' : (r.type === 'sick' ? 'inactive' : 'active');
        const typeLabel = isPunch ? 'Punch Adj.' : esc(r.type);
        const reasonText = isPunch && r.break_start
          ? 'Break: ' + esc(r.break_start) + '-' + esc(r.break_end) + (r.reason ? ' | ' + esc(r.reason) : '')
          : esc(r.reason || '');
        return `
          <tr>
            <td data-label="Employee">${esc(r.first_name)} ${esc(r.last_name)}</td>
            <td data-label="Type"><span class="badge badge-${typeBadge}">${typeLabel}</span></td>
            <td data-label="${isPunch ? 'Date' : 'Days'}" class="text-right">${isPunch ? esc(r.punch_date) : r.days_requested}</td>
            <td data-label="${isPunch ? 'Clock-In' : 'Start'}">${isPunch ? esc(r.clock_in) : esc(r.start_date)}</td>
            <td data-label="${isPunch ? 'Clock-Out' : 'End'}">${isPunch ? esc(r.clock_out) : esc(r.end_date)}</td>
            <td data-label="Reason">${reasonText}</td>
            <td data-label="Status"><span class="badge badge-${esc(r.status)}">${esc(r.status)}</span></td>
            <td>
              ${r.status === 'pending' ? `
                <button class="btn btn-sm btn-success" onclick="reviewRequest(${Number(r.id)}, 'approve')">Approve</button>
                <button class="btn btn-sm btn-danger" onclick="reviewRequest(${Number(r.id)}, 'reject')">Reject</button>
              ` : (r.reviewed_by ? `by ${esc(r.reviewed_by)}` : '')}
            </td>
          </tr>
        `;
      }).join('') :
      '<tr><td colspan="8" style="text-align:center; color:var(--text-light);">No requests found</td></tr>';
  } catch (err) {
    console.error('Failed to load requests:', err);
  }
}

async function reviewRequest(id, action) {
  if (!confirm(`Are you sure you want to ${action} this request?`)) return;
  try {
    const res = await fetch(`/api/requests/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!res.ok) {
      alert('Error: ' + (data.error || 'Failed to process request'));
      return;
    }
    loadRequests();
    loadDashboard();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Time-Off Recording ──────────────────────────────────────────────
let toEmpSearch = null;
async function loadTimeOffForm() {
  try {
    const showInactive = document.getElementById('toShowInactive')?.checked;
    const url = showInactive ? '/api/employees' : '/api/employees?status=active';
    const res = await fetch(url);
    const emps = await res.json();
    const select = document.getElementById('toEmployee');
    const prev = select.value;
    select.innerHTML = '<option value="">Select employee...</option>' +
      emps.map(e => `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}${e.status === 'inactive' ? ' (inactive)' : ''}</option>`).join('');
    if (prev) select.value = prev;
    if (!toEmpSearch) {
      toEmpSearch = makeSearchable(select, { placeholder: 'Search employee...' });
    } else {
      toEmpSearch.refresh();
    }
    onTimeOffTypeChange();
  } catch (err) {
    console.error('Failed to load time-off form:', err);
  }
}

function onTimeOffTypeChange() {
  const type = document.getElementById('toType').value;
  const btn = document.getElementById('liquidateAllBtn');
  btn.style.display = type === 'vacation_liquidation' ? '' : 'none';

  if (type === 'vacation_liquidation') {
    document.getElementById('toNotes').value = document.getElementById('toNotes').value || 'Vacation liquidation (payout)';
  }
}

async function fillVacationBalance() {
  const empId = document.getElementById('toEmployee').value;
  if (!empId) { alert('Please select an employee first.'); return; }

  const res = await fetch(`/api/accruals/detail/${empId}`);
  const data = await res.json();

  const totalVac = data.months.reduce((s, m) => s + (m.vacation_days_earned || 0), 0);
  const vacTaken = data.timeOff.filter(t => t.type === 'vacation').reduce((s, t) => s + t.days_taken, 0);
  const balance = Math.round((totalVac - vacTaken) * 100) / 100;

  if (balance <= 0) {
    alert('This employee has no vacation balance to liquidate.');
    return;
  }

  document.getElementById('toDays').value = balance;
}

async function submitTimeOff(e) {
  e.preventDefault();
  const rawType = document.getElementById('toType').value;
  const body = {
    employee_id: parseInt(document.getElementById('toEmployee').value),
    type: rawType === 'vacation_liquidation' ? 'vacation' : rawType,
    days_taken: parseFloat(document.getElementById('toDays').value),
    date_taken: document.getElementById('toDate').value,
    notes: document.getElementById('toNotes').value || (rawType === 'vacation_liquidation' ? 'Vacation liquidation (payout)' : '')
  };

  const res = await fetch('/api/accruals/record-timeoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (data.success) {
    alert(rawType === 'vacation_liquidation' ? 'Vacation liquidation recorded.' : 'Time-off recorded successfully.');
    document.getElementById('timeOffForm').reset();
    onTimeOffTypeChange();
  } else {
    alert('Error: ' + data.error);
  }
}

// ── Recalculate ─────────────────────────────────────────────────────
async function recalculate() {
  if (!confirm('Recalculate all accruals? This may take a moment.')) return;
  const res = await fetch('/api/accruals/recalculate', { method: 'POST' });
  const data = await res.json();
  alert(`Recalculation complete. ${data.processed} accruals processed.`);
  loadDashboard();
}

// ── User Accounts Tab ───────────────────────────────────────────────
let accountsData = [];

async function loadAccounts() {
  try {
    const res = await fetch('/api/auth/users');
    accountsData = await res.json();
    renderAccounts();
  } catch (err) {
    console.error('Failed to load accounts:', err);
  }
}

function renderAccounts() {
  document.getElementById('accountsBody').innerHTML = accountsData.map(u => `
    <tr>
      <td data-label="PIN"><strong>${esc(u.username)}</strong></td>
      <td data-label="Employee">${u.first_name ? esc(u.first_name) + ' ' + esc(u.last_name) : '<em style="color:var(--text-light);">N/A</em>'}</td>
      <td data-label="Role"><span class="badge badge-${u.role === 'admin' ? 'active' : 'pending'}">${esc(u.role)}</span></td>
      <td data-label="Password">${u.role === 'admin' ? '-' : (u.must_change_password ? '<span class="badge badge-inactive">Pending setup</span>' : '<span class="badge badge-active">Set</span>')}</td>
      <td>
        ${u.role !== 'admin' ? `
          <button class="btn btn-sm" onclick="resetAccount(${Number(u.id)}, '${esc(u.username)}')">Reset</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount(${Number(u.id)}, '${esc(u.username)}')">Delete</button>
        ` : ''}
      </td>
    </tr>
  `).join('');
}

async function showCreateAccount() {
  try {
    const [empRes, acctRes] = await Promise.all([
      fetch('/api/employees?status=active'),
      fetch('/api/auth/users')
    ]);
    const employees = await empRes.json();
    const accounts = await acctRes.json();
    const linkedIds = new Set(accounts.map(a => a.employee_id).filter(Boolean));

    const select = document.getElementById('acctEmployee');
    const available = employees.filter(e => !linkedIds.has(e.id));
    select.innerHTML = '<option value="">Select employee...</option>' +
      available.map(e => `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('');

    document.getElementById('acctPin').value = '';
    document.getElementById('createAccountModal').classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load account form:', err);
  }
}

function closeCreateAccount() {
  document.getElementById('createAccountModal').classList.add('hidden');
}

async function submitCreateAccount(e) {
  e.preventDefault();
  const body = {
    employee_id: parseInt(document.getElementById('acctEmployee').value),
    username: document.getElementById('acctPin').value.trim()
  };

  if (!body.employee_id || !body.username) {
    alert('Please select an employee and enter their PIN.');
    return;
  }

  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  if (data.success) {
    closeCreateAccount();
    loadAccounts();
  } else {
    alert('Error: ' + data.error);
  }
}

async function resetAccount(id, username) {
  if (!confirm(`Reset password for ${username}? They will need to set a new password on next login.`)) return;
  const res = await fetch(`/api/auth/users/${id}/reset`, { method: 'PUT' });
  const data = await res.json();
  if (data.success) {
    alert('Password reset. Employee will set a new password on next login.');
    loadAccounts();
  } else {
    alert('Error: ' + data.error);
  }
}

async function deleteAccount(id, username) {
  if (!confirm(`Delete account for ${username}? This cannot be undone.`)) return;
  const res = await fetch(`/api/auth/users/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.success) {
    loadAccounts();
  } else {
    alert('Error: ' + data.error);
  }
}

// ── Change Password Modal ───────────────────────────────────────────
function showChangePassword() {
  document.getElementById('changePasswordForm').reset();
  document.getElementById('cpError').style.display = 'none';
  document.getElementById('changePasswordModal').classList.remove('hidden');
}

function closeChangePassword() {
  document.getElementById('changePasswordModal').classList.add('hidden');
}

async function submitChangePassword(e) {
  e.preventDefault();
  const errorEl = document.getElementById('cpError');
  errorEl.style.display = 'none';

  const currentPassword = document.getElementById('cpCurrent').value;
  const newPassword = document.getElementById('cpNew').value;
  const confirmPassword = document.getElementById('cpConfirm').value;

  if (newPassword.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    errorEl.style.display = 'block';
    return;
  }
  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.style.display = 'block';
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });

    if (!res.ok && res.status === 401) {
      errorEl.textContent = 'Session expired. Please log out and log back in.';
      errorEl.style.display = 'block';
      return;
    }

    const data = await res.json();

    if (data.success) {
      closeChangePassword();
      alert('Password changed successfully. Use your new password next time you log in.');
    } else {
      errorEl.textContent = data.error || 'Failed to change password.';
      errorEl.style.display = 'block';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error: ' + (err.message || 'Please try again.');
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Password';
  }
}

// ── Export Menu ──────────────────────────────────────────────────────
function toggleExportMenu() {
  document.getElementById('exportMenu').classList.toggle('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#exportMenu') && !e.target.closest('[onclick*="toggleExportMenu"]')) {
    document.getElementById('exportMenu')?.classList.add('hidden');
  }
});

function exportFilteredCSV() {
  const status = document.getElementById('statusFilter').value;
  window.location.href = `/api/reports/export/csv${status ? '?status=' + encodeURIComponent(status) : ''}`;
  toggleExportMenu();
}

function exportStatement() {
  if (currentDetailId) {
    window.open(`/api/reports/export/statement/${currentDetailId}`, '_blank');
  }
}

function showYearEndExport() {
  const year = prompt('Enter year for summary:', new Date().getFullYear());
  if (year) window.open(`/api/reports/export/year-end?year=${encodeURIComponent(year)}`, '_blank');
  toggleExportMenu();
}

// ── Notification Bell ───────────────────────────────────────────────
function toggleNotifications() {
  const dropdown = document.getElementById('notifDropdown');
  dropdown.classList.toggle('hidden');
  if (!dropdown.classList.contains('hidden')) {
    notificationsRead = true;
    lastNotifCount = parseInt(document.getElementById('notifCount').textContent) || 0;
    document.getElementById('notifCount').classList.add('hidden');
    sessionStorage.setItem('notificationsRead', 'true');
    sessionStorage.setItem('lastNotifCount', String(lastNotifCount));
  }
}

function dismissAlert(id) {
  document.getElementById(id).classList.add('hidden');
  dismissedAlerts.add(id);
  sessionStorage.setItem('dismissedAlerts', JSON.stringify([...dismissedAlerts]));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#notificationBell') && !e.target.closest('#notifDropdown')) {
    document.getElementById('notifDropdown')?.classList.add('hidden');
  }
});

function buildNotifList(stats) {
  const items = [];
  if (stats.pendingRequests > 0)
    items.push({ icon: '&#128276;', text: `${stats.pendingRequests} pending request(s)`, action: "switchTab('requests')" });
  if (stats.flaggedCount > 0)
    items.push({ icon: '&#9888;', text: `${stats.flaggedCount} employee(s) flagged for review`, action: "switchTab('employees')" });
  if (stats.daysSinceImport !== null && stats.daysSinceImport > 45)
    items.push({ icon: '&#9200;', text: `Last import was ${stats.daysSinceImport} days ago`, action: "switchTab('import')" });

  const notifCountEl = document.getElementById('notifCount');
  if (items.length > 0 && (!notificationsRead || items.length > lastNotifCount)) {
    notifCountEl.textContent = items.length;
    notifCountEl.classList.remove('hidden');
    if (items.length > lastNotifCount) {
      notificationsRead = false;
    }
  } else if (items.length === 0) {
    notifCountEl.classList.add('hidden');
    notificationsRead = false;
    lastNotifCount = 0;
  }

  document.getElementById('notifList').innerHTML = items.length
    ? items.map(i => `<div class="notif-item" onclick="${i.action}; toggleNotifications();">${i.icon} ${i.text}</div>`).join('')
    : '<div class="notif-item notif-empty">No notifications</div>';
}

// ── Backup Button ───────────────────────────────────────────────────
async function triggerBackup() {
  if (!confirm('Run a database backup now?')) return;
  const btn = document.getElementById('backupBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Backing up...';
  try {
    const data = await fetchJSON('/api/dashboard/backup', { method: 'POST' });
    alert(`Backup complete: ${data.filename} (${data.sizeMB} MB)`);
    loadDashboard();
  } catch (err) {
    alert('Backup failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Backup Now';
  }
}

// ── Notification Settings Modal ─────────────────────────────────────
async function showNotifSettings() {
  document.getElementById('notifSettingsModal').classList.remove('hidden');
  try {
    const res = await fetch('/api/notifications/settings');
    const data = await res.json();
    document.getElementById('adminEmail').value = data.admin_email || '';
    document.getElementById('notifOnSubmit').checked = data.notify_on_submit !== 'false';
    document.getElementById('notifWeeklyDigest').checked = data.weekly_digest !== 'false';
    const statusEl = document.getElementById('emailConfigStatus');
    if (data.email_configured) {
      statusEl.innerHTML = '<span style="color:green;">✓ SMTP configured</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--brand-red);">✗ SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env</span>';
    }
  } catch {
    // Modal shown with defaults
  }
}

function closeNotifSettings() {
  document.getElementById('notifSettingsModal').classList.add('hidden');
}

async function saveNotifSettings(e) {
  e.preventDefault();
  const settings = {
    admin_email: document.getElementById('adminEmail').value,
    notify_on_submit: document.getElementById('notifOnSubmit').checked ? 'true' : 'false',
    weekly_digest: document.getElementById('notifWeeklyDigest').checked ? 'true' : 'false'
  };
  try {
    for (const [key, value] of Object.entries(settings)) {
      await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
    }
    alert('Notification settings saved.');
    closeNotifSettings();
  } catch {
    alert('Error saving settings.');
  }
}

async function testEmail() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res = await fetch('/api/notifications/test', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('Test email sent! Check your inbox.');
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  } catch {
    alert('Error sending test email.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Test';
  }
}

// ── Tardiness Analysis ──────────────────────────────────────────────
let tardinessTempFile = null;
let tardinessExcludedInfractions = [];
let tardinessPreviewData = null;

// Drag-and-drop for tardiness upload area
(function initTardinessDragDrop() {
  const area = document.getElementById('tardinessUploadArea');
  if (!area) return;
  area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadTardinessFile(e.dataTransfer.files[0]);
  });
})();

function handleTardinessFile(input) {
  if (!input.files[0]) return;
  uploadTardinessFile(input.files[0]);
}

async function uploadTardinessFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const area = document.getElementById('tardinessUploadArea');
  area.style.opacity = '0.5';
  area.querySelector('.upload-label').textContent = 'Analyzing...';

  try {
    const data = await fetchJSON('/api/tardiness/preview', { method: 'POST', body: formData });
    if (!data.success) { alert('Error: ' + data.error); return; }

    const p = data.preview;

    // Stats cards
    document.getElementById('tardinessPreviewStats').innerHTML = `
      <div class="stat-card stat-card--info"><div class="label">Pay Period</div><div class="value" style="font-size:0.9rem;">${esc(p.payPeriod?.start || '?')} to ${esc(p.payPeriod?.end || '?')}</div></div>
      <div class="stat-card"><div class="label">Employees</div><div class="value">${esc(p.totalEmployees)}</div></div>
      <div class="stat-card stat-card--infraction"><div class="label">Infractions</div><div class="value">${esc(p.infractions)}</div></div>
      <div class="stat-card stat-card--flag"><div class="label">Flags</div><div class="value">${esc(p.flags)}</div></div>
      <div class="stat-card"><div class="label">Absences</div><div class="value">${esc(p.absences)}</div></div>
      <div class="stat-card stat-card--ok"><div class="label">OK</div><div class="value">${esc(p.ok)}</div></div>
    `;

    // Update section count badges
    document.getElementById('infractionCount').textContent = p.infractions || 0;
    document.getElementById('flagCountBadge').textContent = p.flags || 0;
    document.getElementById('absenceCount').textContent = p.absences || 0;

    // Store preview data for exclusion tracking
    tardinessPreviewData = p;
    tardinessExcludedInfractions = [];

    // Infractions table (with delete buttons)
    const infractions = p.infractionRecords || [];
    document.getElementById('tardinessInfractionsBody').innerHTML = infractions.length
      ? infractions.map((r, i) => `
        <tr id="infraction-row-${i}">
          <td>${esc(r.employeeName)}</td>
          <td>${esc(r.date)}</td>
          <td>${esc(r.scheduledIn || '-')}</td>
          <td>${esc(r.actualIn || '-')}</td>
          <td class="text-right" style="color:var(--brand-red); font-weight:600;">${esc(r.minutesLate)}</td>
          <td><button class="btn-remove" onclick="removePreviewInfraction(${i})" title="Remove infraction">&times;</button></td>
        </tr>`).join('')
      : `<tr><td colspan="6"><div class="empty-state"><span class="empty-state-icon">&#10003;</span><span class="empty-state-text">No infractions</span></div></td></tr>`;

    // Flags table
    const flags = p.flagRecords || [];
    document.getElementById('tardinessFlagsBody').innerHTML = flags.length
      ? flags.map(r => `
        <tr>
          <td>${esc(r.employeeName)}</td>
          <td>${esc(r.date)}</td>
          <td>${esc(r.scheduledIn || '-')}</td>
          <td>${esc(r.actualIn || '-')}</td>
          <td class="text-right" style="color:#d97706;">${esc(r.minutesLate)}</td>
        </tr>`).join('')
      : `<tr><td colspan="5"><div class="empty-state"><span class="empty-state-icon">&#128077;</span><span class="empty-state-text">No flags</span></div></td></tr>`;

    // Absences table
    const absences = p.absenceRecords || [];
    document.getElementById('tardinessAbsencesBody').innerHTML = absences.length
      ? absences.map(r => `
        <tr>
          <td>${esc(r.employeeName)}</td>
          <td>${esc(r.date)}</td>
          <td>${esc(r.scheduledIn || '-')}</td>
          <td>-</td>
        </tr>`).join('')
      : `<tr><td colspan="4"><div class="empty-state"><span class="empty-state-icon">&#128077;</span><span class="empty-state-text">No absences</span></div></td></tr>`;

    tardinessTempFile = data.tempFile;
    document.getElementById('tardinessPreview').style.display = '';
    document.getElementById('tardinessResult').style.display = 'none';
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    area.style.opacity = '';
    area.querySelector('.upload-label').textContent = 'Click to upload or drag and drop';
  }
}

async function commitTardiness(btn) {
  if (!tardinessTempFile) return;

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const data = await fetchJSON('/api/tardiness/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempFile: tardinessTempFile, excludedInfractions: tardinessExcludedInfractions })
    });

    document.getElementById('tardinessPreview').style.display = 'none';
    const resultEl = document.getElementById('tardinessResult');
    resultEl.style.display = '';

    if (data.success) {
      const r = data.report;
      const rid = encodeURIComponent(r.id);
      resultEl.innerHTML = `
        <div class="result-success">
          <div class="result-success-header">
            <span class="check-icon">&#10003;</span>
            Report Saved Successfully
          </div>
          <div style="font-size:0.8125rem; color:var(--text-secondary); margin-bottom:1rem;">
            Pay Period: <strong>${esc(r.payPeriodStart)}</strong> to <strong>${esc(r.payPeriodEnd)}</strong>
            ${data.slackSent ? ' &mdash; <span style="color:var(--success);">Slack notification sent</span>' : ''}
          </div>
          <div class="result-stats">
            <div class="result-stat"><div class="result-stat-value">${esc(r.totalEmployees)}</div><div class="result-stat-label">Employees</div></div>
            <div class="result-stat"><div class="result-stat-value" style="color:var(--brand-red);">${esc(r.infractions)}</div><div class="result-stat-label">Infractions</div></div>
            <div class="result-stat"><div class="result-stat-value" style="color:#D97706;">${esc(r.flags)}</div><div class="result-stat-label">Flags</div></div>
            <div class="result-stat"><div class="result-stat-value">${esc(r.absences)}</div><div class="result-stat-label">Absences</div></div>
          </div>
          <div class="result-actions">
            <a class="btn btn-primary" href="/api/tardiness/report/${rid}/pdf" target="_blank">Download Full Report PDF</a>
            ${r.infractions > 0 ? `<a class="btn" href="/api/tardiness/report/${rid}/infractions" target="_blank">Download Infraction Notices</a>` : ''}
            ${r.infractions > 0 ? `<button class="btn btn-notify" onclick="notifyInfractionEmployees(${esc(r.id)}, this)">Notificar Empleados</button>` : ''}
          </div>
        </div>
      `;
      loadTardinessHistory();
    } else {
      resultEl.innerHTML = `<h3 style="color:var(--danger);">Save Failed</h3><p>${esc(data.error)}</p>`;
    }

    tardinessTempFile = null;
    tardinessExcludedInfractions = [];
    tardinessPreviewData = null;
    document.getElementById('tardinessFileInput').value = '';
  } catch (err) {
    alert('Commit failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Post to Slack';
  }
}

function removePreviewInfraction(idx) {
  const infractions = tardinessPreviewData.infractionRecords || [];
  const rec = infractions[idx];
  if (!rec) return;

  // Track the exclusion, then null out to prevent double-click
  tardinessExcludedInfractions.push({ employeeName: rec.employeeName, date: rec.date });
  infractions[idx] = null;

  // Remove row from DOM with fade
  const row = document.getElementById(`infraction-row-${idx}`);
  if (row) {
    row.style.transition = 'opacity 0.3s';
    row.style.opacity = '0';
    setTimeout(() => row.remove(), 300);
  }

  // Update infraction count in stats (count non-null remaining)
  const remaining = infractions.filter(Boolean).length;
  const statCards = document.querySelectorAll('#tardinessPreviewStats .stat-card');
  for (const card of statCards) {
    if (card.querySelector('.label')?.textContent === 'Infractions') {
      card.querySelector('.value').textContent = remaining;
    }
  }
}

function cancelTardiness() {
  document.getElementById('tardinessPreview').style.display = 'none';
  tardinessTempFile = null;
  tardinessExcludedInfractions = [];
  tardinessPreviewData = null;
  document.getElementById('tardinessFileInput').value = '';
}

async function loadTardinessHistory() {
  try {
    const reports = await fetchJSON('/api/tardiness/reports');

    document.getElementById('tardinessHistoryBody').innerHTML = reports.length
      ? reports.map(r => {
        const rid = encodeURIComponent(r.id);
        return `
        <tr>
          <td data-label="Pay Period">${esc(r.pay_period_start)} to ${esc(r.pay_period_end)}</td>
          <td data-label="Employees" class="text-right">${esc(r.total_employees)}</td>
          <td data-label="Infractions" class="text-right" style="color:var(--brand-red); font-weight:600;">${esc(r.infraction_count)}</td>
          <td data-label="Flags" class="text-right" style="color:#d97706;">${esc(r.flag_count)}</td>
          <td data-label="Absences" class="text-right">${esc(r.absence_count)}</td>
          <td data-label="Uploaded">${esc(new Date(r.created_at).toLocaleDateString())}</td>
          <td>
            <div class="action-group">
              <a class="btn btn-sm" href="/api/tardiness/report/${rid}/pdf" target="_blank">Report</a>
              ${r.infraction_count > 0 ? `<a class="btn btn-sm" href="/api/tardiness/report/${rid}/infractions" target="_blank">Infractions</a>` : ''}
              ${r.infraction_count > 0 ? `<button class="btn btn-sm btn-notify" onclick="notifyInfractionEmployees(${esc(r.id)}, this)">Notificar</button>` : ''}
              <button class="btn btn-sm btn-danger" onclick="deleteTardinessReport(${esc(r.id)})">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('')
      : `<tr><td colspan="7"><div class="empty-state"><span class="empty-state-icon">&#128203;</span><span class="empty-state-text">No reports yet. Upload a Punch Variance Report to get started.</span></div></td></tr>`;
  } catch (err) {
    console.error('Failed to load tardiness history:', err);
  }
}

async function deleteTardinessReport(id) {
  if (!confirm('Delete this tardiness report and all its records? This cannot be undone.')) return;
  try {
    const data = await fetchJSON(`/api/tardiness/report/${id}`, { method: 'DELETE' });
    if (data.success) {
      loadTardinessHistory();
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function notifyInfractionEmployees(reportId, btnEl) {
  if (!confirm('Enviar DM de Slack a todos los empleados con infracciones en este reporte?')) return;
  const originalText = btnEl?.textContent || 'Notificar';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Enviando...'; }
  try {
    const data = await fetchJSON(`/api/tardiness/report/${reportId}/notify-infractions`, { method: 'POST' });

    let msg = `DMs enviados a ${data.sent.length} empleado(s).`;
    if (data.notFound.length) msg += `\n\nNo encontrados en la base de datos (${data.notFound.length}):\n${data.notFound.join('\n')}`;
    if (data.noSlackId.length) msg += `\n\nSin Slack ID configurado (${data.noSlackId.length}):\n${data.noSlackId.join('\n')}`;
    if (data.errors && data.errors.length) msg += `\n\nErrores al enviar (${data.errors.length}):\n${data.errors.join('\n')}`;
    alert(msg);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalText; }
  }
}

// ── Meal Penalty Analysis ───────────────────────────────────────────
let mealPenaltyTempFile = null;
let mealPenaltyPreviewData = null;

// Drag-and-drop for meal penalty upload area
(function initMealPenaltyDragDrop() {
  const area = document.getElementById('mealPenaltyUploadArea');
  if (!area) return;
  area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadMealPenaltyFile(e.dataTransfer.files[0]);
  });
})();

function handleMealPenaltyFile(input) {
  if (!input.files[0]) return;
  uploadMealPenaltyFile(input.files[0]);
}

async function uploadMealPenaltyFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const area = document.getElementById('mealPenaltyUploadArea');
  area.style.opacity = '0.5';
  area.querySelector('.upload-label').textContent = 'Analyzing...';

  try {
    const data = await fetchJSON('/api/meal-penalty/preview', { method: 'POST', body: formData });
    if (!data.success) { alert('Error: ' + data.error); return; }

    const p = data.preview;

    // Stats cards
    document.getElementById('mealPenaltyPreviewStats').innerHTML = `
      <div class="stat-card stat-card--info"><div class="label">Date Range</div><div class="value" style="font-size:0.9rem;">${esc(p.dateRange?.start || '?')} to ${esc(p.dateRange?.end || '?')}</div></div>
      <div class="stat-card"><div class="label">Employees</div><div class="value">${esc(p.totalEmployees)}</div></div>
      <div class="stat-card stat-card--infraction"><div class="label">Penalties</div><div class="value">${esc(p.totalPenalties)}</div></div>
      <div class="stat-card"><div class="label">With Penalties</div><div class="value">${esc(p.employeesWithPenalties)}</div></div>
      <div class="stat-card stat-card--ok"><div class="label">Clean</div><div class="value">${esc(p.employeesClean)}</div></div>
    `;

    // Update count badge
    document.getElementById('mealPenaltyCount').textContent = p.totalPenalties || 0;

    // Store preview data
    mealPenaltyPreviewData = p;

    // Penalties table
    const penalties = p.penaltyRecords || [];
    document.getElementById('mealPenaltyPreviewBody').innerHTML = penalties.length
      ? penalties.map(r => `
        <tr>
          <td>${esc(r.employeeName)}</td>
          <td>${esc(r.date)}</td>
          <td>${esc(r.shiftDetail)}</td>
          <td class="text-right" style="color:var(--brand-red); font-weight:600;">${esc(r.consecutiveFormatted)}</td>
        </tr>`).join('')
      : `<tr><td colspan="4"><div class="empty-state"><span class="empty-state-icon">&#10003;</span><span class="empty-state-text">No meal penalties found</span></div></td></tr>`;

    mealPenaltyTempFile = data.tempFile;
    document.getElementById('mealPenaltyPreview').style.display = '';
    document.getElementById('mealPenaltyResult').style.display = 'none';
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    area.style.opacity = '';
    area.querySelector('.upload-label').textContent = 'Click to upload or drag and drop';
  }
}

async function commitMealPenalty(btn) {
  if (!mealPenaltyTempFile) return;

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const data = await fetchJSON('/api/meal-penalty/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempFile: mealPenaltyTempFile })
    });

    document.getElementById('mealPenaltyPreview').style.display = 'none';
    const resultEl = document.getElementById('mealPenaltyResult');
    resultEl.style.display = '';

    if (data.success) {
      const r = data.report;
      const rid = encodeURIComponent(r.id);
      resultEl.innerHTML = `
        <div class="result-success">
          <div class="result-success-header">
            <span class="check-icon">&#10003;</span>
            Report Saved Successfully
          </div>
          <div style="font-size:0.8125rem; color:var(--text-secondary); margin-bottom:1rem;">
            Date Range: <strong>${esc(r.dateRangeStart)}</strong> to <strong>${esc(r.dateRangeEnd)}</strong>
          </div>
          <div class="result-stats">
            <div class="result-stat"><div class="result-stat-value">${esc(r.totalEmployees)}</div><div class="result-stat-label">Employees</div></div>
            <div class="result-stat"><div class="result-stat-value" style="color:var(--brand-red);">${esc(r.totalPenalties)}</div><div class="result-stat-label">Penalties</div></div>
            <div class="result-stat"><div class="result-stat-value">${esc(r.employeesWithPenalties)}</div><div class="result-stat-label">With Penalties</div></div>
            <div class="result-stat"><div class="result-stat-value" style="color:var(--success);">${esc(r.employeesClean)}</div><div class="result-stat-label">Clean</div></div>
          </div>
          <div class="result-actions">
            <a class="btn btn-primary" href="/api/meal-penalty/report/${rid}/pdf" target="_blank">Download Report PDF</a>
          </div>
        </div>
      `;
      loadMealPenaltyHistory();
    } else {
      resultEl.innerHTML = `<h3 style="color:var(--danger);">Save Failed</h3><p>${esc(data.error)}</p>`;
    }

    mealPenaltyTempFile = null;
    mealPenaltyPreviewData = null;
    document.getElementById('mealPenaltyFileInput').value = '';
  } catch (err) {
    alert('Commit failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Report';
  }
}

function cancelMealPenalty() {
  document.getElementById('mealPenaltyPreview').style.display = 'none';
  mealPenaltyTempFile = null;
  mealPenaltyPreviewData = null;
  document.getElementById('mealPenaltyFileInput').value = '';
}

async function loadMealPenaltyHistory() {
  try {
    const reports = await fetchJSON('/api/meal-penalty/reports');

    document.getElementById('mealPenaltyHistoryBody').innerHTML = reports.length
      ? reports.map(r => {
        const rid = encodeURIComponent(r.id);
        return `
        <tr>
          <td data-label="Date Range">${esc(r.date_range_start)} to ${esc(r.date_range_end)}</td>
          <td data-label="Employees" class="text-right">${esc(r.total_employees)}</td>
          <td data-label="Penalties" class="text-right" style="color:var(--brand-red); font-weight:600;">${esc(r.total_penalties)}</td>
          <td data-label="With Penalties" class="text-right">${esc(r.employees_with_penalties)}</td>
          <td data-label="Uploaded">${esc(new Date(r.created_at).toLocaleDateString())}</td>
          <td>
            <div class="action-group">
              <a class="btn btn-sm" href="/api/meal-penalty/report/${rid}/pdf" target="_blank">Report</a>
              <button class="btn btn-sm btn-danger" onclick="deleteMealPenaltyReport(${esc(r.id)})">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('')
      : `<tr><td colspan="6"><div class="empty-state"><span class="empty-state-icon">&#128203;</span><span class="empty-state-text">No reports yet. Upload an Employee Time Detail Report to get started.</span></div></td></tr>`;
  } catch (err) {
    console.error('Failed to load meal penalty history:', err);
  }
}

async function deleteMealPenaltyReport(id) {
  if (!confirm('Delete this meal penalty report and all its records? This cannot be undone.')) return;
  try {
    const data = await fetchJSON(`/api/meal-penalty/report/${id}`, { method: 'DELETE' });
    if (data.success) {
      loadMealPenaltyHistory();
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ── Reconciliation ─────────────────────────────────────────────────

// Populate year dropdown on load
// Month/year auto-detected from uploaded files — no manual picker needed

async function loadCachedStatements() {
  try {
    const cached = await fetchJSON('/api/reconciliation/cached-statements');
    const fieldMap = {
      chase: { id: 'cachedChase', label: 'Chase' },
      amexPlatinum: { id: 'cachedAmexPlatinum', label: 'AMEX Platinum' },
      amexDelta: { id: 'cachedAmexDelta', label: 'AMEX Delta' },
      banco: { id: 'cachedBanco', label: 'Banco Popular' },
    };
    for (const [field, info] of Object.entries(fieldMap)) {
      const badge = document.getElementById(info.id);
      if (!badge) continue;
      if (cached[field]) {
        const d = new Date(cached[field].modified);
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        badge.textContent = `✓ Cached (${dateStr}) — upload new to replace`;
        badge.className = 'cached-badge';
        badge.style.display = '';
      } else {
        badge.textContent = 'No cached file — upload required on first run';
        badge.className = 'cached-badge missing';
        badge.style.display = '';
      }
    }
  } catch (e) { /* ignore */ }
}

async function runReconciliation(btn) {
  const gastosInput = document.getElementById('reconGastos');
  const singleInputs = {
    chase: document.getElementById('reconChase'),
    amexPlatinum: document.getElementById('reconAmexPlat'),
    amexDelta: document.getElementById('reconAmexDelta'),
    banco: document.getElementById('reconBanco'),
  };

  if (!gastosInput.files.length) {
    alert('Please select at least one GASTOS file.');
    return;
  }

  const formData = new FormData();
  // Append each GASTOS file (supports multiple)
  for (let i = 0; i < gastosInput.files.length; i++) {
    formData.append('gastos', gastosInput.files[i]);
  }
  // Append CC/bank files only if the user selected new ones
  for (const [name, input] of Object.entries(singleInputs)) {
    if (input.files[0]) {
      formData.append(name, input.files[0]);
    }
  }

  btn.disabled = true;
  document.getElementById('reconLoading').style.display = '';
  document.getElementById('reconResult').style.display = 'none';

  try {
    const data = await fetchJSON('/api/reconciliation/run', {
      method: 'POST',
      body: formData,
    });

    document.getElementById('reconLoading').style.display = 'none';
    const resultEl = document.getElementById('reconResult');
    resultEl.style.display = '';

    if (data.success) {
      const r = data.report;
      const sizeKB = Math.round(r.fileSize / 1024);
      resultEl.innerHTML = `
        <h3 style="color:var(--success); margin-bottom:0.75rem;">Reconciliation Complete</h3>
        <p>Period: <strong>${esc(r.periodLabel)}</strong> &mdash; Report size: ${sizeKB} KB</p>
      `;
      gastosInput.value = '';
      for (const input of Object.values(singleInputs)) input.value = '';
      await loadReconHistory();   // must await so reconReportsList is fresh before opening viewer
      loadCachedStatements();
      openReconViewer(r.id, r.periodLabel);
    } else {
      resultEl.innerHTML = `<h3 style="color:var(--danger);">Reconciliation Failed</h3><p>${esc(data.error)}</p>`;
    }
  } catch (err) {
    document.getElementById('reconLoading').style.display = 'none';
    const resultEl = document.getElementById('reconResult');
    resultEl.style.display = '';
    resultEl.innerHTML = `<h3 style="color:var(--danger);">Reconciliation Failed</h3><p>${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

async function loadReconHistory() {
  try {
    const reports = await fetchJSON('/api/reconciliation/reports');
    reconReportsList = reports;
    const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    document.getElementById('reconHistoryBody').innerHTML = reports.length
      ? reports.map(r => {
        const sizeKB = Math.round(r.file_size / 1024);
        const label = `${monthNames[r.month]} ${r.year}`;
        return `
        <tr>
          <td data-label="Period">${esc(label)}</td>
          <td data-label="File Size">${sizeKB} KB</td>
          <td data-label="Generated">${esc(new Date(r.created_at).toLocaleDateString())}</td>
          <td data-label="By">${esc(r.uploaded_by || '-')}</td>
          <td>
            <div class="action-group">
              <button class="btn btn-sm btn-primary" onclick="openReconViewer(${r.id}, '${esc(label)}')">View</button>
              <button class="btn btn-sm btn-danger" onclick="deleteReconReport(${r.id})">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="5"><div class="empty-state"><span class="empty-state-icon">&#128203;</span><span class="empty-state-text">No reports yet</span></div></td></tr>';
  } catch (err) {
    console.error('Failed to load reconciliation history:', err);
  }
}

async function deleteReconReport(id) {
  if (!confirm('Delete this reconciliation report? This cannot be undone.')) return;
  try {
    const data = await fetchJSON(`/api/reconciliation/report/${id}`, { method: 'DELETE' });
    if (data.success) {
      loadReconHistory();
      // Close viewer if showing the deleted report
      const iframe = document.getElementById('reconIframe');
      if (iframe.src.includes(`/report/${id}/view`)) closeReconViewer();
    }
    else alert('Error: ' + (data.error || 'Unknown error'));
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function openReconViewer(reportId, periodLabel) {
  const viewer = document.getElementById('reconViewer');
  const iframe = document.getElementById('reconIframe');
  const title = document.getElementById('reconViewerTitle');
  const newTabLink = document.getElementById('reconNewTabLink');
  const url = `/api/reconciliation/report/${encodeURIComponent(reportId)}/view`;

  title.textContent = 'Reconciliation Report';
  newTabLink.href = url;
  iframe.src = url;
  viewer.style.display = '';

  // Reset section toggles to all checked
  document.querySelectorAll('#reconSectionPanel input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
  });
  document.getElementById('reconSectionPanel').style.display = 'none';

  // Auto-resize iframe + inject period switcher into report's internal dropdown
  iframe.onload = function() {
    try {
      const body = iframe.contentDocument.body;
      const html = iframe.contentDocument.documentElement;
      const height = Math.max(body.scrollHeight, html.scrollHeight);
      iframe.style.height = Math.max(height + 40, 600) + 'px';

      // Replace the report's internal #monthSelector with working links to other reports
      const innerSelect = iframe.contentDocument.getElementById('monthSelector');
      if (innerSelect && reconReportsList.length > 0) {
        const fullMonths = ['','January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
        const shortMonths = ['','jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

        // Build set of months that already have reports
        const reportMonthKeys = new Set(reconReportsList.map(r => `${shortMonths[r.month]}${r.year}`));

        // Scan localStorage for months with incoming moved items that don't have reports yet
        const movedMonths = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const match = key.match(/^cfa_recon_([a-z]+)(\d{4})_moved$/);
          if (!match) continue;
          const mk = match[1] + match[2];
          if (reportMonthKeys.has(mk)) continue; // already has a report
          try {
            const data = JSON.parse(localStorage.getItem(key) || '{}');
            if (data.in && data.in.length > 0) {
              const mIdx = shortMonths.indexOf(match[1]);
              if (mIdx > 0) {
                movedMonths.push({ monthKey: mk, month: mIdx, year: parseInt(match[2]), count: data.in.length });
              }
            }
          } catch(_) {}
        }
        movedMonths.sort((a, b) => a.year - b.year || a.month - b.month);

        // Build dropdown: reports first, then moved-only months
        let options = reconReportsList.map(r => {
          const lbl = `${fullMonths[r.month]} ${r.year}`;
          return `<option value="${r.id}" ${r.id === reportId ? 'selected' : ''}>${lbl}</option>`;
        }).join('');

        movedMonths.forEach(m => {
          options += `<option value="moved_${m.monthKey}">${fullMonths[m.month]} ${m.year} (${m.count} moved items)</option>`;
        });

        innerSelect.innerHTML = options;
        innerSelect.onchange = function() {
          const val = this.value;
          if (val.startsWith('moved_')) {
            alert(`This month has items moved from other periods but no report yet.\nUpload that month's GASTOS and run reconciliation to generate its report.`);
            // Reset selection to current report
            this.value = String(reportId);
          } else {
            window.switchReconPeriod(val);
          }
        };
      }
    } catch (_) {
      iframe.style.height = '85vh';
    }
  };

  // Scroll viewer into view
  viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function switchReconPeriod(id) {
  const r = reconReportsList.find(r => r.id === Number(id));
  if (!r) return;
  const mNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  openReconViewer(r.id, `${mNames[r.month]} ${r.year}`);
}

function closeReconViewer() {
  const viewer = document.getElementById('reconViewer');
  const iframe = document.getElementById('reconIframe');
  viewer.style.display = 'none';
  iframe.src = 'about:blank';
}

function toggleReconSectionPanel() {
  const panel = document.getElementById('reconSectionPanel');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
}

function toggleReconSection(checkbox) {
  const sectionId = checkbox.dataset.section;
  const visible = checkbox.checked;
  const iframe = document.getElementById('reconIframe');
  try {
    iframe.contentWindow.postMessage({
      type: 'recon-toggle-section',
      sectionId: sectionId,
      visible: visible
    }, '*');
  } catch (_) {}
}

// ── Performance Reviews ─────────────────────────────────────────────

let editingPerfReviewId = null;
let perfReviewsData = [];
let perfSortCol = 'employee_name';
let perfSortDir = 'asc';

const PERF_CATEGORIES = [
  { key: 'operations',      id: 'perfOperations',      label: 'OPS' },
  { key: 'cfa_values',      id: 'perfCfaValues',       label: 'VAL' },
  { key: 'communication',   id: 'perfCommunication',   label: 'COM' },
  { key: 'guest_obsession', id: 'perfGuestObsession',  label: 'GST' },
  { key: 'responsibility',  id: 'perfResponsibility',  label: 'RSP' },
  { key: 'culture',         id: 'perfCulture',         label: 'CUL' }
];

const SCORE_LABELS = { 1: 'Necesita Mejorar Urgente', 2: 'Necesita Mejorar', 3: 'Consistente', 4: 'Alto Desempeño', 5: 'Modelo a Seguir' };

function scoreColorClass(v) {
  if (v <= 2) return 'score-red';
  if (v <= 3) return 'score-yellow';
  return 'score-green';
}

function toggleCatAccordion(header) {
  const body = header.nextElementSibling;
  const arrow = header.querySelector('.toggle-arrow');
  body.classList.toggle('open');
  arrow.textContent = body.classList.contains('open') ? '\u25BC' : '\u25B6';
}

let perfEmployeesCache = [];

function onPerfEmployeeChange() {
  const empId = parseInt(document.getElementById('perfEmployee').value, 10);
  const emp = perfEmployeesCache.find(e => e.id === empId);
  const isBoh = emp && (emp.department === 'BOH' || (emp.department === 'BOH/FOH' && document.getElementById('perfBohToggle') && document.getElementById('perfBohToggle').value === 'BOH'));

  document.getElementById('perfOpsFOH').style.display = isBoh ? 'none' : '';
  document.getElementById('perfOpsBOH').style.display = isBoh ? '' : 'none';

  // Show BOH/FOH toggle for dual-dept employees
  const toggleRow = document.getElementById('perfBohFohToggleRow');
  if (toggleRow) {
    toggleRow.style.display = emp && emp.department === 'BOH/FOH' ? '' : 'none';
  }

  // Swap Guest Obsession label for BOH
  const guestLabel = document.getElementById('perfGuestLabel');
  if (guestLabel) {
    guestLabel.innerHTML = isBoh
      ? 'Diligencia y Sentido de Urgencia <small>Completar órdenes de invitados</small>'
      : 'Obsesión por el Invitado <small>Guest Obsession</small>';
  }

  // Swap Operations label for Trainers
  const opsLabel = document.getElementById('perfOpsLabel');
  if (opsLabel) {
    const isTrainer = emp && emp.role === 'Trainer';
    opsLabel.innerHTML = isTrainer
      ? 'Aplica su Dominio en la Operación para Enseñar Efectivamente <small>Training Effectiveness</small>'
      : 'Conoce y Ejecuta la Operación <small>Operations</small>';
  }

  if (!isBoh) {
    // Clear BOH subsection values
    ['perfBohPrimaria','perfBohSecundaria','perfBohMaquinas','perfBohBreading','perfBohFileteo','perfBohPrep','perfBohDesayuno'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  } else {
    document.getElementById('perfOperations').value = '';
  }
  updatePerfAverage();
}

function updateBohOpsAvg() {
  const ids = ['perfBohPrimaria','perfBohSecundaria','perfBohMaquinas','perfBohBreading','perfBohFileteo','perfBohPrep','perfBohDesayuno'];
  const vals = ids.map(id => parseInt(document.getElementById(id).value, 10)).filter(v => !isNaN(v));
  const display = document.getElementById('bohOpsAvgDisplay');
  if (vals.length === 7) {
    const avg = (vals.reduce((a,b) => a+b, 0) / 7).toFixed(2);
    display.textContent = `Avg: ${avg}`;
  } else {
    display.textContent = `Avg: — (${vals.length}/7)`;
  }
}

let perfEmpSearch = null;
async function loadPerformanceReviews() {
  // Populate employee dropdown
  try {
    perfEmployeesCache = await fetchJSON('/api/employees?status=active');
    const sel = document.getElementById('perfEmployee');
    sel.innerHTML = '<option value="">Select employee...</option>' +
      perfEmployeesCache.map(e => `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('');
    if (!perfEmpSearch) {
      perfEmpSearch = makeSearchable(sel, { placeholder: 'Search employee...', onChange: () => onPerfEmployeeChange() });
    } else {
      perfEmpSearch.refresh();
    }
  } catch {}

  // Populate year dropdown
  const yearSel = document.getElementById('perfYear');
  const filterYearSel = document.getElementById('perfFilterYear');
  const currentYear = new Date().getFullYear();
  if (yearSel.options.length <= 1) {
    yearSel.innerHTML = '';
    for (let y = currentYear; y >= 2026; y--) {
      yearSel.innerHTML += `<option value="${y}">${y}</option>`;
    }
  }
  if (filterYearSel.options.length <= 1) {
    filterYearSel.innerHTML = '<option value="">All Years</option>';
    for (let y = currentYear; y >= 2026; y--) {
      filterYearSel.innerHTML += `<option value="${y}">${y}</option>`;
    }
  }

  // Load reviews table
  const year = document.getElementById('perfFilterYear').value;
  const quarter = document.getElementById('perfFilterQuarter').value;
  let url = '/api/performance-reviews?';
  if (year) url += `year=${year}&`;
  if (quarter) url += `quarter=${quarter}&`;

  try {
    perfReviewsData = await fetchJSON(url);
    renderPerfReviewsTable();
  } catch (err) {
    console.error('Failed to load reviews:', err);
  }
}

function sortPerfBy(col) {
  if (perfSortCol === col) {
    perfSortDir = perfSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    perfSortCol = col;
    perfSortDir = col === 'employee_name' ? 'asc' : 'desc';
  }
  renderPerfReviewsTable();
}

function filterPerfTable() { renderPerfReviewsTable(); }

function renderPerfReviewsTable() {
  const tbody = document.getElementById('perfReviewsBody');
  const deptFilter = document.getElementById('perfFilterDept')?.value || '';

  // Filter by department
  let filtered = perfReviewsData;
  if (deptFilter) {
    filtered = perfReviewsData.filter(r => r.employee_department === deptFilter || (deptFilter !== 'BOH/FOH' && r.employee_department === 'BOH/FOH'));
  }

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; color:var(--text-light);">No reviews found</td></tr>';
    return;
  }

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let va, vb;
    if (perfSortCol === 'average') {
      va = a.average; vb = b.average;
    } else if (perfSortCol === 'overall') {
      va = a.overall_override != null ? a.overall_override : a.average;
      vb = b.overall_override != null ? b.overall_override : b.average;
    } else if (perfSortCol === 'employee_name') {
      va = (a.employee_name || '').toLowerCase();
      vb = (b.employee_name || '').toLowerCase();
    } else {
      va = a[perfSortCol] || 0; vb = b[perfSortCol] || 0;
    }
    if (va < vb) return perfSortDir === 'asc' ? -1 : 1;
    if (va > vb) return perfSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  // Update header arrows
  document.querySelectorAll('#tab-performance th[data-psort]').forEach(th => {
    const arrow = th.dataset.psort === perfSortCol ? (perfSortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
    th.querySelector('.sort-arrow').textContent = arrow;
  });

  tbody.innerHTML = sorted.map(r => {
    const avg = r.average;
    const overall = r.overall_override != null ? r.overall_override : avg;
    const escapedComments = esc((r.comments || '').replace(/'/g, "\\'"));
    return `
      <tr>
        <td data-label="Employee">${esc(r.employee_name)}</td>
        <td data-label="Dept"><span class="badge ${r.employee_department === 'BOH' ? 'badge-boh' : r.employee_department === 'BOH/FOH' ? 'badge-exempt' : 'badge-foh'}">${esc(r.employee_department || 'FOH')}</span></td>
        <td data-label="Period">Q${r.quarter} ${r.year}</td>
        <td data-label="OPS" class="text-center"><span class="perf-score-badge ${scoreColorClass(r.operations)}">${r.operations}</span></td>
        <td data-label="VAL" class="text-center"><span class="perf-score-badge ${scoreColorClass(r.cfa_values)}">${r.cfa_values}</span></td>
        <td data-label="COM" class="text-center"><span class="perf-score-badge ${scoreColorClass(r.communication)}">${r.communication}</span></td>
        <td data-label="GST" class="text-center"><span class="perf-score-badge ${scoreColorClass(r.guest_obsession)}">${r.guest_obsession}</span></td>
        <td data-label="RSP" class="text-center"><span class="perf-score-badge ${scoreColorClass(r.responsibility)}">${r.responsibility}</span></td>
        <td data-label="CUL" class="text-center"><span class="perf-score-badge ${scoreColorClass(r.culture)}">${r.culture}</span></td>
        <td data-label="Avg" class="text-center"><strong class="${scoreColorClass(avg)}">${avg.toFixed(2)}</strong></td>
        <td data-label="Overall" class="text-center"><strong class="${scoreColorClass(overall)}">${overall.toFixed(2)}</strong></td>
        <td>
          <div style="display:flex; gap:0.25rem;">
            <button class="btn btn-sm" onclick="editPerfReview(${r.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deletePerfReview(${r.id})">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function isPerfFormBoh() {
  const empId = parseInt(document.getElementById('perfEmployee').value, 10);
  const emp = perfEmployeesCache.find(e => e.id === empId);
  if (!emp) return false;
  if (emp.department === 'BOH') return true;
  if (emp.department === 'BOH/FOH') {
    const toggle = document.getElementById('perfBohToggle');
    return toggle && toggle.value === 'BOH';
  }
  return false;
}

function updatePerfAverage() {
  const isBoh = isPerfFormBoh();
  const vals = PERF_CATEGORIES.map(c => {
    if (c.id === 'perfOperations' && isBoh) {
      // Use BOH subsection average
      const bohIds = ['perfBohPrimaria','perfBohSecundaria','perfBohMaquinas','perfBohBreading','perfBohFileteo','perfBohPrep','perfBohDesayuno'];
      const bohVals = bohIds.map(id => parseInt(document.getElementById(id).value, 10)).filter(v => !isNaN(v));
      if (bohVals.length === 7) return bohVals.reduce((a,b)=>a+b,0) / 7;
      return NaN;
    }
    return parseInt(document.getElementById(c.id).value, 10);
  }).filter(v => !isNaN(v));

  const el = document.getElementById('perfAutoAvg');
  if (vals.length === 6) {
    const avg = vals.reduce((s, v) => s + v, 0) / 6;
    el.textContent = avg.toFixed(2);
    el.className = 'perf-avg-display ' + scoreColorClass(avg);
  } else {
    el.textContent = `${vals.length}/6 scored`;
    el.className = 'perf-avg-display';
  }
}

async function submitPerformanceReview(e) {
  e.preventDefault();
  const isBoh = isPerfFormBoh();
  const body = {
    employee_id: document.getElementById('perfEmployee').value,
    year: document.getElementById('perfYear').value,
    quarter: document.getElementById('perfQuarter').value,
    is_boh: isBoh,
    operations: isBoh ? '3' : document.getElementById('perfOperations').value, // placeholder for BOH; backend recalculates
    cfa_values: document.getElementById('perfCfaValues').value,
    communication: document.getElementById('perfCommunication').value,
    guest_obsession: document.getElementById('perfGuestObsession').value,
    responsibility: document.getElementById('perfResponsibility').value,
    culture: document.getElementById('perfCulture').value,
    overall_override: document.getElementById('perfOverride').value || null,
    comments: document.getElementById('perfComments').value
  };
  // Add BOH subsections if applicable
  if (isBoh) {
    body.boh_primaria = document.getElementById('perfBohPrimaria').value;
    body.boh_secundaria = document.getElementById('perfBohSecundaria').value;
    body.boh_maquinas = document.getElementById('perfBohMaquinas').value;
    body.boh_breading = document.getElementById('perfBohBreading').value;
    body.boh_fileteo = document.getElementById('perfBohFileteo').value;
    body.boh_prep = document.getElementById('perfBohPrep').value;
    body.boh_desayuno = document.getElementById('perfBohDesayuno').value;
  }

  try {
    await fetchJSON('/api/performance-reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    alert(editingPerfReviewId ? 'Review updated!' : 'Review submitted!');
    cancelPerfEdit();
    document.getElementById('perfForm').reset();
    updatePerfAverage();
    loadPerformanceReviews();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function editPerfReview(id) {
  const r = perfReviewsData.find(rv => rv.id === id);
  if (!r) return;
  editingPerfReviewId = id;
  document.getElementById('perfEmployee').value = r.employee_id;
  onPerfEmployeeChange();
  document.getElementById('perfYear').value = r.year;
  document.getElementById('perfQuarter').value = r.quarter;
  document.getElementById('perfOperations').value = r.operations;
  document.getElementById('perfCfaValues').value = r.cfa_values;
  document.getElementById('perfCommunication').value = r.communication;
  document.getElementById('perfGuestObsession').value = r.guest_obsession;
  document.getElementById('perfResponsibility').value = r.responsibility;
  document.getElementById('perfCulture').value = r.culture;
  document.getElementById('perfOverride').value = r.overall_override != null ? r.overall_override : '';
  document.getElementById('perfComments').value = r.comments || '';

  // Populate BOH subsections if present
  if (r.boh_primaria != null) {
    // If it's a BOH/FOH employee, switch toggle to BOH
    const toggle = document.getElementById('perfBohToggle');
    if (toggle && document.getElementById('perfBohFohToggleRow').style.display !== 'none') {
      toggle.value = 'BOH';
      onPerfEmployeeChange();
    }
    document.getElementById('perfBohPrimaria').value = r.boh_primaria;
    document.getElementById('perfBohSecundaria').value = r.boh_secundaria;
    document.getElementById('perfBohMaquinas').value = r.boh_maquinas;
    document.getElementById('perfBohBreading').value = r.boh_breading;
    document.getElementById('perfBohFileteo').value = r.boh_fileteo;
    document.getElementById('perfBohPrep').value = r.boh_prep;
    document.getElementById('perfBohDesayuno').value = r.boh_desayuno;
    updateBohOpsAvg();
  }

  document.getElementById('perfFormTitle').textContent = 'Edit Performance Review';
  document.getElementById('perfSubmitBtn').textContent = 'Update Review';
  document.getElementById('perfCancelEdit').style.display = '';
  updatePerfAverage();
  document.getElementById('perfForm').scrollIntoView({ behavior: 'smooth' });
}

function cancelPerfEdit() {
  editingPerfReviewId = null;
  document.getElementById('perfFormTitle').textContent = 'Submit Performance Review';
  document.getElementById('perfSubmitBtn').textContent = 'Submit Review';
  document.getElementById('perfCancelEdit').style.display = 'none';
}

async function deletePerfReview(id) {
  if (!confirm('Delete this review? This cannot be undone.')) return;
  try {
    await fetchJSON(`/api/performance-reviews/${id}`, { method: 'DELETE' });
    loadPerformanceReviews();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function exportPerformanceReviews() {
  window.location.href = '/api/performance-reviews/export';
}

// ── A&C Evaluations ──────────────────────────────────────────────────
let acGapChart = null;
let acTrendChart = null;
let acPeriodDays = 7;
let acEvalsCache = [];

function setACPeriod(days) {
  acPeriodDays = days;
  document.querySelectorAll('.ac-period-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  loadACEvals();
}

async function loadACEvals() {
  try {
    // Populate employee filter (FOH only)
    const empRes = await fetch('/api/employees?status=active');
    const emps = await empRes.json();
    const fohEmps = emps.filter(e => e.department === 'FOH' || e.department === 'BOH/FOH');
    const empSelect = document.getElementById('acEmpFilter');
    const currentVal = empSelect.value;
    empSelect.innerHTML = '<option value="">All Employees</option>' +
      fohEmps.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('');
    empSelect.value = currentVal;
    if (!window._acEmpSearch) {
      window._acEmpSearch = makeSearchable(empSelect, { placeholder: 'Filter by employee...', onChange: () => loadACEvals() });
    } else {
      window._acEmpSearch.refresh();
    }

    const empId = document.getElementById('acEmpFilter').value;
    const evalType = document.getElementById('acTypeFilter').value;

    // Load gaps
    let gapUrl = `/api/ac-evaluations/gaps?days=${acPeriodDays}`;
    if (empId) gapUrl += `&employee_id=${empId}`;
    if (evalType) gapUrl += `&eval_type=${evalType}`;
    const gapRes = await fetch(gapUrl);
    const gapData = await gapRes.json();

    // Summary stats
    document.getElementById('acSummaryStats').innerHTML = `
      <div class="stat-card"><div class="label">Total Evaluations</div><div class="value">${gapData.total_evals}</div></div>
      <div class="stat-card"><div class="label">Avg Score</div><div class="value" style="color:${gapData.avg_score >= 80 ? 'var(--brand-green)' : gapData.avg_score >= 60 ? '#eab308' : 'var(--brand-red)'};">${gapData.avg_score}%</div></div>
      <div class="stat-card"><div class="label">Biggest Gap</div><div class="value" style="font-size:0.875rem;">${gapData.gaps.length > 0 ? gapData.gaps[0].label : 'N/A'}</div></div>
    `;

    // Gap chart
    renderACGapChart(gapData.gaps);

    // Load trends
    let trendUrl = `/api/ac-evaluations/trends?days=${acPeriodDays}`;
    if (empId) trendUrl += `&employee_id=${empId}`;
    if (evalType) trendUrl += `&eval_type=${evalType}`;
    const trendRes = await fetch(trendUrl);
    const trendData = await trendRes.json();
    renderACTrendChart(trendData);

    // Load table
    let tableUrl = `/api/ac-evaluations?days=${acPeriodDays}`;
    if (empId) tableUrl += `&employee_id=${empId}`;
    if (evalType) tableUrl += `&eval_type=${evalType}`;
    const tableRes = await fetch(tableUrl);
    acEvalsCache = await tableRes.json();
    renderACTable();

  } catch (err) {
    console.error('Failed to load A&C evaluations:', err);
  }
}

function renderACGapChart(gaps) {
  const canvas = document.getElementById('acGapChart');
  if (!canvas) return;
  if (acGapChart) acGapChart.destroy();

  if (gaps.length === 0) {
    acGapChart = null;
    canvas.parentElement.innerHTML = '<p style="text-align:center; color:var(--text-light); padding:2rem;">No evaluation data for this period.</p><canvas id="acGapChart"></canvas>';
    return;
  }

  // Show top 20 worst gaps
  const topGaps = gaps.slice(0, 20);

  acGapChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: topGaps.map(g => g.label),
      datasets: [
        {
          label: 'Pass Rate %',
          data: topGaps.map(g => g.pass_rate),
          backgroundColor: topGaps.map(g => g.pass_rate >= 80 ? '#22c55e' : g.pass_rate >= 60 ? '#eab308' : '#E51636'),
          borderRadius: 4
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.raw}% pass rate (${topGaps[ctx.dataIndex].yes} yes, ${topGaps[ctx.dataIndex].no} no, ${topGaps[ctx.dataIndex].na} N/A)`
          }
        }
      },
      scales: {
        x: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
        y: { ticks: { font: { size: 11 } } }
      }
    }
  });

  // Set height based on number of gaps
  canvas.parentElement.style.height = Math.max(300, topGaps.length * 32) + 'px';
}

function renderACTrendChart(data) {
  const canvas = document.getElementById('acTrendChart');
  if (!canvas) return;
  if (acTrendChart) acTrendChart.destroy();

  if (data.length === 0) {
    if (acTrendChart) { acTrendChart.destroy(); acTrendChart = null; }
    return;
  }

  acTrendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => d.eval_date),
      datasets: [{
        label: 'Avg Score %',
        data: data.map(d => Math.round(d.avg_score * 100) / 100),
        borderColor: '#004F71',
        backgroundColor: 'rgba(0,79,113,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: '#004F71'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ctx.raw.toFixed(1) + '%' } }
      },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
        x: { ticks: { maxTicksLimit: 10 } }
      }
    }
  });
}

function renderACTable() {
  document.getElementById('acEvalsBody').innerHTML = acEvalsCache.map(ev => {
    const typeLabel = ev.eval_type === 'order_taking' ? 'Order Taking' : 'Meal Delivery';
    const locLabel = ev.location === 'front_counter' ? 'Front Counter' : 'Drive Thru';
    const scoreClass = ev.score_pct >= 80 ? 'score-green' : ev.score_pct >= 60 ? 'score-yellow' : 'score-red';
    return `
    <tr>
      <td data-label="Date">${ev.eval_date}</td>
      <td data-label="Employee">${esc(ev.employee_name)}</td>
      <td data-label="Evaluator">${esc(ev.evaluator_name)}</td>
      <td data-label="Type"><span class="badge badge-foh">${typeLabel}</span></td>
      <td data-label="Location">${locLabel}</td>
      <td data-label="Score" class="text-center"><span class="perf-score-badge ${scoreClass}">${Math.round(ev.score_pct)}%</span></td>
      <td>
        <button class="btn btn-sm" onclick="viewACEval(${ev.id})">View</button>
        <button class="btn btn-sm btn-danger" onclick="deleteACEval(${ev.id})">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function viewACEval(id) {
  const ev = acEvalsCache.find(e => e.id === id);
  if (!ev) return;
  const resp = JSON.parse(ev.responses);
  const items = Object.entries(resp).map(([k, v]) => {
    const badge = v === 'yes' ? '<span class="badge badge-active">YES</span>'
      : v === 'no' ? '<span class="badge badge-rejected">NO</span>'
      : '<span class="badge badge-cancelled">N/A</span>';
    return `<div style="display:flex; justify-content:space-between; padding:0.375rem 0; border-bottom:1px solid var(--border);">
      <span>${k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>${badge}</div>`;
  }).join('');

  const typeLabel = ev.eval_type === 'order_taking' ? 'Order Taking' : 'Meal Delivery';

  // Use a simple modal approach
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;">
      <h2>${esc(ev.employee_name)} — ${typeLabel}</h2>
      <p style="color:var(--text-light); font-size:0.8125rem;">${ev.eval_date} | ${ev.location === 'front_counter' ? 'Front Counter' : 'Drive Thru'} | Score: ${Math.round(ev.score_pct)}%</p>
      <div style="max-height:50vh; overflow-y:auto; margin:1rem 0;">${items}</div>
      ${ev.comments ? `<p style="margin-top:0.5rem; font-style:italic; color:var(--text-light);">${esc(ev.comments)}</p>` : ''}
      <div class="modal-actions"><button class="btn" onclick="this.closest('.modal-overlay').remove()">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
}

async function deleteACEval(id) {
  if (!confirm('Delete this evaluation?')) return;
  try {
    await fetch(`/api/ac-evaluations/${id}`, { method: 'DELETE' });
    loadACEvals();
  } catch (err) {
    alert('Failed to delete evaluation');
  }
}

async function exportACEvals() {
  window.location.href = '/api/ac-evaluations/export';
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Fetch JSON from the server with automatic error handling.
 * Throws a descriptive Error if the response is not 2xx.
 *
 * @param {string} url - API endpoint
 * @param {RequestInit} [opts] - Fetch options (method, headers, body, etc.)
 * @returns {Promise<any>} Parsed JSON response
 */
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = res.statusText; }
    throw new Error(msg || `Server error (${res.status})`);
  }
  return res.json();
}

/** Escape HTML to prevent XSS in template strings. */
function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Convert a <select> into a searchable dropdown.
 * Usage: makeSearchable(selectElement, { placeholder, onChange })
 * Returns an object with setValue(val) and refresh() methods.
 */
function makeSearchable(select, opts = {}) {
  const placeholder = opts.placeholder || 'Search...';
  const onChange = opts.onChange || (() => {});

  // Hide original select
  select.style.display = 'none';

  // Create wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'search-select';
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  wrapper.appendChild(input);

  const list = document.createElement('div');
  list.className = 'search-select-list';
  wrapper.appendChild(list);

  let selectedValue = select.value;
  let highlighted = -1;

  function getOptions() {
    return Array.from(select.options).filter(o => o.value);
  }

  function render(filter = '') {
    const options = getOptions();
    const term = filter.toLowerCase();
    const filtered = term ? options.filter(o => o.text.toLowerCase().includes(term)) : options;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="search-select-empty">No matches</div>';
      return;
    }

    list.innerHTML = filtered.map((o, i) => {
      const sel = o.value === selectedValue ? ' selected' : '';
      const hi = i === highlighted ? ' highlighted' : '';
      return `<div class="search-select-option${sel}${hi}" data-value="${esc(o.value)}">${esc(o.text)}</div>`;
    }).join('');

    list.querySelectorAll('.search-select-option').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        selectOption(el.dataset.value, el.textContent);
      });
    });
  }

  function selectOption(val, text) {
    selectedValue = val;
    select.value = val;
    input.value = text;
    list.classList.remove('open');
    highlighted = -1;
    onChange(val);
    select.dispatchEvent(new Event('change'));
  }

  function open() {
    render(input.value === getDisplayText() ? '' : input.value);
    list.classList.add('open');
  }

  function getDisplayText() {
    const opt = getOptions().find(o => o.value === selectedValue);
    return opt ? opt.text : '';
  }

  input.addEventListener('focus', () => {
    input.select();
    open();
  });

  input.addEventListener('input', () => {
    highlighted = -1;
    render(input.value);
    list.classList.add('open');
  });

  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.search-select-option');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('highlighted', i === highlighted));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      items.forEach((el, i) => el.classList.toggle('highlighted', i === highlighted));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted >= 0 && items[highlighted]) {
        selectOption(items[highlighted].dataset.value, items[highlighted].textContent);
      }
    } else if (e.key === 'Escape') {
      list.classList.remove('open');
      input.value = getDisplayText();
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      list.classList.remove('open');
      input.value = getDisplayText();
    }, 150);
  });

  // Public API
  return {
    setValue(val) {
      selectedValue = val;
      select.value = val;
      input.value = getDisplayText();
    },
    refresh() {
      input.value = getDisplayText();
    },
    clear() {
      selectedValue = '';
      select.value = '';
      input.value = '';
    }
  };
}

// ══════════════════════════════════════════════════════════════════════
// ── Leadership Academy (Admin) ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const LA_TIER_NAMES = { 1: "A Servant's Heart", 2: 'Emerging Servant Leader', 3: 'Business Leader', 4: 'Senior Leader' };
const LA_TIER_COLORS = { 1: '#3EB1C8', 2: '#F5A623', 3: '#8B5CF6', 4: '#E51636' };
const LA_STATUS_COLORS = { active: 'badge-active', on_hold: 'badge-pending', graduated: 'badge-exempt', withdrawn: 'badge-inactive' };
let laCandidatesCache = [];
let laResourcesCache = [];

function switchLASub(sub) {
  ['candidates', 'detail', 'resources', 'analytics'].forEach(s => {
    const el = document.getElementById('la-sub-' + s);
    if (el) el.style.display = s === sub ? '' : 'none';
  });
  document.querySelectorAll('.la-sub-nav').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`.la-sub-nav[onclick*="'${sub}'"]`);
  if (activeBtn) activeBtn.classList.add('active');
  if (sub === 'candidates') loadLACandidates();
  if (sub === 'resources') loadLAResources();
  if (sub === 'analytics') loadLAAnalytics();
}

// ── Candidates ───────────────────────────────────────────────────────
async function loadLACandidates() {
  try {
    const statusFilter = document.getElementById('laStatusFilter')?.value || '';
    const url = '/api/leadership-academy/candidates' + (statusFilter ? `?status=${statusFilter}` : '');
    const res = await fetch(url);
    laCandidatesCache = await res.json();
    renderLACandidateTable();
  } catch (err) { console.error('Failed to load LA candidates:', err); }
}

function renderLACandidateTable() {
  const body = document.getElementById('laCandidateBody');
  if (!body) return;
  body.innerHTML = laCandidatesCache.map(c => {
    const pct = c.total_count ? Math.round(c.completed_count / c.total_count * 100) : 0;
    return `<tr>
      <td data-label="Name">${esc(c.first_name)} ${esc(c.last_name)}</td>
      <td data-label="Dept"><span class="badge badge-${c.department === 'BOH' ? 'boh' : 'foh'}">${esc(c.department)}</span></td>
      <td data-label="Tier"><span class="badge" style="background:${LA_TIER_COLORS[c.current_tier]}15; color:${LA_TIER_COLORS[c.current_tier]}; font-weight:600;">Tier ${c.current_tier}</span></td>
      <td data-label="Status"><span class="badge ${LA_STATUS_COLORS[c.status] || ''}">${esc(c.status)}</span></td>
      <td data-label="Progress">
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <div style="flex:1; background:var(--border); border-radius:4px; height:8px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:${pct >= 75 ? '#22c55e' : pct >= 40 ? '#eab308' : '#E51636'}; border-radius:4px;"></div>
          </div>
          <span style="font-size:0.75rem; font-weight:600; min-width:35px;">${pct}%</span>
        </div>
      </td>
      <td data-label="Enrolled">${c.enrolled_at ? new Date(c.enrolled_at).toLocaleDateString() : 'N/A'}</td>
      <td>
        <button class="btn btn-sm" onclick="viewLACandidate(${c.id})">View</button>
        ${c.status === 'active' && c.current_tier < 4 ? `<button class="btn btn-sm btn-primary" onclick="advanceLATier(${c.id}, ${c.current_tier + 1})">Advance</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="removeLACandidate(${c.id}, '${esc(c.first_name)} ${esc(c.last_name)}')">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

let laEnrollAvailable = [];

async function showLAEnrollModal() {
  const res = await fetch('/api/employees?status=active');
  const employees = await res.json();
  const enrolled = new Set(laCandidatesCache.map(c => c.employee_id));
  laEnrollAvailable = employees.filter(e => !enrolled.has(e.id));
  document.getElementById('laEnrollDept').value = '';
  document.getElementById('laEnrollSearch').value = '';
  document.getElementById('laEnrollTarget').value = '';
  filterLAEnrollList();
  document.getElementById('laEnrollModal').classList.remove('hidden');
}

function filterLAEnrollList() {
  const dept = document.getElementById('laEnrollDept').value;
  const search = (document.getElementById('laEnrollSearch').value || '').toLowerCase();
  const sel = document.getElementById('laEnrollEmployee');

  let filtered = laEnrollAvailable;
  if (dept) {
    // Show employees matching the selected dept OR BOH/FOH (both)
    filtered = filtered.filter(e => e.department === dept || e.department === 'BOH/FOH');
  }
  if (search) {
    filtered = filtered.filter(e =>
      (e.first_name + ' ' + e.last_name).toLowerCase().includes(search) ||
      e.full_name.toLowerCase().includes(search)
    );
  }

  sel.innerHTML = '<option value="">Select employee...</option>' +
    filtered.map(e => {
      const deptBadge = e.department === 'BOH/FOH' ? '[BOH/FOH]' : '[' + e.department + ']';
      return `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)} ${deptBadge}</option>`;
    }).join('');
}

async function submitLAEnroll(e) {
  e.preventDefault();
  const employee_id = document.getElementById('laEnrollEmployee').value;
  const current_tier = parseInt(document.getElementById('laEnrollLevel').value) || 1;
  const target_ldp_date = document.getElementById('laEnrollTarget').value || null;
  if (!employee_id) return alert('Please select an employee');
  await fetch('/api/leadership-academy/candidates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: parseInt(employee_id), current_tier, target_ldp_date })
  });
  document.getElementById('laEnrollModal').classList.add('hidden');
  loadLACandidates();
}

async function advanceLATier(id, newTier) {
  if (!confirm(`Advance this candidate to ${LA_TIER_NAMES[newTier]}?`)) return;
  await fetch(`/api/leadership-academy/candidates/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_tier: newTier })
  });
  loadLACandidates();
}

async function removeLACandidate(id, name) {
  if (!confirm(`Remove ${name} from Leadership Academy? This will delete all their progress.`)) return;
  await fetch(`/api/leadership-academy/candidates/${id}`, { method: 'DELETE' });
  loadLACandidates();
}

function exportLACandidates() {
  window.location.href = '/api/leadership-academy/export';
}

// ── Candidate Detail ─────────────────────────────────────────────────
var laCurrentCandidateId = null;

async function viewLACandidate(id) {
  try {
    laCurrentCandidateId = id;
    const res = await fetch(`/api/leadership-academy/candidates/${id}`);
    const data = await res.json();
    renderLADetail(data);
    document.getElementById('laDetailBtn').style.display = '';
    switchLASub('detail');
  } catch (err) { console.error('Failed to load candidate:', err); }
}

async function loadAdminGapAnalysis() {
  if (!laCurrentCandidateId) return;
  const container = document.getElementById('laAdminGapAnalysis');
  if (!container) return;
  if (container.style.display !== 'none') { container.style.display = 'none'; return; }
  container.style.display = '';
  container.innerHTML = '<p style="text-align:center; padding:1rem; color:var(--text-light);">Generating development plan...</p>';
  try {
    const res = await fetch(`/api/leadership-academy/candidates/${laCurrentCandidateId}/gap-analysis`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    renderAdminGapAnalysis(container, data);
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    container.innerHTML = '<p style="text-align:center; padding:1rem; color:var(--danger);">Failed to load development plan.</p>';
  }
}

function renderAdminGapAnalysis(container, data) {
  const areasHtml = data.areas.map(a => {
    const color = a.pct >= 75 ? '#22c55e' : a.pct >= 50 ? '#eab308' : '#E51636';
    const strengthItems = (a.strengths || []).map(s =>
      `<div style="display:flex; align-items:center; gap:0.5rem; padding:0.375rem 0.5rem; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px;">
        <span style="color:#22c55e;">✅</span>
        <span style="font-size:0.8125rem; color:#166534;">${esc(s.code)} — ${esc(s.title)}</span>
      </div>`).join('');
    const gapItems = (a.gaps || []).map(g =>
      `<div style="display:flex; align-items:center; gap:0.5rem; padding:0.375rem 0.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:6px;">
        <span style="color:#E51636;">🎯</span>
        <span style="font-size:0.8125rem; color:#991b1b;">${esc(g.code)} — ${esc(g.title)}</span>
      </div>`).join('');
    const hasContent = strengthItems || gapItems;
    return `
      <div style="margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; padding-bottom:0.375rem; border-bottom:2px solid ${color};">
          <h4 style="margin:0; font-size:0.9375rem; color:var(--brand-navy);">${esc(a.name)}</h4>
          <span style="font-size:0.8125rem; font-weight:700; color:${color};">${a.pct}%</span>
        </div>
        ${strengthItems ? '<div style="margin-bottom:0.5rem;"><div style="font-size:0.75rem; font-weight:600; color:#15803d; margin-bottom:0.25rem;">Strengths</div><div style="display:flex; flex-direction:column; gap:0.25rem;">' + strengthItems + '</div></div>' : ''}
        ${gapItems ? '<div><div style="font-size:0.75rem; font-weight:600; color:#991b1b; margin-bottom:0.25rem;">Gaps</div><div style="display:flex; flex-direction:column; gap:0.25rem;">' + gapItems + '</div></div>' : ''}
        ${!hasContent ? '<p style="font-size:0.8125rem; color:var(--text-light); margin:0;">All in progress</p>' : ''}
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="detail-panel" id="laGapPrintArea" style="margin-bottom:1.5rem; border:2px solid var(--brand-navy);">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem;">
        <h3 style="margin:0; color:var(--brand-navy);">📊 Gaps & Strengths — ${esc(data.candidate.name || '')}</h3>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-sm" onclick="exportGapAnalysisPDF()" style="font-size:0.75rem; background:var(--brand-red); color:#fff; border:none;">📥 Download PDF</button>
          <button class="btn btn-sm" onclick="document.getElementById('laAdminGapAnalysis').style.display='none'" style="font-size:0.75rem;">✕ Close</button>
        </div>
      </div>
      ${areasHtml}
    </div>`;
}

async function exportGapAnalysisPDF() {
  const el = document.getElementById('laGapPrintArea');
  if (!el) return;
  if (typeof html2canvas === 'undefined' || typeof jspdf === 'undefined') {
    alert('PDF libraries not loaded. Please refresh the page.');
    return;
  }
  try {
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jspdf.jsPDF('p', 'mm', 'letter');
    const pageWidth = pdf.internal.pageSize.getWidth() - 20;
    const imgHeight = (canvas.height * pageWidth) / canvas.width;
    const pageHeight = pdf.internal.pageSize.getHeight() - 20;
    let y = 10;
    if (imgHeight <= pageHeight) {
      pdf.addImage(imgData, 'PNG', 10, y, pageWidth, imgHeight);
    } else {
      // Multi-page
      let remaining = imgHeight;
      while (remaining > 0) {
        pdf.addImage(imgData, 'PNG', 10, y - (imgHeight - remaining), pageWidth, imgHeight);
        remaining -= pageHeight;
        if (remaining > 0) { pdf.addPage(); y = 10; }
      }
    }
    const name = el.querySelector('h3')?.textContent?.replace('📊 Development Plan — ', '') || 'Candidate';
    pdf.save(`Development_Plan_${name.replace(/\s+/g, '_')}.pdf`);
  } catch (err) {
    console.error('PDF export error:', err);
    alert('Failed to export PDF. Please try again.');
  }
}

function renderLADetail(data) {
  const { candidate, checkpoints, resources } = data;
  const totalCP = checkpoints.length;
  const completedCP = checkpoints.filter(c => c.status === 'completed').length;
  const pct = totalCP ? Math.round(completedCP / totalCP * 100) : 0;

  // Group checkpoints by area then tier
  const areas = {};
  checkpoints.forEach(cp => {
    if (!areas[cp.area_id]) areas[cp.area_id] = { name: cp.area_name, slug: cp.area_slug, icon: cp.area_icon, tiers: {} };
    if (!areas[cp.area_id].tiers[cp.tier]) areas[cp.area_id].tiers[cp.tier] = [];
    areas[cp.area_id].tiers[cp.tier].push(cp);
  });

  const container = document.getElementById('laDetailContent');
  container.innerHTML = `
    <div class="detail-panel" style="margin-bottom:1.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
        <div>
          <h2 style="margin:0;">${esc(candidate.first_name)} ${esc(candidate.last_name)}</h2>
          <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center;">
            <span class="badge" style="background:${LA_TIER_COLORS[candidate.current_tier]}15; color:${LA_TIER_COLORS[candidate.current_tier]}; font-weight:700; font-size:0.875rem;">
              ${LA_TIER_NAMES[candidate.current_tier]}
            </span>
            <span class="badge ${LA_STATUS_COLORS[candidate.status]}">${esc(candidate.status)}</span>
            <span class="badge badge-${candidate.department === 'BOH' ? 'boh' : 'foh'}">${esc(candidate.department)}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:2rem; font-weight:700; color:var(--brand-navy);">${pct}%</div>
          <div style="font-size:0.75rem; color:var(--text-light);">${completedCP} of ${totalCP} checkpoints</div>
          <button class="btn" onclick="loadAdminGapAnalysis()" style="margin-top:0.5rem; font-size:0.8125rem; padding:0.375rem 0.75rem; background:var(--brand-navy); color:#fff; border:none; border-radius:6px; cursor:pointer;">📊 Development Plan</button>
        </div>
      </div>
      <div style="margin-top:1rem; background:var(--border); border-radius:6px; height:12px; overflow:hidden;">
        <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--brand-red), var(--brand-navy)); border-radius:6px; transition:width 0.3s;"></div>
      </div>
    </div>
    <div id="laAdminGapAnalysis" style="display:none;"></div>

    ${Object.entries(areas).map(([areaId, area]) => {
      const areaCheckpoints = checkpoints.filter(c => c.area_id === parseInt(areaId));
      const areaCompleted = areaCheckpoints.filter(c => c.status === 'completed').length;
      const areaPct = areaCheckpoints.length ? Math.round(areaCompleted / areaCheckpoints.length * 100) : 0;
      return `
      <div class="detail-panel" style="margin-bottom:1rem; padding:1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="document.getElementById('la-area-${area.slug}').style.display = document.getElementById('la-area-${area.slug}').style.display === 'none' ? '' : 'none'; this.querySelector('.toggle-arrow').textContent = document.getElementById('la-area-${area.slug}').style.display === 'none' ? '\\u25B6' : '\\u25BC';">
          <h3 style="margin:0; color:var(--brand-navy); font-size:0.9375rem;">${esc(area.name)} <span style="color:var(--text-light); font-weight:400;">(${areaCompleted}/${areaCheckpoints.length})</span></h3>
          <div style="display:flex; align-items:center; gap:0.75rem;">
            <span style="font-weight:600; font-size:0.875rem; color:${areaPct >= 75 ? '#22c55e' : areaPct >= 40 ? '#eab308' : '#E51636'};">${areaPct}%</span>
            <span class="toggle-arrow" style="font-size:1rem; color:var(--brand-navy);">&#9654;</span>
          </div>
        </div>
        <div id="la-area-${area.slug}" style="display:none; margin-top:1rem;">
          ${Object.entries(area.tiers).map(([tier, cps]) => `
            <h4 style="color:${LA_TIER_COLORS[tier]}; font-size:0.8125rem; margin:0.75rem 0 0.5rem; text-transform:uppercase; letter-spacing:0.04em;">${LA_TIER_NAMES[tier]}</h4>
            ${cps.map(cp => {
              const statusBadge = cp.status === 'completed' ? '<span class="badge badge-active">Completed</span>' :
                                  cp.status === 'in_progress' ? '<span class="badge badge-pending">In Progress</span>' :
                                  cp.status === 'na' ? '<span class="badge badge-cancelled">N/A</span>' :
                                  '<span class="badge" style="background:#f3f4f6; color:#6b7280;">Not Started</span>';
              const ratingStars = cp.rating ? '★'.repeat(cp.rating) + '☆'.repeat(4 - cp.rating) : '';
              return `
              <div style="padding:0.625rem; margin-bottom:0.375rem; background:var(--bg-alt, #f8f9fa); border:1px solid var(--border); border-radius:var(--radius-sm); ${cp.approved_at ? 'border-left:3px solid #22c55e;' : ''}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem;">
                  <div style="flex:1;">
                    <strong style="color:var(--brand-navy); font-size:0.8125rem;">${esc(cp.code)} — ${esc(cp.title)}</strong>
                    ${cp.evidence_notes ? `<div style="font-size:0.75rem; color:var(--text-light); margin-top:0.25rem;">📝 ${esc(cp.evidence_notes)}</div>` : ''}
                  </div>
                  <div style="display:flex; align-items:center; gap:0.5rem; flex-shrink:0;">
                    ${ratingStars ? `<span style="color:#eab308; font-size:0.875rem;">${ratingStars}</span>` : ''}
                    ${statusBadge}
                  </div>
                </div>
                ${!cp.approved_at ? `
                <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                  <select id="la-cp-status-${cp.id}" style="width:auto; font-size:0.75rem; padding:0.25rem;" onchange="updateLACheckpoint(${cp.id})">
                    <option value="not_started" ${cp.status === 'not_started' ? 'selected' : ''}>Not Started</option>
                    <option value="in_progress" ${cp.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                    <option value="completed" ${cp.status === 'completed' ? 'selected' : ''}>Completed</option>
                    <option value="na" ${cp.status === 'na' ? 'selected' : ''}>N/A</option>
                  </select>
                  <select id="la-cp-rating-${cp.id}" style="width:auto; font-size:0.75rem; padding:0.25rem;">
                    <option value="">Rating</option>
                    <option value="1" ${cp.rating === 1 ? 'selected' : ''}>1 — Beginning</option>
                    <option value="2" ${cp.rating === 2 ? 'selected' : ''}>2 — Developing</option>
                    <option value="3" ${cp.rating === 3 ? 'selected' : ''}>3 — Proficient</option>
                    <option value="4" ${cp.rating === 4 ? 'selected' : ''}>4 — Exemplary</option>
                  </select>
                  <input type="text" id="la-cp-notes-${cp.id}" value="${esc(cp.leader_notes || '')}" placeholder="Leader notes..." style="flex:1; font-size:0.75rem; padding:0.25rem 0.5rem; min-width:120px;">
                  <button class="btn btn-sm btn-primary" onclick="updateLACheckpoint(${cp.id})" style="font-size:0.6875rem; padding:0.25rem 0.5rem;">Save</button>
                </div>` : `
                ${cp.leader_notes ? `<div style="font-size:0.75rem; color:var(--text-light); margin-top:0.25rem;">Leader: ${esc(cp.leader_notes)}</div>` : ''}
                `}
                <div id="la-cp-resources-${cp.id}" style="margin-top:0.5rem; border-top:1px solid var(--border); padding-top:0.5rem;">
                  <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
                    <span style="font-size:0.75rem; color:var(--text-light); font-weight:600;">Linked Resources</span>
                    <button class="btn btn-sm" onclick="toggleCPResourceDropdown(${cp.id})" style="font-size:0.6875rem; padding:0.125rem 0.375rem;">&#128218; Link Resource</button>
                  </div>
                  <div id="la-cp-res-dropdown-${cp.id}" style="display:none; margin-bottom:0.5rem;">
                    <div style="display:flex; gap:0.25rem; align-items:center;">
                      <select id="la-cp-res-select-${cp.id}" style="flex:1; font-size:0.75rem; padding:0.25rem;"><option value="">Loading...</option></select>
                      <button class="btn btn-sm btn-primary" onclick="linkCPResource(${cp.id})" style="font-size:0.6875rem; padding:0.25rem 0.5rem;">Add</button>
                    </div>
                  </div>
                  <div id="la-cp-res-list-${cp.id}" style="font-size:0.75rem;">
                    <span style="color:var(--text-light);">Loading...</span>
                  </div>
                </div>
              </div>`;
            }).join('')}
          `).join('')}
        </div>
      </div>`;
    }).join('')}
  `;

  // Load linked resources for all checkpoints
  const cpIds = checkpoints.map(cp => cp.id);
  loadAllCPResources(cpIds);
}

async function updateLACheckpoint(progressId) {
  const status = document.getElementById(`la-cp-status-${progressId}`)?.value;
  const rating = document.getElementById(`la-cp-rating-${progressId}`)?.value;
  const leader_notes = document.getElementById(`la-cp-notes-${progressId}`)?.value;
  await fetch(`/api/leadership-academy/checkpoints/${progressId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, rating: rating ? parseInt(rating) : null, leader_notes })
  });
  // Refresh detail
  const candidateId = laCandidatesCache.find(c => true)?.id; // Will be refreshed from current view
  // Just show a brief confirmation
  const btn = event?.target;
  if (btn) { btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Save', 1000); }
}

// ── Checkpoint Resource Linking ─────────────────────────────────────
function loadAllCPResources(checkpointIds) {
  checkpointIds.forEach(id => loadCPResources(id));
}

async function loadCPResources(checkpointId) {
  const listEl = document.getElementById(`la-cp-res-list-${checkpointId}`);
  if (!listEl) return;
  try {
    const res = await fetch(`/api/leadership-academy/checkpoints/${checkpointId}/resources`);
    const linked = await res.json();
    if (!linked.length) {
      listEl.innerHTML = '<span style="color:var(--text-light); font-style:italic;">No resources linked.</span>';
    } else {
      const typeIcons = { book: '📖', video: '🎬', podcast: '🎧', ted_talk: '🎤', article: '📄' };
      listEl.innerHTML = linked.map(r => `
        <span style="display:inline-flex; align-items:center; gap:0.25rem; background:var(--bg-alt, #f0f4f8); border:1px solid var(--border); border-radius:4px; padding:0.125rem 0.5rem; margin:0.125rem 0.125rem 0.125rem 0; font-size:0.75rem;">
          ${typeIcons[r.type] || ''} ${esc(r.title)}
          <button onclick="unlinkCPResource(${checkpointId}, ${r.id})" style="background:none; border:none; color:#dc2626; cursor:pointer; font-size:0.875rem; padding:0 0.125rem; line-height:1;" title="Remove">&times;</button>
        </span>
      `).join('');
    }
  } catch (err) {
    listEl.innerHTML = '<span style="color:#dc2626; font-size:0.75rem;">Failed to load.</span>';
  }
}

async function toggleCPResourceDropdown(checkpointId) {
  const dd = document.getElementById(`la-cp-res-dropdown-${checkpointId}`);
  if (!dd) return;
  const isHidden = dd.style.display === 'none';
  dd.style.display = isHidden ? '' : 'none';
  if (isHidden) {
    // Populate the select with available resources
    let resources = laResourcesCache;
    if (!resources || !resources.length) {
      try {
        const res = await fetch('/api/leadership-academy/resources');
        resources = await res.json();
        laResourcesCache = resources;
      } catch { resources = []; }
    }
    const sel = document.getElementById(`la-cp-res-select-${checkpointId}`);
    if (sel) {
      sel.innerHTML = '<option value="">— Select a resource —</option>' +
        resources.map(r => `<option value="${r.id}">${esc(r.title)} (${esc(r.type)})</option>`).join('');
    }
  }
}

async function linkCPResource(checkpointId) {
  const sel = document.getElementById(`la-cp-res-select-${checkpointId}`);
  const resourceId = sel ? parseInt(sel.value) : null;
  if (!resourceId) return;
  try {
    await safeFetch(`/api/leadership-academy/checkpoints/${checkpointId}/resources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: resourceId })
    });
    document.getElementById(`la-cp-res-dropdown-${checkpointId}`).style.display = 'none';
    loadCPResources(checkpointId);
  } catch (err) {
    alert('Failed to link resource: ' + err.message);
  }
}

async function unlinkCPResource(checkpointId, resourceId) {
  try {
    await safeFetch(`/api/leadership-academy/checkpoints/${checkpointId}/resources/${resourceId}`, {
      method: 'DELETE'
    });
    loadCPResources(checkpointId);
  } catch (err) {
    alert('Failed to unlink resource: ' + err.message);
  }
}

// ── Learning Resources CMS ──────────────────────────────────────────
async function loadLAResources() {
  try {
    const res = await fetch('/api/leadership-academy/resources');
    laResourcesCache = await res.json();
    renderLAResourceTable();
  } catch (err) { console.error('Failed to load resources:', err); }
}

function renderLAResourceTable() {
  const body = document.getElementById('laResourceBody');
  if (!body) return;
  const typeIcons = { book: '📖', video: '🎬', podcast: '🎧', ted_talk: '🎤', article: '📄' };
  body.innerHTML = laResourcesCache.map(r => `
    <tr>
      <td data-label="Title">${esc(r.title)}${r.url ? ` <a href="${esc(r.url)}" target="_blank" style="font-size:0.75rem;">🔗</a>` : ''}</td>
      <td data-label="Author">${esc(r.author || '—')}</td>
      <td data-label="Type">${typeIcons[r.type] || ''} ${esc(r.type)}</td>
      <td data-label="Tier">Tier ${r.tier}</td>
      <td data-label="Required">${r.required ? '<span class="badge badge-active">Required</span>' : '<span class="badge" style="background:#f3f4f6; color:#6b7280;">Optional</span>'}</td>
      <td>
        <button class="btn btn-sm" onclick="editLAResource(${r.id})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteLAResource(${r.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function showLAResourceModal(editId) {
  document.getElementById('laResEditId').value = editId || '';
  document.getElementById('laResourceModalTitle').textContent = editId ? 'Edit Resource' : 'Add Resource';
  if (!editId) {
    ['laResTitle', 'laResAuthor', 'laResUrl', 'laResDesc', 'laResLeader'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('laResType').value = 'book';
    document.getElementById('laResTier').value = '1';
    document.getElementById('laResRequired').checked = false;
  }
  document.getElementById('laResourceModal').classList.remove('hidden');
}

function editLAResource(id) {
  const r = laResourcesCache.find(x => x.id === id);
  if (!r) return;
  document.getElementById('laResTitle').value = r.title;
  document.getElementById('laResAuthor').value = r.author || '';
  document.getElementById('laResType').value = r.type;
  document.getElementById('laResTier').value = r.tier;
  document.getElementById('laResUrl').value = r.url || '';
  document.getElementById('laResDesc').value = r.description || '';
  document.getElementById('laResLeader').value = r.thought_leader || '';
  document.getElementById('laResRequired').checked = !!r.required;
  showLAResourceModal(id);
}

async function submitLAResource(e) {
  e.preventDefault();
  const id = document.getElementById('laResEditId').value;
  const body = {
    title: document.getElementById('laResTitle').value,
    author: document.getElementById('laResAuthor').value,
    type: document.getElementById('laResType').value,
    tier: parseInt(document.getElementById('laResTier').value),
    url: document.getElementById('laResUrl').value,
    description: document.getElementById('laResDesc').value,
    thought_leader: document.getElementById('laResLeader').value,
    required: document.getElementById('laResRequired').checked ? 1 : 0,
    sort_order: 0
  };
  const url = id ? `/api/leadership-academy/resources/${id}` : '/api/leadership-academy/resources';
  await fetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('laResourceModal').classList.add('hidden');
  loadLAResources();
}

async function deleteLAResource(id) {
  if (!confirm('Delete this resource?')) return;
  await fetch(`/api/leadership-academy/resources/${id}`, { method: 'DELETE' });
  loadLAResources();
}

// ── Analytics ────────────────────────────────────────────────────────
async function loadLAAnalytics() {
  try {
    const res = await fetch('/api/leadership-academy/analytics');
    const data = await res.json();
    renderLAAnalytics(data);
  } catch (err) { console.error('Failed to load analytics:', err); }
}

function renderLAAnalytics(data) {
  const container = document.getElementById('laAnalyticsContent');
  const pipelineCounts = { 1: 0, 2: 0, 3: 0 };
  data.pipeline.forEach(p => { pipelineCounts[p.current_tier] = p.count; });

  container.innerHTML = `
    <div class="stats-grid" style="margin-bottom:1.5rem;">
      <div class="stat-card"><div class="label">Phase 1 — A Servant's Heart</div><div class="value" style="color:${LA_TIER_COLORS[1]};">${pipelineCounts[1] || 0}</div></div>
      <div class="stat-card"><div class="label">Phase 2 — Emerging Servant Leader</div><div class="value" style="color:${LA_TIER_COLORS[2]};">${pipelineCounts[2] || 0}</div></div>
      <div class="stat-card"><div class="label">Phase 3 — Business Leader</div><div class="value" style="color:${LA_TIER_COLORS[3]};">${pipelineCounts[3] || 0}</div></div>
      <div class="stat-card"><div class="label">Phase 4 — Senior Leader</div><div class="value" style="color:${LA_TIER_COLORS[4]};">${pipelineCounts[4] || 0}</div></div>
      <div class="stat-card"><div class="label">Graduated</div><div class="value" style="color:var(--brand-green);">${data.graduated}</div></div>
    </div>

    <div class="detail-panel" style="margin-bottom:1.5rem; padding:1rem;">
      <h3 style="margin:0 0 1rem; color:var(--brand-navy);">Competency Completion Rates</h3>
      ${data.competencyRates.map(cr => {
        const pct = cr.total ? Math.round(cr.completed / cr.total * 100) : 0;
        return `
        <div style="margin-bottom:0.75rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.25rem;">
            <span style="font-size:0.8125rem; font-weight:600; color:var(--text);">${esc(cr.name)}</span>
            <span style="font-size:0.8125rem; color:var(--text-light);">${cr.completed}/${cr.total} (${pct}%)</span>
          </div>
          <div style="background:var(--border); border-radius:4px; height:10px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--brand-red), var(--brand-navy)); border-radius:4px;"></div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="detail-panel" style="padding:1rem;">
      <h3 style="margin:0 0 1rem; color:var(--brand-navy);">Recent Activity</h3>
      ${data.recentActivity.length ? data.recentActivity.map(a => `
        <div style="padding:0.5rem 0; border-bottom:1px solid var(--border); font-size:0.8125rem;">
          <strong>${esc(a.first_name)} ${esc(a.last_name)}</strong> completed <strong>${esc(a.code)} — ${esc(a.title)}</strong>
          <span style="color:var(--text-light); margin-left:0.5rem;">${a.completed_date || ''}</span>
        </div>
      `).join('') : '<p style="color:var(--text-light);">No recent completions yet.</p>'}
    </div>

    ${data.velocityByTier && data.velocityByTier.length ? `
    <div class="detail-panel" style="margin-top:1.5rem; padding:1rem;">
      <h3 style="margin:0 0 1rem; color:var(--brand-navy);">Velocity by Tier</h3>
      <div class="stats-grid">
        ${data.velocityByTier.map(v => {
          const tierName = {1: 'Foundations', 2: 'Emerging Leader', 3: 'Business Leader', 4: 'Senior Leader'}[v.current_tier] || ('Tier ' + v.current_tier);
          return `<div class="stat-card">
            <div class="label">${esc(tierName)}</div>
            <div class="value" style="color:${LA_TIER_COLORS[v.current_tier] || 'var(--brand-navy)'};">${Math.round(v.avg_days)}d</div>
            <div style="font-size:0.75rem; color:var(--text-light);">${v.candidate_count} candidate${v.candidate_count !== 1 ? 's' : ''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    ${data.stalledCandidates && data.stalledCandidates.length ? `
    <div class="detail-panel" style="margin-top:1.5rem; padding:1rem;">
      <h3 style="margin:0 0 1rem; color:#dc2626;">&#9888; Stalled Candidates (&gt;30 days no activity)</h3>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr>
            <th>Name</th><th>Current Tier</th><th>Days Stalled</th><th>Progress</th>
          </tr></thead>
          <tbody>
            ${data.stalledCandidates.map(s => {
              const tierName = {1: 'Foundations', 2: 'Emerging Leader', 3: 'Business Leader', 4: 'Senior Leader'}[s.current_tier] || ('Tier ' + s.current_tier);
              const pct = s.total ? Math.round(s.completed / s.total * 100) : 0;
              return `<tr>
                <td data-label="Name"><strong>${esc(s.first_name)} ${esc(s.last_name)}</strong></td>
                <td data-label="Current Tier"><span class="badge" style="background:${LA_TIER_COLORS[s.current_tier]}15; color:${LA_TIER_COLORS[s.current_tier]};">${esc(tierName)}</span></td>
                <td data-label="Days Stalled" style="color:#dc2626; font-weight:600;">${s.days_stalled}</td>
                <td data-label="Progress">${s.completed}/${s.total} (${pct}%)</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${data.candidateVelocity && data.candidateVelocity.length ? `
    <div class="detail-panel" style="margin-top:1.5rem; padding:1rem;">
      <h3 style="margin:0 0 1rem; color:var(--brand-navy);">Candidate Velocity Leaderboard</h3>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr>
            <th>#</th><th>Name</th><th>Current Tier</th><th>Progress</th><th>Days Enrolled</th><th>Checkpoints / Week</th>
          </tr></thead>
          <tbody>
            ${data.candidateVelocity.map((cv, idx) => {
              const tierName = {1: 'Foundations', 2: 'Emerging Leader', 3: 'Business Leader', 4: 'Senior Leader'}[cv.current_tier] || ('Tier ' + cv.current_tier);
              const pct = cv.total ? Math.round(cv.completed / cv.total * 100) : 0;
              return `<tr>
                <td data-label="#">${idx + 1}</td>
                <td data-label="Name"><strong>${esc(cv.first_name)} ${esc(cv.last_name)}</strong></td>
                <td data-label="Current Tier"><span class="badge" style="background:${LA_TIER_COLORS[cv.current_tier]}15; color:${LA_TIER_COLORS[cv.current_tier]};">${esc(tierName)}</span></td>
                <td data-label="Progress">${cv.completed}/${cv.total} (${pct}%)</td>
                <td data-label="Days Enrolled">${cv.days_enrolled}</td>
                <td data-label="Checkpoints / Week" style="font-weight:700; color:var(--brand-navy);">${parseFloat(cv.checkpoints_per_week).toFixed(2)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;
}

// ══════════════════════════════════════════════════════════════════════
// EXECUTIVE SCORECARD
// ══════════════════════════════════════════════════════════════════════
// All rendering logic lives in /js/scorecard.js (ScorecardView).
// Below: admin instance + thin wrappers for data entry & tab switching.

var adminScorecard = new ScorecardView({
  monthPicker: 'scMonthPicker',
  section1: 'scSection1',
  section2: 'scSection2',
  section3: 'scSection3',
  section4: 'scSection4',
  osatSlot: 'scOsatGeneralSlot',
  salesSlot: 'scSalesTotalSlot',
  osatChart: 'scOsatTrendChart',
  salesChart: 'scSalesTrendChart',
  sosChart: 'scSosTrendChart',
  periodBtnScope: ''
});

var scConfig = null;
var scData = null;

async function loadScorecardConfig() {
  scConfig = await adminScorecard.loadConfig();
  return scConfig;
}

function setSCPeriod(period, btn) {
  adminScorecard.setPeriod(period, btn);
}

async function loadScorecard() {
  await adminScorecard.load();
  scConfig = adminScorecard.config;
  scData = adminScorecard.data;
}

function scFormatValue(key, value) {
  return adminScorecard.formatValue(key, value);
}

// ── Data Entry Modal ────────────────────────────────────────────────
function showSCDataEntry() {
  loadScorecardConfig().then(function(cfg) {
    var picker = document.getElementById('scMonthPicker');
    document.getElementById('scEntryMonth').value = picker.value || new Date().toISOString().slice(0, 7);

    var sectionNames = {
      operational_excellence: 'Hospitality & Second Mile Service',
      sales_growth: 'Ventas y Crecimiento',
      quality_brand: 'Excelencia Operacional',
      community: 'Comunidad'
    };

    var html = '';
    var sectionKeys = Object.keys(cfg.sections);
    for (var s = 0; s < sectionKeys.length; s++) {
      var secKey = sectionKeys[s];
      var metrics = cfg.sections[secKey];
      html += '<h3 style="color:var(--brand-navy); margin:1.5rem 0 0.75rem; border-bottom:2px solid var(--border); padding-bottom:0.5rem;">' + sectionNames[secKey] + '</h3>';
      html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">';
      for (var m = 0; m < metrics.length; m++) {
        var key = metrics[m];
        var label = cfg.labels[key] || key;
        var hint = '';
        if (cfg.pctMetrics.includes(key)) hint = ' (decimal, ej: 0.92)';
        if (cfg.currencyMetrics.includes(key)) hint = ' ($)';
        if (key === 'speed_of_service') hint = ' (M:SS, ej: 4:41)';
        var inputType = key === 'speed_of_service' ? 'text' : 'number';
        html += '<div class="form-group" style="margin:0;">';
        html += '<label style="font-size:0.8rem;">' + esc(label) + '<span style="color:var(--text-light); font-size:0.7rem;">' + hint + '</span></label>';
        html += '<input type="' + inputType + '" step="any" id="sc_' + key + '" style="font-size:0.875rem;" placeholder="' + (key === 'speed_of_service' ? '4:41' : '—') + '">';
        html += '</div>';
      }
      html += '</div>';
    }
    // OSAT by Weekday section
    html += '<h3 style="color:var(--brand-navy); margin:1.5rem 0 0.75rem; border-bottom:2px solid var(--border); padding-bottom:0.5rem;">OSAT por Día de la Semana</h3>';
    html += '<div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.75rem;">';
    var weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    for (var w = 0; w < weekdays.length; w++) {
      html += '<div class="form-group" style="margin:0;">';
      html += '<label style="font-size:0.8rem;">' + weekdays[w] + ' <span style="color:var(--text-light); font-size:0.7rem;">(decimal, ej: 0.85)</span></label>';
      html += '<input type="number" step="any" id="sc_weekday_' + w + '" style="font-size:0.875rem;" placeholder="—">';
      html += '</div>';
    }
    html += '</div>';

    document.getElementById('scEntryFields').innerHTML = html;

    // Pre-fill with existing data for that month
    var entryMonth = document.getElementById('scEntryMonth').value;
    if (entryMonth) {
      fetch('/api/scorecard/month/' + entryMonth).then(function(r) { return r.json(); }).then(function(rows) {
        for (var i = 0; i < rows.length; i++) {
          var inp = document.getElementById('sc_' + rows[i].metric_key);
          if (inp && rows[i].metric_value !== null) {
            if (rows[i].metric_key === 'speed_of_service') {
              var sosM = Math.floor(rows[i].metric_value / 60);
              var sosS = Math.round(rows[i].metric_value % 60);
              inp.value = sosM + ':' + String(sosS).padStart(2, '0');
            } else {
              inp.value = rows[i].metric_value;
            }
          }
        }
      });
      // Pre-fill weekday OSAT
      fetch('/api/scorecard/osat-weekday/' + entryMonth).then(function(r) { return r.json(); }).then(function(rows) {
        var weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        for (var i = 0; i < rows.length; i++) {
          var idx = weekdays.indexOf(rows[i].weekday);
          if (idx >= 0) {
            var inp = document.getElementById('sc_weekday_' + idx);
            if (inp && rows[i].osat_value !== null) inp.value = rows[i].osat_value;
          }
        }
      });
    }

    document.getElementById('scEntryModal').style.display = '';
  });
}

function reloadSCEntryData() {
  var entryMonth = document.getElementById('scEntryMonth').value;
  if (!entryMonth) return;

  // Clear all inputs
  var allKeys = Object.values(scConfig.sections).flat();
  for (var i = 0; i < allKeys.length; i++) {
    var inp = document.getElementById('sc_' + allKeys[i]);
    if (inp) inp.value = '';
  }
  for (var w = 0; w < 6; w++) {
    var wInp = document.getElementById('sc_weekday_' + w);
    if (wInp) wInp.value = '';
  }

  // Reload regular metrics
  fetch('/api/scorecard/month/' + entryMonth).then(function(r) { return r.json(); }).then(function(rows) {
    for (var i = 0; i < rows.length; i++) {
      var inp = document.getElementById('sc_' + rows[i].metric_key);
      if (inp && rows[i].metric_value !== null) inp.value = rows[i].metric_value;
    }
  });

  // Reload weekday OSAT
  var weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  fetch('/api/scorecard/osat-weekday/' + entryMonth).then(function(r) { return r.json(); }).then(function(rows) {
    for (var i = 0; i < rows.length; i++) {
      var idx = weekdays.indexOf(rows[i].weekday);
      if (idx >= 0) {
        var inp = document.getElementById('sc_weekday_' + idx);
        if (inp && rows[i].osat_value !== null) inp.value = rows[i].osat_value;
      }
    }
  });
}

function closeSCModal() {
  document.getElementById('scEntryModal').style.display = 'none';
}

async function saveSCData(e) {
  e.preventDefault();
  var month = document.getElementById('scEntryMonth').value;
  if (!month) { alert('Selecciona un mes'); return; }

  var metrics = {};
  var allKeys = Object.values(scConfig.sections).flat();
  for (var i = 0; i < allKeys.length; i++) {
    var inp = document.getElementById('sc_' + allKeys[i]);
    if (inp && inp.value !== '') {
      if (allKeys[i] === 'speed_of_service') {
        // Accept M:SS format (e.g. 4:41 → 281 seconds) or raw seconds
        var sosVal = inp.value.trim();
        if (sosVal.indexOf(':') !== -1) {
          var sosParts = sosVal.split(':');
          metrics[allKeys[i]] = parseInt(sosParts[0]) * 60 + parseInt(sosParts[1] || 0);
        } else {
          metrics[allKeys[i]] = parseFloat(sosVal);
        }
      } else {
        metrics[allKeys[i]] = parseFloat(inp.value);
      }
    }
  }

  // Collect weekday OSAT data
  var weekdayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  var weekdays = {};
  for (var w = 0; w < weekdayNames.length; w++) {
    var wInp = document.getElementById('sc_weekday_' + w);
    if (wInp && wInp.value !== '') {
      weekdays[weekdayNames[w]] = parseFloat(wInp.value);
    }
  }

  try {
    // Save regular metrics
    var res = await fetch('/api/scorecard/month/' + month, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metrics: metrics })
    });
    var data = await res.json();

    // Save weekday OSAT if any provided
    if (Object.keys(weekdays).length > 0) {
      await fetch('/api/scorecard/osat-weekday/' + month, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekdays: weekdays })
      });
    }

    if (data.success) {
      closeSCModal();
      loadScorecard();
    } else {
      alert(data.error || 'Error guardando datos');
    }
  } catch (err) {
    alert('Error de conexión');
  }
}

// ── Auto-Collect Public Metrics ─────────────────────────────────────
async function scAutoCollect() {
  const picker = document.getElementById('scMonthPicker');
  const month = picker ? picker.value : null;

  const btn = document.getElementById('scAutoCollectBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Recopilando...'; }

  // Remove any previous result panel
  var oldPanel = document.getElementById('scAutoCollectResult');
  if (oldPanel) oldPanel.remove();

  try {
    const res = await fetch('/api/scorecard/auto-collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month })
    });
    const data = await res.json();

    if (!data.success) {
      alert('Auto-collect failed: ' + (data.error || 'Unknown error'));
      return;
    }

    const labels = { google_reviews: 'Google Reviews', facebook_followers: 'Facebook Followers', instagram_followers: 'Instagram Followers' };
    const icons = { google_reviews: '⭐', facebook_followers: '👥', instagram_followers: '📸' };
    const collectedCount = Object.keys(data.collected).length;
    const failedCount = Object.keys(data.failed).length;

    // Build styled result panel
    let html = '<div id="scAutoCollectResult" style="margin:16px 0;padding:16px 20px;border-radius:8px;border:1px solid #e0e0e0;background:#fafbfc;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    html += '<h4 style="margin:0;font-size:15px;color:#333;">📊 Auto-Collect — ' + data.month + '</h4>';
    html += '<button onclick="this.closest(\'#scAutoCollectResult\').remove()" style="background:none;border:none;cursor:pointer;font-size:18px;color:#999;" title="Cerrar">&times;</button>';
    html += '</div>';

    if (collectedCount > 0) {
      html += '<div style="margin-bottom:10px;">';
      for (const [key, value] of Object.entries(data.collected)) {
        const label = labels[key] || key;
        const icon = icons[key] || '✓';
        const formatted = key.includes('followers') ? Number(value).toLocaleString() : value;
        html += '<div style="padding:6px 10px;margin:4px 0;background:#e8f5e9;border-radius:5px;color:#2e7d32;font-size:14px;">';
        html += icon + ' <strong>' + label + ':</strong> ' + formatted + ' <span style="color:#66bb6a;">✓ guardado</span></div>';
      }
      html += '</div>';
    }

    if (failedCount > 0) {
      html += '<div style="margin-bottom:10px;">';
      html += '<div style="font-size:12px;color:#666;margin-bottom:4px;font-weight:600;">Requiere entrada manual:</div>';
      for (const [key, reason] of Object.entries(data.failed)) {
        const label = labels[key] || key;
        const icon = icons[key] || '✗';
        // Simplify technical error messages for users
        let userReason = reason;
        if (reason.includes('API_KEY not configured')) userReason = 'API key no configurada';
        else if (reason.includes('Could not extract')) userReason = 'No disponible vía web — ingresar manualmente';
        html += '<div style="padding:6px 10px;margin:4px 0;background:#fff3e0;border-radius:5px;color:#e65100;font-size:14px;">';
        html += icon + ' <strong>' + label + ':</strong> ' + userReason + '</div>';
      }
      html += '</div>';
    }

    // Setup tips if nothing was collected
    if (collectedCount === 0) {
      html += '<div style="padding:10px 12px;background:#e3f2fd;border-radius:5px;font-size:13px;color:#1565c0;">';
      html += '<strong>💡 Configuración:</strong><br>';
      html += '• <strong>Google Reviews:</strong> Requiere <code>GOOGLE_PLACES_API_KEY</code> en el archivo .env del servidor (<a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#1565c0;">Google Cloud Console</a>)<br>';
      html += '• <strong>Facebook / Instagram:</strong> Estas plataformas bloquean scraping — ingresar manualmente en la tabla';
      html += '</div>';
    }

    html += '</div>';

    // Insert panel after the toolbar
    var toolbar = btn.closest('.scorecard-toolbar') || btn.parentElement;
    toolbar.insertAdjacentHTML('afterend', html);

    // Reload scorecard to show new data
    loadScorecard();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Auto-Collect'; }
  }
}

// ── Export Scorecard PDF ────────────────────────────────────────────
function exportScorecardPDF() {
  if (typeof html2canvas === 'undefined' || typeof jspdf === 'undefined') {
    alert('PDF libraries still loading. Please try again in a moment.');
    return;
  }
  var btn = document.querySelector('[onclick="exportScorecardPDF()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Generando...'; }

  var scorecardTab = document.getElementById('tab-scorecard');
  // Hide buttons from PDF
  var buttons = scorecardTab.querySelectorAll('.btn');
  buttons.forEach(function(b) { b.style.visibility = 'hidden'; });

  // Get month and period for filename
  var picker = document.getElementById('scMonthPicker');
  var monthStr = picker ? picker.value : 'scorecard';
  var periodBtn = document.querySelector('.sc-period-btn.active');
  var periodStr = periodBtn ? periodBtn.textContent.trim() : '';

  // Capture each section separately for better quality
  var sections = scorecardTab.querySelectorAll('.detail-panel');
  var pdf = new jspdf.jsPDF('p', 'mm', 'letter');
  var pageWidth = pdf.internal.pageSize.getWidth();
  var pageHeight = pdf.internal.pageSize.getHeight();
  var margin = 10;
  var usableWidth = pageWidth - margin * 2;
  var yPos = margin;

  // Add header
  pdf.setFontSize(16);
  pdf.setTextColor(0, 48, 87); // brand navy
  pdf.text('Executive Scorecard — CFA La Rambla', margin, yPos + 6);
  pdf.setFontSize(10);
  pdf.setTextColor(100, 100, 100);
  pdf.text(monthStr + (periodStr ? ' (' + periodStr + ')' : ''), margin, yPos + 12);
  yPos += 18;

  var sectionIndex = 0;

  function captureNext() {
    if (sectionIndex >= sections.length) {
      // Finish
      buttons.forEach(function(b) { b.style.visibility = ''; });
      if (btn) { btn.disabled = false; btn.innerHTML = '&#128196; Export PDF'; }
      pdf.save('Scorecard_' + monthStr + '.pdf');
      return;
    }

    var section = sections[sectionIndex];
    sectionIndex++;

    html2canvas(section, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false
    }).then(function(canvas) {
      var imgData = canvas.toDataURL('image/jpeg', 0.95);
      var imgWidth = usableWidth;
      var imgHeight = (canvas.height * imgWidth) / canvas.width;

      // Check if we need a new page
      if (yPos + imgHeight > pageHeight - margin) {
        pdf.addPage();
        yPos = margin;
      }

      // If section is taller than a full page, scale it down
      if (imgHeight > pageHeight - margin * 2) {
        var scaleFactor = (pageHeight - margin * 2) / imgHeight;
        imgWidth *= scaleFactor;
        imgHeight *= scaleFactor;
      }

      pdf.addImage(imgData, 'JPEG', margin, yPos, imgWidth, imgHeight);
      yPos += imgHeight + 5;

      captureNext();
    }).catch(function(err) {
      console.error('PDF capture error:', err);
      captureNext();
    });
  }

  captureNext();
}

// ── Bulk Upload Modal ───────────────────────────────────────────────
function showSCBulkUpload() {
  loadScorecardConfig().then(function(cfg) {
    var allKeys = Object.values(cfg.sections).flat();
    var html = allKeys.map(function(k) {
      return '<code>' + k + '</code> — ' + (cfg.labels[k] || k);
    }).join('<br>');
    document.getElementById('scValidKeys').innerHTML = html;
    document.getElementById('scBulkResult').innerHTML = '';
    document.getElementById('scBulkFile').value = '';
    document.getElementById('scBulkModal').style.display = '';
  });
}

function closeSCBulkModal() {
  document.getElementById('scBulkModal').style.display = 'none';
}

async function processSCBulkUpload() {
  var fileInput = document.getElementById('scBulkFile');
  if (!fileInput.files.length) { alert('Selecciona un archivo CSV'); return; }

  var text = await fileInput.files[0].text();
  var lines = text.trim().split('\n');
  if (lines.length < 2) { alert('El archivo debe tener al menos un encabezado y una fila de datos'); return; }

  var header = lines[0].split(',').map(function(h) { return h.trim().toLowerCase(); });
  var monthIdx = header.indexOf('month');
  var keyIdx = header.indexOf('metric_key');
  var valIdx = header.indexOf('metric_value');

  if (monthIdx === -1 || keyIdx === -1 || valIdx === -1) {
    alert('El CSV debe tener columnas: month, metric_key, metric_value');
    return;
  }

  var entries = [];
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var cols = lines[i].split(',').map(function(c) { return c.trim(); });
    entries.push({
      month: cols[monthIdx],
      metric_key: cols[keyIdx],
      metric_value: cols[valIdx] === '' ? null : parseFloat(cols[valIdx])
    });
  }

  try {
    var res = await fetch('/api/scorecard/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: entries })
    });
    var data = await res.json();
    if (data.success) {
      document.getElementById('scBulkResult').innerHTML =
        '<div style="padding:0.75rem; background:#e8f5e9; border-radius:8px; color:#2e7d32;">' +
        '&#9989; ' + data.imported + ' métricas importadas exitosamente.</div>';
      loadScorecard();
    } else {
      document.getElementById('scBulkResult').innerHTML =
        '<div style="padding:0.75rem; background:#fce4ec; border-radius:8px; color:#c62828;">' +
        'Error: ' + (data.error || 'Importación fallida') + '</div>';
    }
  } catch (err) {
    document.getElementById('scBulkResult').innerHTML =
      '<div style="padding:0.75rem; background:#fce4ec; border-radius:8px; color:#c62828;">Error de conexión</div>';
  }
}
