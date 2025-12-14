/**
 * Codex Event Processor Module
 *
 * Handles processing of Codex CLI events from OTLP logs
 * Based on https://openai.github.io/codex/ telemetry documentation
 *
 * Codex events have a different structure than Claude Code:
 * - Event names: codex.* prefix instead of claude_code.*
 * - Session ID: conversation.id instead of session.id
 * - Token usage: comes from codex.sse_event instead of api_request
 * - No direct cost_usd - needs calculation from token counts
 */

const pino = require('pino')
const { extractAttributesArray } = require('./sessionHandler')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            colorize: true,
          },
        }
      : undefined,
})

// Token pricing per 1M tokens (approximate, update as needed)
const TOKEN_PRICING = {
  'gpt-4o': { input: 2.5, output: 10.0, cached: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
  'gpt-4-turbo': { input: 10.0, output: 30.0, cached: 5.0 },
  'gpt-4': { input: 30.0, output: 60.0, cached: 15.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5, cached: 0.25 },
  'o1': { input: 15.0, output: 60.0, cached: 7.5 },
  'o1-mini': { input: 3.0, output: 12.0, cached: 1.5 },
  'o1-preview': { input: 15.0, output: 60.0, cached: 7.5 },
  'o3-mini': { input: 1.1, output: 4.4, cached: 0.55 },
  default: { input: 5.0, output: 15.0, cached: 2.5 },
}

/**
 * Calculate cost from token counts
 * @param {string} model - Model name
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @param {number} cachedTokens - Cached token count
 * @param {number} reasoningTokens - Reasoning token count (counted as output)
 * @returns {number} Cost in USD
 */
function calculateCost(model, inputTokens, outputTokens, cachedTokens = 0, reasoningTokens = 0) {
  // Find matching pricing or use default
  const modelLower = (model || '').toLowerCase()
  let pricing = TOKEN_PRICING.default

  for (const [key, value] of Object.entries(TOKEN_PRICING)) {
    if (key !== 'default' && modelLower.includes(key)) {
      pricing = value
      break
    }
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = ((outputTokens + reasoningTokens) / 1_000_000) * pricing.output
  const cachedCost = (cachedTokens / 1_000_000) * pricing.cached

  return inputCost + outputCost + cachedCost
}

/**
 * Check if an event is from Codex CLI
 * @param {string} eventName - Event name from log body
 * @returns {boolean}
 */
function isCodexEvent(eventName) {
  return !!(eventName && eventName.startsWith('codex.'))
}

/**
 * Extract Codex-specific session ID from attributes
 * Codex uses conversation.id instead of session.id
 * @param {Object} attrs - Extracted attributes
 * @returns {string|null}
 */
function extractCodexSessionId(attrs) {
  return attrs['conversation.id'] || attrs['codex.conversation.id'] || null
}

/**
 * Process a Codex event from log record
 * @param {Object} logRecord - OTLP log record
 * @param {Object} resource - Resource information
 * @param {Object} session - Session handler instance
 * @returns {Object} Processed event data
 */
function processCodexEvent(logRecord, resource, session) {
  const eventName = logRecord.body?.stringValue
  const attrs = extractAttributesArray(logRecord.attributes)
  const timestamp = logRecord.timeUnixNano
    ? new Date(Number(logRecord.timeUnixNano) / 1000000).toISOString()
    : new Date().toISOString()

  // Extract standard Codex attributes
  const standardAttrs = {
    conversationId: attrs['conversation.id'] || session.sessionId,
    userAccountId: attrs['user.account_id'],
    authMode: attrs['auth_mode'],
    terminalType: attrs['terminal.type'],
    appVersion: attrs['app.version'],
    model: attrs.model,
    slug: attrs.slug,
    environment: attrs.env || 'dev',
    timestamp,
  }

  // Store standard attributes in session
  if (standardAttrs.userAccountId && !session.userAccountId) {
    session.userAccountId = standardAttrs.userAccountId
  }
  if (standardAttrs.terminalType && !session.terminalType) {
    session.terminalType = standardAttrs.terminalType
  }
  if (standardAttrs.model && !session.defaultModel) {
    session.defaultModel = standardAttrs.model
  }

  switch (eventName) {
    case 'codex.conversation_starts':
      return processConversationStarts(attrs, standardAttrs, timestamp, session)

    case 'codex.user_prompt':
      return processUserPrompt(attrs, standardAttrs, timestamp, session)

    case 'codex.api_request':
      return processApiRequest(attrs, standardAttrs, timestamp, session)

    case 'codex.sse_event':
      return processSseEvent(attrs, standardAttrs, timestamp, session)

    case 'codex.tool_decision':
      return processToolDecision(attrs, standardAttrs, timestamp, session)

    case 'codex.tool_result':
      return processToolResult(attrs, standardAttrs, timestamp, session)

    default:
      logger.debug({ eventName, attrs }, 'Unknown Codex event')
      return null
  }
}

/**
 * Process conversation starts event
 * Fired when a new Codex session begins
 * Attributes: provider_name, reasoning_effort, reasoning_summary, context_window,
 *             max_output_tokens, auto_compact_token_limit, approval_policy,
 *             sandbox_policy, mcp_servers, active_profile
 */
function processConversationStarts(attrs, standardAttrs, timestamp, session) {
  const config = {
    providerName: attrs.provider_name || 'openai',
    reasoningEffort: attrs.reasoning_effort,
    reasoningSummary: attrs.reasoning_summary,
    contextWindow: parseInt(attrs.context_window || '0', 10),
    maxOutputTokens: parseInt(attrs.max_output_tokens || '0', 10),
    autoCompactTokenLimit: parseInt(attrs.auto_compact_token_limit || '0', 10),
    approvalPolicy: attrs.approval_policy || 'suggest',
    sandboxPolicy: attrs.sandbox_policy || 'none',
    mcpServers: attrs.mcp_servers ? attrs.mcp_servers.split(',').map((s) => s.trim()) : [],
    activeProfile: attrs.active_profile,
  }

  logger.info(
    {
      sessionId: session.sessionId,
      provider: config.providerName,
      model: standardAttrs.model,
      approvalPolicy: config.approvalPolicy,
      sandboxPolicy: config.sandboxPolicy,
    },
    'Codex conversation started',
  )

  // Store config in session
  session.codexConfig = config
  session.conversationCount = (session.conversationCount || 0) + 1
  session.conversationStartTime = Date.now()

  // Create trace for conversation
  if (session.langfuse) {
    const traceOptions = {
      name: session.langfuseConfig?.traceName || `codex-conversation-${session.conversationCount}`,
      sessionId: session.langfuseConfig?.sessionId || session.sessionId,
      userId: session.langfuseConfig?.userId || standardAttrs.userAccountId || session.metadata?.userId,
      input: {
        provider: config.providerName,
        model: standardAttrs.model,
        config: {
          approvalPolicy: config.approvalPolicy,
          sandboxPolicy: config.sandboxPolicy,
          contextWindow: config.contextWindow,
          maxOutputTokens: config.maxOutputTokens,
        },
      },
      metadata: {
        ...(session.langfuseConfig?.metadata || {}),
        conversationIndex: session.conversationCount,
        codexConfig: config,
        codex: {
          conversationId: standardAttrs.conversationId,
          version: standardAttrs.appVersion,
          environment: standardAttrs.environment,
        },
      },
      version: standardAttrs.appVersion,
    }

    if (session.langfuseConfig?.tags?.length > 0) {
      traceOptions.tags = [...session.langfuseConfig.tags, 'codex']
    } else {
      traceOptions.tags = ['codex']
    }

    session.currentTrace = session.langfuse.trace(traceOptions)
  }

  return {
    type: 'conversation_starts',
    config,
    ...standardAttrs,
  }
}

/**
 * Process user prompt event
 * Attributes: prompt_length, prompt (only if log_user_prompt = true)
 */
function processUserPrompt(attrs, standardAttrs, timestamp, session) {
  const prompt = attrs.prompt || ''
  const promptLength = parseInt(attrs.prompt_length || '0', 10)

  logger.info(
    {
      sessionId: session.sessionId,
      promptLength,
      hasPrompt: !!prompt,
    },
    'Codex user prompt received',
  )

  // If no conversation trace exists, create one
  if (!session.currentTrace && session.langfuse) {
    session.conversationCount = (session.conversationCount || 0) + 1
    session.conversationStartTime = Date.now()

    const traceOptions = {
      name: session.langfuseConfig?.traceName || `codex-conversation-${session.conversationCount}`,
      sessionId: session.langfuseConfig?.sessionId || session.sessionId,
      userId: session.langfuseConfig?.userId || standardAttrs.userAccountId || session.metadata?.userId,
      input: {
        prompt: prompt || '[Prompt hidden - log_user_prompt disabled]',
        length: promptLength,
      },
      metadata: {
        ...(session.langfuseConfig?.metadata || {}),
        conversationIndex: session.conversationCount,
        codex: {
          conversationId: standardAttrs.conversationId,
          version: standardAttrs.appVersion,
        },
      },
      version: standardAttrs.appVersion,
    }

    if (session.langfuseConfig?.tags?.length > 0) {
      traceOptions.tags = [...session.langfuseConfig.tags, 'codex']
    } else {
      traceOptions.tags = ['codex']
    }

    session.currentTrace = session.langfuse.trace(traceOptions)
  } else if (session.currentTrace) {
    // Update existing trace with prompt
    session.currentTrace.update({
      input: {
        prompt: prompt || '[Prompt hidden - log_user_prompt disabled]',
        length: promptLength,
      },
    })
  }

  return {
    type: 'user_prompt',
    prompt,
    promptLength,
    ...standardAttrs,
  }
}

/**
 * Process API request event
 * Represents an API call to a model provider
 * Attributes: attempt, duration_ms, http.response.status_code, error.message
 */
function processApiRequest(attrs, standardAttrs, timestamp, session) {
  const attempt = parseInt(attrs.attempt || '1', 10)
  const durationMs = parseInt(attrs.duration_ms || '0', 10)
  const statusCode = parseInt(attrs['http.response.status_code'] || '0', 10)
  const errorMessage = attrs['error.message']

  const isSuccess = !errorMessage && statusCode >= 200 && statusCode < 300

  session.apiCallCount = (session.apiCallCount || 0) + 1

  logger.info(
    {
      sessionId: session.sessionId,
      attempt,
      durationMs,
      statusCode,
      error: errorMessage,
      success: isSuccess,
    },
    `Codex API request #${session.apiCallCount}`,
  )

  // Track latency
  if (durationMs > 0) {
    if (!session.latencies) session.latencies = { api: [], tool: [], conversation: [] }
    session.latencies.api.push(durationMs)
  }

  // Create event in Langfuse
  if (session.currentTrace && session.langfuse) {
    session.langfuse.event({
      name: isSuccess ? 'api-request' : 'api-error',
      traceId: session.currentTrace.id,
      input: {
        attempt,
        model: standardAttrs.model,
      },
      output: {
        statusCode,
        durationMs,
        error: errorMessage,
      },
      metadata: {
        attempt,
        durationMs,
        statusCode,
        error: errorMessage,
        codex: {
          conversationId: standardAttrs.conversationId,
        },
      },
      level: isSuccess ? 'DEFAULT' : 'ERROR',
    })
  }

  return {
    type: 'api_request',
    attempt,
    durationMs,
    statusCode,
    errorMessage,
    isSuccess,
    ...standardAttrs,
  }
}

/**
 * Process SSE event
 * Tracks streamed responses with token usage
 * Attributes: event.kind, duration_ms, error.message, input_token_count,
 *             output_token_count, cached_token_count, reasoning_token_count, tool_token_count
 */
function processSseEvent(attrs, standardAttrs, timestamp, session) {
  const eventKind = attrs['event.kind'] || 'response'
  const durationMs = parseInt(attrs.duration_ms || '0', 10)
  const errorMessage = attrs['error.message']

  // Token counts
  const inputTokens = parseInt(attrs.input_token_count || '0', 10)
  const outputTokens = parseInt(attrs.output_token_count || '0', 10)
  const cachedTokens = parseInt(attrs.cached_token_count || '0', 10)
  const reasoningTokens = parseInt(attrs.reasoning_token_count || '0', 10)
  const toolTokens = parseInt(attrs.tool_token_count || '0', 10)

  const totalTokens = inputTokens + outputTokens + cachedTokens + reasoningTokens + toolTokens

  // Calculate cost
  const model = standardAttrs.model || session.defaultModel || 'gpt-4o'
  const cost = calculateCost(model, inputTokens, outputTokens, cachedTokens, reasoningTokens)

  // Update session metrics
  session.totalTokens = (session.totalTokens || 0) + totalTokens
  session.totalCost = (session.totalCost || 0) + cost

  if (!session.tokenBreakdown) {
    session.tokenBreakdown = { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0 }
  }
  session.tokenBreakdown.input += inputTokens
  session.tokenBreakdown.output += outputTokens
  session.tokenBreakdown.cached += cachedTokens
  session.tokenBreakdown.reasoning += reasoningTokens
  session.tokenBreakdown.tool += toolTokens

  logger.info(
    {
      sessionId: session.sessionId,
      eventKind,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cached: cachedTokens,
        reasoning: reasoningTokens,
        tool: toolTokens,
        total: totalTokens,
      },
      cost,
      durationMs,
      error: errorMessage,
    },
    'Codex SSE event processed',
  )

  // Create generation in Langfuse
  if (session.currentTrace && session.langfuse) {
    const startTime = durationMs > 0 ? new Date(Date.now() - durationMs) : new Date()

    session.currentSpan = session.langfuse.generation({
      name: `generation-${model}`,
      traceId: session.currentTrace.id,
      startTime,
      endTime: new Date(),
      model,
      input: `[${eventKind} request]`,
      output: errorMessage ? `Error: ${errorMessage}` : `[${eventKind} response]`,
      usage: {
        input: inputTokens,
        output: outputTokens + reasoningTokens,
        total: totalTokens,
        unit: 'TOKENS',
      },
      metadata: {
        cost,
        eventKind,
        durationMs,
        error: errorMessage,
        tokens: {
          input: inputTokens,
          output: outputTokens,
          cached: cachedTokens,
          reasoning: reasoningTokens,
          tool: toolTokens,
        },
        performance: {
          durationMs,
          tokensPerSecond: durationMs > 0 ? (outputTokens / durationMs) * 1000 : 0,
        },
        model: {
          name: model,
          provider: 'openai',
        },
        codex: {
          conversationId: standardAttrs.conversationId,
        },
      },
      level: errorMessage ? 'ERROR' : 'DEFAULT',
      statusMessage: errorMessage || `${eventKind} completed`,
    })
  }

  return {
    type: 'sse_event',
    eventKind,
    durationMs,
    errorMessage,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cached: cachedTokens,
      reasoning: reasoningTokens,
      tool: toolTokens,
      total: totalTokens,
    },
    cost,
    ...standardAttrs,
  }
}

