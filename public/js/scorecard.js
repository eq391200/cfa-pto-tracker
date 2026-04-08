// ══════════════════════════════════════════════════════════════════════
// SHARED EXECUTIVE SCORECARD MODULE
// Used by both admin (index.html) and employee (employee.html) portals.
// ══════════════════════════════════════════════════════════════════════

var SC_ICONS = {
  osat_overall: '\u2B50',
  osat_speed: '\u26A1',
  osat_attentive: '\uD83E\uDD1D',
  osat_cleanliness: '\u2728',
  osat_accuracy: '\uD83C\uDFAF',
  osat_taste: '\uD83D\uDE0B',
  google_reviews: '<img src="https://www.google.com/favicon.ico" style="width:16px;height:16px;vertical-align:middle;" alt="G">',
  uber_rating: '<img src="/img/uber-eats.png" style="width:20px;height:20px;vertical-align:middle;" alt="UE">',
  sales_total: '\uD83D\uDCB0',
  sales_drive_thru: '\uD83D\uDE97',
  sales_dine_in: '\uD83C\uDF7D\uFE0F',
  sales_carry_out: '\uD83E\uDD61',
  sales_catering: '\uD83C\uDF89',
  sales_third_party: '\uD83D\uDCF1',
  growth_sales: '\uD83D\uDCC8',
  avg_check: '\uD83E\uDDFE',
  avg_transactions: '\uD83D\uDD22',
  qiv: '\uD83D\uDD0D',
  ecosure: '\uD83D\uDEE1\uFE0F',
  smart_shop: '\uD83D\uDED2',
  food_cost_gap: '\uD83C\uDF57',
  aha_pct: '\u23F1\uFE0F',
  speed_of_service: '\uD83C\uDFCE\uFE0F',
  productivity: '\u26A1',
  instagram_followers: '<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Instagram_icon.png/120px-Instagram_icon.png" style="width:16px;height:16px;vertical-align:middle;" alt="IG">',
  facebook_followers: '<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Facebook_Logo_%282019%29.png/120px-Facebook_Logo_%282019%29.png" style="width:16px;height:16px;vertical-align:middle;" alt="FB">'
};

var SC_OSAT_KEYS = ['osat_overall', 'osat_speed', 'osat_attentive', 'osat_cleanliness', 'osat_accuracy', 'osat_taste'];
var SC_PREV_MONTH_KEYS = ['instagram_followers', 'facebook_followers', 'google_reviews', 'uber_rating',
  'qiv', 'ecosure', 'smart_shop', 'food_cost_gap', 'aha_pct', 'productivity'];

var SC_WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
var SC_WEEKDAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
var SC_MONTH_COLORS = [
  'rgba(229,22,54,0.85)', 'rgba(0,48,87,0.85)', 'rgba(221,68,68,0.85)',
  'rgba(0,135,60,0.85)', 'rgba(153,27,27,0.85)', 'rgba(51,51,51,0.85)',
  'rgba(229,22,54,0.6)', 'rgba(0,48,87,0.6)', 'rgba(221,68,68,0.6)',
  'rgba(0,135,60,0.6)', 'rgba(153,27,27,0.6)', 'rgba(51,51,51,0.6)'
];
var SC_MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

// ── ScorecardView constructor ────────────────────────────────────────
// ids: { monthPicker, section1, section2, section3, section4,
//        osatSlot, salesSlot, osatChart, salesChart, sosChart,
//        periodBtnScope }
function ScorecardView(ids) {
  this.ids = ids;
  this.config = null;
  this.data = null;
  this.currentPeriod = 'monthly';
  this._sosChart = null;
  this._salesChart = null;
  this._osatChart = null;
}

ScorecardView.prototype.loadConfig = async function() {
  if (this.config) return this.config;
  var res = await fetch('/api/scorecard/config');
  this.config = await res.json();
  return this.config;
};

