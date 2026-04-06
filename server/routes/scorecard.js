/**
 * Executive Scorecard routes — monthly metrics across 4 sections:
 *   1. Operational Excellence & Second Mile Service (OSAT, Google, Uber)
 *   2. Sales & Growth (by channel, transactions, avg check)
 *   3. Quality & Brand Standards (QIV, Ecosure, Smart Shop, etc.)
 *   4. Community (social media followers)
 *
 * Supports period aggregation: Monthly, 90 Days, 6 Months, Year
 */

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// All valid metric keys grouped by section
const METRIC_SECTIONS = {
  operational_excellence: [
    'osat_overall', 'osat_speed', 'osat_attentive', 'osat_cleanliness',
    'osat_accuracy', 'osat_taste', 'google_reviews', 'uber_rating'
  ],
  sales_growth: [
    'sales_total', 'sales_drive_thru', 'sales_dine_in', 'sales_carry_out',
    'sales_catering', 'sales_third_party',
    'avg_check', 'avg_transactions'
  ],
  quality_brand: [
    'qiv', 'ecosure', 'smart_shop', 'food_cost_gap', 'aha_pct',
    'productivity'
  ],
  community: [
    'instagram_followers', 'facebook_followers'
  ]
};

// Reference metrics (not displayed as their own card, used for comparisons)
const REFERENCE_METRICS = ['osat_market'];

const ALL_METRICS = Object.values(METRIC_SECTIONS).flat().concat(REFERENCE_METRICS);

// Human-readable labels for each metric
const METRIC_LABELS = {
  osat_overall: 'OSAT General',
  osat_speed: 'Rapidez de Servicio',
  osat_attentive: 'Atento y Amigable',
  osat_cleanliness: 'Limpieza',
  osat_accuracy: 'Precisión de Orden',
  osat_taste: 'Sabor de la Comida',
  google_reviews: 'Google Reviews',
  uber_rating: 'Uber Rating',
  sales_total: 'Ventas Totales',
  sales_drive_thru: 'Servi-Carro',
  sales_dine_in: 'Dine In',
  sales_carry_out: 'Carry Out',
  sales_catering: 'Catering',
  sales_third_party: '3rd Party (Uber/DoorDash)',
  growth_sales: 'Same Store Sales (SSS%)',
  avg_check: 'Ticket Promedio',
  avg_transactions: 'Transacciones Promedio',
  qiv: 'QIV (Quality Inspection)',
  ecosure: 'Ecosure (Food Safety)',
  smart_shop: 'Smart Shop',
  food_cost_gap: 'Food Cost Positive Gap',
  aha_pct: 'AHA (<20min)',
  speed_of_service: 'Speed of Service',
  productivity: 'Productivity ($/Hr)',
  instagram_followers: 'Instagram Followers',
  facebook_followers: 'Facebook Followers',
  osat_market: 'OSAT Market'
};

// Which metrics are percentages (for display formatting)
const PCT_METRICS = ['osat_overall', 'osat_speed', 'osat_attentive', 'osat_cleanliness',
  'osat_accuracy', 'osat_taste', 'growth_sales',
  'food_cost_gap', 'aha_pct', 'qiv', 'osat_market'];

// Which metrics are currency
const CURRENCY_METRICS = ['sales_total', 'sales_drive_thru', 'sales_dine_in', 'sales_carry_out',
  'sales_catering', 'sales_third_party', 'avg_check', 'productivity'];

// Which metrics use average (vs sum) when aggregating across months
const AVG_METRICS = ['osat_overall', 'osat_speed', 'osat_attentive', 'osat_cleanliness',
  'osat_accuracy', 'osat_taste', 'google_reviews', 'uber_rating',
  'growth_sales', 'avg_check', 'avg_transactions',
  'qiv', 'ecosure', 'smart_shop', 'food_cost_gap', 'aha_pct', 'speed_of_service',
  'productivity', 'osat_market'];

// Metrics that use the latest value (snapshot, not sum/avg)
const LATEST_METRICS = ['instagram_followers', 'facebook_followers'];