/**
 * Process tool decision event
 * Emitted when Codex decides whether to run a tool
 * Attributes: tool_name, call_id, decision, source
 * Decision values: "approved", "approved_for_session", "denied", "abort"
 * Source values: "config", "user"
 */
function processToolDecision(attrs, standardAttrs, timestamp, session) {
  const toolName = attrs.tool_name || 'unknown'
  const callId = attrs.call_id
  const decision = attrs.decision || 'unknown'
  const source = attrs.source || 'unknown'

  const isApproved = decision === 'approved' || decision === 'approved_for_session'

  logger.info(
    {
      sessionId: session.sessionId,
      tool: toolName,
      callId,
      decision,
      source,
      approved: isApproved,
    },
    'Codex tool decision',
  )

  // Track tool decisions
  if (!session.toolDecisions) session.toolDecisions = []
  session.toolDecisions.push({
    tool: toolName,
    callId,
    decision,
    source,
    timestamp,
  })

  // Create event in Langfuse
  if (session.currentTrace && session.langfuse) {
    session.langfuse.event({
      name: 'tool-decision',
      traceId: session.currentTrace.id,
      parentObservationId: session.currentSpan?.id,
      input: {
        toolName,
        callId,
        source,
      },
      output: {
        decision,
        approved: isApproved,
      },
      metadata: {
        tool: toolName,
        callId,
        decision,
        source,
        timestamp,
        codex: {
          conversationId: standardAttrs.conversationId,
        },
      },
      level: isApproved ? 'DEFAULT' : 'WARNING',
    })
  }

  return {
    type: 'tool_decision',
    toolName,
    callId,
    decision,
    source,
    isApproved,
    ...standardAttrs,
  }
}

