/**
 * Gastos (Invoice Management) — Frontend Module
 *
 * Provides the client-side logic for:
 *   - Invoice table with filtering, stats, and CRUD
 *   - AI-powered OCR upload (single & bulk)
 *   - Manual invoice entry
 *   - Invoice detail view with Payment ID and status management
 *   - Bookmarklet generation for Oracle APEX auto-fill
 *   - CSV and PDF receipt export
 *
 * All functions are prefixed `gastos` to avoid global namespace collisions.
 * DOM element IDs follow the pattern `gastos*` / `gStat*`.
 *
 * @module gastos
 */

/* global switchTab */

// ═══════════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════════

var GASTOS = {
  suppliers: [],
  categories: [],
  invoices: [],
  currentOCR: null,       // OCR results pending review
  sourceFile: null,        // Uploaded file path from OCR
  reviewLineCount: 0,
  manualLineCount: 0,
  _visibilityListenerAdded: false
};

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * HTML-escape a string to prevent XSS when injecting into innerHTML.
 * @param {*} str - Value to escape (coerced to string)
 * @returns {string} Safe HTML string
 */
function gastosEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Make a fetch call with standardized error handling.
 * Checks response.ok before parsing JSON; surfaces server error messages.
 * @param {string} url
 * @param {Object} [opts] - fetch options
 * @returns {Promise<Object>} Parsed JSON body
 * @throws {Error} On network failure or non-2xx response
 */
function gastosFetch(url, opts) {
  return fetch(url, opts).then(function(r) {
    if (!r.ok) {
      return r.json().catch(function() { return {}; }).then(function(body) {
        throw new Error(body.error || 'Server returned ' + r.status);
      });
    }
    return r.json();
  });
}

/**
 * Format a YYYY-MM-DD date string for display, avoiding timezone offset issues.
 * Uses UTC parsing to prevent off-by-one day bugs.
 * @param {string} isoDate - e.g. "2026-04-05"
 * @returns {string} Localized date string or '-'
 */
function gastosFormatDate(isoDate) {
  if (!isoDate) return '-';
  // Parse as UTC to avoid timezone shifts
  var parts = isoDate.split('-');
  if (parts.length === 3) {
    var d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
    return d.toLocaleDateString('en-US', { timeZone: 'UTC' });
  }
  return isoDate;
}

/**
 * Convert MM/DD/YYYY to YYYY-MM-DD for HTML date inputs and DB storage.
 * @param {string} mdyDate - e.g. "04/05/2026"
 * @returns {string} e.g. "2026-04-05" or original if format doesn't match
 */
function gastosToIsoDate(mdyDate) {
  if (!mdyDate) return '';
  var parts = mdyDate.split('/');
  if (parts.length === 3) {
    return parts[2] + '-' + parts[0].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
  }
  return mdyDate;
}

/**
 * Get current month as YYYY-MM string.
 * @returns {string}
 */
function gastosCurrentMonth() {
  var now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize the Gastos module — load reference data, render table.
 * Safe to call multiple times (visibility listener is added only once).
 */
function gastosInit() {
  gastosLoadSuppliers();
  gastosLoadCategories();
  gastosLoadInvoices();
  gastosPopulateMonthFilter();
  gastosGenerateBookmarklet();

  // Auto-refresh when user returns to this tab (e.g. after using bookmarklet)
  if (!GASTOS._visibilityListenerAdded) {
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden && document.querySelector('[data-tab="gastos"].active, .tab-nav-item.active[data-tab="gastos"]')) {
        gastosLoadInvoices();
      }
    });
    GASTOS._visibilityListenerAdded = true;
  }
}

// ═══════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════

/** Fetch supplier list and populate all supplier dropdowns. */
function gastosLoadSuppliers() {
  gastosFetch('/api/gastos/suppliers').then(function(data) {
    GASTOS.suppliers = data || [];
    gastosPopulateSupplierDropdowns();
  }).catch(function(e) { console.error('Failed to load suppliers:', e); });
}

/** Fetch expense category list. */
function gastosLoadCategories() {
  gastosFetch('/api/gastos/categories').then(function(data) {
    GASTOS.categories = data || [];
  }).catch(function(e) { console.error('Failed to load categories:', e); });
}

/** Fetch invoices (respecting current filters) and update table + stats. */
function gastosLoadInvoices() {
  var status = document.getElementById('gastosStatusFilter').value;
  var month = document.getElementById('gastosMonthFilter').value;
  var params = [];
  if (status) params.push('status=' + encodeURIComponent(status));
  if (month) params.push('month=' + encodeURIComponent(month));
  var url = '/api/gastos/invoices' + (params.length ? '?' + params.join('&') : '');

  gastosFetch(url).then(function(data) {
    GASTOS.invoices = data.invoices || [];
    gastosRenderTable();
    gastosRenderStats(data.stats || {});
  }).catch(function(e) { console.error('Failed to load invoices:', e); });
}

