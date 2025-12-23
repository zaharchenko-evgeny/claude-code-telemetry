/**
 * Langfuse Handler
 *
 * Processes normalized events from any AI agent and sends them to Langfuse.
 * This provides a unified interface for all agent telemetry.
 */

const pino = require('pino')
const { EventType } = require('./agents/types')

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

/**
 * Handle a normalized event and send it to Langfuse
 * @param {Object} event - Normalized event from agent processor
 * @param {Object} session - Session handler instance
 * @param {Object} agent - Agent class that processed the event
 */
function handleNormalizedEvent(event, session, agent) {
  if (!event || !session) return

  session.lastActivity = Date.now()

  // Update session source if not set
  if (!session.source && agent) {
    session.source = agent.name
  }

  switch (event.type) {
    case EventType.CONVERSATION_START:
      handleConversationStart(event, session, agent)
      break

    case EventType.USER_PROMPT:
      handleUserPrompt(event, session, agent)
      break

    case EventType.API_REQUEST:
      handleApiRequest(event, session)
      break

    case EventType.API_ERROR:
      handleApiError(event, session)
      break

    case EventType.GENERATION:
      handleGeneration(event, session, agent)
      break

    case EventType.TOOL_DECISION:
      handleToolDecision(event, session)
      break

    case EventType.TOOL_RESULT:
      handleToolResult(event, session)
      break

    default:
      logger.debug({ eventType: event.type }, 'Unknown normalized event type')
  }
}

/**
 * Handle conversation start event
 */
function handleConversationStart(event, session, agent) {
  session.conversationCount = (session.conversationCount || 0) + 1
  session.conversationStartTime = Date.now()
  session.toolSequence = []

  // Store config
  if (event.config) {
    session.agentConfig = event.config
    if (event.config.model) {
      session.defaultModel = event.config.model
    }
  }

  // Create trace
  if (session.langfuse) {
    const traceOptions = buildTraceOptions(event, session, agent, {
      name: session.langfuseConfig?.traceName || `${agent?.name || 'ai'}-conversation-${session.conversationCount}`,
      input: {
        provider: event.config?.provider,
        model: event.config?.model,
        config: event.config,
      },
    })

    session.currentTrace = session.langfuse.trace(traceOptions)
    logger.debug({ traceId: session.currentTrace?.id }, 'Trace created for conversation start')
  }
}

/**
 * Handle user prompt event
 */
function handleUserPrompt(event, session, agent) {
  logger.info(
    {
      sessionId: session.sessionId,
      promptLength: event.promptLength,
      hasPrompt: !!event.prompt,
      hasTrace: !!session.currentTrace,
      source: agent?.name || 'unknown',
    },
    'User prompt event received',
  )

  // Start new conversation if no trace exists
  if (!session.currentTrace && session.langfuse) {
    session.conversationCount = (session.conversationCount || 0) + 1
    session.conversationStartTime = Date.now()
    session.toolSequence = []

    const traceOptions = buildTraceOptions(event, session, agent, {
      name: session.langfuseConfig?.traceName || `${agent?.name || 'ai'}-conversation-${session.conversationCount}`,
      input: {
        prompt: event.prompt || '[Prompt hidden]',
        length: event.promptLength,
      },
    })

    session.currentTrace = session.langfuse.trace(traceOptions)
  } else if (session.currentTrace) {
    // Update existing trace with prompt
    logger.info(
      {
        sessionId: session.sessionId,
        traceId: session.currentTrace.id,
        promptLength: event.promptLength,
        hasPrompt: !!event.prompt,
      },
      'Updating existing trace with user prompt',
    )
    session.currentTrace.update({
      input: {
        prompt: event.prompt || '[Prompt hidden]',
        length: event.promptLength,
      },
    })
  }
}

/**
 * Handle API request event (non-generation)
 */
function handleApiRequest(event, session) {
  session.apiCallCount = (session.apiCallCount || 0) + 1

  // Track latency
  if (event.durationMs > 0) {
    if (!session.latencies) session.latencies = { api: [], tool: [], conversation: [] }
    session.latencies.api.push(event.durationMs)
  }

  // Create event in Langfuse
  if (session.currentTrace && session.langfuse) {
    session.langfuse.event({
      name: 'api-request',
      traceId: session.currentTrace.id,
      input: {
        model: event.model,
        attempt: event.attempt,
      },
      output: {
        statusCode: event.statusCode,
        durationMs: event.durationMs,
        success: event.success,
      },
      metadata: event.metadata,
      level: event.success ? 'DEFAULT' : 'WARNING',
    })
  }
}

/**
 * Handle API error event
 */