ScorecardView.prototype.setPeriod = function(period, btn) {
  this.currentPeriod = period;
  var scope = this.ids.periodBtnScope || '';
  document.querySelectorAll(scope + ' .sc-period-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  this.load();
};

ScorecardView.prototype.load = async function() {
  await this.loadConfig();
  var picker = document.getElementById(this.ids.monthPicker);
  if (!picker.value) {
    var now = new Date();
    now.setMonth(now.getMonth() - 1);
    picker.value = now.toISOString().slice(0, 7);
  }
  try {
    var res = await fetch('/api/scorecard/data?period=' + this.currentPeriod + '&month=' + picker.value);
    this.data = await res.json();
    this.render();
  } catch (err) {
    console.error('Scorecard load error:', err);
  }
};

/** Convert pct value: if already > 1 (e.g. 95) treat as whole %; if <= 1 (e.g. 0.95) multiply by 100 */
ScorecardView.prototype.pctVal = function(value) {
  if (value === null || value === undefined) return null;
  return Math.abs(value) > 1 ? value : value * 100;
};

ScorecardView.prototype.formatValue = function(key, value) {
  if (value === null || value === undefined) return '<span style="color:var(--text-light);">\u2014</span>';
  var cfg = this.config;
  if (cfg.pctMetrics.includes(key)) return this.pctVal(value).toFixed(1) + '%';
  if (cfg.currencyMetrics.includes(key)) {
    if (Math.abs(value) >= 1000) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return '$' + value.toFixed(2);
  }
  if (key === 'instagram_followers' || key === 'facebook_followers' || key === 'avg_transactions') return Math.round(value).toLocaleString('en-US');
  if (key === 'speed_of_service') {
    var mins = Math.floor(value / 60);
    var secs = Math.round(value % 60);
    return mins + ':' + String(secs).padStart(2, '0');
  }
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(2);
};

ScorecardView.prototype.getDelta = function(key, current, previous) {
  if (current === undefined || current === null || previous === undefined || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
};

ScorecardView.prototype.deltaHTML = function(key, delta) {
  if (delta === null) return '';
  var lowerIsBetter = ['food_cost_gap', 'speed_of_service', 'ecosure'].includes(key);
  var isGood = lowerIsBetter ? (delta <= 0) : (delta >= 0);
  var color = isGood ? 'var(--brand-green)' : 'var(--brand-red)';
  var arrow = delta >= 0 ? '&#9650;' : '&#9660;';
  return '<span style="font-size:0.75rem; color:' + color + '; font-weight:600;">' + arrow + ' ' + Math.abs(delta).toFixed(1) + '%</span>';
};

ScorecardView.prototype.buildCard = function(key, current, prevYoY, prevMonth, extraStyle) {
  var self = this;
  var label = self.config.labels[key] || key;
  var icon = SC_ICONS[key] || '';
  var val = current[key];
  var isOsat = SC_OSAT_KEYS.indexOf(key) !== -1;
  var isPrevMonth = SC_PREV_MONTH_KEYS.indexOf(key) !== -1;
  var prev = (isOsat || isPrevMonth) ? (prevMonth || {})[key] : (prevYoY || {})[key];
  var delta = self.getDelta(key, val, prev);
  var compLabel = (isOsat || isPrevMonth) ? 'vs mes anterior' : 'vs mismo mes a\u00F1o anterior';

  // Ecosure color coding: 1-2 green, 3-4 yellow, 5-10 red
  var ecosureStyle = '';
  if (key === 'ecosure' && val != null) {
    if (val <= 2) ecosureStyle = 'border-left:4px solid var(--brand-green);';
    else if (val <= 4) ecosureStyle = 'border-left:4px solid #F5A623;';
    else ecosureStyle = 'border-left:4px solid var(--brand-red);';
  }

  var viewId = self.ids.monthPicker;
  var html = '<div class="stat-card" style="cursor:pointer; ' + (ecosureStyle || extraStyle || '') + '" onclick="scShowMetricDrilldown(\'' + key + '\', \'' + viewId + '\')">';
  html += '<div class="stat-value">' + self.formatValue(key, val) + '</div>';
  html += '<div class="stat-label">' + (icon ? '<span style="margin-right:0.3rem;">' + icon + '</span>' : '') + esc(label) + '</div>';
  if (delta !== null) {
    html += '<div style="margin-top:0.25rem;">' + self.deltaHTML(key, delta) + ' <span style="font-size:0.65rem; color:var(--text-light);">' + compLabel + '</span></div>';
  }
  var isCommunity = ['instagram_followers', 'facebook_followers'].indexOf(key) !== -1;
  if (isCommunity && val != null && prev != null) {
    var added = Math.round(val - prev);
    var addColor = added >= 0 ? 'var(--brand-green)' : 'var(--brand-red)';
    var addSign = added >= 0 ? '+' : '';
    html += '<div style="margin-top:0.15rem; font-size:0.75rem; color:' + addColor + '; font-weight:600;">' + addSign + added.toLocaleString('en-US') + ' este mes</div>';
  }
  if (key === 'osat_overall' && current.osat_market != null && val != null) {
    var mktNorm = Math.abs(current.osat_market) > 1 ? current.osat_market : current.osat_market * 100;
    var valNorm = Math.abs(val) > 1 ? val : val * 100;
    var mktDelta = valNorm - mktNorm;
    var mktColor = mktDelta >= 0 ? 'var(--brand-green)' : 'var(--brand-red)';
    var mktArrow = mktDelta >= 0 ? '&#9650;' : '&#9660;';
    html += '<div style="margin-top:0.25rem;">';
    html += '<span style="font-size:0.75rem; color:' + mktColor + '; font-weight:600;">' + mktArrow + ' ' + Math.abs(mktDelta).toFixed(1) + ' pp</span>';
    html += ' <span style="font-size:0.65rem; color:var(--text-light);">vs mercado (' + mktNorm.toFixed(0) + '%)</span>';
    html += '</div>';
  }
  html += '</div>';
  return html;
};

ScorecardView.prototype.renderSection = function(sectionKey, metrics, current, prevYoY, prevMonth) {
  var self = this;
  var sectionId = self.ids['section' + sectionKey];

  // Section 1: Operational Excellence — OSAT sub-metrics grouped
  if (sectionKey === '1') {
    var html = '';
    var osatSlot = document.getElementById(self.ids.osatSlot);
    if (osatSlot) {
      osatSlot.innerHTML = self.buildCard('osat_overall', current, prevYoY, prevMonth, 'border-left:4px solid var(--brand-red); flex:1; display:flex; flex-direction:column; justify-content:center; min-height:100%;');
    }
    var osatSubs = ['osat_speed', 'osat_attentive', 'osat_cleanliness', 'osat_accuracy', 'osat_taste'];
    html += '<div style="margin-bottom:1.25rem; padding:1rem; background:var(--bg-alt, #f8f9fa); border-radius:var(--radius-lg, 12px); border:1px solid var(--border, #e0e0e0);">';
    html += '<div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--brand-navy); margin-bottom:0.75rem;">Desglose OSAT</div>';
    html += '<div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:0.75rem;">';
    for (var i = 0; i < osatSubs.length; i++) {
      html += self.buildCard(osatSubs[i], current, prevYoY, prevMonth, 'background:white; border-left:3px solid var(--brand-blue);');
    }
    html += '</div></div>';
    var extMetrics = ['google_reviews', 'uber_rating'];
    html += '<div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">';
    for (var j = 0; j < extMetrics.length; j++) {
      html += self.buildCard(extMetrics[j], current, prevYoY, prevMonth, '');
    }
    html += '</div>';
    // Google Reviews Goal Tracker placeholder
    html += '<div id="review-goal-tracker" style="margin-top:1.25rem;"></div>';
    document.getElementById(sectionId).innerHTML = html;
    self.renderReviewGoalTracker();
    return;
  }

  // Section 2: Sales Growth — channels grouped + SSS% card
  if (sectionKey === '2') {
    var salesChannels = ['sales_drive_thru', 'sales_dine_in', 'sales_carry_out', 'sales_catering', 'sales_third_party'];
    var otherSales = metrics.filter(function(k) { return k !== 'sales_total' && salesChannels.indexOf(k) === -1; });
    var html = '';
    var salesSlot = document.getElementById(self.ids.salesSlot);
    if (salesSlot) {
      salesSlot.innerHTML = self.buildCard('sales_total', current, prevYoY, prevMonth, 'border-left:4px solid var(--brand-red); flex:1; display:flex; flex-direction:column; justify-content:center; min-height:100%;');
    }
    html += '<div style="margin-bottom:1.25rem; padding:1rem; background:var(--bg-alt, #f8f9fa); border-radius:var(--radius-lg, 12px); border:1px solid var(--border, #e0e0e0);">';
    html += '<div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--brand-navy); margin-bottom:0.75rem;">Ventas por Canal</div>';
    html += '<div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:0.75rem;">';
    for (var i = 0; i < salesChannels.length; i++) {
      html += self.buildCard(salesChannels[i], current, prevYoY, prevMonth, 'background:white; border-left:3px solid var(--brand-blue);');
    }
    html += '</div></div>';
    html += '<div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">';
    html += self.buildCard('growth_sales', current, prevYoY, prevMonth, '');
    for (var j = 0; j < otherSales.length; j++) {
      html += self.buildCard(otherSales[j], current, prevYoY, prevMonth, '');
    }
    html += '</div>';
    document.getElementById(sectionId).innerHTML = html;
    return;
  }

  // Section 4: Community — social media cards + monthly follower goal tracker
  if (sectionKey === '4') {
    var html = '<div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">';
    for (var i = 0; i < metrics.length; i++) {
      html += self.buildCard(metrics[i], current, prevYoY, prevMonth, '');
    }
    html += '</div>';

    // Monthly goal tracker: 1,000 combined new followers across IG + FB
    var igCur = current.instagram_followers;
    var fbCur = current.facebook_followers;
    var igPrev = prevMonth ? prevMonth.instagram_followers : null;
    var fbPrev = prevMonth ? prevMonth.facebook_followers : null;
    var igNew = (igCur != null && igPrev != null) ? Math.round(igCur - igPrev) : null;
    var fbNew = (fbCur != null && fbPrev != null) ? Math.round(fbCur - fbPrev) : null;
    var totalNew = null;
    if (igNew !== null || fbNew !== null) totalNew = (igNew || 0) + (fbNew || 0);

    if (totalNew !== null) {
      var goal = 1000;
      var pct = Math.min((totalNew / goal) * 100, 100);
      var barColor = totalNew >= goal ? 'var(--brand-green)' : (pct >= 60 ? '#F5A623' : 'var(--brand-red)');
      var statusEmoji = totalNew >= goal ? '\u2705' : (pct >= 60 ? '\u26A0\uFE0F' : '\uD83D\uDEA8');

      html += '<div style="margin-top:1.25rem; padding:1rem 1.25rem; background:var(--bg-alt, #f8f9fa); border-radius:var(--radius-lg, 12px); border:1px solid var(--border, #e0e0e0);">';
      html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">';
      html += '<div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--brand-navy);">\uD83C\uDFAF Meta Mensual de Seguidores</div>';
      html += '<div style="font-size:0.85rem; font-weight:700; color:' + barColor + ';">' + statusEmoji + ' ' + totalNew.toLocaleString('en-US') + ' / ' + goal.toLocaleString('en-US') + '</div>';
      html += '</div>';

      // Progress bar
      html += '<div style="background:#e0e0e0; border-radius:8px; height:22px; overflow:hidden; position:relative;">';
      html += '<div style="background:' + barColor + '; height:100%; width:' + pct.toFixed(1) + '%; border-radius:8px; transition:width 0.5s ease;"></div>';
      html += '<div style="position:absolute; top:0; left:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; font-size:0.7rem; font-weight:700; color:' + (pct > 50 ? 'white' : '#333') + ';">' + pct.toFixed(0) + '%</div>';
      html += '</div>';

      // Breakdown: IG and FB contributions
      html += '<div style="display:flex; gap:1.5rem; margin-top:0.75rem; font-size:0.8rem; color:var(--text-light);">';
      if (igNew !== null) {
        var igIcon = SC_ICONS.instagram_followers || '';
        var igColor = igNew >= 0 ? 'var(--brand-green)' : 'var(--brand-red)';
        html += '<div>' + igIcon + ' <span style="color:' + igColor + '; font-weight:600;">' + (igNew >= 0 ? '+' : '') + igNew.toLocaleString('en-US') + '</span> Instagram</div>';
      }
      if (fbNew !== null) {
        var fbIcon = SC_ICONS.facebook_followers || '';
        var fbColor = fbNew >= 0 ? 'var(--brand-green)' : 'var(--brand-red)';
        html += '<div>' + fbIcon + ' <span style="color:' + fbColor + '; font-weight:600;">' + (fbNew >= 0 ? '+' : '') + fbNew.toLocaleString('en-US') + '</span> Facebook</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Yearly goal tracker: 40,000 total community audience (IG + FB combined)
    if (igCur != null || fbCur != null) {
      var totalAudience = (igCur || 0) + (fbCur || 0);
      var yearlyGoal = 40000;
      var yearPct = Math.min((totalAudience / yearlyGoal) * 100, 100);
      var yearColor = totalAudience >= yearlyGoal ? 'var(--brand-green)' : (yearPct >= 75 ? '#F5A623' : 'var(--brand-navy)');
      var yearEmoji = totalAudience >= yearlyGoal ? '\u2705' : '\uD83D\uDCCA';

      html += '<div style="margin-top:0.75rem; padding:0.75rem 1rem; background:var(--bg-alt, #f8f9fa); border-radius:var(--radius-lg, 12px); border:1px solid var(--border, #e0e0e0);">';
      html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">';
      html += '<div style="font-size:0.65rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-light);">' + yearEmoji + ' Audiencia Total — Meta Anual</div>';
      html += '<div style="font-size:0.8rem; font-weight:700; color:' + yearColor + ';">' + totalAudience.toLocaleString('en-US') + ' / ' + yearlyGoal.toLocaleString('en-US') + '</div>';
      html += '</div>';

      // Smaller progress bar
      html += '<div style="background:#e0e0e0; border-radius:6px; height:14px; overflow:hidden; position:relative;">';
      html += '<div style="background:' + yearColor + '; height:100%; width:' + yearPct.toFixed(1) + '%; border-radius:6px; transition:width 0.5s ease;"></div>';
      html += '<div style="position:absolute; top:0; left:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; font-size:0.6rem; font-weight:700; color:' + (yearPct > 45 ? 'white' : '#333') + ';">' + yearPct.toFixed(0) + '%</div>';
      html += '</div>';

      // Platform breakdown
      html += '<div style="display:flex; gap:1.5rem; margin-top:0.5rem; font-size:0.7rem; color:var(--text-light);">';
      if (igCur != null) html += '<div>' + (SC_ICONS.instagram_followers || '') + ' ' + Math.round(igCur).toLocaleString('en-US') + '</div>';
      if (fbCur != null) html += '<div>' + (SC_ICONS.facebook_followers || '') + ' ' + Math.round(fbCur).toLocaleString('en-US') + '</div>';
      var remaining = yearlyGoal - totalAudience;
      if (remaining > 0) html += '<div style="margin-left:auto; font-style:italic;">Faltan ' + remaining.toLocaleString('en-US') + '</div>';
      html += '</div>';
      html += '</div>';
    }

    document.getElementById(sectionId).innerHTML = html;
    return;
  }

  // Default layout for remaining sections
  var html = '<div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">';
  for (var i = 0; i < metrics.length; i++) {
    html += self.buildCard(metrics[i], current, prevYoY, prevMonth, '');
  }
  html += '</div>';
  document.getElementById(sectionId).innerHTML = html;
};

ScorecardView.prototype.render = function() {
  if (!this.data || !this.config) return;
  var cur = this.data.current;
  var prevYoY = this.data.previousYoY;
  var prevMonth = this.data.previousMonth;
  var sec = this.config.sections;

  // Auto-compute SSS%
  if (cur.sales_total != null && prevYoY && prevYoY.sales_total != null && prevYoY.sales_total !== 0) {
    cur.growth_sales = (cur.sales_total - prevYoY.sales_total) / prevYoY.sales_total;
  }

  this.renderSection('1', sec.operational_excellence, cur, prevYoY, prevMonth);
  this.renderSection('2', sec.sales_growth, cur, prevYoY, prevMonth);
  this.renderSection('3', sec.quality_brand, cur, prevYoY, prevMonth);
  this.renderSection('4', sec.community, cur, prevYoY, prevMonth);
  this.renderSalesTrendChart();
  this.renderOsatTrendChart();
  this.renderSosTrendChart();
};

// ── SOS Trend Chart (12 months + YoY label) ────────────────────────
ScorecardView.prototype.renderSosTrendChart = async function() {
  var picker = document.getElementById(this.ids.monthPicker);
  var refMonth = picker ? picker.value : null;
  if (!refMonth) return;

  // Fetch last 12 months
  var sosTrend, allTrend;
  try {
    var sosRes = await fetch('/api/scorecard/data?period=year&month=' + refMonth);
    var sosData = await sosRes.json();
    sosTrend = sosData.trend && sosData.trend.speed_of_service;
    allTrend = sosData.trend;
  } catch(e) { return; }
  if (!sosTrend || !sosTrend.length) return;

  // Also fetch prior year for YoY comparison
  var prevYear = parseInt(refMonth.split('-')[0]) - 1;
  var prevMap = {};
  try {
    var prevRefMonth = prevYear + refMonth.slice(4);
    var prevRes = await fetch('/api/scorecard/data?period=year&month=' + prevRefMonth);
    var prevData = await prevRes.json();
    var prevTrend = prevData.trend && prevData.trend.speed_of_service;
    if (prevTrend) {
      for (var p = 0; p < prevTrend.length; p++) {
        prevMap[prevTrend[p].month.split('-')[1]] = prevTrend[p].value;
      }
    }
  } catch(e) {}

  var last12 = sosTrend.slice(-12);
  var values = last12.map(function(t) { return t.value != null ? t.value : null; });
  var monthLabels = last12.map(function(t) {
    var parts = t.month.split('-');
    return SC_MONTH_NAMES[parseInt(parts[1]) - 1] + ' ' + parts[0].slice(2);
  });

  // Build YoY diff for each point
  var diffLabels = last12.map(function(t) {
    if (t.value == null) return null;
    var mm = t.month.split('-')[1];
    var prev = prevMap[mm];
    if (prev == null) return null;
    return t.value - prev; // negative = faster
  });

  function fmtTime(v) {
    if (v == null) return '';
    var m = Math.floor(Math.abs(v) / 60); var s = Math.round(Math.abs(v) % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function fmtDiff(v) {
    if (v == null) return '';
    var sign = v <= 0 ? '\u2212' : '+'; // − or +
    var abs = Math.abs(v);
    var m = Math.floor(abs / 60); var s = Math.round(abs % 60);
    if (m === 0) return sign + s + 's';
    if (s === 0) return sign + m + 'm';
    return sign + m + 'm ' + s + 's';
  }

  var canvas = document.getElementById(this.ids.sosChart);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (this._sosChart) this._sosChart.destroy();

  var sosLabelsPlugin = {
    id: 'sosLabels_' + this.ids.sosChart,
    afterDraw: function(chart) {
      var ctx2 = chart.ctx; ctx2.save();
      var meta = chart.getDatasetMeta(0);
      for (var i = 0; i < meta.data.length; i++) {
        var val = chart.data.datasets[0].data[i];
        if (val == null) continue;
        var pt = meta.data[i];

        // M:SS time label
        ctx2.font = 'bold 10px sans-serif'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'bottom';
        var timeLabel = fmtTime(val);
        var textW = ctx2.measureText(timeLabel).width;
        ctx2.fillStyle = 'rgba(255,255,255,0.85)';
        ctx2.fillRect(pt.x - textW / 2 - 2, pt.y - 18, textW + 4, 14);
        ctx2.fillStyle = '#004F71';
        ctx2.fillText(timeLabel, pt.x, pt.y - 5);

        // YoY diff label above the time
        var diff = diffLabels[i];
        if (diff != null) {
          var isFaster = diff <= 0;
          var diffStr = fmtDiff(diff);
          ctx2.font = 'bold 9px sans-serif'; ctx2.textBaseline = 'bottom';
          ctx2.fillStyle = isFaster ? '#2e7d32' : '#c62828';
          ctx2.fillText(diffStr + ' vs PY', pt.x, pt.y - 20);
        }
      }
      ctx2.restore();
    }
  };

  this._sosChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: monthLabels,
      datasets: [
        { label: 'Speed of Service', data: values, borderColor: '#E51636', backgroundColor: 'rgba(229,22,54,0.1)', borderWidth: 2.5, pointBackgroundColor: '#E51636', pointRadius: 5, pointHoverRadius: 7, fill: true, tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          label: function(tipCtx) { var v = tipCtx.raw; if (v == null) return ''; return 'SOS: ' + fmtTime(v); },
          afterLabel: function(tipCtx) {
            var diff = diffLabels[tipCtx.dataIndex];
            if (diff == null) return '';
            var isFaster = diff <= 0;
            return (isFaster ? 'Faster' : 'Slower') + ' by ' + fmtTime(Math.abs(diff)) + ' vs ' + prevYear;
          }
        }}
      },
      scales: {
        y: { title: { display: true, text: 'Time (M:SS)', font: { size: 11 } }, ticks: { callback: function(v) { return fmtTime(v); } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        x: { ticks: { font: { size: 10 } } }
      },
      layout: { padding: { top: 30 } }
    },
    plugins: [sosLabelsPlugin]
  });
};

// ── Google Reviews Goal Tracker ──────────────────────────────────────
ScorecardView.prototype.renderReviewGoalTracker = async function() {
  var self = this;
  var container = document.getElementById('review-goal-tracker');
  if (!container) return;

  var picker = document.getElementById(this.ids.monthPicker);
  var refMonth = picker ? picker.value : null;
  var year = refMonth ? refMonth.split('-')[0] : new Date().getFullYear().toString();

  try {
    var res = await fetch('/api/scorecard/review-goals?year=' + year);
    var data = await res.json();
    if (data.error) { container.innerHTML = ''; return; }

    var ANNUAL_GOAL = data.annualGoal;
    var MONTHLY_GOAL = data.monthlyGoal;
    var currentCount = data.currentCount || 0;
    var totalNew = data.totalNewThisYear;
    var progressPct = data.progressPct || 0;
    if (progressPct > 100) progressPct = 100;
    var hasData = data.months.some(function(m) { return m.totalCount !== null; });

    var html = '';
    html += '<div style="padding:1.25rem; background:var(--bg-alt, #f8f9fa); border-radius:var(--radius-lg, 12px); border:1px solid var(--border, #e0e0e0);">';

    // Header with fetch button
    html += '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:1rem;">';
    html += '<div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--brand-navy);"><img src="https://www.google.com/favicon.ico" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;" alt="G"> Google Reviews Goal Tracker ' + year + '</div>';
    html += '<div style="display:flex; align-items:center; gap:10px;">';
    html += '<span style="font-size:0.75rem; color:var(--text-light);">Meta: <strong>' + ANNUAL_GOAL.toLocaleString() + '/a\u00F1o</strong> | <strong>' + MONTHLY_GOAL + '/mes</strong></span>';
    html += '<button onclick="window._scFetchReviewCount()" style="font-size:0.7rem; padding:4px 10px; border:1px solid var(--brand-navy); background:var(--brand-navy); color:#fff; border-radius:6px; cursor:pointer;">Actualizar desde Google</button>';
    html += '</div></div>';

    // Progress bar
    var barColor = progressPct >= 75 ? '#2e7d32' : progressPct >= 50 ? '#F5A623' : '#E51636';
    html += '<div style="position:relative; background:#e0e0e0; border-radius:20px; height:28px; overflow:hidden; margin-bottom:0.75rem;">';
    html += '<div style="width:' + progressPct + '%; height:100%; background:' + barColor + '; border-radius:20px; transition:width 0.5s ease;"></div>';
    html += '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:0.8rem; font-weight:700; color:' + (progressPct > 45 ? '#fff' : '#333') + ';">';
    if (totalNew !== null && hasData) {
      html += totalNew.toLocaleString() + ' nuevos / ' + ANNUAL_GOAL.toLocaleString() + ' meta (' + progressPct + '%)';
    } else {
      html += 'Haz clic en "Actualizar desde Google" para comenzar';
    }
    html += '</div></div>';

    // Current total
    if (currentCount > 0) {
      html += '<div style="text-align:center; margin-bottom:1rem; font-size:0.85rem; color:var(--text-light);">Total de reviews actual: <strong style="color:var(--brand-navy); font-size:1rem;">' + currentCount.toLocaleString() + '</strong></div>';
    }

    // Monthly breakdown grid — always show all 12 months
    html += '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(80px, 1fr)); gap:6px;">';
    for (var i = 0; i < data.months.length; i++) {
      var m = data.months[i];
      var monthIdx = parseInt(m.month.split('-')[1]) - 1;
      var monthName = SC_MONTH_NAMES[monthIdx];
      var isCurrentOrPast = m.totalCount !== null;
      var bg = '#fff'; var borderColor = '#e0e0e0'; var textColor = '#999';

      if (isCurrentOrPast && m.newReviews !== null && m.newReviews > 0) {
        if (m.newReviews >= MONTHLY_GOAL) {
          bg = '#e8f5e9'; borderColor = '#2e7d32'; textColor = '#2e7d32';
        } else {
          bg = '#fce4ec'; borderColor = '#c62828'; textColor = '#c62828';
        }
      } else if (isCurrentOrPast) {
        bg = '#e3f2fd'; borderColor = '#1565c0'; textColor = '#1565c0';
      }

      // Clickable to set baseline for empty months
      var clickAttr = !isCurrentOrPast ? ' onclick="window._scSetBaseline(\'' + m.month + '\')" style="cursor:pointer; text-align:center; padding:8px 4px; background:' + bg + '; border:1px solid ' + borderColor + '; border-radius:8px;" title="Clic para ingresar datos"' : ' style="text-align:center; padding:8px 4px; background:' + bg + '; border:1px solid ' + borderColor + '; border-radius:8px;"';

      html += '<div' + clickAttr + '>';
      html += '<div style="font-size:0.65rem; font-weight:600; text-transform:uppercase; color:' + (isCurrentOrPast ? 'var(--brand-navy)' : '#bbb') + ';">' + monthName + '</div>';
      if (m.newReviews !== null && m.newReviews > 0) {
        html += '<div style="font-size:1.1rem; font-weight:700; color:' + textColor + ';">+' + m.newReviews + '</div>';
        html += '<div style="font-size:0.55rem; color:var(--text-light);">' + (m.totalCount ? m.totalCount.toLocaleString() : '') + ' total</div>';
      } else if (isCurrentOrPast) {
        html += '<div style="font-size:0.9rem; font-weight:600; color:' + textColor + ';">' + (m.totalCount ? m.totalCount.toLocaleString() : '0') + '</div>';
        html += '<div style="font-size:0.55rem; color:var(--text-light);">' + (m.newReviews === 0 ? 'base' : 'total') + '</div>';
      } else {
        html += '<div style="font-size:0.9rem; color:#ccc;">\u2014</div>';
        html += '<div style="font-size:0.5rem; color:#ccc;">clic para editar</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    html += '</div>';
    container.innerHTML = html;

    // Attach global handlers
    window._scFetchReviewCount = async function() {
      try {
        var btn = container.querySelector('button');
        if (btn) { btn.disabled = true; btn.textContent = 'Cargando...'; }
        var r = await fetch('/api/scorecard/review-goals/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        var d = await r.json();
        if (d.error) { alert('Error: ' + d.error); return; }
        alert('Google Reviews actualizado: ' + d.totalReviews.toLocaleString() + ' reviews (Rating: ' + d.rating + ')');
        self.renderReviewGoalTracker();
      } catch (e) { alert('Error: ' + e.message); }
    };

    window._scSetBaseline = function(month) {
      var val = prompt('Ingrese el total de Google Reviews para ' + month + ':');
      if (val === null || val === '') return;
      var count = parseInt(val);
      if (isNaN(count) || count < 0) { alert('N\u00FAmero inv\u00E1lido'); return; }
      fetch('/api/scorecard/review-goals/set-baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: month, count: count })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.error) { alert('Error: ' + d.error); return; }
        self.renderReviewGoalTracker();
      }).catch(function(e) { alert('Error: ' + e.message); });
    };
  } catch (err) {
    console.error('Review goal tracker error:', err);
    container.innerHTML = '';
  }
};

// ── OSAT by Weekday Chart ────────────────────────────────────────────
ScorecardView.prototype.renderOsatTrendChart = async function() {
  var picker = document.getElementById(this.ids.monthPicker);
  var refMonth = picker.value || new Date().toISOString().slice(0, 7);
  var year = refMonth.split('-')[0];

  var res = await fetch('/api/scorecard/osat-weekday-range?startMonth=' + year + '-01&endMonth=' + refMonth);
  var rows = await res.json();
  if (!rows || rows.length === 0) {
    var canvas = document.getElementById(this.ids.osatChart);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (this._osatChart) this._osatChart.destroy();
    ctx.font = '13px sans-serif'; ctx.fillStyle = '#999'; ctx.textAlign = 'center';
    ctx.fillText('No hay datos de OSAT por d\u00EDa.', ctx.canvas.width / 2, ctx.canvas.height / 2);
    return;
  }

  var monthMap = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!monthMap[r.month]) monthMap[r.month] = {};
    monthMap[r.month][r.weekday] = r.osat_value;
  }

  var allMonthKeys = Object.keys(monthMap).sort();
  // Only show current month and prior month
  var monthKeys = allMonthKeys.slice(-2);
  var datasets = [];
  for (var m = 0; m < monthKeys.length; m++) {
    var mk = monthKeys[m];
    var monthIdx = parseInt(mk.split('-')[1]) - 1;
    var data = SC_WEEKDAYS.map(function(d) { var val = monthMap[mk][d]; return val != null ? Math.round(Math.abs(val) > 1 ? val : val * 100) : null; });
    datasets.push({
      label: SC_MONTH_NAMES[monthIdx], data: data,
      backgroundColor: SC_MONTH_COLORS[monthIdx],
      borderColor: SC_MONTH_COLORS[monthIdx].replace('0.85', '1').replace('0.6', '1'),
      borderWidth: 1, borderRadius: 4
    });
  }

  var canvas = document.getElementById(this.ids.osatChart);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (this._osatChart) this._osatChart.destroy();

  var osatBarLabels = {
    id: 'osatBarLabels_' + this.ids.osatChart,
    afterDraw: function(chart) {
      var ctx2 = chart.ctx; ctx2.save();
      ctx2.font = 'bold 9px sans-serif'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'bottom';
      for (var ds = 0; ds < chart.data.datasets.length; ds++) {
        var meta = chart.getDatasetMeta(ds);
        for (var i = 0; i < meta.data.length; i++) {
          var val = chart.data.datasets[ds].data[i];
          if (val == null) continue;
          ctx2.fillStyle = '#333';
          ctx2.fillText(val + '%', meta.data[i].x, meta.data[i].y - 3);
        }
      }
      ctx2.restore();
    }
  };

  this._osatChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: SC_WEEKDAY_SHORT, datasets: datasets },
    plugins: [osatBarLabels],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y + '%' : '\u2014'); } } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { min: 50, max: 100, title: { display: true, text: 'OSAT (%)', font: { size: 11 } }, ticks: { font: { size: 10 }, callback: function(v) { return v + '%'; }, stepSize: 10 }, grid: { color: 'rgba(0,0,0,0.06)' } }
      }
    }
  });
};