/** Populate the month filter dropdown with the last 12 months. */
function gastosPopulateMonthFilter() {
  var sel = document.getElementById('gastosMonthFilter');
  if (!sel || sel.options.length > 1) return; // Already populated
  var now = new Date();
  for (var i = 0; i < 12; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    var label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    var opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

/** Populate all supplier select dropdowns with current supplier list. */
function gastosPopulateSupplierDropdowns() {
  ['gastosReviewSupplier', 'gastosManualSupplier'].forEach(function(id) {
    var sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select Supplier --</option>';
    GASTOS.suppliers.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      opt.dataset.incId = s.inc_id || '';
      sel.appendChild(opt);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════

/** Render the stats bar at the top of the Gastos tab. */
function gastosRenderStats(stats) {
  document.getElementById('gStatDraft').textContent = stats.draft || 0;
  document.getElementById('gStatReady').textContent = stats.ready || 0;
  document.getElementById('gStatSubmitted').textContent = stats.submitted || 0;
  document.getElementById('gStatVerified').textContent = stats.verified || 0;
  var total = stats.total_amount || 0;
  document.getElementById('gStatTotal').textContent = '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ═══════════════════════════════════════════════════════════════════
// INVOICE TABLE
// ═══════════════════════════════════════════════════════════════════

/** @const {number} Number of columns in the invoice table (must match HTML thead) */
var GASTOS_TABLE_COLS = 9;

/** Render the invoice table body from GASTOS.invoices. */
function gastosRenderTable() {
  var tbody = document.getElementById('gastosTableBody');
  if (!GASTOS.invoices.length) {
    tbody.innerHTML = '<tr><td colspan="' + GASTOS_TABLE_COLS + '" style="text-align:center; color:#999; padding:2rem;">No invoices found. Upload or add one to get started.</td></tr>';
    return;
  }

  tbody.innerHTML = GASTOS.invoices.map(function(inv) {
    var statusBadge = gastosStatusBadge(inv.status);
    var date = gastosFormatDate(inv.invoice_date);
    var total = '$' + Number(inv.total_amount || 0).toFixed(2);
    var created = gastosFormatDate(inv.created_at ? inv.created_at.split('T')[0] : inv.created_at);
    var payId = inv.inc_payment_id ? gastosEscape(inv.inc_payment_id) : '-';

    return '<tr>' +
      '<td>' + statusBadge + '</td>' +
      '<td style="font-weight:600;">' + gastosEscape(inv.supplier_name || 'Unknown') + '</td>' +
      '<td><code>' + gastosEscape(inv.invoice_number || '-') + '</code></td>' +
      '<td>' + date + '</td>' +
      '<td style="text-align:center;">' + (inv.line_count || 0) + '</td>' +
      '<td style="font-weight:600;">' + total + '</td>' +
      '<td style="font-size:0.85rem; color:#27ae60; font-weight:600;">' + payId + '</td>' +
      '<td style="font-size:0.8rem; color:#666;">' + created + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-sm" onclick="gastosViewDetail(' + inv.id + ')" title="View Details">&#128065;</button> ' +
        (inv.status === 'draft' || inv.status === 'verified'
          ? '<button class="btn btn-sm" style="background:#e67e22; color:white;" onclick="gastosMarkReady(' + inv.id + ')" title="Mark Ready for Inc.">Ready</button> '
          : '') +
        '<button class="btn btn-sm" style="background:var(--danger); color:white;" onclick="gastosDeleteInvoice(' + inv.id + ')" title="Delete">&#128465;</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

/**
 * Render a colored status badge.
 * @param {string} status - Invoice status
 * @returns {string} HTML span element
 */
function gastosStatusBadge(status) {
  var colors = { draft: '#95a5a6', ready: '#e67e22', submitted: '#27ae60', verified: '#2ecc71', error: '#e74c3c' };
  var labels = { draft: 'Draft', ready: '\u23F3 Ready for Inc.', submitted: '\u2705 Submitted to Inc.', verified: 'Verified', error: 'Error' };
  var bg = colors[status] || '#999';
  var label = labels[status] || gastosEscape(status);
  return '<span style="display:inline-block; padding:2px 8px; border-radius:12px; font-size:0.75rem; font-weight:600; color:white; background:' + bg + ';">' + label + '</span>';
}

// ═══════════════════════════════════════════════════════════════════
// UPLOAD INVOICE (AI OCR)
// ═══════════════════════════════════════════════════════════════════

/** Show the upload modal and reset form state. */
function gastosShowUpload() {
  document.getElementById('gastosUploadModal').classList.remove('hidden');
  document.getElementById('gastosUploadForm').reset();
  document.getElementById('gastosUploadProgress').style.display = 'none';
  document.getElementById('gastosUploadBtn').disabled = false;
}

/** Hide the upload modal. */
function gastosCloseUpload() {
  document.getElementById('gastosUploadModal').classList.add('hidden');
}

/**
 * Handle invoice file upload. Routes to:
 *   - Single file → OCR + review modal
 *   - Multiple files → Sequential bulk OCR, auto-save as drafts
 */
function gastosUploadInvoice() {
  var fileInput = document.getElementById('gastosFile');
  if (!fileInput.files.length) return alert('Please select a file');

  var files = Array.from(fileInput.files);

  // ── Single file: OCR + interactive review ──
  if (files.length === 1) {
    gastosUploadSingle(files[0]);
    return;
  }

  // ── Multiple files: bulk sequential processing ──
  gastosUploadBulk(files);
}

/**
 * Upload a single invoice file, run OCR, and open the review modal.
 * @param {File} file
 */
function gastosUploadSingle(file) {
  var progressEl = document.getElementById('gastosUploadProgress');
  var uploadBtn = document.getElementById('gastosUploadBtn');

  progressEl.style.display = 'block';
  uploadBtn.disabled = true;
  progressEl.innerHTML =
    '<div style="font-size:1.2rem; margin-bottom:0.5rem;">\uD83E\uDD16 Analyzing invoice...</div>' +
    '<div style="font-size:0.85rem; color:#666;">Claude Vision is reading the document</div>';

  var formData = new FormData();
  formData.append('invoice', file);

  fetch('/api/gastos/upload-invoice', { method: 'POST', body: formData })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(b) { throw new Error(b.error || 'Upload failed'); });
      return r.json();
    })
    .then(function(data) {
      progressEl.style.display = 'none';
      uploadBtn.disabled = false;
      if (data.error) return alert('Error: ' + data.error);

      if (data.multiple && data.invoices && data.invoices.length > 1) {
        // Multi-invoice PDF — queue all for sequential review
        GASTOS.reviewQueue = data.invoices.map(function(inv, i) {
          inv.source_file = data.source_file;
          inv.ocr_raw = inv.ocr_raw || '';
          return inv;
        });
        GASTOS.reviewQueueIdx = 0;
        gastosCloseUpload();
        gastosShowQueuedReview();
      } else {
        GASTOS.currentOCR = data;
        GASTOS.sourceFile = data.source_file;
        GASTOS.reviewQueue = null;
        gastosCloseUpload();
        gastosShowReview(data);
      }
    })
    .catch(function(e) {
      progressEl.style.display = 'none';
      uploadBtn.disabled = false;
      alert('Upload failed: ' + e.message);
    });
}

/**
 * Upload multiple files sequentially. Each is OCR'd and auto-saved as a draft.
 * Shows progress bar and summary on completion.
 * @param {File[]} files
 */
function gastosUploadBulk(files) {
  var progressEl = document.getElementById('gastosUploadProgress');
  var uploadBtn = document.getElementById('gastosUploadBtn');

  progressEl.style.display = 'block';
  uploadBtn.disabled = true;

  var results = { success: 0, failed: 0, errors: [] };
  var idx = 0;

  function processNext() {
    if (idx >= files.length) {
      // ── All done — show summary ──
      progressEl.style.display = 'none';
      uploadBtn.disabled = false;
      gastosCloseUpload();
      gastosLoadInvoices();
      var msg = results.success + ' invoice(s) uploaded as drafts.';
      if (results.failed > 0) msg += '\n' + results.failed + ' failed: ' + results.errors.join(', ');
      alert(msg + '\nReview and adjust each one from the table below.');
      return;
    }

    var file = files[idx];
    var pct = Math.round((idx / files.length) * 100);
    progressEl.innerHTML =
      '<div style="font-size:1.2rem; margin-bottom:0.5rem;">\uD83E\uDD16 Processing file ' + (idx + 1) + ' of ' + files.length + '</div>' +
      '<div style="font-size:0.85rem; color:#666;">' + gastosEscape(file.name) + '</div>' +
      '<div style="margin-top:0.5rem; background:#e0e0e0; border-radius:4px; height:8px;">' +
      '<div style="background:var(--brand-red); height:100%; border-radius:4px; width:' + pct + '%;"></div></div>';

    var formData = new FormData();
    formData.append('invoice', file);

    fetch('/api/gastos/upload-invoice', { method: 'POST', body: formData })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(b) { throw new Error(b.error || 'Upload failed'); });
        return r.json();
      })
      .then(function(data) {
        if (data.error) throw new Error(data.error);

        // Handle multi-invoice PDFs (e.g. scanned receipts with multiple pages)
        var invoiceList = data.multiple ? data.invoices : [data];
        var savePromises = invoiceList.map(function(inv, invIdx) {
          return gastosFetch('/api/gastos/confirm-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              supplier_id: inv.matched_supplier ? inv.matched_supplier.id : null,
              invoice_number: inv.invoice_number || (file.name + (invoiceList.length > 1 ? ' (' + (invIdx + 1) + ')' : '')),
              invoice_date: gastosToIsoDate(inv.invoice_date),
              business_period: gastosCurrentMonth(),
              currency: inv.currency || 'USD',
              lines: inv.lines.map(function(l) {
                return { category_id: l.matched_category_id, amount: l.amount, description: l.description };
              }),
              source_file: data.source_file,
              ocr_raw: JSON.stringify(inv)
            })
          });
        });
        return Promise.all(savePromises).then(function() {
          results.success += invoiceList.length;
        });
      })
      .catch(function(e) {
        results.failed++;
        results.errors.push(file.name + ': ' + e.message);
      })
      .then(function() { idx++; processNext(); }); // Always advance
  }

  processNext();
}

