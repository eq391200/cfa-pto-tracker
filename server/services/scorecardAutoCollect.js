/**
 * Scorecard Auto-Collect Service
 *
 * Automatically fetches public metrics on the 1st of every month:
 *   - Google Reviews (rating + count) via Google Places API
 *   - Facebook followers via page scraping
 *   - Instagram followers via profile scraping
 *
 * Requires env vars:
 *   GOOGLE_PLACES_API_KEY  — for Google Reviews (get from Google Cloud Console)
 *   GOOGLE_PLACE_ID        — the Place ID for the restaurant
 *
 * Social media metrics are fetched via HTTP and parsed from meta tags / JSON-LD.
 * If parsing fails, they are skipped and flagged for manual entry.
 */

const https = require('https');
const http = require('http');
const { getDb } = require('../db');

// ── Configuration ──────────────────────────────────────────────────
const CONFIG = {
  google: {
    placeId: process.env.GOOGLE_PLACE_ID || 'ChIJkYtJbADVHIwR8BI3RW7xaR4',
    apiKey: process.env.GOOGLE_PLACES_API_KEY || '',
  },
  facebook: {
    url: 'https://www.facebook.com/chickfilaponce/',
    pageId: 'chickfilaponce',
  },
  instagram: {
    url: 'https://www.instagram.com/chickfila_larambla/',
    username: 'chickfila_larambla',
  },
};

// ── HTTP Helper ────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
        ...options.headers,
      },
      timeout: 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchUrl(redirectUrl, options).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Google Reviews via Places API ──────────────────────────────────
async function fetchGoogleReviews() {
  if (!CONFIG.google.apiKey) {
    return { success: false, error: 'GOOGLE_PLACES_API_KEY not configured' };
  }

  // Use clean API headers (NOT browser User-Agent — Google blocks spoofed browser UAs on API calls)
  try {
    const apiUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${CONFIG.google.placeId}&fields=rating,user_ratings_total&key=${CONFIG.google.apiKey}`;
    const body = await new Promise((resolve, reject) => {
      https.get(apiUrl, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    const data = JSON.parse(body);

    if (data.status !== 'OK' || !data.result) {
      return { success: false, error: `Google API: ${data.status} - ${data.error_message || 'No result'}` };
    }

    return {
      success: true,
      rating: data.result.rating,
      totalReviews: data.result.user_ratings_total,
    };
  } catch (err) {
    return { success: false, error: `Google API error: ${err.message}` };
  }
}

// ── Facebook Followers via page scraping ───────────────────────────
async function fetchFacebookFollowers() {
  try {
    const res = await fetchUrl(CONFIG.facebook.url);
    const body = res.body;

    // Try multiple extraction patterns from the page HTML/meta tags
    let followers = null;

    // Pattern 1: Open Graph meta tag (most reliable)
    // <meta content="X people follow this" ... >
    const followMatch = body.match(/(\d[\d,.]+)\s*(?:people\s+)?follow/i);
    if (followMatch) {
      followers = parseInt(followMatch[1].replace(/[,.]/g, ''));
    }

    // Pattern 2: JSON structured data
    if (!followers) {
      const jsonMatch = body.match(/"follower_count"\s*:\s*(\d+)/);
      if (jsonMatch) followers = parseInt(jsonMatch[1]);
    }

    // Pattern 3: "X followers" text
    if (!followers) {
      const altMatch = body.match(/([\d,.]+)\s*(?:seguidores|followers)/i);
      if (altMatch) followers = parseInt(altMatch[1].replace(/[,.]/g, ''));
    }

    // Pattern 4: Meta description often has follower count
    if (!followers) {
      const metaMatch = body.match(/content="[^"]*?([\d,.]+)\s*(?:seguidores|followers|likes?|me gusta)/i);
      if (metaMatch) followers = parseInt(metaMatch[1].replace(/[,.]/g, ''));
    }

    if (followers && followers > 0) {
      return { success: true, followers };
    }

    return { success: false, error: 'Could not extract follower count from Facebook page' };
  } catch (err) {
    return { success: false, error: `Facebook fetch error: ${err.message}` };
  }
}

// ── Instagram Followers via profile scraping ───────────────────────
async function fetchInstagramFollowers() {
  try {
    const res = await fetchUrl(CONFIG.instagram.url);
    const body = res.body;

    let followers = null;

    // Pattern 1: Meta description "X Followers"
    const metaMatch = body.match(/content="[^"]*?([\d,.]+[KkMm]?)\s*(?:Followers|seguidores)/i);
    if (metaMatch) {
      followers = parseFollowerCount(metaMatch[1]);
    }

    // Pattern 2: JSON data in page source
    if (!followers) {
      const jsonMatch = body.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
      if (jsonMatch) followers = parseInt(jsonMatch[1]);
    }

    // Pattern 3: "follower_count": N
    if (!followers) {
      const altMatch = body.match(/"follower_count"\s*:\s*(\d+)/);
      if (altMatch) followers = parseInt(altMatch[1]);
    }

    // Pattern 4: og:description meta tag
    if (!followers) {
      const ogMatch = body.match(/og:description[^>]*content="([\d,.]+[KkMm]?)\s*(?:Followers|seguidores)/i);
      if (ogMatch) followers = parseFollowerCount(ogMatch[1]);
    }

    if (followers && followers > 0) {
      return { success: true, followers };
    }

    return { success: false, error: 'Could not extract follower count from Instagram profile' };
  } catch (err) {
    return { success: false, error: `Instagram fetch error: ${err.message}` };
  }
}

/** Parse follower counts like "12.5K", "1.2M", "8,432" */
function parseFollowerCount(str) {
  if (!str) return null;
  str = str.trim().replace(/,/g, '');
  const multipliers = { k: 1000, m: 1000000 };
  const match = str.match(/^([\d.]+)\s*([KkMm])?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const mult = match[2] ? multipliers[match[2].toLowerCase()] || 1 : 1;
  return Math.round(num * mult);
}

// ── Main Auto-Collect Function ─────────────────────────────────────

/**
 * Run the auto-collection for the previous month's metrics.
 * Called on the 1st of each month to collect data for the month that just ended.
 *
 * @param {string} [targetMonth] - Override month in YYYY-MM format. Defaults to previous month.
 * @returns {{ collected: Object, failed: Object, saved: number }}
 */
async function runAutoCollect(targetMonth) {
  // Default to previous month
  if (!targetMonth) {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    targetMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  }

  console.log(`[Scorecard Auto-Collect] Running for month: ${targetMonth}`);

  const collected = {};
  const failed = {};

  // 1. Google Reviews (rating only — review COUNT is saved separately via live fetch
  //    because the API returns the current snapshot, not historical month-end data)
  const google = await fetchGoogleReviews();
  if (google.success) {
    collected.google_reviews = google.rating;
    // Save review count for CURRENT month (live snapshot), not targetMonth
    if (google.totalReviews != null) {
      const now = new Date();
      const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const db = getDb();
      db.prepare(`
        INSERT INTO scorecard_entries (month, metric_key, metric_value, notes, updated_at)
        VALUES (?, 'google_review_count', ?, 'auto-collected-snapshot', datetime('now'))
        ON CONFLICT(month, metric_key)
        DO UPDATE SET metric_value = excluded.metric_value, notes = 'auto-collected-snapshot', updated_at = datetime('now')
      `).run(currentMonth, google.totalReviews);
      console.log(`  Google Review Count: ${google.totalReviews} saved for ${currentMonth} (live snapshot)`);
    }
    console.log(`  Google Reviews: ${google.rating} (${google.totalReviews} reviews)`);
  } else {
    failed.google_reviews = google.error;
    console.log(`  Google Reviews: FAILED - ${google.error}`);
  }

  // Facebook & Instagram require Meta API credentials (manual entry until configured)
  // See Meta_API_Setup_Guide.docx for setup instructions

  // Save collected metrics to database
  let saved = 0;
  if (Object.keys(collected).length > 0) {
    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO scorecard_entries (month, metric_key, metric_value, notes, updated_at)
      VALUES (?, ?, ?, 'auto-collected', datetime('now'))
      ON CONFLICT(month, metric_key)
      DO UPDATE SET metric_value = excluded.metric_value, notes = 'auto-collected', updated_at = datetime('now')
    `);

    const saveAll = db.transaction(() => {
      for (const [key, value] of Object.entries(collected)) {
        upsert.run(targetMonth, key, value);
        saved++;
      }
    });
    saveAll();
  }

  console.log(`[Scorecard Auto-Collect] Saved ${saved} metrics, ${Object.keys(failed).length} failed`);

  return { month: targetMonth, collected, failed, saved };
}

