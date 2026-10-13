import { execSync } from 'child_process';

/**
 * AI Agent for Log Analysis
 *
 * This agent analyzes log JSON payloads and returns a concise "probable issue" string.
 * It supports:
 * 1. LLM API providers (OpenAI, Gemini, Anthropic, or OpenAI-compatible endpoints) when configured.
 * 2. Intelligent heuristic rule-based diagnostic engine for offline/zero-dependency operation and fallback.
 */

/**
 * Intelligent pattern matching engine for offline analysis and fallback.
 * Identifies the probable root cause from log attributes, error codes, and stack traces.
 *
 * @param {object} logData - The JSON log object
 * @returns {string} - Concise summary of the probable issue
 */
export function analyzeLogWithHeuristics(logData) {
  // Convert entire log object into searchable strings
  const rawString = typeof logData === 'string' ? logData : JSON.stringify(logData);
  const text = rawString.toLowerCase();

  // Extract explicit message or error fields if available
  const messageField = logData.message || logData.msg || logData.error || logData.err?.message || '';
  const messageText = typeof messageField === 'string' ? messageField : JSON.stringify(messageField);

  // 1. Database & Persistence Issues
  if (text.includes('connection refused') && (text.includes('5432') || text.includes('postgres'))) {
    return 'PostgreSQL database connection refused on port 5432';
  }
  if (text.includes('connection refused') && (text.includes('3306') || text.includes('mysql'))) {
    return 'MySQL database connection refused on port 3306';
  }
  if (text.includes('connection refused') && (text.includes('27017') || text.includes('mongo'))) {
    return 'MongoDB connection refused on port 27017';
  }
  if (text.includes('econnrefused')) {
    const portMatch = rawString.match(/(?:port|connect)\s*[:=]?\s*(\d+)/i);
    return portMatch 
      ? `TCP connection refused on port ${portMatch[1]}` 
      : 'Connection refused by target host (ECONNREFUSED)';
  }
  if (text.includes('mongoserverselectionerror') || text.includes('server selection timed out')) {
    return 'MongoDB replica set or server selection timeout';
  }
  if (text.includes('deadlock detected') || text.includes('deadlock') || text.includes('lock wait timeout')) {
    return 'Database transaction deadlock detected';
  }
  if (text.includes('pool') && (text.includes('exhausted') || text.includes('timeout') || text.includes('max connections'))) {
    return 'Database connection pool capacity exhausted';
  }
  if (text.includes('duplicate key') || text.includes('unique constraint')) {
    return 'Database unique constraint violation (duplicate key)';
  }

  // 2. Memory & Resource Exhaustion
  if (text.includes('outofmemoryerror') && text.includes('heap space')) {
    return 'JVM heap space exhaustion (OutOfMemoryError)';
  }
  if (text.includes('javascript heap out of memory') || text.includes('allocation failed - javascript heap')) {
    return 'Node.js V8 process out of memory (heap exhaustion)';
  }
  if (text.includes('enospc') || text.includes('no space left on device')) {
    return 'Disk storage full: No space left on device (ENOSPC)';
  }
  if (text.includes('emfile') || text.includes('too many open files')) {
    return 'Operating system file descriptor limit reached (EMFILE)';
  }

  // 3. Network, Timeouts & HTTP Gateway
  if (text.includes('etimedout') || text.includes('connection timed out') || text.includes('connect timeout')) {
    return 'Network connection timeout to upstream service (ETIMEDOUT)';
  }
  if (text.includes('enotfound') || text.includes('getaddrinfo') || text.includes('dns')) {
    return 'DNS resolution failure: Target hostname not found (ENOTFOUND)';
  }
  if (text.includes('econnreset') || text.includes('socket hang up') || text.includes('connection reset by peer')) {
    return 'Upstream connection reset by peer (ECONNRESET)';
  }
  if (text.includes('504') || text.includes('gateway timeout')) {
    return 'HTTP 504: Gateway timeout from upstream service';
  }
  if (text.includes('502') || text.includes('bad gateway')) {
    return 'HTTP 502: Bad gateway - upstream service unavailable';
  }
  if (text.includes('503') || text.includes('service unavailable')) {
    return 'HTTP 503: Service temporarily unavailable';
  }
  if (text.includes('429') || text.includes('too many requests') || text.includes('rate limit')) {
    return 'Rate limit exceeded: HTTP 429 Too Many Requests';
  }
  if (text.includes('cert_has_expired') || text.includes('certificate has expired') || text.includes('ssl')) {
    return 'SSL/TLS certificate expired or invalid handshake';
  }

  // 4. Authentication & Authorization
  if (text.includes('jwtexpired') || text.includes('jwt expired') || text.includes('token expired')) {
    return 'Authentication failure: Expired JWT token';
  }
  if (text.includes('invalid signature') || text.includes('jwt malformed')) {
    return 'Authentication failure: Invalid JWT token signature';
  }
  if (text.includes('401') || text.includes('unauthorized') || text.includes('invalid credentials')) {
    return 'Authentication failed: HTTP 401 Unauthorized';
  }
  if (text.includes('403') || text.includes('forbidden') || text.includes('permission denied') || text.includes('eacces')) {
    return 'Access forbidden: Insufficient permissions (HTTP 403 / EACCES)';
  }
  if (text.includes('cors') || text.includes('cross-origin')) {
    return 'Cross-Origin Resource Sharing (CORS) policy violation';
  }

  // 5. Application Code & Runtime Errors
  if (text.includes('cannot read properties of undefined') || text.includes('cannot read property') || text.includes('nullpointerexception')) {
    return 'Null or undefined dereference runtime exception';
  }
  if (text.includes('syntaxerror') || text.includes('unexpected token')) {
    return 'Syntax or payload parsing error';
  }
  if (text.includes('unhandledpromiserejection') || text.includes('unhandled rejection')) {
    return 'Unhandled asynchronous Promise rejection in application code';
  }
  if (text.includes('segmentation fault') || text.includes('sigsegv')) {
    return 'Process crash: Segmentation fault (SIGSEGV)';
  }

  // 6. Generic extraction fallback
  if (messageText && messageText.length > 0 && messageText.length < 120) {
    return cleanProbableIssue(messageText);
  }

  if (logData.status_code || logData.statusCode || logData.status) {
    const status = logData.status_code || logData.statusCode || logData.status;
    return `Service returned HTTP error status ${status}`;
  }

  return 'Unspecified application error in log entry';
}

