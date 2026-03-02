/**
 * Email service — Sends transactional emails via SendGrid Web API (HTTPS).
 *
 * Requires SENDGRID_API_KEY (or SMTP_PASS as fallback) in .env.
 * Uses HTTPS (port 443) instead of SMTP (port 587) to avoid
 * DigitalOcean's outbound SMTP port restrictions.
 *
 * Used for:
 *   - New time-off request notifications (to admin)
 *   - Request review notifications (to employee)
 *   - Weekly PTO digest (to admin)
 *   - Test emails
 */

const https = require('https');

// ── Helpers ──────────────────────────────────────────────────────────

/** Escape user-controlled strings before interpolating into HTML emails. */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Config ───────────────────────────────────────────────────────────

/** Get SendGrid API key from env. */
function getApiKey() {
  return process.env.SENDGRID_API_KEY || process.env.SMTP_PASS || '';
}

/** Check if SendGrid is configured. */
function isConfigured() {
  const key = getApiKey();
  return !!(key && key.startsWith('SG.'));
}

/** Sender address. */
function getFromAddress() {
  return process.env.SMTP_FROM || 'noreply@cfalarambla.com';
}

// ── SendGrid API Helper ──────────────────────────────────────────────

/**
 * Send email via SendGrid v3 Web API (HTTPS POST).
 * No external dependencies needed — uses Node built-in https module.
 */
