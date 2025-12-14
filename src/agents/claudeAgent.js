/**
 * Claude Code Agent
 *
 * Handles telemetry from Anthropic's Claude Code CLI.
 * Events have the prefix 'claude_code.' and use 'session.id' for session tracking.
 *
 * Supported events:
 * - claude_code.user_prompt
 * - claude_code.api_request
 * - claude_code.api_error
 * - claude_code.tool_result
 * - claude_code.tool_decision
 */

const BaseAgent = require('./baseAgent')
const {
  EventType,
  createUserPromptEvent,
  createGenerationEvent,
  createApiErrorEvent,
  createToolDecisionEvent,
  createToolResultEvent,
} = require('./types')


class ClaudeAgent extends BaseAgent {
  static get name() {
    return 'claude-code'
  }

  static get eventPrefix() {
    return 'claude_code.'
  }

  static get provider() {
    return 'anthropic'
  }

  /**
   * Check if this agent can handle the given event
   */
  static canHandle(eventName) {
    return eventName && eventName.startsWith('claude_code.')
  }

  /**
   * Extract session ID from attributes
   * Claude Code uses 'session.id' or 'claude.session.id'
   */
  static extractSessionId(attrs) {
    return attrs['session.id'] || attrs['claude.session.id'] || null
  }


  /**
   * Process a log record and return a normalized event
   */
  static processEvent(logRecord, attrs, session) {
    const eventName = logRecord.body?.stringValue
    const timestamp = logRecord.timeUnixNano
      ? new Date(Number(logRecord.timeUnixNano) / 1000000).toISOString()
      : new Date().toISOString()

    const baseMetadata = this.getStandardMetadata(attrs, session)
    baseMetadata.organizationId = attrs['organization.id'] || session.organizationId
    baseMetadata.userAccountUuid = attrs['user.account_uuid'] || session.userAccountUuid
    baseMetadata.userEmail = attrs['user.email'] || session.userEmail

    switch (eventName) {
      case 'claude_code.user_prompt':
        return this._processUserPrompt(attrs, timestamp, session, baseMetadata)

      case 'claude_code.api_request':
        return this._processApiRequest(attrs, timestamp, session, baseMetadata)

      case 'claude_code.api_error':
        return this._processApiError(attrs, timestamp, session, baseMetadata)

      case 'claude_code.tool_result':
        return this._processToolResult(attrs, timestamp, session, baseMetadata)

      case 'claude_code.tool_decision':
        return this._processToolDecision(attrs, timestamp, session, baseMetadata)

      default:
        this.logger.debug({ eventName, agent: this.name }, 'Unknown event')
        return null
    }
  }

  static _processUserPrompt(attrs, timestamp, session, baseMetadata) {
    const prompt = attrs.prompt || attrs['user.prompt'] || ''
    const promptLength = parseInt(attrs.prompt_length || attrs['prompt.length'] || '0', 10)

    this.logger.info(
      { sessionId: session.sessionId, promptLength, agent: this.name },
      'User prompt received',
    )

    return createUserPromptEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.email'] || session.userEmail || session.metadata?.userId,
      prompt,
      promptLength,
      metadata: baseMetadata,
    })
  }

  static _processApiRequest(attrs, timestamp, session, baseMetadata) {
    const model = attrs.model || attrs['model.name'] || 'unknown'
    const inputTokens = parseInt(attrs.input_tokens || attrs['tokens.input'] || '0', 10)
    const outputTokens = parseInt(attrs.output_tokens || attrs['tokens.output'] || '0', 10)
    const cacheReadTokens = parseInt(attrs.cache_read_tokens || attrs['cache.read_tokens'] || '0', 10)
    const cacheCreationTokens = parseInt(
      attrs.cache_creation_tokens || attrs['cache.creation_tokens'] || '0',
      10,
    )
    // Use cost provided by the agent - don't calculate
    const cost = parseFloat(attrs.cost_usd || attrs.cost || attrs['cost.usd'] || '0')
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const requestId = attrs.request_id || attrs['request.id']

    this.logger.info(
      {
        sessionId: session.sessionId,
        model,
        tokens: inputTokens + outputTokens,
        cost,
        duration: durationMs,
        agent: this.name,
      },
      'API request processed',
    )

    return createGenerationEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      durationMs,
      inputTokens,
      outputTokens,
      cachedTokens: cacheReadTokens + cacheCreationTokens,
      cost,
      requestId,
      metadata: {
        ...baseMetadata,
        cacheRead: cacheReadTokens,
        cacheCreation: cacheCreationTokens,
      },
    })
  }

  static _processApiError(attrs, timestamp, session, baseMetadata) {
    const errorMessage = attrs.error_message || attrs.error || attrs.message || 'Unknown error'
    const statusCode = parseInt(attrs.status_code || attrs.status || '0', 10)
    const model = attrs.model || 'unknown'
    const requestId = attrs.request_id || attrs['request.id']
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)

    this.logger.warn(
      {
        sessionId: session.sessionId,
        error: errorMessage,
        statusCode,
        model,
        agent: this.name,
      },
      'API error occurred',
    )

    return createApiErrorEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      errorMessage,
      statusCode,
      durationMs,
      requestId,
      metadata: baseMetadata,
    })
  }

  static _processToolResult(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || attrs.tool || attrs.name || 'unknown'
    const success = attrs.success === 'true' || attrs.success === true
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const error = attrs.error || null

    // Parse tool_parameters (JSON string from Claude Code telemetry)
    let toolParameters = null
    if (attrs.tool_parameters) {
      try {
        toolParameters =
          typeof attrs.tool_parameters === 'string'
            ? JSON.parse(attrs.tool_parameters)
            : attrs.tool_parameters
      } catch {
        toolParameters = attrs.tool_parameters
      }
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        tool: toolName,
        success,
        duration: durationMs,
        agent: this.name,
      },
      'Tool result processed',
    )

    return createToolResultEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      success,
      durationMs,
      arguments: toolParameters,
      error,
      metadata: baseMetadata,
    })
  }

  static _processToolDecision(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || attrs.tool || 'unknown'
    const decision = attrs.decision || 'unknown'
    const source = attrs.source || 'unknown'

    this.logger.info(
      {
        sessionId: session.sessionId,
        tool: toolName,
        decision,
        source,
        agent: this.name,
      },
      'Tool decision processed',
    )

    return createToolDecisionEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      decision,
      source,
      metadata: baseMetadata,
    })
  }
}

module.exports = ClaudeAgent