// ═══════════════════════════════════════════════════════════════════
// OCR REVIEW MODAL
// ═══════════════════════════════════════════════════════════════════

/**
 * Open the review modal pre-filled with OCR results.
 * @param {Object} parsed - Data returned by /upload-invoice
 */
function gastosShowReview(parsed) {
  document.getElementById('gastosReviewModal').classList.remove('hidden');

  // ── Supplier matching ──
  var supplierSel = document.getElementById('gastosReviewSupplier');
  if (parsed.matched_supplier && parsed.matched_supplier.id) {
    supplierSel.value = parsed.matched_supplier.id;
  } else if (parsed.supplier_name) {
    var needle = parsed.supplier_name.toLowerCase();
    for (var i = 0; i < supplierSel.options.length; i++) {
      if (supplierSel.options[i].textContent.toLowerCase().indexOf(needle) >= 0) {
        supplierSel.selectedIndex = i;
        break;
      }
    }
  }

  // ── Invoice header fields ──
  document.getElementById('gastosReviewInvNum').value = parsed.invoice_number || '';
  document.getElementById('gastosReviewInvDate').value = gastosToIsoDate(parsed.invoice_date);
  document.getElementById('gastosReviewPeriod').value = gastosCurrentMonth();

  // ── Line items ──
  GASTOS.reviewLineCount = 0;
  document.getElementById('gastosReviewLines').innerHTML = '';

  if (parsed.lines && parsed.lines.length) {
    parsed.lines.forEach(function(item) { gastosAddReviewLine(item); });
  } else {
    gastosAddReviewLine();
  }
  gastosUpdateReviewTotal();
}

/**
 * Add a line item row to the review modal.
 * @param {Object} [item] - Pre-fill data from OCR
 */
function gastosAddReviewLine(item) {
  var idx = GASTOS.reviewLineCount++;
  var container = document.getElementById('gastosReviewLines');

  var catOptions = '<option value="">-- Select Category --</option>';
  GASTOS.categories.forEach(function(c) {
    var selected = '';
    if (item && item.matched_category_id && item.matched_category_id == c.id) {
      selected = ' selected';
    } else if (item && item.suggested_category && c.name.toLowerCase().indexOf(item.suggested_category.toLowerCase()) >= 0) {
      selected = ' selected';
    }
    catOptions += '<option value="' + c.id + '"' + selected + '>' + gastosEscape(c.name) + (c.name_es ? ' / ' + gastosEscape(c.name_es) : '') + '</option>';
  });

  var amtVal = (item && item.amount) ? item.amount : '';
  var descVal = (item && item.description) ? gastosEscape(item.description) : '';

  container.insertAdjacentHTML('beforeend',
    '<div id="reviewLine' + idx + '" style="display:grid; grid-template-columns:2fr 1fr 2fr auto; gap:0.5rem; margin-bottom:0.5rem; align-items:start;">' +
      '<select style="padding:0.4rem; border:1px solid var(--border); border-radius:6px; font-size:0.8rem;" id="rlCat' + idx + '">' + catOptions + '</select>' +
      '<input type="number" step="0.01" placeholder="Amount" value="' + amtVal + '" style="padding:0.4rem; border:1px solid var(--border); border-radius:6px; font-size:0.85rem;" id="rlAmt' + idx + '" oninput="gastosUpdateReviewTotal()">' +
      '<input type="text" placeholder="Description" value="' + descVal + '" style="padding:0.4rem; border:1px solid var(--border); border-radius:6px; font-size:0.85rem;" id="rlDesc' + idx + '">' +
      '<button type="button" class="btn btn-sm" style="background:var(--danger); color:white; padding:0.3rem 0.5rem;" onclick="document.getElementById(\'reviewLine' + idx + '\').remove(); gastosUpdateReviewTotal();">&#10005;</button>' +
    '</div>'
  );
}

/** Recalculate and display the review modal total. */
function gastosUpdateReviewTotal() {
  var total = 0;
  for (var i = 0; i < GASTOS.reviewLineCount; i++) {
    var el = document.getElementById('rlAmt' + i);
    if (el) total += parseFloat(el.value) || 0;
  }
  document.getElementById('gastosReviewTotal').textContent = total.toFixed(2);
}