// ── GET /api/scorecard/config — Return metric definitions ───────────
router.get('/config', (_req, res) => {
  res.json({
    sections: METRIC_SECTIONS,
    labels: METRIC_LABELS,
    pctMetrics: PCT_METRICS,
    currencyMetrics: CURRENCY_METRICS,
    avgMetrics: AVG_METRICS,
    latestMetrics: LATEST_METRICS
  });
});

// ── GET /api/scorecard/months — List all months that have data ──────
router.get('/months', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT month FROM scorecard_entries ORDER BY month DESC').all();
    res.json(rows.map(r => r.month));
  } catch (err) {
    console.error('Scorecard months error:', err.message);
    res.status(500).json({ error: 'Failed to load months' });
  }
});

// ── GET /api/scorecard/data — Get metrics for a period ──────────────
// Query params: period=monthly|90d|6m|year, month=YYYY-MM (reference month)
router.get('/data', (req, res) => {
  try {
    const db = getDb();
    const { period = 'monthly', month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month parameter required (YYYY-MM)' });
    }

    // Calculate date range based on period
    const refDate = new Date(month + '-01');
    let startMonth, endMonth;

    endMonth = month;

    if (period === 'monthly') {
      startMonth = month;
    } else if (period === '90d') {
      const d = new Date(refDate);
      d.setMonth(d.getMonth() - 2);
      startMonth = d.toISOString().slice(0, 7);
    } else if (period === '6m') {
      const d = new Date(refDate);
      d.setMonth(d.getMonth() - 5);
      startMonth = d.toISOString().slice(0, 7);
    } else if (period === 'year') {
      const d = new Date(refDate);
      d.setMonth(d.getMonth() - 11);
      startMonth = d.toISOString().slice(0, 7);
    } else {
      startMonth = month;
    }

    const rows = db.prepare(`
      SELECT metric_key, metric_value, month
      FROM scorecard_entries
      WHERE month >= ? AND month <= ?
      ORDER BY month
    `).all(startMonth, endMonth);

    // Aggregate based on metric type
    const aggregated = {};
    const grouped = {};

    for (const row of rows) {
      if (!grouped[row.metric_key]) grouped[row.metric_key] = [];
      grouped[row.metric_key].push(row);
    }

    for (const [key, entries] of Object.entries(grouped)) {
      const values = entries.map(e => e.metric_value).filter(v => v !== null);
      if (values.length === 0) continue;

      if (LATEST_METRICS.includes(key)) {
        // Use the most recent month's value
        aggregated[key] = values[values.length - 1];
      } else if (AVG_METRICS.includes(key)) {
        aggregated[key] = values.reduce((a, b) => a + b, 0) / values.length;
      } else {
        // Sum (sales totals, transaction counts)
        aggregated[key] = values.reduce((a, b) => a + b, 0);
      }
    }

    // ── Year-over-Year comparison (same period, prior year) ──
    function aggregateRows(dbRows) {
      const result = {};
      const grp = {};
      for (const row of dbRows) {
        if (!grp[row.metric_key]) grp[row.metric_key] = [];
        grp[row.metric_key].push(row);
      }
      for (const [key, entries] of Object.entries(grp)) {
        const values = entries.map(e => e.metric_value).filter(v => v !== null);
        if (values.length === 0) continue;
        if (LATEST_METRICS.includes(key)) {
          result[key] = values[values.length - 1];
        } else if (AVG_METRICS.includes(key)) {
          result[key] = values.reduce((a, b) => a + b, 0) / values.length;
        } else {
          result[key] = values.reduce((a, b) => a + b, 0);
        }
      }
      return result;
    }

    // YoY: same date range shifted back 12 months
    const yoyStartDate = new Date(new Date(startMonth + '-01'));
    yoyStartDate.setFullYear(yoyStartDate.getFullYear() - 1);
    const yoyEndDate = new Date(new Date(endMonth + '-01'));
    yoyEndDate.setFullYear(yoyEndDate.getFullYear() - 1);
    const yoyStartMonth = yoyStartDate.toISOString().slice(0, 7);
    const yoyEndMonth = yoyEndDate.toISOString().slice(0, 7);

    const yoyRows = db.prepare(`
      SELECT metric_key, metric_value, month
      FROM scorecard_entries
      WHERE month >= ? AND month <= ?
      ORDER BY month
    `).all(yoyStartMonth, yoyEndMonth);
    const previousYoY = aggregateRows(yoyRows);

    // ── Prior month comparison (for OSAT metrics) ──
    const prevMonthDate = new Date(refDate);
    prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
    const prevMonthStr = prevMonthDate.toISOString().slice(0, 7);

    const prevMonthRows = db.prepare(`
      SELECT metric_key, metric_value, month
      FROM scorecard_entries
      WHERE month = ?
      ORDER BY metric_key
    `).all(prevMonthStr);
    const previousMonth = aggregateRows(prevMonthRows);

    // Monthly trend data (raw monthly values for charts)
    const trend = {};
    for (const row of rows) {
      if (!trend[row.metric_key]) trend[row.metric_key] = [];
      trend[row.metric_key].push({ month: row.month, value: row.metric_value });
    }

    res.json({
      period, month, startMonth, endMonth,
      current: aggregated,
      previousYoY,
      previousMonth,
      trend
    });
  } catch (err) {
    console.error('Scorecard data error:', err.message);
    res.status(500).json({ error: 'Failed to load scorecard data' });
  }
});

