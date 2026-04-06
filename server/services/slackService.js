/**
 * Slack integration service.
 *
 * Provides two communication channels:
 *   1. Webhook — simple text messages via SLACK_WEBHOOK_URL (used by cron scripts)
 *   2. Bot API — DMs, channel posts, file uploads, group DMs via SLACK_BOT_TOKEN
 *
 * All Bot API functions delegate to `slackApiCall`, the single HTTP primitive
 * for Slack's Web API. File uploads use a separate presigned-URL flow.
 */

const https = require('https');

/* ─── Configuration helpers ───────────────────────────────────────── */

/** @returns {boolean} Whether a Slack webhook URL is configured. */
function isConfigured() {
  return !!process.env.SLACK_WEBHOOK_URL;
}

/** @returns {boolean} Whether a Slack bot/user token is configured. */
function isBotConfigured() {
  return !!(process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN);
}

/**
 * Read and validate the Slack token from environment.
 * Prefers SLACK_BOT_TOKEN, falls back to SLACK_USER_TOKEN.
 * @returns {string} The token
 * @throws {Error} If no Slack token is set
 */
function requireBotToken() {
  const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('Slack bot not configured — set SLACK_BOT_TOKEN or SLACK_USER_TOKEN in .env');
  return token;
}

/* ─── Core HTTP primitives ────────────────────────────────────────── */

/**
 * Generic Slack Web API call over HTTPS.
 *
 * @param {string} method - HTTP method (GET or POST)
 * @param {string} apiPath - Slack API path (e.g. '/api/chat.postMessage')
 * @param {object|null} body - JSON body (null for GET requests)
 * @param {string} token - Bot OAuth token
 * @param {{ timeoutMs?: number }} [opts] - Optional settings
 * @returns {Promise<object>} Parsed JSON response from Slack
 */
function slackApiCall(method, apiPath, body, token, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${token}` };
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request({
      hostname: 'slack.com', port: 443, path: apiPath, method, headers
    }, (res) => {
      let data = '';
      const MAX_BODY = 1024 * 1024; // 1 MB safety cap
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY) {
          res.destroy();
          reject(new Error('Slack API response exceeded 1 MB'));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 300) {
          return reject(new Error(
            `Slack API HTTP ${res.statusCode}: ${data.slice(0, 200)}`
          ));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Slack API invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Slack API timed out after ${timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Send a plain-text message via the configured Incoming Webhook.
 * Used by the anniversary-check cron script.
 *
 * @param {string} text - Message text (supports Slack mrkdwn)
 * @returns {Promise<string>} Raw response body ("ok")
 */
function sendSlackMessage(text) {
  return new Promise((resolve, reject) => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) return reject(new Error('SLACK_WEBHOOK_URL not configured in .env'));

    let parsed;
    try { parsed = new URL(webhookUrl); }
    catch { return reject(new Error('SLACK_WEBHOOK_URL is not a valid URL')); }

    const payload = JSON.stringify({ text });
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`Slack webhook HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Slack webhook timed out'));
    });
    req.write(payload);
    req.end();
  });
}

/* ─── Bot API wrappers (all delegate to slackApiCall) ─────────────── */

/**
 * Send a direct message to a Slack user via chat.postMessage.
 *
 * @param {string} slackUserId - Slack user ID (e.g. "U07ABC123")
 * @param {string} text - Message text (supports mrkdwn)
 * @returns {Promise<object>} Slack API response
 */
async function sendSlackDM(slackUserId, text) {
  const token = requireBotToken();
  const data = await slackApiCall('POST', '/api/chat.postMessage',
    { channel: slackUserId, text }, token);
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

/**
 * Post a message to a Slack channel via chat.postMessage.
 *
 * @param {string} channelId - Slack channel ID (e.g. "C07ABC123")
 * @param {string} text - Message text (supports mrkdwn)
 * @returns {Promise<object>} Slack API response
 */
async function sendSlackToChannel(channelId, text) {
  const token = requireBotToken();
  const data = await slackApiCall('POST', '/api/chat.postMessage',
    { channel: channelId, text }, token);
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

/**
 * Open a group DM (multi-party IM) with multiple Slack users.
 *
 * @param {string[]} userIds - Array of Slack user IDs (minimum 2)
 * @returns {Promise<string>} The channel ID of the group DM
 */
async function openGroupDM(userIds) {
  if (!Array.isArray(userIds) || userIds.length < 2) {
    throw new Error('openGroupDM requires at least 2 user IDs');
  }
  const token = requireBotToken();
  const data = await slackApiCall('POST', '/api/conversations.open',
    { users: userIds.join(',') }, token);
  if (!data.ok || !data.channel?.id) {
    throw new Error(`Slack conversations.open error: ${data.error || 'missing channel'}`);
  }
  return data.channel.id;
}

/**
 * Upload a file (Buffer) to a Slack channel via the files.uploadV2 flow:
 *   1. files.getUploadURLExternal — get presigned URL + file_id
 *   2. POST file bytes to the presigned URL
 *   3. files.completeUploadExternal — finalize and share to channel
 *
 * @param {string} channelId - Target Slack channel ID
 * @param {Buffer} fileBuffer - The file content
 * @param {string} filename - Display filename (e.g. "report.pdf")
 * @param {string} title - Display title in Slack
 * @returns {Promise<object>} Slack API response from step 3
 */
async function uploadFileToSlack(channelId, fileBuffer, filename, title) {
  const token = requireBotToken();

  // Step 1: Get upload URL
  const step1 = await slackApiCall('GET',
    `/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${fileBuffer.length}`,
    null, token);
  if (!step1.ok) throw new Error(`getUploadURL failed: ${step1.error}`);

  // Step 2: Upload file to presigned URL (different hostname, raw binary)
  const uploadUrl = new URL(step1.upload_url);
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: uploadUrl.hostname,
      port: 443,
      path: uploadUrl.pathname + uploadUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileBuffer.length
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode < 300) resolve(body);
        else reject(new Error(`File upload HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('File upload timed out')); });
    req.write(fileBuffer);
    req.end();
  });

  // Step 3: Complete upload and share to channel
  const step3 = await slackApiCall('POST', '/api/files.completeUploadExternal', {
    files: [{ id: step1.file_id, title }],
    channel_id: channelId
  }, token);
  if (!step3.ok) throw new Error(`completeUpload failed: ${step3.error}`);

  return step3;
}

/* ─── Exports ─────────────────────────────────────────────────────── */

module.exports = {
  isConfigured,
  isBotConfigured,
  sendSlackMessage,
  sendSlackDM,
  sendSlackToChannel,
  openGroupDM,
  uploadFileToSlack,
};