/** Close the OCR review modal. */
function gastosCloseReview() {
  document.getElementById('gastosReviewModal').classList.add('hidden');
  GASTOS.currentOCR = null;
  GASTOS.sourceFile = null;
}

/** Show the next invoice in the review queue (multi-page PDF). */
function gastosShowQueuedReview() {
  var queue = GASTOS.reviewQueue;
  var idx = GASTOS.reviewQueueIdx;
  if (!queue || idx >= queue.length) {
    GASTOS.reviewQueue = null;
    gastosLoadInvoices();
    return;
  }
  var inv = queue[idx];
  GASTOS.currentOCR = inv;
  GASTOS.sourceFile = inv.source_file;
  gastosShowReview(inv);

  // Update title to show progress
  var titleEl = document.querySelector('#gastosReviewModal h2, #gastosReviewModal .modal-title');
  if (!titleEl) {
    // Try finding any heading in the review modal
    var modal = document.getElementById('gastosReviewModal');
    if (modal) {
      var h = modal.querySelector('h2, h3, [class*="title"]');
      if (h) h.textContent = 'Review Invoice ' + (idx + 1) + ' of ' + queue.length;
    }
  } else {
    titleEl.textContent = 'Review Invoice ' + (idx + 1) + ' of ' + queue.length;
  }
}

/** Save the reviewed OCR invoice via /confirm-upload. */
function gastosSaveReview() {
  var supplierId = document.getElementById('gastosReviewSupplier').value;
  var invNum = document.getElementById('gastosReviewInvNum').value.trim();
  var invDate = document.getElementById('gastosReviewInvDate').value;
  var period = document.getElementById('gastosReviewPeriod').value;

  if (!supplierId) return alert('Please select a supplier');
  if (!invNum) return alert('Please enter an invoice number');
  if (!invDate) return alert('Please enter an invoice date');

  var lines = gastosCollectLines('rl', GASTOS.reviewLineCount);
  if (!lines.length) return alert('Please add at least one line item');

  gastosFetch('/api/gastos/confirm-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supplier_id: parseInt(supplierId),
      invoice_number: invNum,
      invoice_date: invDate,
      business_period: period,
      currency: 'USD',
      lines: lines,
      source_file: GASTOS.sourceFile || null,
      ocr_raw: GASTOS.currentOCR ? JSON.stringify(GASTOS.currentOCR) : null
    })
  }).then(function() {
    // If there's a queue, advance to the next invoice
    if (GASTOS.reviewQueue && GASTOS.reviewQueueIdx < GASTOS.reviewQueue.length - 1) {
      GASTOS.reviewQueueIdx++;
      gastosShowQueuedReview();
    } else {
      GASTOS.reviewQueue = null;
      gastosCloseReview();
      gastosLoadInvoices();
    }
  }).catch(function(e) { alert('Save failed: ' + e.message); });
}

// ═══════════════════════════════════════════════════════════════════
// MANUAL ENTRY MODAL
// ═══════════════════════════════════════════════════════════════════

/** Show the manual entry modal and reset form. */
function gastosShowManual() {
  document.getElementById('gastosManualModal').classList.remove('hidden');
  document.getElementById('gastosManualSupplier').value = '';
  document.getElementById('gastosManualInvNum').value = '';
  document.getElementById('gastosManualInvDate').value = '';
  document.getElementById('gastosManualPayDate').value = '';
  document.getElementById('gastosManualPeriod').value = '';
  GASTOS.manualLineCount = 0;
  document.getElementById('gastosManualLines').innerHTML = '';
  gastosAddManualLine();
  document.getElementById('gastosManualTotal').textContent = '0.00';
}

/** Close the manual entry modal. */
function gastosCloseManual() {
  document.getElementById('gastosManualModal').classList.add('hidden');
}

/** Add a blank line item row to the manual entry modal. */
function gastosAddManualLine() {
  var idx = GASTOS.manualLineCount++;
  var container = document.getElementById('gastosManualLines');

  var catOptions = '<option value="">-- Select Category --</option>';
  GASTOS.categories.forEach(function(c) {
    catOptions += '<option value="' + c.id + '">' + gastosEscape(c.name) + '</option>';
  });

  container.insertAdjacentHTML('beforeend',
    '<div id="manualLine' + idx + '" style="display:grid; grid-template-columns:2fr 1fr 2fr auto; gap:0.5rem; margin-bottom:0.5rem; align-items:start;">' +
      '<select style="padding:0.4rem; border:1px solid var(--border); border-radius:6px; font-size:0.8rem;" id="mlCat' + idx + '">' + catOptions + '</select>' +
      '<input type="number" step="0.01" placeholder="Amount" style="padding:0.4rem; border:1px solid var(--border); border-radius:6px; font-size:0.85rem;" id="mlAmt' + idx + '" oninput="gastosUpdateManualTotal()">' +
      '<input type="text" placeholder="Description" style="padding:0.4rem; border:1px solid var(--border); border-radius:6px; font-size:0.85rem;" id="mlDesc' + idx + '">' +
      '<button type="button" class="btn btn-sm" style="background:var(--danger); color:white; padding:0.3rem 0.5rem;" onclick="document.getElementById(\'manualLine' + idx + '\').remove(); gastosUpdateManualTotal();">&#10005;</button>' +
    '</div>'
  );
}

/** Recalculate and display the manual entry modal total. */
function gastosUpdateManualTotal() {
  var total = 0;
  for (var i = 0; i < GASTOS.manualLineCount; i++) {
    var el = document.getElementById('mlAmt' + i);
    if (el) total += parseFloat(el.value) || 0;
  }
  document.getElementById('gastosManualTotal').textContent = total.toFixed(2);
}

/** Save a manually entered invoice (creates invoice header, then adds lines). */
function gastosSaveManual() {
  var supplierId = document.getElementById('gastosManualSupplier').value;
  var invNum = document.getElementById('gastosManualInvNum').value.trim();
  var invDate = document.getElementById('gastosManualInvDate').value;
  var payDate = document.getElementById('gastosManualPayDate').value;
  var period = document.getElementById('gastosManualPeriod').value;
  var currency = document.getElementById('gastosManualCurrency').value;

  if (!supplierId) return alert('Please select a supplier');
  if (!invNum) return alert('Please enter an invoice number');
  if (!invDate) return alert('Please enter an invoice date');

  var lines = gastosCollectLines('ml', GASTOS.manualLineCount);
  if (!lines.length) return alert('Please add at least one line item');

  gastosFetch('/api/gastos/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supplier_id: parseInt(supplierId),
      invoice_number: invNum,
      invoice_date: invDate,
      payment_date: payDate || null,
      business_period: period || null,
      currency: currency
    })
  }).then(function(data) {
    // Add lines sequentially to the new invoice
    var promises = lines.map(function(line) {
      return gastosFetch('/api/gastos/invoices/' + data.id + '/lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(line)
      });
    });
    return Promise.all(promises);
  }).then(function() {
    gastosCloseManual();
    gastosLoadInvoices();
  }).catch(function(e) { alert('Save failed: ' + e.message); });
}