// ── GET /api/scorecard/month/:month — Get raw entries for a month ───
router.get('/month/:month', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM scorecard_entries WHERE month = ? ORDER BY metric_key')
      .all(req.params.month);
    res.json(rows);
  } catch (err) {
    console.error('Scorecard month error:', err.message);
    res.status(500).json({ error: 'Failed to load month data' });
  }
});

// ── POST /api/scorecard/month/:month — Save/update metrics for a month ─
// Body: { metrics: { metric_key: value, ... } }
router.post('/month/:month', (req, res) => {
  try {
    const db = getDb();
    const { month } = req.params;
    const { metrics } = req.body;

    if (!metrics || typeof metrics !== 'object') {
      return res.status(400).json({ error: 'metrics object required' });
    }

    const upsert = db.prepare(`
      INSERT INTO scorecard_entries (month, metric_key, metric_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(month, metric_key)
      DO UPDATE SET metric_value = excluded.metric_value, updated_at = datetime('now')
    `);

    const insertMany = db.transaction((entries) => {
      let count = 0;
      for (const [key, value] of Object.entries(entries)) {
        if (!ALL_METRICS.includes(key)) continue;
        const numVal = value === '' || value === null || value === undefined ? null : Number(value);
        upsert.run(month, key, numVal);
        count++;
      }
      return count;
    });

    const count = insertMany(metrics);
    res.json({ success: true, saved: count });
  } catch (err) {
    console.error('Scorecard save error:', err.message);
    res.status(500).json({ error: 'Failed to save scorecard data' });
  }
});

// ── POST /api/scorecard/bulk — Bulk import multiple months ──────────
// Body: { entries: [{ month: 'YYYY-MM', metric_key: '...', metric_value: 123 }, ...] }
router.post('/bulk', (req, res) => {
  try {
    const db = getDb();
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries array required' });
    }

    const upsert = db.prepare(`
      INSERT INTO scorecard_entries (month, metric_key, metric_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(month, metric_key)
      DO UPDATE SET metric_value = excluded.metric_value, updated_at = datetime('now')
    `);

    const insertMany = db.transaction((rows) => {
      let count = 0;
      for (const row of rows) {
        if (!row.month || !ALL_METRICS.includes(row.metric_key)) continue;
        const numVal = row.metric_value === '' || row.metric_value === null ? null : Number(row.metric_value);
        upsert.run(row.month, row.metric_key, numVal);
        count++;
      }
      return count;
    });

    const count = insertMany(entries);
    res.json({ success: true, imported: count });
  } catch (err) {
    console.error('Scorecard bulk import error:', err.message);
    res.status(500).json({ error: 'Failed to bulk import' });
  }
});

// ── DELETE /api/scorecard/month/:month — Delete all entries for a month ─
router.delete('/month/:month', (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM scorecard_entries WHERE month = ?').run(req.params.month);
    res.json({ success: true, deleted: result.changes });
  } catch (err) {
    console.error('Scorecard delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete month' });
  }
});

// ── OSAT by Weekday ────────────────────────────────────────────────

