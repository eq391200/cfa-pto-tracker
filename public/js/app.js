/**
 * La Rambla — Restaurant Admin Hub
 *
 * Single-page app controlling all admin tabs: Dashboard, Employees,
 * Import, Time-Off, Requests, Accounts, Reports, and Settings.
 */

// ── State ───────────────────────────────────────────────────────────
let currentUser = null;
let summaryData = [];
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

// ── Initialization ──────────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login.html'; return; }
    currentUser = await res.json();
    if (currentUser.role !== 'admin') { window.location.href = '/employee.html'; return; }
    document.getElementById('userInfo').textContent = currentUser.username;
    loadDashboard();
  } catch { window.location.href = '/login.html'; }
})();

// ── Mobile Menu ─────────────────────────────────────────────────────
function toggleMobileMenu() {
  document.querySelector('.header-actions').classList.toggle('mobile-open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.header-actions') && !e.target.closest('.hamburger-btn')) {
    document.querySelector('.header-actions')?.classList.remove('mobile-open');
  }
});

// ── Tab Navigation ──────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelector('.header-actions')?.classList.remove('mobile-open');
  document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).style.display = '';
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'dashboard') loadDashboard();
  if (tab === 'employees') loadEmployees();
  if (tab === 'requests') loadRequests();
  if (tab === 'timeoff') loadTimeOffForm();
  if (tab === 'tardiness') loadTardinessHistory();
  if (tab === 'mealpenalty') loadMealPenaltyHistory();
  if (tab === 'reconciliation') loadReconHistory();
  if (tab === 'accounts') loadAccounts();
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
  const statusFilter = document.getElementById('empStatusFilter').value;

  const filtered = employeeData.filter(e => {
    if (search && !e.full_name.toLowerCase().includes(search) &&
        !e.first_name.toLowerCase().includes(search) &&
        !e.last_name.toLowerCase().includes(search)) return false;
    if (typeFilter && e.employee_type !== typeFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });

  document.getElementById('employeeBody').innerHTML = filtered.map(e => {
    const toggleTo = e.status === 'active' ? 'inactive' : 'active';
    return `
    <tr>
      <td data-label="Name">${esc(e.first_name)} ${esc(e.last_name)}</td>
      <td data-label="Type"><span class="badge badge-${esc(e.employee_type)}">${esc(e.employee_type)}</span></td>
      <td data-label="Status"><span class="badge badge-${esc(e.status)}" style="cursor:pointer;" onclick="toggleStatus(${Number(e.id)}, '${esc(toggleTo)}', 'employees')" title="Click to toggle status">${esc(e.status)}</span></td>
      <td data-label="First Clock-In">${esc(e.first_clock_in || 'N/A')}</td>
      <td data-label="Flagged">${e.flagged_for_review ? '<span class="badge badge-pending">Review</span>' : ''}</td>
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
  document.getElementById('editType').value = emp.employee_type;
  document.getElementById('editStatus').value = emp.status;
  document.getElementById('editEmail').value = emp.email || '';
  document.getElementById('editSlackId').value = emp.slack_user_id || '';
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEdit() { document.getElementById('editModal').classList.add('hidden'); }

async function saveEmployee(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  await fetch(`/api/employees/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employee_type: document.getElementById('editType').value,
      status: document.getElementById('editStatus').value,
      email: document.getElementById('editEmail').value,
      slack_user_id: document.getElementById('editSlackId').value
    })
  });
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
    employee_type: document.getElementById('addType').value,
    first_clock_in: document.getElementById('addStartDate').value
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
    alert('Employee added successfully.');
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

    // ── Duplicate warning ─────────────────────────────────────────
    const dupeEl = document.getElementById('duplicateWarning');
    if (dupeEl) dupeEl.remove(); // clear any prior warning

    if (p.duplicates && p.duplicates.count > 0) {
      const dupeNames = [...new Set(p.duplicates.details.map(d => d.name))];
      const dupeWarning = document.createElement('div');
      dupeWarning.id = 'duplicateWarning';
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
      document.getElementById('previewSection').insertBefore(
        dupeWarning,
        document.getElementById('previewSection').querySelector('button') ||
        document.getElementById('previewSection').lastChild
      );
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
      resultEl.innerHTML = `
        <h3 style="color:var(--success); margin-bottom:0.75rem;">Import Successful</h3>
        <p>New employees created: <strong>${data.employeesCreated}</strong></p>
        <p>New month records: <strong>${data.monthsInserted}</strong></p>
        ${data.monthsUpdated > 0 ? `<p style="color:var(--warning);">Overwritten month records: <strong>${data.monthsUpdated}</strong></p>` : ''}
        <p>Accruals processed: <strong>${data.accrualsProcessed}</strong></p>
        ${data.flaggedForReview > 0 ? `<p style="color:var(--warning);">Employees flagged for review: <strong>${data.flaggedForReview}</strong></p>` : ''}
      `;
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
(function initReconYearDropdown() {
  const sel = document.getElementById('reconYear');
  if (!sel) return;
  const now = new Date();
  const currentYear = now.getFullYear();
  for (let y = currentYear; y >= currentYear - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    sel.appendChild(opt);
  }
  const monthSel = document.getElementById('reconMonth');
  if (monthSel) monthSel.value = now.getMonth() + 1;
})();

async function runReconciliation(btn) {
  const month = document.getElementById('reconMonth').value;
  const year = document.getElementById('reconYear').value;

  const fileInputs = {
    gastos: document.getElementById('reconGastos'),
    chase: document.getElementById('reconChase'),
    amexPlatinum: document.getElementById('reconAmexPlat'),
    amexDelta: document.getElementById('reconAmexDelta'),
    bancoCurrent: document.getElementById('reconBancoCurrent'),
    bancoPrior: document.getElementById('reconBancoPrior'),
  };

  const missing = [];
  for (const [name, input] of Object.entries(fileInputs)) {
    if (!input.files[0]) missing.push(name);
  }
  if (missing.length > 0) {
    alert('Please select all 6 files before running. Missing: ' + missing.join(', '));
    return;
  }

  const formData = new FormData();
  formData.append('month', month);
  formData.append('year', year);
  for (const [name, input] of Object.entries(fileInputs)) {
    formData.append(name, input.files[0]);
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
        <p style="margin-bottom:1rem;">Period: <strong>${esc(r.periodLabel)}</strong> &mdash; Report size: ${sizeKB} KB</p>
        <a class="btn btn-primary" href="/api/reconciliation/report/${encodeURIComponent(r.id)}/view" target="_blank">
          Open Report
        </a>
      `;
      for (const input of Object.values(fileInputs)) input.value = '';
      loadReconHistory();
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
              <a class="btn btn-sm" href="/api/reconciliation/report/${encodeURIComponent(r.id)}/view" target="_blank">View</a>
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
    if (data.success) loadReconHistory();
    else alert('Error: ' + (data.error || 'Unknown error'));
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
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