/**
 * Collect line items from a set of dynamic form rows.
 * Shared by both review and manual entry flows.
 * @param {string} prefix - Element ID prefix ('rl' for review, 'ml' for manual)
 * @param {number} count - Number of rows that were created
 * @returns {Object[]} Array of { category_id, amount, description }
 */
function gastosCollectLines(prefix, count) {
  var lines = [];
  for (var i = 0; i < count; i++) {
    var catEl = document.getElementById(prefix + 'Cat' + i);
    var amtEl = document.getElementById(prefix + 'Amt' + i);
    var descEl = document.getElementById(prefix + 'Desc' + i);
    if (!catEl || !amtEl) continue; // Row was deleted
    var amt = parseFloat(amtEl.value);
    if (!amt) continue;
    lines.push({
      category_id: catEl.value ? parseInt(catEl.value) : null,
      amount: amt,
      description: descEl ? descEl.value.trim() : ''
    });
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════
// INVOICE DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════

/**
 * Load and display the full detail view for an invoice.
 * @param {number} id - Invoice ID
 */
function gastosViewDetail(id) {
  gastosFetch('/api/gastos/invoices/' + id).then(function(inv) {
    document.getElementById('gastosDetailTitle').textContent = 'Invoice: ' + (inv.invoice_number || 'N/A');

    // ── Editable line items table ──
    var linesHtml = '';
    if (inv.lines && inv.lines.length) {
      linesHtml = '<table class="data-table" style="margin-top:0.75rem;">' +
        '<thead><tr><th>Category</th><th>Description</th><th style="text-align:right;">Amount</th></tr></thead><tbody>';
      inv.lines.forEach(function(l) {
        linesHtml += '<tr id="gastosDetailLine' + l.id + '">' +
          '<td><select class="gastos-line-cat" data-line-id="' + l.id + '" style="width:100%; padding:0.3rem; border:1px solid var(--border); border-radius:4px; font-size:0.85rem;">' +
            '<option value="">-- Select --</option>' +
            (GASTOS.categories || []).map(function(c) {
              return '<option value="' + c.id + '"' + (c.id == l.category_id ? ' selected' : '') + '>' + gastosEscape(c.name) + '</option>';
            }).join('') +
          '</select></td>' +
          '<td><input type="text" class="gastos-line-desc" data-line-id="' + l.id + '" value="' + gastosEscape(l.description || '') + '" style="width:100%; padding:0.3rem; border:1px solid var(--border); border-radius:4px; font-size:0.85rem;"></td>' +
          '<td style="text-align:right;"><input type="number" class="gastos-line-amt" data-line-id="' + l.id + '" value="' + Number(l.amount).toFixed(2) + '" step="0.01" style="width:90px; padding:0.3rem; border:1px solid var(--border); border-radius:4px; font-size:0.85rem; text-align:right;"></td>' +
        '</tr>';
      });
      linesHtml += '</tbody></table>';
      linesHtml += '<div style="margin-top:0.5rem; text-align:right;">' +
        '<button class="btn btn-sm" style="background:var(--brand-red); color:white;" onclick="gastosSaveAllLines(' + inv.id + ')">Save Line Items</button>' +
      '</div>';
    }

    // ── Header info — editable fields ──
    var supplierOptions = '<option value="">-- Select Supplier --</option>' +
      (GASTOS.suppliers || []).map(function(s) {
        return '<option value="' + s.id + '"' + (s.id == inv.supplier_id ? ' selected' : '') + '>' + gastosEscape(s.name) + '</option>';
      }).join('');

    var html = '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-bottom:1rem;">' +
      '<div><strong>Supplier:</strong><br><select id="gastosDetailSupplier" style="width:100%; padding:0.35rem; border:1px solid var(--border); border-radius:4px; margin-top:0.25rem;">' + supplierOptions + '</select></div>' +
      '<div><strong>Status:</strong> ' + gastosStatusBadge(inv.status) + '</div>' +
      '<div><strong>Invoice #:</strong><br><input id="gastosDetailInvNum" type="text" value="' + gastosEscape(inv.invoice_number || '') + '" style="width:100%; padding:0.35rem; border:1px solid var(--border); border-radius:4px; margin-top:0.25rem;"></div>' +
      '<div><strong>Invoice Date:</strong><br><input id="gastosDetailInvDate" type="date" value="' + (inv.invoice_date || '') + '" style="width:100%; padding:0.35rem; border:1px solid var(--border); border-radius:4px; margin-top:0.25rem;"></div>' +
      '<div><strong>Business Period:</strong><br><input id="gastosDetailPeriod" type="month" value="' + (inv.business_period || '') + '" style="width:100%; padding:0.35rem; border:1px solid var(--border); border-radius:4px; margin-top:0.25rem;"></div>' +
      '<div><strong>Total:</strong> <span style="font-size:1.2rem; font-weight:700; color:var(--brand-navy);">$' + Number(inv.total_amount || 0).toFixed(2) + '</span></div>' +
    '</div>' +
    '<div style="margin-bottom:0.75rem; text-align:right;">' +
      '<button class="btn btn-sm" style="background:var(--brand-navy); color:white;" onclick="gastosSaveHeader(' + inv.id + ')">Save Invoice Details</button>' +
    '</div>' +
    (inv.notes ? '<div style="margin-bottom:1rem;"><strong>Notes:</strong> ' + gastosEscape(inv.notes) + '</div>' : '') +
    '<h3 style="font-size:1rem; color:var(--brand-navy);">Line Items (' + (inv.lines ? inv.lines.length : 0) + ')</h3>' +
    linesHtml;

    // ── Payment ID edit control ──
    html += '<div style="margin-top:1rem; display:flex; gap:0.5rem; align-items:center; padding:0.75rem; background:#f0f4f8; border-radius:8px;">' +
      '<label style="font-weight:600; white-space:nowrap;">Payment ID:</label>' +
      '<input type="text" id="gastosDetailPaymentId" value="' + gastosEscape(inv.inc_payment_id || '') + '" placeholder="Enter Payment ID" style="flex:1; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; font-size:0.95rem;">' +
      '<button class="btn btn-sm" style="background:#27ae60; color:white;" onclick="gastosSavePaymentId(' + inv.id + ')">Save</button>' +
    '</div>';

    // ── Status change control ──
    html += '<div style="margin-top:0.75rem; display:flex; gap:0.5rem; align-items:center;">' +
      '<label style="font-weight:600;">Change Status:</label>' +
      '<select id="gastosDetailStatusSel" style="padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px;">';
    ['draft', 'ready', 'submitted', 'verified'].forEach(function(s) {
      html += '<option value="' + s + '"' + (inv.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
    });
    html += '</select>' +
      '<button class="btn btn-sm" style="background:var(--brand-navy); color:white;" onclick="gastosChangeStatus(' + inv.id + ', document.getElementById(\'gastosDetailStatusSel\').value); gastosCloseDetail();">Update</button>' +
    '</div>';

    document.getElementById('gastosDetailContent').innerHTML = html;
    document.getElementById('gastosDetailModal').classList.remove('hidden');
  }).catch(function(e) { alert('Failed to load invoice: ' + e.message); });
}

/** Save invoice header fields (supplier, date, number, period). */
function gastosSaveHeader(id) {
  gastosFetch('/api/gastos/invoices/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supplier_id: document.getElementById('gastosDetailSupplier').value || null,
      invoice_number: document.getElementById('gastosDetailInvNum').value || null,
      invoice_date: document.getElementById('gastosDetailInvDate').value || null,
      business_period: document.getElementById('gastosDetailPeriod').value || null
    })
  }).then(function() {
    gastosLoadInvoices();
    alert('Invoice details saved.');
  }).catch(function(e) { alert('Save failed: ' + e.message); });
}