const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// GET /api/scorecard/osat-weekday/:month
router.get('/osat-weekday/:month', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT weekday, osat_value FROM scorecard_osat_weekday WHERE month = ? ORDER BY id')
      .all(req.params.month);
    res.json(rows);
  } catch (err) {
    console.error('OSAT weekday get error:', err.message);
    res.status(500).json({ error: 'Failed to load weekday data' });
  }
});

// GET /api/scorecard/osat-weekday-range?startMonth=&endMonth= (for YTD)
router.get('/osat-weekday-range', (req, res) => {
  try {
    const db = getDb();
    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) {
      return res.status(400).json({ error: 'startMonth and endMonth required' });
    }
    const rows = db.prepare(`
      SELECT month, weekday, osat_value
      FROM scorecard_osat_weekday
      WHERE month >= ? AND month <= ?
      ORDER BY month, id
    `).all(startMonth, endMonth);
    res.json(rows);
  } catch (err) {
    console.error('OSAT weekday range error:', err.message);
    res.status(500).json({ error: 'Failed to load weekday range' });
  }
});

// POST /api/scorecard/osat-weekday/:month — Save weekday OSAT for a month
// Body: { weekdays: { Lunes: 85, Martes: 90, ... } }
router.post('/osat-weekday/:month', (req, res) => {
  try {
    const db = getDb();
    const { month } = req.params;
    const { weekdays } = req.body;

    if (!weekdays || typeof weekdays !== 'object') {
      return res.status(400).json({ error: 'weekdays object required' });
    }

    const upsert = db.prepare(`
      INSERT INTO scorecard_osat_weekday (month, weekday, osat_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(month, weekday)
      DO UPDATE SET osat_value = excluded.osat_value, updated_at = datetime('now')
    `);

    const insertMany = db.transaction((entries) => {
      let count = 0;
      for (const [day, value] of Object.entries(entries)) {
        if (!WEEKDAYS.includes(day)) continue;
        const numVal = value === '' || value === null || value === undefined ? null : Number(value);
        upsert.run(month, day, numVal);
        count++;
      }
      return count;
    });

    const count = insertMany(weekdays);
    res.json({ success: true, saved: count });
  } catch (err) {
    console.error('OSAT weekday save error:', err.message);
    res.status(500).json({ error: 'Failed to save weekday data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-COLLECT — automated metric fetching
// ═══════════════════════════════════════════════════════════════════════════

const { runAutoCollect, formatSlackSummary } = require('../services/scorecardAutoCollect');

/**
 * POST /api/scorecard/auto-collect — Trigger auto-collection of public metrics.
 * Can be called manually from the UI or by the monthly cron.
 * Body: { month?: 'YYYY-MM' }  — defaults to previous month.
 */
router.post('/auto-collect', async (req, res) => {
  try {
    const { month } = req.body || {};
    const result = await runAutoCollect(month || undefined);

    // Send Slack notification if configured
    try {
      const { sendSlackToChannel, isBotConfigured } = require('../services/slackService');
      if (isBotConfigured() && process.env.SLACK_DIRECTORES_CHANNEL) {
        const msg = formatSlackSummary(result);
        await sendSlackToChannel(process.env.SLACK_DIRECTORES_CHANNEL, msg);
      }
    } catch (slackErr) {
      console.error('Scorecard auto-collect Slack notification failed:', slackErr.message);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Auto-collect error:', err.message);
    res.status(500).json({ error: 'Auto-collect failed: ' + err.message });
  }
});

/**
 * GET /api/scorecard/auto-collect/status — Check what metrics can be auto-collected.
 */
router.get('/auto-collect/status', (_req, res) => {
  const { CONFIG } = require('../services/scorecardAutoCollect');
  res.json({
    google_reviews: {
      enabled: !!CONFIG.google.apiKey,
      placeId: CONFIG.google.placeId,
      note: CONFIG.google.apiKey ? 'Configured' : 'Set GOOGLE_PLACES_API_KEY in .env',
    },
    facebook_followers: {
      enabled: true,
      url: CONFIG.facebook.url,
      note: 'Scraped from public page (may require manual fallback)',
    },
    instagram_followers: {
      enabled: true,
      url: CONFIG.instagram.url,
      note: 'Scraped from public profile (may require manual fallback)',
    },
  });
});

module.exports = router;