/**
 * Build a Slack-friendly summary of the auto-collect results.
 */
function formatSlackSummary(result) {
  const metricLabels = {
    google_reviews: 'Google Reviews',
    facebook_followers: 'Facebook Followers',
    instagram_followers: 'Instagram Followers',
  };

  let msg = `*Scorecard Auto-Collect — ${result.month}*\n\n`;

  if (Object.keys(result.collected).length > 0) {
    msg += `*Collected:*\n`;
    for (const [key, value] of Object.entries(result.collected)) {
      const label = metricLabels[key] || key;
      const formatted = key.includes('followers') ? value.toLocaleString() : value;
      msg += `  ${label}: *${formatted}*\n`;
    }
  }

  if (Object.keys(result.failed).length > 0) {
    msg += `\n*Manual entry needed:*\n`;
    for (const [key, reason] of Object.entries(result.failed)) {
      const label = metricLabels[key] || key;
      msg += `  ${label}: ${reason}\n`;
    }
    msg += `\nPlease enter these manually in *Executive Scorecard → Ingresar Datos*`;
  }

  // Remind about other metrics that are always manual
  msg += `\n\n*Reminder:* The following metrics still need manual entry for ${result.month}:`;
  msg += `\n  OSAT scores, Sales data, QIV, Ecosure, Smart Shop, Food Cost, AHA%, Productivity, Uber Rating`;

  return msg;
}

module.exports = {
  runAutoCollect,
  formatSlackSummary,
  fetchGoogleReviews,
  fetchFacebookFollowers,
  fetchInstagramFollowers,
  CONFIG,
};