// ── Sales Trend Chart (Stacked Bar + SSS% Line) ─────────────────────
ScorecardView.prototype.renderSalesTrendChart = async function() {
  var picker = document.getElementById(this.ids.monthPicker);
  var refMonth = picker.value || new Date().toISOString().slice(0, 7);

  var res = await fetch('/api/scorecard/data?period=year&month=' + refMonth);
  var data = await res.json();
  if (!data.trend || !data.trend.sales_total) return;

  var months = data.trend.sales_total.map(function(t) { return t.month; });
  var channels = [
    { key: 'sales_drive_thru', label: 'Servi-Carro', color: '#E51636' },
    { key: 'sales_dine_in', label: 'Dine In', color: '#004F71' },
    { key: 'sales_carry_out', label: 'Carry Out', color: '#3EB1C8' },
    { key: 'sales_catering', label: 'Catering', color: '#F5A623' },
    { key: 'sales_third_party', label: '3rd Party', color: '#249E6B' }
  ];

  var datasets = [];
  for (var c = 0; c < channels.length; c++) {
    var ch = channels[c];
    var trendData = data.trend[ch.key] || [];
    var valMap = {};
    for (var t = 0; t < trendData.length; t++) valMap[trendData[t].month] = trendData[t].value;
    datasets.push({
      type: 'bar', label: ch.label,
      data: months.map(function(m) { return valMap[m] || 0; }),
      backgroundColor: ch.color, stack: 'sales', order: 2, yAxisID: 'y'
    });
  }

  // SSS% line
  var salesTotalTrend = data.trend.sales_total || [];
  var salesTotalMap = {};
  for (var st = 0; st < salesTotalTrend.length; st++) salesTotalMap[salesTotalTrend[st].month] = salesTotalTrend[st].value;

  var priorYearSales = {};
  try {
    var lastMonth = months[months.length - 1];
    var pyLast = (parseInt(lastMonth.split('-')[0]) - 1) + '-' + lastMonth.split('-')[1];
    var pyRes = await fetch('/api/scorecard/data?period=year&month=' + pyLast);
    var pyData = await pyRes.json();
    if (pyData.trend && pyData.trend.sales_total) {
      for (var py = 0; py < pyData.trend.sales_total.length; py++) {
        priorYearSales[pyData.trend.sales_total[py].month] = pyData.trend.sales_total[py].value;
      }
    }
  } catch (e) {}

  var sssData = months.map(function(m) {
    var parts = m.split('-');
    var priorMonth = (parseInt(parts[0]) - 1) + '-' + parts[1];
    var curSales = salesTotalMap[m]; var priorSales = priorYearSales[priorMonth];
    if (curSales && priorSales && priorSales !== 0) return ((curSales - priorSales) / priorSales) * 100;
    return null;
  });

  datasets.push({
    type: 'line', label: 'Same Store Sales (SSS%)', data: sssData,
    borderColor: '#333', backgroundColor: 'rgba(0,0,0,0.1)', borderWidth: 2.5,
    pointRadius: 4, pointBackgroundColor: '#333', tension: 0.3,
    yAxisID: 'y1', order: 1, spanGaps: true
  });

  var monthLabels = months.map(function(m) {
    var parts = m.split('-');
    return SC_MONTH_NAMES[parseInt(parts[1]) - 1] + ' ' + parts[0].slice(2);
  });

  var canvas = document.getElementById(this.ids.salesChart);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (this._salesChart) this._salesChart.destroy();

  var barTotalsPlugin = {
    id: 'barTotals_' + this.ids.salesChart,
    afterDraw: function(chart) {
      var ctx2 = chart.ctx; ctx2.save();
      var meta0 = chart.getDatasetMeta(0);
      if (meta0 && meta0.data.length) {
        ctx2.font = 'bold 10px sans-serif'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'bottom';
        for (var i = 0; i < meta0.data.length; i++) {
          var total = 0;
          for (var d = 0; d < chart.data.datasets.length; d++) {
            if (chart.data.datasets[d].type === 'line') continue;
            var val = chart.data.datasets[d].data[i];
            if (val != null) total += val;
          }
          if (total === 0) continue;
          var topY = Infinity;
          for (var d2 = 0; d2 < chart.data.datasets.length; d2++) {
            if (chart.data.datasets[d2].type === 'line') continue;
            var meta = chart.getDatasetMeta(d2);
            if (meta.data[i] && meta.data[i].y < topY) topY = meta.data[i].y;
          }
          var label = '$' + Math.round(total / 1000) + 'K';
          var textW = ctx2.measureText(label).width;
          ctx2.fillStyle = 'rgba(255,255,255,0.85)';
          ctx2.fillRect(meta0.data[i].x - textW / 2 - 2, topY - 18, textW + 4, 14);
          ctx2.fillStyle = '#333';
          ctx2.fillText(label, meta0.data[i].x, topY - 5);
        }
      }
      for (var ds = 0; ds < chart.data.datasets.length; ds++) {
        if (chart.data.datasets[ds].type !== 'line') continue;
        var lineMeta = chart.getDatasetMeta(ds);
        ctx2.font = 'bold 9px sans-serif'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'bottom';
        for (var p = 0; p < lineMeta.data.length; p++) {
          var rawVal = chart.data.datasets[ds].data[p];
          if (rawVal == null) continue;
          var pt = lineMeta.data[p];
          var sssLabel = rawVal.toFixed(1) + '%';
          var sssW = ctx2.measureText(sssLabel).width;
          ctx2.fillStyle = 'rgba(255,255,255,0.85)';
          ctx2.fillRect(pt.x - sssW / 2 - 2, pt.y - 16, sssW + 4, 13);
          ctx2.fillStyle = rawVal >= 0 ? '#00873c' : '#e51636';
          ctx2.fillText(sssLabel, pt.x, pt.y - 4);
        }
      }
      ctx2.restore();
    }
  };

  this._salesChart = new Chart(ctx, {
    data: { labels: monthLabels, datasets: datasets },
    plugins: [barTotalsPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: function(ctx) {
          if (ctx.dataset.yAxisID === 'y1') return ctx.dataset.label + ': ' + (ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) + '%' : '\u2014');
          return ctx.dataset.label + ': $' + ctx.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 0 });
        } } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { stacked: true, position: 'left', max: 1000000, title: { display: true, text: 'Ventas ($)', font: { size: 11 } }, ticks: { font: { size: 10 }, callback: function(v) { if (v >= 1000) return '$' + (v / 1000).toFixed(0) + 'K'; return '$' + v; } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y1: { position: 'right', title: { display: true, text: 'SSS (%)', font: { size: 11 } }, min: -15, max: 15, ticks: { font: { size: 10 }, callback: function(v) { return v.toFixed(0) + '%'; }, stepSize: 5 }, grid: { display: false } }
      }
    }
  });
};

