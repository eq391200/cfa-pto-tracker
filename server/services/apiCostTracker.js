/**
 * API Cost Tracker & Rate Limiter
 *
 * Tracks all external API calls (Anthropic, Google Places) with:
 *   - Per-call token usage and estimated cost logging
 *   - Daily and monthly budget limits
 *   - Call count rate limiting
 *   - Budget alerts when approaching limits
 *
 * Cost estimates (as of 2026):
 *   Anthropic Claude Sonnet: $3/M input tokens, $15/M output tokens
 *   Google Places Details:   ~$0.017 per call (Basic tier)
 */

const { getDb } = require('../db');

// ── Cost per token by model (USD) ─────────────────────────────────
const MODEL_COSTS = {
  'claude-sonnet-4-20250514': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-sonnet-4-latest':   { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  // Fallback for unknown models
  default:                    { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 }
};

const GOOGLE_PLACES_COST_PER_CALL = 0.017; // Basic Data SKU

/**
 * Estimate cost for an Anthropic API call.
 * @param {string} model - Model name
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @returns {number} Estimated cost in USD
 */
function estimateCost(model, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[model] || MODEL_COSTS.default;
  return (inputTokens * costs.input) + (outputTokens * costs.output);
}

/**
 * Log an API call and its cost.
 * @param {Object} opts
 * @param {string} opts.service - 'anthropic' | 'google_places'
 * @param {string} opts.endpoint - Description (e.g., 'gastos-ocr', 'social-post-generate')
 * @param {number} [opts.userId] - User who triggered the call
 * @param {string} [opts.username] - Username
 * @param {number} [opts.inputTokens] - Input tokens used
 * @param {number} [opts.outputTokens] - Output tokens used
 * @param {string} [opts.model] - Model name
 * @param {string} [opts.status] - 'success' | 'error'
 * @param {string} [opts.errorMessage] - Error details if failed
 */
