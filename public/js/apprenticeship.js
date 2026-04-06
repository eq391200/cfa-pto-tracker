/**
 * Apprenticeship Module — Frontend Module
 *
 * Provides the client-side logic for:
 *   - Dashboard with metric cards and enrollment table
 *   - Enrollment detail view (info, tasks, hours, RI, compliance)
 *   - Enrollment creation wizard
 *   - Timesheet import with OCR preview
 *   - Signature capture (canvas draw + photo upload)
 *   - Task sign-offs and period summaries
 *   - RI attendance logging
 *   - Compliance overview
 *   - ETA-671 PDF generation
 *   - RAPIDS CSV export
 *
 * All functions prefixed `appr` to avoid global namespace collisions.
 * DOM IDs follow pattern `appr*`.
 *
 * @module apprenticeship
 */

/* global switchTab */

// ═══════════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════════

var APPR = {
  tracks: [],
  enrollments: [],
  currentEnrollment: null,
  currentDetail: null,
  ocrResult: null,
  ocrImportId: null,
  signatureCanvas: null,
  signatureCtx: null,
  isDrawing: false,
  subTab: 'appr-dashboard',
  initialized: false,
};

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function apprEscape(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function apprFetch(url, opts) {
  const res = await fetch('/api/apprenticeship' + url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function apprFmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function apprStatusBadge(status) {
  const colors = {
    probation: '#f39c12', active: '#27ae60', suspended: '#e67e22',
    cancelled: '#c0392b', completed: '#2ecc71',
    pending: '#f39c12', complete: '#27ae60', overdue: '#c0392b',
  };
  const c = colors[status] || '#999';
  return `<span style="display:inline-block; padding:2px 8px; border-radius:12px; font-size:0.75rem; font-weight:600; color:#fff; background:${c}; text-transform:capitalize;">${apprEscape(status)}</span>`;
}

function apprPct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

function apprProgressBar(value, max, label) {
  const pct = apprPct(value, max);
  return `<div style="margin-bottom:0.5rem;">
    <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:2px;">
      <span>${apprEscape(label)}</span><span>${value}/${max} (${pct}%)</span>
    </div>
    <div style="background:#e9ecef; border-radius:4px; height:8px; overflow:hidden;">
      <div style="background:${pct>=100?'#27ae60':pct>=50?'#f39c12':'var(--brand-red)'}; height:100%; width:${Math.min(pct,100)}%; transition:width 0.3s;"></div>
    </div>
  </div>`;
}

/** Human-readable labels for compliance event types */
function apprEventLabel(eventType) {
  const labels = {
    agreement_submission: 'Agreement Submission',
    probation_evaluation: 'Probation Evaluation',
    wage_tier_advancement: 'Wage Tier Advancement',
    ri_hours_check: 'Related Instruction Hours Check',
    annual_progress_review: 'Annual Progress Review',
    status_change_notification: 'Status Change Notification',
  };
  return labels[eventType] || eventType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Return an HTML checklist for a compliance event type.
 * Each event type has specific federal/program requirements.
 */
function apprEventChecklist(eventType, enrollment) {
  const checklists = {
    agreement_submission: [
      'Apprenticeship Agreement form completed and reviewed with apprentice',
      'Apprentice signature obtained on Agreement',
      'Sponsor signature(s) obtained on Agreement',
      'Guardian signature obtained (if apprentice is a minor)',
      'Copy of Agreement provided to apprentice',
      'Agreement submitted to RAPIDS within 45 days of enrollment',
    ],
    probation_evaluation: [
      `Apprentice has completed ${enrollment.probation_hours || '—'} probation OJL hours`,
      'Performance review conducted with apprentice',
      'Journeyworker/supervisor feedback collected',
      'Decision documented: advance to Active or cancel enrollment',
      'Apprentice notified of evaluation results in writing',
    ],
    wage_tier_advancement: [
      'Verify OJL hour threshold met for next tier',
      'Confirm new wage rate per approved wage schedule',
      'Wage change form/signature completed',
      'Payroll updated to reflect new hourly rate',
      'Update current wage in Apprenticeship module',
      'Notify apprentice of wage increase in writing',
    ],
    ri_hours_check: [
      'Review RI attendance records for current period',
      'Verify minimum RI hours completed (36 hrs/quarter)',
      'Contact RI provider if hours are behind schedule',
      'Document any excused absences or make-up sessions',
      'Schedule catch-up sessions if needed',
    ],
    annual_progress_review: [
      'Calculate total OJL hours for the year',
      'Review RI course completion status',
      'Review work process task sign-off progress',
      'Conduct formal review meeting with apprentice',
      'Document progress and any areas for improvement',
      'Generate ETA-671 Progress Report (Part B)',
      'Both parties sign annual progress report',
      'Submit progress report to RAPIDS',
    ],
    status_change_notification: [
      'Document reason for status change',
      'Obtain required signatures for status change',
      'Notify DOL/Office of Apprenticeship within 45 days',
      'Update RAPIDS system with new status',
      'Notify apprentice in writing',
      'File documentation in apprentice record',
    ],
  };

  const items = checklists[eventType];
  if (!items) return '';
  return `<ul style="margin:0; padding-left:1.2rem; list-style:none;">
    ${items.map(item => `<li style="padding:1px 0;">&#9744; ${apprEscape(item)}</li>`).join('')}
  </ul>`;
}

// ═══════════════════════════════════════════════════════════════════
// INIT + SUB-TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════════

async function apprInit() {
  if (!APPR.initialized) {
    try {
      APPR.tracks = await apprFetch('/tracks');
    } catch (_) { APPR.tracks = []; }
    APPR.initialized = true;
  }
  apprSwitchSub(APPR.subTab);
}

function apprSwitchSub(sub) {
  APPR.subTab = sub;
  document.querySelectorAll('.appr-sub-tab').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.appr-sub-btn').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById(sub);
  if (panel) panel.style.display = '';
  const btn = document.querySelector(`[data-appr-sub="${sub}"]`);
  if (btn) btn.classList.add('active');

  if (sub === 'appr-dashboard') apprLoadDashboard();
  if (sub === 'appr-timesheet') apprResetTimesheet();
  if (sub === 'appr-compliance') apprLoadCompliance();
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD SUB-TAB
// ═══════════════════════════════════════════════════════════════════

async function apprLoadDashboard() {
  try {
    const [enrollments, compliance] = await Promise.all([
      apprFetch('/enrollments'),
      apprFetch('/compliance/overview'),
    ]);
    APPR.enrollments = enrollments;
    apprRenderDashboardStats(enrollments, compliance);
    apprRenderEnrollmentTable(enrollments);
  } catch (e) {
    document.getElementById('apprDashContent').innerHTML =
      `<p style="color:var(--brand-red); padding:1rem;">Error loading dashboard: ${apprEscape(e.message)}</p>`;
  }
}

function apprRenderDashboardStats(enrollments, compliance) {
  const active = enrollments.filter(e => e.status === 'active' || e.status === 'probation').length;
  const completed = enrollments.filter(e => e.status === 'completed').length;
  const overdue = compliance.overdue || 0;
  const upcoming = compliance.due_soon || 0;

  document.getElementById('apprStatActive').textContent = active;
  document.getElementById('apprStatCompleted').textContent = completed;
  document.getElementById('apprStatOverdue').textContent = overdue;
  document.getElementById('apprStatUpcoming').textContent = upcoming;

  // Color overdue red
  const overdueEl = document.getElementById('apprStatOverdue');
  overdueEl.style.color = overdue > 0 ? 'var(--brand-red)' : '#27ae60';
}

function apprRenderEnrollmentTable(enrollments) {
  const tbody = document.getElementById('apprEnrollBody');
  if (!enrollments.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:2rem; color:#999;">No enrollments yet. Click "New Enrollment" to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = enrollments.map(e => {
    const ojlPct = e.ojl_pct || 0;
    const riPct = e.ri_pct || 0;
    return `<tr style="cursor:pointer;" onclick="apprShowDetail(${e.id})">
      <td>${apprEscape(e.employee_name || 'Employee #'+e.employee_id)}</td>
      <td>${apprEscape(e.track_title)}</td>
      <td>${apprStatusBadge(e.status)}</td>
      <td>${apprFmtDate(e.enrollment_date)}</td>
      <td>
        <div style="background:#e9ecef; border-radius:4px; height:6px; width:80px; display:inline-block; vertical-align:middle;">
          <div style="background:${ojlPct>=100?'#27ae60':'var(--brand-navy)'}; height:100%; width:${Math.min(ojlPct,100)}%; border-radius:4px;"></div>
        </div>
        <span style="font-size:0.75rem; margin-left:4px;">${ojlPct}%</span>
      </td>
      <td>
        <div style="background:#e9ecef; border-radius:4px; height:6px; width:80px; display:inline-block; vertical-align:middle;">
          <div style="background:${riPct>=100?'#27ae60':'var(--brand-navy)'}; height:100%; width:${Math.min(riPct,100)}%; border-radius:4px;"></div>
        </div>
        <span style="font-size:0.75rem; margin-left:4px;">${riPct}%</span>
      </td>
      <td style="font-size:0.85rem;">${apprFmtDate(e.expected_completion_date)}</td>
      <td><button class="btn btn-sm" onclick="event.stopPropagation(); apprShowDetail(${e.id})">View</button></td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// NEW ENROLLMENT
// ═══════════════════════════════════════════════════════════════════

async function apprShowNewEnrollment() {
  // Load employees for dropdown
  let employees = [];
  try {
    const res = await fetch('/api/employees');
    if (res.ok) employees = await res.json();
  } catch(_) {}

  const trackOpts = APPR.tracks.map(t =>
    `<option value="${t.id}">${apprEscape(t.title)} (${t.approach}, ${t.term_years}yr)</option>`
  ).join('');

  const empOpts = employees.filter(e => e.status === 'active').map(e =>
    `<option value="${e.id}">${apprEscape(e.full_name)}</option>`
  ).join('');

  // Journeyworker options (supervisors/directors)
  const jwOpts = employees.filter(e => e.status === 'active' && ['Director','Senior Director','Shift Leader','Instructor'].includes(e.role)).map(e =>
    `<option value="${e.id}">${apprEscape(e.full_name)} (${e.role})</option>`
  ).join('');

  document.getElementById('apprNewModal').innerHTML = `
    <div class="modal" style="max-width:600px;">
      <h2 style="color:var(--brand-navy); margin-bottom:1rem;">&#127891; New Apprenticeship Enrollment</h2>
      <form onsubmit="event.preventDefault(); apprCreateEnrollment();">
        <div class="form-group">
          <label>Employee *</label>
          <select id="apprNewEmployee" required style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
            <option value="">Select employee...</option>${empOpts}
          </select>
        </div>
        <div class="form-group">
          <label>Track *</label>
          <select id="apprNewTrack" required onchange="apprUpdateTrackInfo()" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
            <option value="">Select track...</option>${trackOpts}
          </select>
        </div>
        <div id="apprTrackInfo" style="display:none; background:#f0f7ff; border-radius:8px; padding:1rem; margin-bottom:1rem; font-size:0.85rem;"></div>
        <div class="form-group">
          <label>Journeyworker (Supervisor)</label>
          <select id="apprNewJW" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
            <option value="">Select journeyworker...</option>${jwOpts}
          </select>
        </div>
        <div class="form-group">
          <label>Start Date *</label>
          <input type="date" id="apprNewStartDate" required value="${new Date().toISOString().slice(0,10)}" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
        </div>
        <div class="form-group">
          <label>RAPIDS Registration ID</label>
          <input type="text" id="apprNewRapids" placeholder="Optional — assigned by DOL" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
        </div>
        <div class="form-group">
          <label>Credit for Previous Hours</label>
          <input type="number" id="apprNewCreditHours" value="0" min="0" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
        </div>
        <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1.5rem;">
          <button type="button" class="btn" onclick="apprCloseModal('apprNewModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Create Enrollment</button>
        </div>
      </form>
    </div>`;
  document.getElementById('apprNewModal').classList.remove('hidden');
}

function apprUpdateTrackInfo() {
  const trackId = parseInt(document.getElementById('apprNewTrack').value);
  const info = document.getElementById('apprTrackInfo');
  const track = APPR.tracks.find(t => t.id === trackId);
  if (!track) { info.style.display = 'none'; return; }
  info.style.display = '';
  info.innerHTML = `
    <strong>${apprEscape(track.title)}</strong><br>
    <span>Approach: ${apprEscape(track.approach)} | Term: ${track.term_years} year(s)</span><br>
    <span>OJL Hours: ${track.ojl_hours_required} | RI Hours/Year: ${track.ri_hours_per_year}</span><br>
    <span>Probation: ${track.probation_hours} hours | Journeyworker Wage: $${track.journeyworker_wage}</span>
  `;
}

async function apprCreateEnrollment() {
  const data = {
    employee_id: parseInt(document.getElementById('apprNewEmployee').value),
    track_id: parseInt(document.getElementById('apprNewTrack').value),
    enrollment_date: document.getElementById('apprNewStartDate').value,
    journeyworker_id: parseInt(document.getElementById('apprNewJW').value) || null,
    rapids_apprentice_id: document.getElementById('apprNewRapids').value.trim() || null,
    credit_hours: parseInt(document.getElementById('apprNewCreditHours').value) || 0,
  };
  try {
    const result = await apprFetch('/enrollments', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
    });
    apprCloseModal('apprNewModal');
    alert('Enrollment created! ' + (result.compliance_events || 0) + ' compliance events generated.');
    apprLoadDashboard();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ENROLLMENT DETAIL
// ═══════════════════════════════════════════════════════════════════

async function apprShowDetail(id) {
  try {
    const detail = await apprFetch('/enrollments/' + id);
    APPR.currentDetail = detail;
    apprRenderDetail(detail);
    apprSwitchSub('appr-detail');
  } catch (e) {
    alert('Error loading enrollment: ' + e.message);
  }
}

function apprRenderDetail(d) {
  const el = document.getElementById('apprDetailContent');
  const e = d.enrollment;
  const p = d.progress;
  const ojlPct = p.ojl_pct || 0;
  const riPct = p.ri_pct || 0;
  const taskPct = p.tasks_total > 0 ? Math.round((p.tasks_completed / p.tasks_total) * 100) : 0;

  // Wage compliance data
  const wc = d.wageCompliance || {};
  const currentWage = d.wages ? d.wages.find(w => w.tier === e.current_wage_tier) : null;

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap;">
      <button class="btn btn-sm" onclick="apprSwitchSub('appr-dashboard')" style="margin-right:auto;">&larr; Back</button>
      <h2 style="margin:0; color:var(--brand-navy);">${apprEscape(e.employee_name || 'Apprentice')}</h2>
      ${apprStatusBadge(e.status)}
      <span style="font-size:0.85rem; color:#666;">${apprEscape(e.track_title)} &middot; Started ${apprFmtDate(e.enrollment_date)}</span>
      <div style="margin-left:auto; display:flex; gap:0.5rem;">
        ${e.status !== 'completed' && e.status !== 'cancelled' ? `
          <button class="btn btn-sm" onclick="apprShowStatusChange(${e.id}, '${e.status}')">Change Status</button>
          <button class="btn btn-sm" onclick="apprShowSignature(${e.id}, 'agreement')">&#9999;&#65039; Signature</button>
        ` : ''}
        <button class="btn btn-sm" onclick="apprDownloadETA671(${e.id})">&#128196; ETA-671</button>
      </div>
    </div>

    <!-- Three-column layout -->
    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:1.5rem;">

      <!-- COL 1: Info + Compliance -->
      <div>
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; margin-bottom:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">Enrollment Info</h3>
          <table style="width:100%; font-size:0.85rem;">
            <tr><td style="padding:4px 0; color:#666;">Track</td><td style="padding:4px 0; font-weight:600;">${apprEscape(e.track_title)}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Approach</td><td style="padding:4px 0;">${apprEscape(e.approach)}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Term</td><td style="padding:4px 0;">${e.term_years} year(s)</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Start Date</td><td style="padding:4px 0;">${apprFmtDate(e.enrollment_date)}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Expected End</td><td style="padding:4px 0;">${apprFmtDate(e.expected_completion_date)}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Wage Tier</td><td style="padding:4px 0;">Tier ${e.current_wage_tier}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Current Wage</td>
              <td style="padding:4px 0;">
                <span style="font-weight:600;${wc.isCompliant === false ? ' color:var(--danger);' : wc.isCompliant === true ? ' color:var(--success);' : ''}">
                  ${e.current_hourly_wage ? '$' + Number(e.current_hourly_wage).toFixed(2) : '—'}
                </span>
                ${wc.isCompliant === false ? ' <span style="color:var(--danger); font-size:0.75rem;">&#9888; Below minimum</span>' : ''}
                ${wc.isCompliant === true ? ' <span style="color:var(--success); font-size:0.75rem;">&#10003;</span>' : ''}
                <button class="btn btn-sm" onclick="apprShowWageEdit(${e.id})" style="margin-left:0.5rem; font-size:0.65rem; padding:2px 6px;">Edit</button>
              </td>
            </tr>
            <tr><td style="padding:4px 0; color:#666;">Required Min.</td><td style="padding:4px 0;">${wc.requiredMinimum ? '$' + Number(wc.requiredMinimum).toFixed(2) + '/hr (Tier ' + wc.tier + ')' : '—'}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Journeyworker</td><td style="padding:4px 0;">${apprEscape(e.journeyworker_name || '—')}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">RAPIDS ID</td><td style="padding:4px 0;">${apprEscape(e.rapids_apprentice_id || '—')}</td></tr>
            <tr><td style="padding:4px 0; color:#666;">Credit Hours</td><td style="padding:4px 0;">${e.credit_hours || 0}</td></tr>
          </table>
        </div>

        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">Compliance Events</h3>
          <div id="apprDetailCompliance" style="max-height:400px; overflow-y:auto;">
            ${d.compliance.length === 0 ? '<p style="color:#999; font-size:0.85rem;">No compliance events.</p>' :
              d.compliance.map(c => {
                const label = apprEventLabel(c.event_type);
                const checklist = apprEventChecklist(c.event_type, e);
                return `
                <div style="padding:0.5rem 0; border-bottom:1px solid #f0f0f0; font-size:0.8rem;">
                  <div style="display:flex; align-items:center; gap:0.5rem;">
                    ${apprStatusBadge(c.status)}
                    <div style="flex:1;">
                      <div style="font-weight:600;">${label}</div>
                      <div style="color:#999;">Due: ${apprFmtDate(c.due_date)}${c.completed_date ? ' &middot; Completed: ' + apprFmtDate(c.completed_date) : ''}</div>
                      ${c.notes ? `<div style="color:#666; font-size:0.75rem; margin-top:2px;">${apprEscape(c.notes)}</div>` : ''}
                    </div>
                    ${c.status === 'pending' ? `<button class="btn btn-sm" onclick="apprCompleteEvent(${c.id}, ${e.id})" style="font-size:0.7rem;">Complete</button>` : ''}
                  </div>
                  ${checklist && c.status === 'pending' ? `
                    <div style="margin:0.4rem 0 0 1.5rem; padding:0.4rem 0.6rem; background:#f8f9fa; border-radius:4px; font-size:0.75rem;">
                      <div style="font-weight:600; margin-bottom:0.25rem; color:var(--brand-navy);">Checklist:</div>
                      ${checklist}
                    </div>` : ''}
                </div>`;
              }).join('')}
          </div>
        </div>

        <!-- Wage Schedule & Compliance -->
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; margin-top:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">Wage Schedule</h3>
          ${d.wages && d.wages.length > 0 ? `
            <table style="width:100%; font-size:0.8rem; border-collapse:collapse;">
              <thead><tr style="border-bottom:2px solid var(--border);">
                <th style="text-align:left; padding:4px;">Tier</th>
                <th style="text-align:left; padding:4px;">OJL Hours</th>
                <th style="text-align:right; padding:4px;">Rate</th>
                <th style="text-align:center; padding:4px;">Status</th>
              </tr></thead>
              <tbody>
                ${d.wages.map(w => {
                  const isCurrent = w.tier === e.current_wage_tier;
                  const isPast = w.tier < e.current_wage_tier;
                  return `<tr style="border-bottom:1px solid #f0f0f0;${isCurrent ? ' background:#f0f7ff; font-weight:600;' : ''}">
                    <td style="padding:4px;">Tier ${w.tier}</td>
                    <td style="padding:4px;">${w.ojl_hours_from.toLocaleString()}–${w.ojl_hours_to ? w.ojl_hours_to.toLocaleString() : '∞'} hrs</td>
                    <td style="padding:4px; text-align:right;">$${Number(w.hourly_rate).toFixed(2)}/hr</td>
                    <td style="padding:4px; text-align:center;">${isCurrent ? '<span style="color:var(--brand-navy);">&#9654; Current</span>' : isPast ? '<span style="color:var(--success);">&#10003;</span>' : '<span style="color:#999;">—</span>'}</td>
                  </tr>`;
                }).join('')}
                <tr style="border-top:2px solid var(--border); font-weight:600;">
                  <td style="padding:4px;" colspan="2">Journeyworker</td>
                  <td style="padding:4px; text-align:right;">$${d.enrollment.journeyworker_wage ? Number(d.enrollment.journeyworker_wage).toFixed(2) : '—'}/hr</td>
                  <td style="padding:4px; text-align:center;">${e.status === 'completed' ? '<span style="color:var(--success);">&#10003;</span>' : ''}</td>
                </tr>
              </tbody>
            </table>
          ` : '<p style="color:#999; font-size:0.85rem;">No wage schedule defined.</p>'}
        </div>

        ${d.wageHistory && d.wageHistory.length > 0 ? `
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; margin-top:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">Wage History</h3>
          <div style="max-height:200px; overflow-y:auto;">
            ${d.wageHistory.map(wh => `
              <div style="display:flex; align-items:center; gap:0.5rem; padding:0.4rem 0; border-bottom:1px solid #f0f0f0; font-size:0.8rem;">
                <div style="flex:1;">
                  <div>${wh.previous_wage ? '$' + Number(wh.previous_wage).toFixed(2) : '—'} &rarr; <strong>$${Number(wh.new_wage).toFixed(2)}</strong></div>
                  <div style="color:#999;">${apprEscape(wh.reason.replace(/_/g, ' '))}${wh.notes ? ' — ' + apprEscape(wh.notes) : ''}</div>
                </div>
                <div style="color:#999; font-size:0.75rem; white-space:nowrap;">${apprFmtDate(wh.created_at)}</div>
              </div>
            `).join('')}
          </div>
        </div>` : ''}
      </div>

      <!-- COL 2: Task Sign-offs -->
      <div>
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">Work Process Tasks</h3>
          ${apprProgressBar(p.tasks_completed, p.tasks_total, 'Tasks Completed')}
          <div id="apprDetailTasks" style="max-height:500px; overflow-y:auto;">
            ${d.tasks.length === 0 ? '<p style="color:#999; font-size:0.85rem;">No tasks for this track.</p>' :
              apprRenderTaskList(d.tasks, e.id)}
          </div>
        </div>
      </div>

      <!-- COL 3: Hours + RI -->
      <div>
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; margin-bottom:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">OJL Hours</h3>
          ${apprProgressBar(p.ojl_hours, p.ojl_required, 'On-the-Job Learning')}
          <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
            <button class="btn btn-sm btn-primary" onclick="apprSwitchSub('appr-timesheet'); document.getElementById('apprTimesheetEnrollmentId').value=${e.id};">Import Timesheet</button>
          </div>
          <div style="margin-top:1rem;">
            <h4 style="font-size:0.85rem; color:#666; margin-bottom:0.5rem;">Recent Imports</h4>
            ${d.timesheets && d.timesheets.length > 0 ?
              d.timesheets.slice(0, 5).map(t => `
                <div style="font-size:0.8rem; padding:0.25rem 0; border-bottom:1px solid #f0f0f0;">
                  ${apprFmtDate(t.pay_period_start)} - ${apprFmtDate(t.pay_period_end)}: <strong>${t.total_hours_extracted}h</strong>
                </div>`).join('') :
              '<p style="color:#999; font-size:0.8rem;">No timesheets imported yet.</p>'}
          </div>
        </div>

        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem;">
          <h3 style="color:var(--brand-navy); font-size:1rem; margin-bottom:0.75rem;">Related Instruction</h3>
          ${apprProgressBar(p.ri_hours, p.ri_required, 'RI Hours')}
          <div id="apprDetailRI" style="margin-top:0.75rem;">
            ${d.ri_courses && d.ri_courses.length > 0 ?
              d.ri_courses.map(r => `
                <div style="display:flex; justify-content:space-between; font-size:0.8rem; padding:0.3rem 0; border-bottom:1px solid #f0f0f0;">
                  <span>${apprEscape(r.title)}</span>
                  <span style="font-weight:600;">${r.completed_hours || 0}/${r.required_hours}h</span>
                </div>`).join('') :
              '<p style="color:#999; font-size:0.8rem;">No RI courses assigned.</p>'}
          </div>
          <button class="btn btn-sm" style="margin-top:0.75rem;" onclick="apprShowRILog(${e.id})">+ Log RI Hours</button>
        </div>
      </div>
    </div>`;
}

function apprRenderTaskList(tasks, enrollmentId) {
  // Group by category
  const groups = {};
  tasks.forEach(t => {
    const cat = t.category || 'General';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(t);
  });

  return Object.entries(groups).map(([cat, items]) => {
    const done = items.filter(i => i.completed_date).length;
    return `
      <div style="margin-bottom:0.75rem;">
        <div style="font-weight:600; font-size:0.85rem; color:var(--brand-navy); margin-bottom:0.25rem; cursor:pointer;"
             onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display==='none'?'':'none';">
          ${apprEscape(cat)} (${done}/${items.length}) &#9660;
        </div>
        <div style="${done === items.length ? 'display:none;' : ''}">
          ${items.map(t => `
            <div style="display:flex; align-items:center; gap:0.5rem; padding:0.25rem 0.5rem; font-size:0.8rem; border-bottom:1px solid #f8f8f8;">
              ${t.completed_date
                ? `<span style="color:#27ae60;" title="Completed ${apprFmtDate(t.completed_date)}">&#9745;</span>`
                : `<button onclick="apprSignOffTask(${enrollmentId}, ${t.id})" style="background:none; border:1px solid var(--border); border-radius:4px; padding:1px 6px; font-size:0.75rem; cursor:pointer;" title="Sign off">&#9744;</button>`}
              <span style="${t.completed_date ? 'color:#999;' : ''}">${apprEscape(t.task_label)}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// STATUS CHANGE
// ═══════════════════════════════════════════════════════════════════

function apprShowStatusChange(enrollmentId, currentStatus) {
  const transitions = {
    probation: ['active', 'cancelled'],
    active: ['suspended', 'cancelled', 'completed'],
    suspended: ['active', 'cancelled'],
  };
  const opts = (transitions[currentStatus] || []).map(s =>
    `<option value="${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</option>`
  ).join('');

  document.getElementById('apprNewModal').innerHTML = `
    <div class="modal" style="max-width:400px;">
      <h2 style="color:var(--brand-navy); margin-bottom:1rem;">Change Enrollment Status</h2>
      <p style="font-size:0.85rem; color:#666; margin-bottom:1rem;">Current: <strong>${currentStatus}</strong></p>
      <div class="form-group">
        <label>New Status</label>
        <select id="apprNewStatus" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">${opts}</select>
      </div>
      <div class="form-group">
        <label>Reason (required for cancel/suspend)</label>
        <textarea id="apprStatusReason" rows="3" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;"></textarea>
      </div>
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1rem;">
        <button class="btn" onclick="apprCloseModal('apprNewModal')">Cancel</button>
        <button class="btn btn-primary" onclick="apprChangeStatus(${enrollmentId})">Update</button>
      </div>
    </div>`;
  document.getElementById('apprNewModal').classList.remove('hidden');
}

async function apprChangeStatus(enrollmentId) {
  const newStatus = document.getElementById('apprNewStatus').value;
  const reason = document.getElementById('apprStatusReason').value.trim();
  try {
    await apprFetch('/enrollments/' + enrollmentId + '/status', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: newStatus, reason })
    });
    apprCloseModal('apprNewModal');
    apprShowDetail(enrollmentId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// WAGE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function apprShowWageEdit(enrollmentId) {
  const d = APPR.currentDetail;
  const wc = d?.wageCompliance || {};
  const reasonOpts = [
    { value: 'tier_advancement', label: 'Tier Advancement' },
    { value: 'manual_adjustment', label: 'Manual Adjustment' },
    { value: 'correction', label: 'Correction' },
  ];

  document.getElementById('apprNewModal').innerHTML = `
    <div class="modal" style="max-width:420px;">
      <h2 style="color:var(--brand-navy); margin-bottom:1rem;">Update Wage</h2>
      <p style="font-size:0.85rem; color:#666; margin-bottom:0.5rem;">
        Current: <strong>${wc.currentWage ? '$' + Number(wc.currentWage).toFixed(2) + '/hr' : 'Not set'}</strong>
        &middot; Required minimum: <strong>${wc.requiredMinimum ? '$' + Number(wc.requiredMinimum).toFixed(2) + '/hr' : '—'}</strong>
      </p>
      ${d.wages && d.wages.length > 0 ? `
        <div style="background:#f8f9fa; border-radius:6px; padding:0.5rem; margin-bottom:1rem; font-size:0.8rem;">
          <strong>Wage Schedule:</strong>
          ${d.wages.map(w => `Tier ${w.tier}: $${Number(w.hourly_rate).toFixed(2)}/hr`).join(' &rarr; ')}
          &rarr; Journeyworker: $${d.enrollment.journeyworker_wage ? Number(d.enrollment.journeyworker_wage).toFixed(2) : '—'}/hr
        </div>
      ` : ''}
      <div class="form-group">
        <label>New Hourly Wage ($)</label>
        <input type="number" id="apprNewWage" step="0.01" min="0" value="${wc.currentWage || ''}"
          style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px; font-size:1rem;"
          placeholder="e.g. 12.50">
        <div id="apprWageWarning" style="margin-top:0.25rem; font-size:0.8rem;"></div>
      </div>
      <div class="form-group">
        <label>Reason</label>
        <select id="apprWageReason" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
          ${reasonOpts.map(r => `<option value="${r.value}">${r.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <textarea id="apprWageNotes" rows="2" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;" placeholder="e.g. OJL milestone reached, payroll effective date..."></textarea>
      </div>
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1rem;">
        <button class="btn" onclick="apprCloseModal('apprNewModal')">Cancel</button>
        <button class="btn btn-primary" onclick="apprSaveWage(${enrollmentId})">Save Wage</button>
      </div>
    </div>`;

  // Live validation on wage input
  const wageInput = document.getElementById('apprNewWage');
  const warningEl = document.getElementById('apprWageWarning');
  wageInput.addEventListener('input', () => {
    const val = parseFloat(wageInput.value);
    if (!val || val <= 0) { warningEl.innerHTML = ''; return; }
    if (wc.requiredMinimum && val < wc.requiredMinimum) {
      warningEl.innerHTML = `<span style="color:var(--danger);">&#9888; Below required minimum of $${Number(wc.requiredMinimum).toFixed(2)}/hr for current tier</span>`;
    } else if (wc.requiredMinimum && val >= wc.requiredMinimum) {
      warningEl.innerHTML = `<span style="color:var(--success);">&#10003; Meets tier requirement</span>`;
    } else {
      warningEl.innerHTML = '';
    }
  });

  document.getElementById('apprNewModal').classList.remove('hidden');
}

async function apprSaveWage(enrollmentId) {
  const wage = parseFloat(document.getElementById('apprNewWage').value);
  const reason = document.getElementById('apprWageReason').value;
  const notes = document.getElementById('apprWageNotes').value.trim();

  if (!wage || wage <= 0) { alert('Enter a valid wage amount.'); return; }

  try {
    const result = await apprFetch('/enrollments/' + enrollmentId + '/wage', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ hourly_wage: wage, reason, notes })
    });
    apprCloseModal('apprNewModal');
    if (result.is_compliant === false) {
      alert(`Wage saved, but WARNING: $${wage.toFixed(2)}/hr is below the required minimum of $${Number(result.required_minimum).toFixed(2)}/hr for Tier ${result.new_tier}.`);
    }
    apprShowDetail(enrollmentId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// TASK SIGN-OFFS
// ═══════════════════════════════════════════════════════════════════

async function apprSignOffTask(enrollmentId, taskId) {
  if (!confirm('Sign off this task as completed?')) return;
  try {
    await apprFetch('/tasks/' + enrollmentId + '/' + taskId + '/complete', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
    });
    apprShowDetail(enrollmentId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// COMPLIANCE EVENT COMPLETION
// ═══════════════════════════════════════════════════════════════════

async function apprCompleteEvent(eventId, enrollmentId) {
  if (!confirm('Mark this compliance event as complete?')) return;
  try {
    await apprFetch('/compliance/' + eventId + '/complete', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ notes: 'Completed from admin portal' })
    });
    apprShowDetail(enrollmentId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// RI ATTENDANCE LOGGING
// ═══════════════════════════════════════════════════════════════════

async function apprShowRILog(enrollmentId) {
  let courses = [];
  try { courses = await apprFetch('/ri/' + enrollmentId + '/summary'); } catch(_) {}
  const courseOpts = (courses.courses || []).map(c =>
    `<option value="${c.id}">${apprEscape(c.title)} (${c.completed_hours || 0}/${c.required_hours}h)</option>`
  ).join('');

  document.getElementById('apprNewModal').innerHTML = `
    <div class="modal" style="max-width:450px;">
      <h2 style="color:var(--brand-navy); margin-bottom:1rem;">Log RI Attendance</h2>
      <form onsubmit="event.preventDefault(); apprLogRI(${enrollmentId});">
        <div class="form-group">
          <label>Course *</label>
          <select id="apprRICourse" required style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">${courseOpts}</select>
        </div>
        <div class="form-group">
          <label>Hours *</label>
          <input type="number" id="apprRIHours" step="0.5" min="0.5" max="40" required style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
        </div>
        <div class="form-group">
          <label>Session Date *</label>
          <input type="date" id="apprRIDate" required value="${new Date().toISOString().slice(0,10)}" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
        </div>
        <div class="form-group">
          <label>Notes</label>
          <input type="text" id="apprRINotes" placeholder="Optional" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
        </div>
        <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1rem;">
          <button type="button" class="btn" onclick="apprCloseModal('apprNewModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Log Hours</button>
        </div>
      </form>
    </div>`;
  document.getElementById('apprNewModal').classList.remove('hidden');
}

async function apprLogRI(enrollmentId) {
  try {
    await apprFetch('/ri/' + enrollmentId + '/attendance', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        course_id: parseInt(document.getElementById('apprRICourse').value),
        hours: parseFloat(document.getElementById('apprRIHours').value),
        session_date: document.getElementById('apprRIDate').value,
        notes: document.getElementById('apprRINotes').value.trim(),
      })
    });
    apprCloseModal('apprNewModal');
    apprShowDetail(enrollmentId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// TIMESHEET IMPORT SUB-TAB
// ═══════════════════════════════════════════════════════════════════

function apprResetTimesheet() {
  document.getElementById('apprOCRResult').style.display = 'none';
  document.getElementById('apprTimesheetForm').reset();
  APPR.ocrResult = null;
  APPR.ocrImportId = null;
  // Populate enrollment dropdown
  const sel = document.getElementById('apprTimesheetEnrollmentId');
  if (sel && APPR.enrollments.length) {
    sel.innerHTML = '<option value="">Select enrollment...</option>' +
      APPR.enrollments.filter(e => e.status === 'active' || e.status === 'probation').map(e =>
        `<option value="${e.id}">${apprEscape(e.employee_name || 'Employee #'+e.employee_id)} — ${apprEscape(e.track_name)}</option>`
      ).join('');
  }
}

async function apprUploadTimesheet() {
  const enrollmentId = document.getElementById('apprTimesheetEnrollmentId').value;
  const fileInput = document.getElementById('apprTimesheetFile');
  if (!enrollmentId || !fileInput.files.length) {
    alert('Please select an enrollment and a timesheet file.');
    return;
  }
  const btn = document.getElementById('apprTimesheetBtn');
  btn.disabled = true; btn.textContent = 'Processing with AI...';

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('enrollment_id', enrollmentId);

  try {
    const res = await fetch('/api/apprenticeship/timesheets/import', { method:'POST', body: formData });
    if (!res.ok) { const b = await res.json().catch(()=>({})); throw new Error(b.error || 'Upload failed'); }
    const data = await res.json();
    APPR.ocrResult = data;
    APPR.ocrImportId = data.import_id;
    apprRenderOCRPreview(data);
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Upload & Process';
  }
}

function apprRenderOCRPreview(data) {
  const container = document.getElementById('apprOCRResult');
  container.style.display = '';
  container.innerHTML = `
    <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem;" style="margin-top:1rem;">
      <h3 style="color:var(--brand-navy); margin-bottom:0.75rem;">&#129302; AI Extraction Results</h3>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:1rem; margin-bottom:1rem;">
        <div><label style="font-size:0.8rem; color:#666;">Period Start</label>
          <input type="date" id="apprOCRStart" value="${data.extracted?.period_start || ''}" style="width:100%; padding:0.4rem; border:1px solid var(--border); border-radius:6px;"></div>
        <div><label style="font-size:0.8rem; color:#666;">Period End</label>
          <input type="date" id="apprOCREnd" value="${data.extracted?.period_end || ''}" style="width:100%; padding:0.4rem; border:1px solid var(--border); border-radius:6px;"></div>
        <div><label style="font-size:0.8rem; color:#666;">Total Hours</label>
          <input type="number" id="apprOCRHours" step="0.5" value="${data.extracted?.total_hours || 0}" style="width:100%; padding:0.4rem; border:1px solid var(--border); border-radius:6px;"></div>
      </div>
      ${data.extracted?.employee_name ? `<p style="font-size:0.85rem; color:#666;">Employee: <strong>${apprEscape(data.extracted.employee_name)}</strong></p>` : ''}
      ${data.extracted?.notes ? `<p style="font-size:0.8rem; color:#999;">${apprEscape(data.extracted.notes)}</p>` : ''}
      <div style="display:flex; gap:0.5rem; margin-top:1rem;">
        <button class="btn btn-primary" onclick="apprConfirmTimesheet()">&#9989; Confirm & Credit Hours</button>
        <button class="btn" onclick="document.getElementById('apprOCRResult').style.display='none';">Cancel</button>
      </div>
    </div>`;
}

async function apprConfirmTimesheet() {
  if (!APPR.ocrImportId) { alert('No timesheet to confirm.'); return; }
  try {
    const result = await apprFetch('/timesheets/confirm', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        import_id: APPR.ocrImportId,
        period_start: document.getElementById('apprOCRStart').value,
        period_end: document.getElementById('apprOCREnd').value,
        total_hours: parseFloat(document.getElementById('apprOCRHours').value),
      })
    });
    alert(`Hours credited! ${result.wage_tier_advanced ? 'Wage tier advanced!' : ''}`);
    document.getElementById('apprOCRResult').style.display = 'none';
    apprLoadDashboard();
    apprSwitchSub('appr-dashboard');
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// COMPLIANCE OVERVIEW SUB-TAB
// ═══════════════════════════════════════════════════════════════════

async function apprLoadCompliance() {
  try {
    const data = await apprFetch('/compliance/overview');
    const el = document.getElementById('apprComplianceContent');

    // Build the event rows if we have enrollments loaded
    let eventsHtml = '';
    if (APPR.enrollments && APPR.enrollments.length > 0) {
      // For each active enrollment, fetch compliance events
      const activeEnrollments = APPR.enrollments.filter(e => e.status === 'active' || e.status === 'probation');
      const allEvents = [];
      for (const enr of activeEnrollments) {
        try {
          const events = await apprFetch('/compliance/' + enr.id);
          events.forEach(ev => { ev.employee_name = enr.employee_name; });
          allEvents.push(...events.filter(ev => ev.status === 'pending'));
        } catch(_) {}
      }
      allEvents.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
      if (allEvents.length > 0) {
        eventsHtml = `
          <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem;">
            <table class="data-table">
              <thead><tr>
                <th>Status</th><th>Apprentice</th><th>Event</th><th>Due Date</th><th>Days</th><th>Actions</th>
              </tr></thead>
              <tbody>
                ${allEvents.map(ev => `
                  <tr>
                    <td>${apprStatusBadge(ev.display_status || ev.status)}</td>
                    <td>${apprEscape(ev.employee_name || 'Enrollment #'+ev.enrollment_id)}</td>
                    <td style="font-size:0.85rem;">${apprEventLabel(ev.event_type)}</td>
                    <td>${apprFmtDate(ev.due_date)}</td>
                    <td style="font-size:0.85rem; ${ev.days_remaining < 0 ? 'color:var(--brand-red); font-weight:700;' : ''}">${ev.days_remaining != null ? ev.days_remaining + 'd' : '—'}</td>
                    <td><button class="btn btn-sm" onclick="apprCompleteEvent(${ev.id}, ${ev.enrollment_id})">Complete</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      }
    }

    el.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:1rem; margin-bottom:1.5rem;">
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; text-align:center;">
          <div style="font-size:2rem; font-weight:700; color:var(--brand-red);">${data.overdue || 0}</div>
          <div style="font-size:0.85rem; color:#666;">Overdue</div>
        </div>
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; text-align:center;">
          <div style="font-size:2rem; font-weight:700; color:#f39c12;">${data.due_soon || 0}</div>
          <div style="font-size:0.85rem; color:#666;">Upcoming (30 days)</div>
        </div>
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:1rem; text-align:center;">
          <div style="font-size:2rem; font-weight:700; color:#27ae60;">${data.completed || 0}</div>
          <div style="font-size:0.85rem; color:#666;">Completed</div>
        </div>
      </div>
      ${eventsHtml || '<p style="color:#999; padding:1rem;">No pending compliance events.</p>'}`;
  } catch (e) {
    document.getElementById('apprComplianceContent').innerHTML =
      `<p style="color:var(--brand-red); padding:1rem;">Error: ${apprEscape(e.message)}</p>`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SIGNATURE CAPTURE
// ═══════════════════════════════════════════════════════════════════

function apprShowSignature(enrollmentId, docType) {
  const modal = document.getElementById('apprNewModal');
  modal.innerHTML = `
    <div class="modal" style="max-width:500px;">
      <h2 style="color:var(--brand-navy); margin-bottom:1rem;">&#9999;&#65039; Capture Signature</h2>
      <div style="display:flex; gap:1rem; margin-bottom:1rem;">
        <button class="btn btn-sm active" id="apprSigTabDraw" onclick="apprSigTab('draw')">Draw</button>
        <button class="btn btn-sm" id="apprSigTabUpload" onclick="apprSigTab('upload')">Upload Photo</button>
      </div>
      <div id="apprSigDraw">
        <canvas id="apprSigCanvas" width="400" height="150"
          style="border:2px solid var(--border); border-radius:8px; cursor:crosshair; background:#fff; width:100%; touch-action:none;"></canvas>
        <button class="btn btn-sm" style="margin-top:0.5rem;" onclick="apprClearSig()">Clear</button>
      </div>
      <div id="apprSigUpload" style="display:none;">
        <input type="file" id="apprSigFile" accept="image/*" style="padding:0.5rem;">
        <img id="apprSigPreview" style="max-width:100%; max-height:150px; display:none; margin-top:0.5rem; border:1px solid var(--border); border-radius:8px;">
      </div>
      <div class="form-group" style="margin-top:1rem;">
        <label>Signer Role *</label>
        <select id="apprSigRole" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px;">
          <option value="apprentice">Apprentice</option>
          <option value="sponsor">Sponsor</option>
          <option value="journeyworker">Journeyworker</option>
        </select>
      </div>
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1rem;">
        <button class="btn" onclick="apprCloseModal('apprNewModal')">Cancel</button>
        <button class="btn btn-primary" onclick="apprSaveSig(${enrollmentId}, '${docType || 'enrollment_agreement'}')">Save Signature</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
  setTimeout(() => apprInitSigCanvas(), 100);
}

function apprSigTab(tab) {
  document.getElementById('apprSigDraw').style.display = tab === 'draw' ? '' : 'none';
  document.getElementById('apprSigUpload').style.display = tab === 'upload' ? '' : 'none';
  document.getElementById('apprSigTabDraw').classList.toggle('active', tab === 'draw');
  document.getElementById('apprSigTabUpload').classList.toggle('active', tab === 'upload');
}

function apprInitSigCanvas() {
  const canvas = document.getElementById('apprSigCanvas');
  if (!canvas) return;
  APPR.signatureCanvas = canvas;
  APPR.signatureCtx = canvas.getContext('2d');
  APPR.signatureCtx.lineWidth = 2;
  APPR.signatureCtx.lineCap = 'round';
  APPR.signatureCtx.strokeStyle = '#000';
  APPR.isDrawing = false;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
  }

  canvas.onmousedown = canvas.ontouchstart = (e) => {
    e.preventDefault();
    APPR.isDrawing = true;
    const p = getPos(e);
    APPR.signatureCtx.beginPath();
    APPR.signatureCtx.moveTo(p.x, p.y);
  };
  canvas.onmousemove = canvas.ontouchmove = (e) => {
    if (!APPR.isDrawing) return;
    e.preventDefault();
    const p = getPos(e);
    APPR.signatureCtx.lineTo(p.x, p.y);
    APPR.signatureCtx.stroke();
  };
  canvas.onmouseup = canvas.ontouchend = canvas.onmouseleave = () => { APPR.isDrawing = false; };

  // File upload preview
  const fileInput = document.getElementById('apprSigFile');
  if (fileInput) {
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = document.getElementById('apprSigPreview');
        img.src = e.target.result;
        img.style.display = '';
      };
      reader.readAsDataURL(file);
    };
  }
}

function apprClearSig() {
  if (APPR.signatureCtx && APPR.signatureCanvas) {
    APPR.signatureCtx.clearRect(0, 0, APPR.signatureCanvas.width, APPR.signatureCanvas.height);
  }
}

async function apprSaveSig(enrollmentId, docType) {
  const role = document.getElementById('apprSigRole').value;
  let imageData = null;
  let source = 'draw';

  // Check if upload tab is active
  const uploadPane = document.getElementById('apprSigUpload');
  if (uploadPane.style.display !== 'none') {
    const preview = document.getElementById('apprSigPreview');
    if (!preview.src || preview.style.display === 'none') {
      alert('Please upload a signature image.');
      return;
    }
    imageData = preview.src;
    source = 'upload';
  } else {
    if (!APPR.signatureCanvas) { alert('Signature canvas not initialized.'); return; }
    imageData = APPR.signatureCanvas.toDataURL('image/png');
    // Check if canvas is blank
    const blank = document.createElement('canvas');
    blank.width = APPR.signatureCanvas.width;
    blank.height = APPR.signatureCanvas.height;
    if (imageData === blank.toDataURL('image/png')) {
      alert('Please draw your signature.');
      return;
    }
  }

  try {
    await apprFetch('/signatures', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        enrollment_id: enrollmentId,
        image_data: imageData,
        signer_role: role,
        document_type: docType,
        source
      })
    });
    apprCloseModal('apprNewModal');
    alert('Signature saved!');
    apprShowDetail(enrollmentId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// ETA-671 + REPORTS
// ═══════════════════════════════════════════════════════════════════

function apprDownloadETA671(enrollmentId) {
  window.open('/api/apprenticeship/reports/' + enrollmentId + '/eta671', '_blank');
}

function apprExportRAPIDS() {
  window.open('/api/apprenticeship/reports/rapids-export', '_blank');
}

// ═══════════════════════════════════════════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════════════════════════════════════════

function apprCloseModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
