import crypto from 'crypto';
import { analyzeLog } from './agent.js';

/**
 * Creates a Slack Block Kit message with an interactive "Analyze with MCP" button.
 *
 * @param {object} options
 * @param {object} options.log - The JSON log object to analyze
 * @param {string} [options.title] - Optional title for the alert
 * @param {string} [options.channel] - Optional target Slack channel ID
 * @returns {object} Slack Block Kit message payload
 */
export function createSlackAlertMessage({ log, title = '🚨 Service Error Alert', channel }) {
  if (!log || typeof log !== 'object') {
    throw new Error('log must be a valid JSON object');
  }

  // Slack button 'value' has a 2000 character limit.
  // Serialize log, truncating or pruning if necessary to stay safely within limits.
  let serializedLog = JSON.stringify(log);
  if (serializedLog.length > 1900) {
    const compactLog = {
      level: log.level || log.severity,
      message: log.message || log.msg || log.error?.message,
      error: typeof log.error === 'string' ? log.error : (log.error?.name || log.err),
      service: log.service || log.app,
      status: log.status || log.statusCode,
      timestamp: log.timestamp || log.time
    };
    serializedLog = JSON.stringify(compactLog);
    if (serializedLog.length > 1900) {
      serializedLog = serializedLog.substring(0, 1900);
    }
  }

  // Format code snippet preview (max 500 chars for readability in Slack)
  const preview = JSON.stringify(log, null, 2).slice(0, 500);

  const message = {
    text: `${title}: ${log.message || log.error || 'Check details'}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: title,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Log Details:*\n\`\`\`json\n${preview}\n\`\`\``
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔍 Analyze with MCP',
              emoji: true
            },
            style: 'primary',
            action_id: 'btn_analyze_log',
            value: serializedLog
          }
        ]
      }
    ]
  };

  if (channel) {
    message.channel = channel;
  }

  return message;
}

/**
 * Formats the AI / MCP diagnosis into a Slack Block Kit response message.
 *
 * @param {object} options
 * @param {string} options.issue - The diagnosed probable issue
 * @param {object} [options.user] - Slack user who triggered the analysis
 * @param {object} [options.log] - Original log object analyzed
 * @returns {object} Slack Block Kit response payload
 */
export function formatSlackSummaryMessage({ issue, user, log }) {
  const userName = user?.name || user?.username || (user?.id ? `<@${user.id}>` : 'Slack User');
  const service = log?.service || log?.app || 'Unknown Service';

  return {
    response_type: 'in_channel', // Broadcast to the channel so the whole team sees the diagnosis
    replace_original: false,     // Do not delete the original alert; append summary
    text: `🔍 MCP Log Diagnosis: ${issue}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🔍 MCP Log Analysis Summary',
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Diagnosed By:* ${userName}`
          },
          {
            type: 'mrkdwn',
            text: `*Service:* \`${service}\``
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Probable Root Cause:*\n> *${issue}*`
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `⚡ Analyzed via *Log Analyzer MCP Server* at <!date^${Math.floor(Date.now() / 1000)}^{date_num} {time_secs}|${new Date().toISOString()}>`
          }
        ]
      }
    ]
  };
}

/**
 * Verifies the Slack request HMAC-SHA256 signature.
 *
 * @param {object} options
 * @param {string} options.signature - 'x-slack-signature' header
 * @param {string} options.timestamp - 'x-slack-request-timestamp' header
 * @param {string|Buffer} options.rawBody - Raw unparsed request body string/buffer
 * @param {string} options.signingSecret - Slack signing secret
 * @returns {boolean} True if signature is valid
 */
export function verifySlackSignature({ signature, timestamp, rawBody, signingSecret }) {
  if (!signature || !timestamp || !rawBody || !signingSecret) {
    return false;
  }

  // Prevent replay attacks (reject timestamps older than 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
  if (Number(timestamp) < fiveMinutesAgo) {
    return false;
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const sigBasestring = `v0:${timestamp}:${bodyStr}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  const expectedSignature = `v0=${hmac.update(sigBasestring).digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Handles incoming Slack interactivity payload (e.g. from button click),
 * calls the log analysis engine (MCP / Agent), and sends the summary back to Slack.
 *
 * @param {object|string} rawPayload - Slack interactive payload object or JSON string
 * @param {object} [options]
 * @param {Function} [options.fetchFn] - Optional fetch implementation for testing
 * @returns {Promise<{ success: boolean, issue: string, responseUrlSent: boolean }>}
 */
export function handleSlackInteraction(rawPayload, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;

  // Slack sends payload as JSON string inside urlencoded req.body.payload
  const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;

  if (!payload || payload.type !== 'block_actions') {
    throw new Error('Unsupported or invalid Slack interaction payload');
  }

  const actions = payload.actions || [];
  const analyzeAction = actions.find(a => a.action_id === 'btn_analyze_log') || actions[0];

  if (!analyzeAction) {
    throw new Error('No interactive action found in Slack payload');
  }

  // Parse log object passed in action.value
  let logData;
  try {
    logData = typeof analyzeAction.value === 'string' 
      ? JSON.parse(analyzeAction.value) 
      : (analyzeAction.value || {});
  } catch (err) {
    logData = { raw: analyzeAction.value };
  }

  return (async () => {
    // 1. Diagnose the issue using AI agent / heuristic engine (underlying MCP tool)
    const issue = await analyzeLog(logData);

    // 2. Format response summary for Slack
    const summaryMessage = formatSlackSummaryMessage({
      issue,
      user: payload.user,
      log: logData
    });

    let responseUrlSent = false;

    // 3. Post summary back to Slack channel using response_url
    if (payload.response_url) {
      const res = await fetchFn(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summaryMessage)
      });
      responseUrlSent = res.ok || res.status === 200;
    }

    return {
      success: true,
      issue,
      responseUrlSent,
      summaryMessage
    };
  })();
}