function handleApiError(event, session) {
  logger.warn(
    {
      sessionId: session.sessionId,
      error: event.errorMessage,
      statusCode: event.statusCode,
      model: event.model,
    },
    'API error occurred',
  )

  // Create error event in Langfuse
  if (session.currentTrace && session.langfuse) {
    session.langfuse.event({
      name: 'api-error',
      traceId: session.currentTrace.id,
      input: {
        model: event.model,
        attempt: event.attempt,
      },
      output: {
        error: event.errorMessage,
        statusCode: event.statusCode,
      },
      metadata: event.metadata,
      level: 'ERROR',
    })
  }
}

/**
 * Handle generation event (token usage)
 */
function handleGeneration(event, session, agent) {
  // Update session metrics
  session.totalTokens = (session.totalTokens || 0) + event.tokens.total
  session.totalCost = (session.totalCost || 0) + event.cost
  session.apiCallCount = (session.apiCallCount || 0) + 1

  // Track token breakdown
  if (!session.tokenBreakdown) {
    session.tokenBreakdown = { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0 }
  }
  session.tokenBreakdown.input += event.tokens.input
  session.tokenBreakdown.output += event.tokens.output
  session.tokenBreakdown.cached += event.tokens.cached
  session.tokenBreakdown.reasoning += event.tokens.reasoning || 0
  session.tokenBreakdown.tool += event.tokens.tool || 0

  // Track latency
  if (event.durationMs > 0) {
    if (!session.latencies) session.latencies = { api: [], tool: [], conversation: [] }
    session.latencies.api.push(event.durationMs)
  }

  // Ensure trace exists
  if (!session.currentTrace && session.langfuse) {
    session.conversationCount = (session.conversationCount || 0) + 1
    session.conversationStartTime = Date.now()

    // WORKAROUND: Use extracted prompt from metadata if available (for non-interactive mode)
    const extractedPrompt = session.langfuseConfig?.extractedPrompt
    const promptSource = extractedPrompt ? 'metadata' : 'unavailable'
    const promptValue = extractedPrompt || '[No user prompt captured - non-interactive mode]'

    if (extractedPrompt) {
      logger.info(
        { sessionId: session.sessionId, promptLength: extractedPrompt.length, source: 'metadata' },
        'Using extracted prompt from metadata (workaround for non-interactive mode)',
      )
    }

    const traceOptions = buildTraceOptions(event, session, agent, {
      name: session.langfuseConfig?.traceName || `${agent?.name || 'ai'}-conversation-${session.conversationCount}`,
      input: {
        prompt: promptValue,
        promptSource,
        length: extractedPrompt?.length || 0,
        model: event.model,
        firstApiCall: true,
      },
    })

    session.currentTrace = session.langfuse.trace(traceOptions)
  }

  // Create generation in Langfuse
  if (session.currentTrace && session.langfuse) {
    const startTime = event.durationMs > 0 ? new Date(Date.now() - event.durationMs) : new Date()

    const modelType = event.model?.includes('haiku') || event.model?.includes('mini') ? 'routing' : 'generation'

    session.currentSpan = session.langfuse.generation({
      name: `${modelType}-${event.model}`,
      traceId: session.currentTrace.id,
      startTime,
      endTime: new Date(),
      model: event.model,
      input: event.input || `[${modelType} request]`,
      output: event.output || `[${modelType} response]`,
      usage: {
        input: event.tokens.input,
        output: event.tokens.output + (event.tokens.reasoning || 0),
        total: event.tokens.total,
        unit: 'TOKENS',
      },
      metadata: {
        cost: event.cost,
        requestId: event.requestId,
        tokens: event.tokens,
        performance: {
          durationMs: event.durationMs,
          tokensPerSecond:
            event.durationMs > 0 ? (event.tokens.output / event.durationMs) * 1000 : 0,
        },
        model: {
          name: event.model,
          type: modelType,
          provider: event.metadata?.provider || agent?.provider,
        },
        ...event.metadata,
      },
      level: modelType === 'generation' ? 'DEFAULT' : 'DEBUG',
      statusMessage: `${modelType} completed`,
    })
  }

  logger.info(
    {
      sessionId: session.sessionId,
      model: event.model,
      tokens: event.tokens.total,
      cost: event.cost,
      duration: event.durationMs,
    },
    'Generation processed',
  )
}

/**
 * Handle tool decision event
 */