function logApiCall({ service, endpoint, userId, username, inputTokens = 0, outputTokens = 0, model, status = 'success', errorMessage }) {
  try {
    const db = getDb();
    let cost = 0;

    if (service === 'anthropic') {
      cost = estimateCost(model || 'default', inputTokens, outputTokens);
    } else if (service === 'google_places') {
      cost = GOOGLE_PLACES_COST_PER_CALL;
    }

    db.prepare(`
      INSERT INTO api_usage (service, endpoint, user_id, username, input_tokens, output_tokens, estimated_cost, model, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(service, endpoint, userId || null, username || null, inputTokens, outputTokens, cost, model || null, status, errorMessage || null);

    return cost;
  } catch (e) {
    console.warn('[ApiCostTracker] Failed to log:', e.message);
    return 0;
  }
}

/**
 * Check if a service is within its budget limits.
 * @param {string} service - 'anthropic' | 'google_places'
 * @returns {{ allowed: boolean, reason?: string, daily: Object, monthly: Object }}
 */
function checkBudget(service) {
  try {
    const db = getDb();

    // Get budget config
    const budget = db.prepare('SELECT * FROM api_budgets WHERE service = ?').get(service);
    if (!budget || !budget.is_active) {
      return { allowed: true, daily: {}, monthly: {} };
    }

    // Daily usage
    const dailyUsage = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(estimated_cost), 0) as cost
      FROM api_usage WHERE service = ? AND created_at >= date('now')
    `).get(service);

    // Monthly usage
    const monthlyUsage = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(estimated_cost), 0) as cost
      FROM api_usage WHERE service = ? AND created_at >= date('now', 'start of month')
    `).get(service);

    const daily = {
      calls: dailyUsage.calls,
      cost: dailyUsage.cost,
      callLimit: budget.daily_call_limit,
      costLimit: budget.daily_limit,
      callPct: Math.round((dailyUsage.calls / budget.daily_call_limit) * 100),
      costPct: Math.round((dailyUsage.cost / budget.daily_limit) * 100)
    };

    const monthly = {
      calls: monthlyUsage.calls,
      cost: monthlyUsage.cost,
      callLimit: budget.monthly_call_limit,
      costLimit: budget.monthly_limit,
      callPct: Math.round((monthlyUsage.calls / budget.monthly_call_limit) * 100),
      costPct: Math.round((monthlyUsage.cost / budget.monthly_limit) * 100)
    };

    // Check limits
    if (dailyUsage.cost >= budget.daily_limit) {
      return { allowed: false, reason: `Daily cost limit reached ($${dailyUsage.cost.toFixed(2)} / $${budget.daily_limit.toFixed(2)})`, daily, monthly };
    }
    if (monthlyUsage.cost >= budget.monthly_limit) {
      return { allowed: false, reason: `Monthly cost limit reached ($${monthlyUsage.cost.toFixed(2)} / $${budget.monthly_limit.toFixed(2)})`, daily, monthly };
    }
    if (dailyUsage.calls >= budget.daily_call_limit) {
      return { allowed: false, reason: `Daily call limit reached (${dailyUsage.calls} / ${budget.daily_call_limit})`, daily, monthly };
    }
    if (monthlyUsage.calls >= budget.monthly_call_limit) {
      return { allowed: false, reason: `Monthly call limit reached (${monthlyUsage.calls} / ${budget.monthly_call_limit})`, daily, monthly };
    }

    return { allowed: true, daily, monthly };
  } catch (e) {
    console.warn('[ApiCostTracker] Budget check failed:', e.message);
    return { allowed: true, daily: {}, monthly: {} }; // Fail open
  }
}

/**
 * Get usage summary for dashboard display.
 * @returns {Object} Summary with daily/monthly/all-time stats per service
 */
function getUsageSummary() {
  try {
    const db = getDb();

    const services = ['anthropic', 'google_places'];
    const summary = {};

    for (const service of services) {
      const budget = db.prepare('SELECT * FROM api_budgets WHERE service = ?').get(service);

      const today = db.prepare(`
        SELECT COUNT(*) as calls, COALESCE(SUM(estimated_cost), 0) as cost,
               COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens
        FROM api_usage WHERE service = ? AND created_at >= date('now')
      `).get(service);

      const thisMonth = db.prepare(`
        SELECT COUNT(*) as calls, COALESCE(SUM(estimated_cost), 0) as cost,
               COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens
        FROM api_usage WHERE service = ? AND created_at >= date('now', 'start of month')
      `).get(service);

      const allTime = db.prepare(`
        SELECT COUNT(*) as calls, COALESCE(SUM(estimated_cost), 0) as cost,
               COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens
        FROM api_usage WHERE service = ?
      `).get(service);

      // Recent calls (last 20)
      const recent = db.prepare(`
        SELECT endpoint, input_tokens, output_tokens, estimated_cost, model, status, error_message, username, created_at
        FROM api_usage WHERE service = ? ORDER BY created_at DESC LIMIT 20
      `).all(service);

      // Daily breakdown for last 30 days
      const dailyBreakdown = db.prepare(`
        SELECT date(created_at) as day, COUNT(*) as calls, COALESCE(SUM(estimated_cost), 0) as cost
        FROM api_usage WHERE service = ? AND created_at >= date('now', '-30 days')
        GROUP BY date(created_at) ORDER BY day
      `).all(service);

      summary[service] = {
        budget: budget || { daily_limit: 0, monthly_limit: 0, daily_call_limit: 0, monthly_call_limit: 0, is_active: 0 },
        today,
        thisMonth,
        allTime,
        recent,
        dailyBreakdown
      };
    }

    return summary;
  } catch (e) {
    console.error('[ApiCostTracker] Summary error:', e.message);
    return {};
  }
}

/**
 * Update budget limits for a service.
 * @param {string} service
 * @param {Object} limits - { dailyLimit, monthlyLimit, dailyCallLimit, monthlyCallLimit, isActive }
 */
function updateBudget(service, { dailyLimit, monthlyLimit, dailyCallLimit, monthlyCallLimit, isActive }) {
  const db = getDb();
  db.prepare(`
    UPDATE api_budgets SET
      daily_limit = COALESCE(?, daily_limit),
      monthly_limit = COALESCE(?, monthly_limit),
      daily_call_limit = COALESCE(?, daily_call_limit),
      monthly_call_limit = COALESCE(?, monthly_call_limit),
      is_active = COALESCE(?, is_active),
      updated_at = datetime('now')
    WHERE service = ?
  `).run(dailyLimit, monthlyLimit, dailyCallLimit, monthlyCallLimit, isActive, service);
}

module.exports = {
  logApiCall,
  checkBudget,
  estimateCost,
  getUsageSummary,
  updateBudget,
  MODEL_COSTS,
  GOOGLE_PLACES_COST_PER_CALL
};