/** Save all line items (category, description, amount) from the detail view. */
function gastosSaveAllLines(invoiceId) {
  var catEls = document.querySelectorAll('.gastos-line-cat');
  var promises = [];
  catEls.forEach(function(sel) {
    var lineId = sel.getAttribute('data-line-id');
    var descEl = document.querySelector('.gastos-line-desc[data-line-id="' + lineId + '"]');
    var amtEl = document.querySelector('.gastos-line-amt[data-line-id="' + lineId + '"]');
    promises.push(gastosFetch('/api/gastos/lines/' + lineId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: sel.value || null,
        description: descEl ? descEl.value : null,
        amount: amtEl ? parseFloat(amtEl.value) : null
      })
    }));
  });
  Promise.all(promises).then(function() {
    gastosLoadInvoices();
    gastosViewDetail(invoiceId); // Refresh to show updated total
    alert('Line items saved.');
  }).catch(function(e) { alert('Save failed: ' + e.message); });
}

/** Close the invoice detail modal. */
function gastosCloseDetail() {
  document.getElementById('gastosDetailModal').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// STATUS & PAYMENT ID ACTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Mark an invoice as "ready" for Inc. submission.
 * @param {number} id
 */
function gastosMarkReady(id) {
  gastosChangeStatus(id, 'ready');
}

/**
 * Update an invoice's status.
 * @param {number} id - Invoice ID
 * @param {string} status - New status
 */
function gastosChangeStatus(id, status) {
  gastosFetch('/api/gastos/invoices/' + id + '/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status })
  }).then(function() {
    gastosLoadInvoices();
  }).catch(function(e) { alert('Status update failed: ' + e.message); });
}

/**
 * Save a Payment ID for an invoice from the detail view.
 * @param {number} id - Invoice ID
 */
function gastosSavePaymentId(id) {
  var val = document.getElementById('gastosDetailPaymentId').value.trim();
  if (!val) return alert('Please enter a Payment ID.');

  gastosFetch('/api/gastos/invoices/' + id + '/payment-id', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_id: val })
  }).then(function() {
    alert('Payment ID saved!');
    gastosLoadInvoices();
    gastosViewDetail(id);
  }).catch(function(e) { alert('Failed to save Payment ID: ' + e.message); });
}

/**
 * Delete an invoice (with confirmation).
 * @param {number} id - Invoice ID
 */