function handleToolDecision(event, session) {
  // Track tool decisions
  if (!session.toolDecisions) session.toolDecisions = []
  session.toolDecisions.push({
    tool: event.toolName,
    callId: event.callId,
    decision: event.decision,
    source: event.source,
    timestamp: event.timestamp,
  })

  // Create event in Langfuse
  if (session.currentTrace && session.langfuse) {
    session.langfuse.event({
      name: 'tool-decision',
      traceId: session.currentTrace.id,
      parentObservationId: session.currentSpan?.id,
      input: {
        toolName: event.toolName,
        callId: event.callId,
        source: event.source,
      },
      output: {
        decision: event.decision,
        approved: event.isApproved,
      },
      metadata: event.metadata,
      level: event.isApproved ? 'DEFAULT' : 'WARNING',
    })
  }
}

/**
 * Handle tool result event
 */
function handleToolResult(event, session) {
  session.toolCallCount = (session.toolCallCount || 0) + 1

  // Track tool sequence
  if (!session.toolSequence) session.toolSequence = []
  session.toolSequence.push({
    name: event.toolName,
    callId: event.callId,
    success: event.success,
    duration: event.durationMs,
    timestamp: event.timestamp,
    arguments: event.arguments,
    error: event.error,
  })

  // Track tool latency
  if (event.durationMs > 0) {
    if (!session.latencies) session.latencies = { api: [], tool: [], conversation: [] }
    session.latencies.tool.push(event.durationMs)
  }

  // Create event in Langfuse
  if (session.currentTrace && session.langfuse) {
    const startTime =
      event.durationMs > 0
        ? new Date(new Date(event.timestamp).getTime() - event.durationMs)
        : new Date(event.timestamp)

    session.langfuse.event({
      name: `tool-${event.toolName}`,
      traceId: session.currentTrace.id,
      parentObservationId: session.currentSpan?.id,
      startTime,
      input: {
        toolName: event.toolName,
        callId: event.callId,
        arguments: event.arguments,
      },
      output: {
        success: event.success,
        durationMs: event.durationMs,
        output: event.output,
        error: event.error,
      },
      metadata: {
        toolIndex: session.toolCallCount,
        performance: { durationMs: event.durationMs },
        ...event.metadata,
      },
      level: event.success ? 'DEFAULT' : 'WARNING',
    })
  }
}

/**
 * Normalize metadata to comply with Langfuse requirements:
 * - All values must be strings
 * - Nested objects should be flattened with dot notation
 * - Remove undefined/null values
 * - Truncate strings longer than 200 characters
 */
function normalizeMetadata(metadata, prefix = '') {
  if (!metadata || typeof metadata !== 'object') {
    return {}
  }

  const normalized = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) {
      continue
    }

    const fullKey = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Flatten nested objects
      Object.assign(normalized, normalizeMetadata(value, fullKey))
    } else {
      // Convert to string and truncate if needed
      let stringValue = String(value)
      if (stringValue.length > 200) {
        stringValue = stringValue.substring(0, 197) + '...'
      }
      normalized[fullKey] = stringValue
    }
  }

  return normalized
}

/**
 * Build trace options with Langfuse config
 */
function buildTraceOptions(event, session, agent, overrides = {}) {
  // Collect all metadata sources
  const rawMetadata = {
    ...(session.langfuseConfig?.metadata || {}),
    conversationIndex: session.conversationCount,
    agent: agent?.name,
    provider: agent?.provider,
    ...event.metadata,
  }

  // Normalize metadata to comply with Langfuse requirements
  const normalizedMetadata = normalizeMetadata(rawMetadata)

  // Debug logging for metadata
  logger.debug(
    {
      hasLangfuseConfig: !!session.langfuseConfig,
      rawMetadataKeys: Object.keys(rawMetadata),
      normalizedMetadataKeys: Object.keys(normalizedMetadata),
      langfuseConfigMetadata: session.langfuseConfig?.metadata,
    },
    'Building trace options - metadata debug',
  )

  const options = {
    name: overrides.name || `${agent?.name || 'ai'}-trace`,
    sessionId: session.langfuseConfig?.sessionId || session.sessionId,
    userId: session.langfuseConfig?.userId || event.userId || session.metadata?.userId,
    input: overrides.input,
    metadata: normalizedMetadata,
    version: session.metadata?.release || event.metadata?.appVersion,
  }

  // Add tags
  const baseTags = session.langfuseConfig?.tags?.length > 0 ? [...session.langfuseConfig.tags] : []
  if (agent?.name) {
    baseTags.push(agent.name)
  }
  if (baseTags.length > 0) {
    options.tags = baseTags
  }

  // Log final options before returning
  logger.debug(
    {
      traceName: options.name,
      metadataKeys: Object.keys(options.metadata || {}),
      metadata: options.metadata,
    },
    'Final trace options built',
  )

  return options
}

module.exports = {
  handleNormalizedEvent,
  handleConversationStart,
  handleUserPrompt,
  handleApiRequest,
  handleApiError,
  handleGeneration,
  handleToolDecision,
  handleToolResult,
}