/**
 * Process tool result event
 * Emitted after a tool invocation completes
 * Attributes: tool_name, call_id, arguments, duration_ms, success, output
 */
function processToolResult(attrs, standardAttrs, timestamp, session) {
  const toolName = attrs.tool_name || 'unknown'
  const callId = attrs.call_id
  const durationMs = parseInt(attrs.duration_ms || '0', 10)
  const success = attrs.success === 'true' || attrs.success === true
  const output = attrs.output
  const args = attrs.arguments

  session.toolCallCount = (session.toolCallCount || 0) + 1

  logger.info(
    {
      sessionId: session.sessionId,
      tool: toolName,
      callId,
      success,
      durationMs,
      hasOutput: !!output,
    },
    `Codex tool result #${session.toolCallCount}`,
  )

  // Track tool sequence
  if (!session.toolSequence) session.toolSequence = []
  session.toolSequence.push({
    name: toolName,
    callId,
    success,
    duration: durationMs,
    timestamp,
    arguments: args,
    output: output ? output.substring(0, 200) : null, // Truncate output
  })

  // Track tool latency
  if (durationMs > 0) {
    if (!session.latencies) session.latencies = { api: [], tool: [], conversation: [] }
    session.latencies.tool.push(durationMs)
  }

  // Create event in Langfuse
  if (session.currentTrace && session.langfuse) {
    const startTime =
      durationMs > 0 ? new Date(new Date(timestamp).getTime() - durationMs) : new Date(timestamp)

    session.langfuse.event({
      name: `tool-${toolName}`,
      traceId: session.currentTrace.id,
      parentObservationId: session.currentSpan?.id,
      startTime,
      input: {
        toolName,
        callId,
        arguments: args,
      },
      output: {
        success,
        durationMs,
        output: output ? output.substring(0, 500) : null, // Truncate for Langfuse
      },
      metadata: {
        toolIndex: session.toolCallCount,
        performance: {
          durationMs,
        },
        codex: {
          conversationId: standardAttrs.conversationId,
          callId,
        },
      },
      level: success ? 'DEFAULT' : 'WARNING',
    })
  }

  return {
    type: 'tool_result',
    toolName,
    callId,
    success,
    durationMs,
    output,
    arguments: args,
    ...standardAttrs,
  }
}

module.exports = {
  isCodexEvent,
  extractCodexSessionId,
  processCodexEvent,
  processConversationStarts,
  processUserPrompt,
  processApiRequest,
  processSseEvent,
  processToolDecision,
  processToolResult,
  calculateCost,
  TOKEN_PRICING,
}