function gastosDeleteInvoice(id) {
  if (!confirm('Delete this invoice? This cannot be undone.')) return;
  gastosFetch('/api/gastos/invoices/' + id, { method: 'DELETE' })
    .then(function() { gastosLoadInvoices(); })
    .catch(function(e) { alert('Delete failed: ' + e.message); });
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════

/** Open CSV export in a new tab. */
function gastosExport() {
  window.open('/api/gastos/export', '_blank');
}

/** Open PDF receipt export in a new tab (respects current filters). */
function gastosExportReceipts() {
  var status = document.getElementById('gastosStatusFilter').value;
  var month = document.getElementById('gastosMonthFilter').value;
  var params = [];
  if (status) params.push('status=' + encodeURIComponent(status));
  if (month) params.push('month=' + encodeURIComponent(month));
  window.open('/api/gastos/export-receipts' + (params.length ? '?' + params.join('&') : ''), '_blank');
}

// ═══════════════════════════════════════════════════════════════════
// BOOKMARKLET
// ═══════════════════════════════════════════════════════════════════

/** Show the bookmarklet modal and regenerate the bookmarklet code. */
function gastosShowBookmarklet() {
  document.getElementById('gastosBookmarkletModal').classList.remove('hidden');
  gastosGenerateBookmarklet();
}

/** Close the bookmarklet modal. */
function gastosCloseBookmarklet() {
  document.getElementById('gastosBookmarkletModal').classList.add('hidden');
}

/**
 * Generate the bookmarklet code with an embedded auth token.
 * The bookmarklet handles a 3-page Oracle APEX flow:
 *   Page 1: Select supplier + payment month → submit
 *   Page 4: Fill invoice number + date → submit
 *   Page 5: Fill line items → save details → mark submitted
 * After APEX submission, captures the Payment ID on the next page load.
 */
function gastosGenerateBookmarklet() {
  var serverUrl = window.location.origin;

  gastosFetch('/api/gastos/bookmarklet-token', { method: 'POST' })
  .then(function(tokenData) {
    var token = tokenData.token;

    // ── Bookmarklet CSS ──
    var cssStr = '.gastos-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;}' +
      '.gastos-panel{background:white;border-radius:12px;padding:24px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:Arial,sans-serif;}' +
      '.gastos-btn{padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px;margin:4px;}' +
      '.gastos-btn-primary{background:#DD0033;color:white;}' +
      '.gastos-btn-secondary{background:#eee;color:#333;}' +
      '.gastos-status{padding:10px;margin:8px 0;border-radius:6px;font-size:13px;line-height:1.5;}';

    // ── Toast notification helper ──
    var toastFn = 'function showToast(msg,color){' +
      'var n=document.createElement("div");' +
      'n.style.cssText="position:fixed;top:20px;right:20px;background:"+(color||"#27ae60")+";color:white;padding:12px 20px;border-radius:8px;z-index:99999;font-family:Arial;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);";' +
      'n.innerHTML=msg;document.body.appendChild(n);setTimeout(function(){n.remove();},5000);}';

    // ── Close button helper ──
    var closeBtnHtml = '<button class=\\"gastos-btn gastos-btn-secondary\\" onclick=\\"this.closest(\\\'.gastos-overlay\\\').remove()\\">Close</button>';
    var cancelBtnHtml = '<button class=\\"gastos-btn gastos-btn-secondary\\" onclick=\\"this.closest(\\\'.gastos-overlay\\\').remove()\\">Cancel</button>';

    var code = '(function(){' +
    'var SERVER="' + serverUrl + '";' +
    'var TOKEN="' + token + '";' +
    'var HDR={headers:{"Authorization":"Bearer "+TOKEN}};' +
    'var JHDR={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"};' +
    toastFn +
    'var style=document.createElement("style");style.textContent="' + cssStr + '";document.head.appendChild(style);' +

    // ═══ Phase 1: Check for pending Payment ID capture ═══
    'var pidCapture=sessionStorage.getItem("gastos_capture_pid");' +
    'if(pidCapture){' +
      'var pidData=JSON.parse(pidCapture);' +
      'sessionStorage.removeItem("gastos_capture_pid");' +
      'var paymentId="";' +
      // Scan APEX page items
      'var pidItems=["P1_PAYMENT_ID","P5_PAYMENT_ID","P4_PAYMENT_ID","P6_PAYMENT_ID","P1_PAYMENTID"];' +
      'for(var pi=0;pi<pidItems.length;pi++){var el=document.getElementById(pidItems[pi]);if(el&&el.value){paymentId=el.value;break;}}' +
      // Scan page text for "Payment Id: 123456" pattern
      'if(!paymentId){var allText=document.body.innerText||"";var pidMatch=allText.match(/Payment\\s*(?:Id|ID|#|No\\.?)\\s*[:\\-]?\\s*(\\d+)/i);if(pidMatch)paymentId=pidMatch[1];}' +
      // Scan table cells
      'if(!paymentId){var tds=document.querySelectorAll("td,th,span,.t-Report-cell");for(var ti=0;ti<tds.length;ti++){var m2=(tds[ti].textContent||"").match(/Payment\\s*(?:Id|ID|#|No\\.?)\\s*[:\\-]?\\s*(\\d+)/i);if(m2){paymentId=m2[1];break;}}}' +
      // Auto-send if found
      'if(paymentId){' +
        'fetch(SERVER+"/api/gastos-bk/submitted/"+pidData.invoice_id,{method:"PUT",headers:JHDR,body:JSON.stringify({payment_id:paymentId})}).then(function(){showToast("\\u2705 Payment ID <strong>"+paymentId+"</strong> captured!");});' +
      '}else{' +
        // Manual entry prompt
        'var pidOverlay=document.createElement("div");pidOverlay.className="gastos-overlay";' +
        'var pidPanel=document.createElement("div");pidPanel.className="gastos-panel";' +
        'pidPanel.innerHTML="<h2 style=\\"margin:0 0 12px;color:#004F71;\\">\\ud83d\\udcb0 Capture Payment ID</h2><p style=\\"font-size:13px;color:#555;\\">Invoice was submitted. Enter the Payment ID shown on this page:</p><input type=\\"text\\" id=\\"gastosPidInput\\" placeholder=\\"Payment ID\\" style=\\"width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:15px;margin:8px 0;\\"><div style=\\"margin-top:12px;text-align:right;\\"><button class=\\"gastos-btn gastos-btn-primary\\" id=\\"gastosPidSave\\">Save Payment ID</button> <button class=\\"gastos-btn gastos-btn-secondary\\" onclick=\\"this.closest(\\\'.gastos-overlay\\\').remove()\\">Skip</button></div>";' +
        'pidOverlay.appendChild(pidPanel);document.body.appendChild(pidOverlay);' +
        'document.getElementById("gastosPidSave").onclick=function(){' +
          'var val=document.getElementById("gastosPidInput").value.trim();' +
          'if(val){fetch(SERVER+"/api/gastos-bk/submitted/"+pidData.invoice_id,{method:"PUT",headers:JHDR,body:JSON.stringify({payment_id:val})}).then(function(){pidOverlay.remove();showToast("\\u2705 Payment ID <strong>"+val+"</strong> saved!");});}' +
        '};' +
      '}' +
      'return;' +
    '}' +

    // ═══ Phase 2: Normal flow — fetch next invoice and auto-fill ═══
    'var overlay=document.createElement("div");overlay.className="gastos-overlay";' +
    'var panel=document.createElement("div");panel.className="gastos-panel";' +
    'panel.innerHTML="<h2 style=\\"margin:0 0 12px;color:#004F71;\\">\\ud83d\\udcb0 Gastos Auto-Filler</h2><div id=\\"gastosStatus\\" class=\\"gastos-status\\" style=\\"background:#f0f4f8;\\">Fetching next invoice...</div><div id=\\"gastosActions\\" style=\\"margin-top:12px;text-align:right;\\"></div>";' +
    'overlay.appendChild(panel);document.body.appendChild(overlay);' +
    'var statusEl=document.getElementById("gastosStatus");' +
    'var actionsEl=document.getElementById("gastosActions");' +

    'fetch(SERVER+"/api/gastos-bk/next",HDR).then(function(r){return r.json();}).then(function(data){' +
      'if(data.error){statusEl.innerHTML="<span style=\\"color:#e74c3c;\\">"+data.error+"</span>";actionsEl.innerHTML="' + closeBtnHtml + '";return;}' +
      'var total=data.lines.reduce(function(s,l){return s+(l.amount||0);},0);' +
      'statusEl.innerHTML="<strong>"+data.supplier_name+"</strong><br>Invoice: "+data.invoice_number+"<br>Date: "+data.invoice_date+"<br>Lines: "+data.lines.length+"<br>Total: $"+total.toFixed(2);' +
      'statusEl.style.background="#e8f5e9";' +
      'var isPage1=!!document.getElementById("P1_SUPPLIER");' +
      'var isPage4=!!document.getElementById("P4_INVOICE_NUMBER");' +
      'var isPage5=!!document.getElementById("P5_EXPENSE_CATEGORY");' +

      // ─── PAGE 1 ───
      'if(isPage1&&!isPage4&&!isPage5){' +
        'statusEl.innerHTML+="<br><br><strong>Page 1:</strong> Will select supplier & payment month, then submit.";' +
        'actionsEl.innerHTML="<button class=\\"gastos-btn gastos-btn-primary\\" id=\\"gastosGoBtn\\">Select Supplier & Continue</button> ' + cancelBtnHtml + '";' +
        'document.getElementById("gastosGoBtn").onclick=function(){try{$s("P1_SUPPLIER",data.supplier_inc_id);if(data.payment_month){$s("P1_BUSINESS_PERIODS",data.payment_month);}overlay.remove();apex.submit("P1_ADD_INVOICE");}catch(err){statusEl.innerHTML="<span style=\\"color:#e74c3c;\\">Error: "+err.message+"</span>";}};' +

      // ─── PAGE 4 ───
      '}else if(isPage4){' +
        'statusEl.innerHTML+="<br><br><strong>Page 4:</strong> Will fill invoice number & date, then submit.";' +
        'actionsEl.innerHTML="<button class=\\"gastos-btn gastos-btn-primary\\" id=\\"gastosFillBtn\\">Fill Header & Continue</button> ' + cancelBtnHtml + '";' +
        'document.getElementById("gastosFillBtn").onclick=function(){try{$s("P4_INVOICE_NUMBER",data.invoice_number);$s("P4_INVOICE_DATE",data.invoice_date);overlay.remove();apex.submit("P4_SAVE_INVOICE");}catch(err){statusEl.innerHTML="<span style=\\"color:#e74c3c;\\">Error: "+err.message+"</span>";}};' +

      // ─── PAGE 5 ───
      '}else if(isPage5){' +
        'var lineIdx=0;' +
        'function fillLine(){' +
          'if(lineIdx>=data.lines.length){' +
            'statusEl.innerHTML="<span style=\\"color:#27ae60;\\">\\u2705 All "+data.lines.length+" line(s) saved!</span><br>Click <strong>Save & Mark Submitted</strong> to finalize.";' +
            'actionsEl.innerHTML="<button class=\\"gastos-btn gastos-btn-primary\\" id=\\"gastosFinalSave\\">Save & Mark Submitted</button> ' + closeBtnHtml + '";' +
            'document.getElementById("gastosFinalSave").onclick=function(){' +
              'fetch(SERVER+"/api/gastos-bk/submitted/"+data.invoice_id,{method:"PUT",headers:JHDR,body:JSON.stringify({})}).then(function(){' +
                'sessionStorage.setItem("gastos_capture_pid",JSON.stringify({invoice_id:data.invoice_id}));' +
                'overlay.remove();apex.submit("P5_UPDATE_INVOICE");' +
              '});' +
            '};' +
            'return;' +
          '}' +
          'var line=data.lines[lineIdx];var dispAmt=parseFloat(line.amount)||0;' +
          'statusEl.innerHTML="<strong>Line "+(lineIdx+1)+"/"+data.lines.length+"</strong><br>"+(line.category_name||"No category")+"<br>"+line.description+"<br><strong>$"+dispAmt.toFixed(2)+"</strong>";' +
          '$s("P5_EXPENSE_CATEGORY",line.category_inc_id||"");$s("P5_AMOUNT",dispAmt.toFixed(2));$s("P5_DESCRIPTION",line.description||"");' +
          'if(!$v("P5_PAYMENT_DATE")){$s("P5_PAYMENT_DATE",data.invoice_date);}' +
          'lineIdx++;' +
          'var btnLabel=lineIdx<data.lines.length?"Save Detail & Fill Next":"Save Last Detail";' +
          'actionsEl.innerHTML="<button class=\\"gastos-btn gastos-btn-primary\\" id=\\"gastosSaveDetail\\">"+btnLabel+"</button> ' + cancelBtnHtml + '";' +
          'document.getElementById("gastosSaveDetail").onclick=function(){' +
            'statusEl.innerHTML="<span style=\\"color:#e67e22;\\">Saving detail...</span>";' +
            'var links=document.querySelectorAll("a");for(var i=0;i<links.length;i++){if(links[i].textContent.indexOf("Save Detail")>=0||links[i].textContent.indexOf("Guardar detalle")>=0){links[i].click();break;}}' +
            'setTimeout(fillLine,2000);' +
          '};' +
        '}' +
        'fillLine();' +

      '}else{' +
        'statusEl.innerHTML="<span style=\\"color:#e67e22;\\">Could not detect APEX page. Navigate to the Inc. expense website home page and click the bookmarklet again.</span>";' +
        'actionsEl.innerHTML="' + closeBtnHtml + '";' +
      '}' +
    '}).catch(function(e){statusEl.innerHTML="<span style=\\"color:#e74c3c;\\">Error: "+e.message+". Try generating a new bookmarklet from the Gastos tab.</span>";actionsEl.innerHTML="' + closeBtnHtml + '";});' +
    '})();';

    var link = document.getElementById('gastosBookmarkletLink');
    if (link) {
      link.href = 'javascript:' + encodeURIComponent(code);
    }
  }).catch(function(e) { console.error('Failed to generate bookmarklet token:', e); });
}

// ═══════════════════════════════════════════════════════════════════
// TAB VISIBILITY (role-based access)
// ═══════════════════════════════════════════════════════════════════

/**
 * Show the Gastos tab only for admin users or employees with Administrator role.
 * Falls back to an API probe if client-side role info is unavailable.
 */
function gastosCheckAccess() {
  var btn = document.getElementById('tabBtnGastos');
  if (!btn) return;

  if (typeof window.currentUserRole !== 'undefined' && window.currentUserRole === 'admin') {
    btn.style.display = '';
    return;
  }
  if (typeof window.currentEmployeeRole !== 'undefined' && window.currentEmployeeRole === 'Administrator') {
    btn.style.display = '';
    return;
  }

  // Fallback: probe an API endpoint (returns 401 if unauthorized)
  fetch('/api/gastos/invoices?status=draft').then(function(r) {
    if (r.ok) btn.style.display = '';
  }).catch(function() {});
}