/**
 * Sanitizes and trims the probable issue string to ensure concise output.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanProbableIssue(text) {
  let cleaned = text.trim();
  // Strip enclosing quotes or backticks if returned by LLM
  cleaned = cleaned.replace(/^["'`]|["'`]$/g, '').trim();
  // Strip markdown prefixes like "Issue: " or "Probable issue: "
  cleaned = cleaned.replace(/^(probable issue|issue|root cause|summary):\s*/i, '');
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ');
  // Ensure reasonably concise length
  if (cleaned.length > 150) {
    cleaned = cleaned.slice(0, 147) + '...';
  }
  return cleaned;
}

/**
 * Calls configured LLM provider to analyze log content.
 *
 * @param {object} logData
 * @returns {Promise<string|null>}
 */
async function callLLMAgent(logData) {
  const prompt = `You are an expert site reliability engineer and log analysis AI agent.
Analyze the following JSON log object and identify the single most probable root-cause issue.

Rules:
- Return ONLY a single concise summary phrase or short sentence describing the probable issue (under 15 words).
- Do NOT include markdown code blocks, prefixes like "Issue:", or quotes.
- Be specific (e.g., "PostgreSQL connection timeout on port 5432" rather than "Database error").

JSON Log Content:
${JSON.stringify(logData, null, 2)}`;
let prompts= JSON.stringify(logData, null, 2)

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 8000); // 8 second timeout

  try {
    // 1. OpenAI or OpenAI-compatible endpoint (e.g. Local Ollama, vLLM, OpenRouter)
    if (process.env.OPENAI_API_KEY) {
      const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are an SRE AI agent that diagnoses logs into concise root-cause issues.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 60
        }),
        signal: abortController.signal
      });

      if (response.ok) {
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) return cleanProbableIssue(content);
      }
    }

    // 2. Google Gemini API
    if (true) {
    // if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
      const url = `https://aiplatform.googleapis.com/v1/projects/panchmeshali/locations/global/publishers/google/models/gemini-3.1-flash-lite:streamGenerateContent`;
      // const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      let accessToken = await execSync("gcloud auth application-default print-access-token");
      let option ={
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 60, temperature: 0.1 }
        }),
        signal: abortController.signal
      }
      //  console.log("start========================>",JSON.stringify(option))
      const response = await fetch(url, option);
      if (response.ok) {
        const data = await response.json();
        // const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        let text=''
        if (data) {
          data.forEach((candidate) => {
            const content = candidate?.candidates[0]?.content?.parts[0]?.text;
            text += content;
          });
        }
        // console.log("response=================>",JSON.stringify(data))
        console.log("response==text==>",JSON.stringify(text))
        if (text) {
          console.log("returned=====>",JSON.stringify(cleanProbableIssue(text)))
          return cleanProbableIssue(text);
        }
      } else {
        const errBody = await response.text();
        console.warn(`[Agent] Gemini API error (status ${response.status}): ${errBody}`);
      }
    }

    // 3. Anthropic Claude API
    if (process.env.ANTHROPIC_API_KEY) {
      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 60,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: abortController.signal
      });

      if (response.ok) {
        const data = await response.json();
        const content = data?.content?.[0]?.text;
        if (content) return cleanProbableIssue(content);
      }
    }

    return null;
  } catch (error) {
    // Log warning and gracefully fall back to heuristics
    console.warn(`[Agent] LLM analysis call failed or timed out (${error.message}). Falling back to heuristic diagnostic engine.`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Main AI Agent analysis entry point.
 * Passes the log content to an AI agent for analysis, with automatic fallback
 * to the intelligent diagnostic engine.
 *
 * @param {object} logData - Parsed JSON log object
 * @returns {Promise<string>} - Concise probable issue string
 */
export async function analyzeLog(logData) {
  if (!logData || typeof logData !== 'object') {
    throw new Error('Log data must be a valid JSON object');
  }

  // Attempt LLM analysis if API keys are configured
  if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    const llmResult = await callLLMAgent(logData);
    if (llmResult) {
      return llmResult;
    }
  }

  // Use heuristic diagnostic engine
  return analyzeLogWithHeuristics(logData);
}