// ══════════════════════════════════════════════════════════════════════
// METRIC DRILLDOWN — Click a card to see monthly history
// ══════════════════════════════════════════════════════════════════════

var _scDrilldownChart = null;

function _ensureDrilldownModal() {
  if (document.getElementById('scDrilldownModal')) return;
  var div = document.createElement('div');
  div.id = 'scDrilldownModal';
  div.style.cssText = 'display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1001; overflow-y:auto;';
  div.innerHTML = '<div style="max-width:700px; margin:3rem auto; background:white; border-radius:12px; padding:2rem; position:relative;">' +
    '<button onclick="scCloseDrilldown()" style="position:absolute; top:1rem; right:1rem; background:none; border:none; font-size:1.5rem; cursor:pointer;">&times;</button>' +
    '<h2 id="scDrilldownTitle" style="color:var(--brand-navy); margin-bottom:1rem;"></h2>' +
    '<div style="position:relative; width:100%; height:280px;"><canvas id="scDrilldownChart"></canvas></div>' +
    '<div style="margin-top:1.5rem; max-height:300px; overflow-y:auto;">' +
    '<table id="scDrilldownTable" style="width:100%; border-collapse:collapse; font-size:0.875rem;"></table>' +
    '</div></div>';
  document.body.appendChild(div);
}