function sendMail({ from, to, subject, html }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'CFA La Rambla PTO Tracker' },
      subject,
      content: [{ type: 'text/html', value: html }]
    });

    const options = {
      hostname: 'api.sendgrid.com',
      port: 443,
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ response: `${res.statusCode} OK` });
        } else {
          reject(new Error(`SendGrid API error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('SendGrid API request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// ── Email Templates ─────────────────────────────────────────────────

/** Wrap body content in CFA-branded HTML email template. */
function htmlTemplate(title, body) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:600px; margin:0 auto; background:#fff;">
      <div style="background:#004F71; padding:16px 24px; text-align:center;">
        <h1 style="color:#fff; font-size:18px; margin:0;">CFA La Rambla — PTO Tracker</h1>
      </div>
      <div style="padding:24px;">
        <h2 style="color:#004F71; font-size:16px; margin:0 0 16px;">${title}</h2>
        ${body}
      </div>
      <div style="background:#F5F4F2; padding:12px 24px; font-size:12px; color:#5B6770; text-align:center;">
        This is an automated message from the PTO Tracker system.
      </div>
    </div>
  `;
}

// ── Email Senders ───────────────────────────────────────────────────

/** Notify admin of a new time-off or punch adjustment request. */
async function sendRequestSubmitted(employeeName, request, adminEmail) {
  if (!isConfigured() || !adminEmail) return;

  const isPunch = request.type === 'punch_adjustment';

  const safeName = escapeHtml(employeeName);

  const detailRows = isPunch ? `
    <tr><td style="padding:6px 0; color:#5B6770;">Type:</td><td style="padding:6px 0;">Punch Adjustment</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Date:</td><td style="padding:6px 0;">${escapeHtml(request.punch_date)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Clock-In:</td><td style="padding:6px 0;">${escapeHtml(request.clock_in)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Clock-Out:</td><td style="padding:6px 0;">${escapeHtml(request.clock_out)}</td></tr>
    ${request.break_start ? `<tr><td style="padding:6px 0; color:#5B6770;">Break:</td><td style="padding:6px 0;">${escapeHtml(request.break_start)} - ${escapeHtml(request.break_end)}</td></tr>` : ''}
  ` : `
    <tr><td style="padding:6px 0; color:#5B6770;">Type:</td><td style="padding:6px 0;">${escapeHtml(request.type)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Days:</td><td style="padding:6px 0;">${request.days_requested}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Start:</td><td style="padding:6px 0;">${escapeHtml(request.start_date)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">End:</td><td style="padding:6px 0;">${escapeHtml(request.end_date)}</td></tr>
  `;

  const html = htmlTemplate(
    isPunch ? 'Punch Adjustment Request' : 'New Time-Off Request',
    `
      <p><strong>${safeName}</strong> submitted a ${isPunch ? 'punch adjustment' : escapeHtml(request.type)} request:</p>
      <table style="width:100%; border-collapse:collapse; margin:12px 0;">
        ${detailRows}
        ${request.reason ? `<tr><td style="padding:6px 0; color:#5B6770;">Notes:</td><td style="padding:6px 0;">${escapeHtml(request.reason)}</td></tr>` : ''}
      </table>
      <p><a href="https://cfalarambla.com" style="display:inline-block; background:#DD0033; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:600;">Review Request</a></p>
    `
  );

  const subject = isPunch
    ? `Punch Adjustment: ${employeeName} - ${request.punch_date}`
    : `PTO Request: ${employeeName} - ${request.type} (${request.days_requested} days)`;

  try {
    await sendMail({ from: getFromAddress(), to: adminEmail, subject, html });
  } catch (err) {
    console.error('Failed to send request notification:', err.message);
  }
}

/** Notify employee that their request was approved/rejected. */
async function sendRequestReviewed(employeeName, status, employeeEmail, request) {
  if (!isConfigured() || !employeeEmail) return;

  const statusColor = status === 'approved' ? '#249E6B' : '#DC2626';
  const statusLabel = status === 'approved' ? 'Approved' : 'Rejected';
  const isPunch = request.type === 'punch_adjustment';

  const detailRows = isPunch ? `
    <tr><td style="padding:6px 0; color:#5B6770;">Type:</td><td style="padding:6px 0;">Punch Adjustment</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Date:</td><td style="padding:6px 0;">${escapeHtml(request.punch_date)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Clock-In:</td><td style="padding:6px 0;">${escapeHtml(request.clock_in)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Clock-Out:</td><td style="padding:6px 0;">${escapeHtml(request.clock_out)}</td></tr>
    ${request.break_start ? `<tr><td style="padding:6px 0; color:#5B6770;">Break:</td><td style="padding:6px 0;">${escapeHtml(request.break_start)} - ${escapeHtml(request.break_end)}</td></tr>` : ''}
  ` : `
    <tr><td style="padding:6px 0; color:#5B6770;">Type:</td><td style="padding:6px 0;">${escapeHtml(request.type)}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Days:</td><td style="padding:6px 0;">${request.days_requested}</td></tr>
    <tr><td style="padding:6px 0; color:#5B6770;">Dates:</td><td style="padding:6px 0;">${escapeHtml(request.start_date)} to ${escapeHtml(request.end_date)}</td></tr>
  `;

  const html = htmlTemplate(
    isPunch ? `Punch Adjustment ${statusLabel}` : `Time-Off Request ${statusLabel}`,
    `
      <p>Your ${isPunch ? 'punch adjustment' : escapeHtml(request.type)} request has been <strong style="color:${statusColor};">${statusLabel.toLowerCase()}</strong>.</p>
      <table style="width:100%; border-collapse:collapse; margin:12px 0;">
        ${detailRows}
        <tr><td style="padding:6px 0; color:#5B6770;">Status:</td><td style="padding:6px 0; font-weight:600; color:${statusColor};">${statusLabel}</td></tr>
        ${request.review_notes ? `<tr><td style="padding:6px 0; color:#5B6770;">Notes:</td><td style="padding:6px 0;">${escapeHtml(request.review_notes)}</td></tr>` : ''}
      </table>
      <p><a href="https://cfalarambla.com" style="display:inline-block; background:#004F71; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:600;">View My Time Off</a></p>
    `
  );

  const subject = isPunch
    ? `Punch Adjustment ${statusLabel}: ${request.punch_date}`
    : `PTO Request ${statusLabel}: ${request.type} (${request.days_requested} days)`;

  try {
    await sendMail({ from: getFromAddress(), to: employeeEmail, subject, html });
  } catch (err) {
    console.error('Failed to send review notification:', err.message);
  }
}

/** Send weekly PTO digest summary to admin. */
async function sendWeeklyDigest(adminEmail, pendingRequests, stats) {
  if (!isConfigured() || !adminEmail) return;

  let requestsList = '<p style="color:#5B6770;">No pending requests.</p>';
  if (pendingRequests.length > 0) {
    requestsList = '<ul style="padding-left:20px; margin:8px 0;">' +
      pendingRequests.map(r => {
        const name = `${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}`;
        if (r.type === 'punch_adjustment') {
          return `<li>${name}: Punch Adjustment (${escapeHtml(r.punch_date || r.start_date)}, ${escapeHtml(r.clock_in)} - ${escapeHtml(r.clock_out)})</li>`;
        }
        return `<li>${name}: ${escapeHtml(r.type)} (${r.days_requested} days, ${escapeHtml(r.start_date)})</li>`;
      }).join('') + '</ul>';
  }

  const html = htmlTemplate(
    'Weekly PTO Digest',
    `
      <p>Here is your weekly PTO summary:</p>
      <table style="width:100%; border-collapse:collapse; margin:12px 0;">
        <tr><td style="padding:6px 0; color:#5B6770;">Active Employees:</td><td style="padding:6px 0;">${stats.totalActive}</td></tr>
        <tr><td style="padding:6px 0; color:#5B6770;">Pending Requests:</td><td style="padding:6px 0; font-weight:600; color:${stats.pendingRequests > 0 ? '#DD0033' : '#249E6B'};">${stats.pendingRequests}</td></tr>
        <tr><td style="padding:6px 0; color:#5B6770;">Flagged Employees:</td><td style="padding:6px 0;">${stats.flaggedCount}</td></tr>
      </table>
      <h3 style="color:#004F71; font-size:14px;">Pending Requests</h3>
      ${requestsList}
      <p><a href="https://cfalarambla.com" style="display:inline-block; background:#DD0033; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:600;">Go to Dashboard</a></p>
    `
  );

  try {
    await sendMail({
      from: getFromAddress(),
      to: adminEmail,
      subject: `PTO Weekly Digest — ${pendingRequests.length} pending request(s)`,
      html
    });
  } catch (err) {
    console.error('Failed to send weekly digest:', err.message);
  }
}

/** Send a test email to verify SendGrid configuration. */
async function sendTestEmail(toEmail) {
  if (!isConfigured()) throw new Error('Email not configured. Set SENDGRID_API_KEY (or SMTP_PASS with SG. key) in .env');

  const html = htmlTemplate(
    'Test Email',
    '<p>This is a test email from the CFA La Rambla PTO Tracker. If you received this, email notifications are working correctly.</p>'
  );

  await sendMail({
    from: getFromAddress(),
    to: toEmail,
    subject: 'PTO Tracker - Test Email',
    html
  });
}

module.exports = {
  sendRequestSubmitted,
  sendRequestReviewed,
  sendWeeklyDigest,
  sendTestEmail,
  isConfigured
};
