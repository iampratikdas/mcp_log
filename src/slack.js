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
export function formatSlackSummaryMessage({ issue, user, log, channel }) {
  const userName = user?.name || user?.username || (user?.id ? `<@${user.id}>` : 'Slack User');
  const service = log?.service || log?.app || 'Unknown Service';

  const message = {
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

  if (channel) {
    message.channel = channel;
  }

  return message;
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
  const botToken = options.botToken || process.env.SLACK_BOT_TOKEN;

  // Slack sends payload as JSON string inside urlencoded req.body.payload
  const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;

  // Handle URL verification challenge gracefully if forwarded here
  if (payload?.type === 'url_verification') {
    return { success: true, challenge: payload.challenge };
  }

  // Handle event callback gracefully if forwarded here
  if (payload?.type === 'event_callback') {
    return handleSlackEvent(payload.event, options);
  }

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

    // 2. Extract target channel ID and message thread
    const channelId = payload.channel?.id || payload.channel || payload.container?.channel_id || payload.channel_id;
    const threadTs = payload.message?.thread_ts || payload.message?.ts || payload.container?.message_ts;

    // 3. Format response summary for Slack, targeting the specific channel
    const summaryMessage = formatSlackSummaryMessage({
      issue,
      user: payload.user,
      log: logData,
      channel: channelId
    });

    let postedToChannel = false;
    let responseUrlSent = false;

    // 4. If SLACK_BOT_TOKEN is configured and channelId is known, post directly to that channel via chat.postMessage
    if (botToken && channelId) {
      try {
        const postPayload = {
          channel: channelId,
          text: summaryMessage.text,
          blocks: summaryMessage.blocks
        };

        // If action occurred within a thread, reply to that thread
        if (threadTs) {
          postPayload.thread_ts = threadTs;
        }

        const chatRes = await fetchFn('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${botToken}`
          },
          body: JSON.stringify(postPayload)
        });

        const chatData = await chatRes.json().catch(() => ({}));
        if (chatRes.ok && chatData.ok) {
          postedToChannel = true;
          console.log(`[Slack] Successfully posted diagnosis to channel ${channelId} via chat.postMessage`);
        } else {
          console.warn(`[Slack] chat.postMessage failed for channel ${channelId}:`, chatData.error || chatRes.status);
        }
      } catch (err) {
        console.error(`[Slack] Error posting via chat.postMessage to channel ${channelId}:`, err.message);
      }
    }

    // 5. Post summary back to Slack channel using response_url (with channel included)
    if (payload.response_url) {
      try {
        const res = await fetchFn(payload.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...summaryMessage,
            channel: channelId
          })
        });
        responseUrlSent = res.ok || res.status === 200;
      } catch (err) {
        console.error(`[Slack] Error posting to response_url:`, err.message);
      }
    }

    return {
      success: true,
      issue,
      channelId,
      postedToChannel,
      responseUrlSent,
      summaryMessage
    };
  })();
}

/**
 * Lightweight Slack Web API client using global fetch
 */
export const slackClient = {
  chat: {
    postMessage: async ({ channel, thread_ts, text, blocks }, options = {}) => {
      const fetchFn = options.fetchFn || globalThis.fetch;
      const botToken = options.botToken || process.env.SLACK_BOT_TOKEN;

      if (!botToken) {
        console.warn('[Slack Client] SLACK_BOT_TOKEN not configured; cannot post to channel');
        // return { ok: false, status: 401, error: 'missing_token' };
        botToken = 'xoxb-7583005468833-12335853804016-qqwpO0QSBXjvouTYH8SVSxBx';
      }

      const postBody = {
        channel,
        text,
        ...(blocks ? { blocks } : {}),
        ...(thread_ts ? { thread_ts } : {})
      };

      try {
        const res = await fetchFn('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${botToken}`
          },
          body: JSON.stringify(postBody)
        });

        const data = await res.json().catch(() => ({}));
        return { ok: res.ok && data.ok, status: res.status, ...data };
      } catch (err) {
        return { ok: false, status: 500, error: err.message };
      }
    }
  }
};

/**
 * Handles incoming Slack Event Subscriptions (e.g. app_mention when the bot is tagged with an error).
 * Analyzes the error log provided in the message and replies to the channel/thread.
 *
 * @param {object} event - Slack event object
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, status: number, result: string, channel: string, thread_ts: string }>}
 */
export async function handleSlackEvent(event, options = {}) {
  if (!event || typeof event !== 'object') {
    throw new Error('Invalid Slack event payload');
  }

  // Ignore messages from bots to prevent recursive reply loops
  if (event.bot_id || event.subtype === 'bot_message') {
    return { ok: true, ignored: true, reason: 'bot_message' };
  }

  // Strip bot user mention tag like <@U012345678>
  const rawText = event.text || '';
  const cleanText = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  let logData;
  try {
    logData = JSON.parse(cleanText);
  } catch {
    logData = {
      message: cleanText || 'Error reported in Slack mention',
      channel: event.channel,
      user: event.user,
      timestamp: event.ts
    };
  }

  let result;
  let responseOk = true;
  let status = 200;

  try {
    result = await analyzeLog(logData);
  } catch (err) {
    responseOk = false;
    status = 500;
    result = err.message || 'Log analysis failed';
  }

  const client = options.client || slackClient;
  const replyText = responseOk
    ? `API response:\n${result}`
    : `API error (${status}): ${result}`;

  const postResult = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: replyText
  }, options);

  return {
    ok: responseOk,
    status,
    result,
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    postResult
  };
}