function scCloseDrilldown() {
  var modal = document.getElementById('scDrilldownModal');
  if (modal) modal.style.display = 'none';
  if (_scDrilldownChart) { _scDrilldownChart.destroy(); _scDrilldownChart = null; }
}

async function scShowMetricDrilldown(metricKey, pickerId) {
  _ensureDrilldownModal();

  var picker = document.getElementById(pickerId);
  var refMonth = picker ? picker.value : new Date().toISOString().slice(0, 7);

  var res = await fetch('/api/scorecard/data?period=year&month=' + refMonth);
  var data = await res.json();
  var trend = data.trend && data.trend[metricKey];
  if (!trend || !trend.length) { alert('No hay datos para esta m\u00E9trica.'); return; }

  var cfgRes = await fetch('/api/scorecard/config');
  var cfg = await cfgRes.json();
  var label = cfg.labels[metricKey] || metricKey;
  var icon = SC_ICONS[metricKey] || '';

  document.getElementById('scDrilldownTitle').innerHTML = (icon ? icon + ' ' : '') + esc(label);

  function fmtVal(key, value) {
    if (value == null) return '\u2014';
    var pv = function(v) { return Math.abs(v) > 1 ? v : v * 100; };
    if (cfg.pctMetrics.includes(key)) return pv(value).toFixed(1) + '%';
    if (cfg.currencyMetrics.includes(key)) {
      if (Math.abs(value) >= 1000) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      return '$' + value.toFixed(2);
    }
    if (key === 'speed_of_service') {
      var m = Math.floor(value / 60), s = Math.round(value % 60);
      return m + ':' + String(s).padStart(2, '0');
    }
    if (key === 'instagram_followers' || key === 'facebook_followers' || key === 'avg_transactions') return Math.round(value).toLocaleString('en-US');
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    return value.toFixed(2);
  }

  var last12 = trend.slice(-12);
  var months = last12.map(function(t) { return t.month; });
  var values = last12.map(function(t) { return t.value; });
  var monthLabels = months.map(function(m) {
    var parts = m.split('-');
    return SC_MONTH_NAMES[parseInt(parts[1]) - 1] + ' ' + parts[0].slice(2);
  });

  // Build table (newest first)
  var isPct = cfg.pctMetrics.includes(metricKey);
  var lowerIsBetter = ['food_cost_gap', 'speed_of_service', 'ecosure'].includes(metricKey);
  var thtml = '<thead><tr style="background:var(--brand-navy); color:white;">' +
    '<th style="padding:0.5rem 0.75rem; text-align:left;">Mes</th>' +
    '<th style="padding:0.5rem 0.75rem; text-align:right;">Valor</th>' +
    '<th style="padding:0.5rem 0.75rem; text-align:right;">vs Mes Anterior</th></tr></thead><tbody>';
  for (var i = last12.length - 1; i >= 0; i--) {
    var val = last12[i].value;
    var prevVal = i > 0 ? last12[i - 1].value : null;
    var deltaStr = '';
    if (val != null && prevVal != null && prevVal !== 0) {
      var delta = ((val - prevVal) / Math.abs(prevVal)) * 100;
      var isGood = lowerIsBetter ? (delta <= 0) : (delta >= 0);
      var color = isGood ? '#00873c' : '#e51636';
      var arrow = delta >= 0 ? '\u25B2' : '\u25BC';
      deltaStr = '<span style="color:' + color + '; font-weight:600;">' + arrow + ' ' + Math.abs(delta).toFixed(1) + '%</span>';
    }
    var rowBg = i % 2 === 0 ? '' : 'background:#f8f9fa;';
    thtml += '<tr style="' + rowBg + '">';
    thtml += '<td style="padding:0.5rem 0.75rem;">' + monthLabels[i] + '</td>';
    thtml += '<td style="padding:0.5rem 0.75rem; text-align:right; font-weight:600;">' + fmtVal(metricKey, val) + '</td>';
    thtml += '<td style="padding:0.5rem 0.75rem; text-align:right;">' + deltaStr + '</td>';
    thtml += '</tr>';
  }
  thtml += '</tbody>';
  document.getElementById('scDrilldownTable').innerHTML = thtml;

  // Build chart
  var canvas = document.getElementById('scDrilldownChart');
  var ctx = canvas.getContext('2d');
  if (_scDrilldownChart) _scDrilldownChart.destroy();

  var chartValues = values.map(function(v) {
    if (v == null) return null;
    return isPct ? (Math.abs(v) > 1 ? v : v * 100) : v;
  });

  var drilldownLabelsPlugin = {
    id: 'drilldownLabels',
    afterDraw: function(chart) {
      var ctx2 = chart.ctx; ctx2.save();
      ctx2.font = 'bold 10px sans-serif'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'bottom';
      var meta = chart.getDatasetMeta(0);
      for (var di = 0; di < meta.data.length; di++) {
        var v = values[di];
        if (v == null) continue;
        var txt = fmtVal(metricKey, v);
        var pt = meta.data[di];
        var tw = ctx2.measureText(txt).width;
        ctx2.fillStyle = 'rgba(255,255,255,0.85)';
        ctx2.fillRect(pt.x - tw / 2 - 2, pt.y - 18, tw + 4, 14);
        ctx2.fillStyle = '#004F71';
        ctx2.fillText(txt, pt.x, pt.y - 5);
      }
      ctx2.restore();
    }
  };

  _scDrilldownChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: monthLabels,
      datasets: [{
        label: label,
        data: chartValues,
        borderColor: '#E51636',
        backgroundColor: 'rgba(229,22,54,0.1)',
        borderWidth: 2.5,
        pointBackgroundColor: '#E51636',
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 25 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function(tipCtx) { return fmtVal(metricKey, values[tipCtx.dataIndex]); } } }
      },
      scales: {
        y: {
          grace: '10%',
          title: { display: true, text: label, font: { size: 11 } },
          ticks: {
            callback: function(v) {
              if (isPct) return v.toFixed(0) + '%';
              if (cfg.currencyMetrics.includes(metricKey)) {
                if (v >= 1000) return '$' + (v / 1000).toFixed(0) + 'K';
                return '$' + v;
              }
              if (metricKey === 'speed_of_service') {
                var m = Math.floor(v / 60), s = Math.round(v % 60);
                return m + ':' + String(s).padStart(2, '0');
              }
              return v;
            }
          }
        },
        x: { ticks: { font: { size: 10 } } }
      }
    },
    plugins: [drilldownLabelsPlugin]
  });

  document.getElementById('scDrilldownModal').style.display = '';
}
