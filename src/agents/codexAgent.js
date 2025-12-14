/**
 * Codex CLI Agent
 *
 * Handles telemetry from OpenAI's Codex CLI.
 * Events have the prefix 'codex.' and use 'conversation.id' for session tracking.
 *
 * Supported events:
 * - codex.conversation_starts
 * - codex.user_prompt
 * - codex.api_request
 * - codex.sse_event (token usage)
 * - codex.tool_decision
 * - codex.tool_result
 */

const BaseAgent = require('./baseAgent')
const {
  EventType,
  createConversationStartEvent,
  createUserPromptEvent,
  createApiRequestEvent,
  createGenerationEvent,
  createApiErrorEvent,
  createToolDecisionEvent,
  createToolResultEvent,
} = require('./types')


class CodexAgent extends BaseAgent {
  static get name() {
    return 'codex'
  }

  static get eventPrefix() {
    return 'codex.'
  }

  static get provider() {
    return 'openai'
  }

  /**
   * Check if this agent can handle the given event
   */
  static canHandle(eventName) {
    return eventName && eventName.startsWith('codex.')
  }

  /**
   * Extract session ID from attributes
   * Codex uses 'conversation.id' or 'codex.conversation.id'
   */
  static extractSessionId(attrs) {
    return attrs['conversation.id'] || attrs['codex.conversation.id'] || null
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
    baseMetadata.conversationId = attrs['conversation.id']
    baseMetadata.userAccountId = attrs['user.account_id']
    baseMetadata.authMode = attrs['auth_mode']
    baseMetadata.environment = attrs.env || 'dev'
    baseMetadata.slug = attrs.slug

    switch (eventName) {
      case 'codex.conversation_starts':
        return this._processConversationStarts(attrs, timestamp, session, baseMetadata)

      case 'codex.user_prompt':
        return this._processUserPrompt(attrs, timestamp, session, baseMetadata)

      case 'codex.api_request':
        return this._processApiRequest(attrs, timestamp, session, baseMetadata)

      case 'codex.sse_event':
        return this._processSseEvent(attrs, timestamp, session, baseMetadata)

      case 'codex.tool_decision':
        return this._processToolDecision(attrs, timestamp, session, baseMetadata)

      case 'codex.tool_result':
        return this._processToolResult(attrs, timestamp, session, baseMetadata)

      default:
        this.logger.debug({ eventName, agent: this.name }, 'Unknown event')
        return null
    }
  }

  static _processConversationStarts(attrs, timestamp, session, baseMetadata) {
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

    this.logger.info(
      {
        sessionId: session.sessionId,
        provider: config.providerName,
        model: attrs.model,
        agent: this.name,
      },
      'Conversation started',
    )

    return createConversationStartEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.account_id'] || session.metadata?.userId,
      provider: config.providerName,
      model: attrs.model,
      approvalPolicy: config.approvalPolicy,
      sandboxPolicy: config.sandboxPolicy,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      extraConfig: {
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        mcpServers: config.mcpServers,
        activeProfile: config.activeProfile,
      },
      metadata: baseMetadata,
    })
  }

  static _processUserPrompt(attrs, timestamp, session, baseMetadata) {
    const prompt = attrs.prompt || ''
    const promptLength = parseInt(attrs.prompt_length || '0', 10)

    this.logger.info(
      {
        sessionId: session.sessionId,
        promptLength,
        hasPrompt: !!prompt,
        agent: this.name,
      },
      'User prompt received',
    )

    return createUserPromptEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.account_id'] || session.metadata?.userId,
      prompt,
      promptLength,
      metadata: baseMetadata,
    })
  }

  static _processApiRequest(attrs, timestamp, session, baseMetadata) {
    const attempt = parseInt(attrs.attempt || '1', 10)
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const statusCode = parseInt(attrs['http.response.status_code'] || '0', 10)
    const errorMessage = attrs['error.message']

    const isSuccess = !errorMessage && statusCode >= 200 && statusCode < 300

    this.logger.info(
      {
        sessionId: session.sessionId,
        attempt,
        durationMs,
        statusCode,
        success: isSuccess,
        agent: this.name,
      },
      'API request processed',
    )

    if (!isSuccess && errorMessage) {
      return createApiErrorEvent({
        timestamp,
        sessionId: session.sessionId,
        model: attrs.model || session.defaultModel || 'unknown',
        errorMessage,
        statusCode,
        durationMs,
        attempt,
        metadata: baseMetadata,
      })
    }

    return createApiRequestEvent({
      timestamp,
      sessionId: session.sessionId,
      model: attrs.model || session.defaultModel || 'unknown',
      durationMs,
      statusCode,
      attempt,
      success: isSuccess,
      metadata: baseMetadata,
    })
  }

  static _processSseEvent(attrs, timestamp, session, baseMetadata) {
    const eventKind = attrs['event.kind'] || 'response'
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const errorMessage = attrs['error.message']

    // Token counts
    const inputTokens = parseInt(attrs.input_token_count || '0', 10)
    const outputTokens = parseInt(attrs.output_token_count || '0', 10)
    const cachedTokens = parseInt(attrs.cached_token_count || '0', 10)
    const reasoningTokens = parseInt(attrs.reasoning_token_count || '0', 10)
    const toolTokens = parseInt(attrs.tool_token_count || '0', 10)

    const model = attrs.model || session.defaultModel || 'gpt-4o'
    // Use cost provided by the agent - don't calculate
    const cost = parseFloat(attrs.cost_usd || attrs.cost || '0')

    this.logger.info(
      {
        sessionId: session.sessionId,
        eventKind,
        tokens: inputTokens + outputTokens,
        cost,
        durationMs,
        agent: this.name,
      },
      'SSE event processed',
    )

    if (errorMessage) {
      return createApiErrorEvent({
        timestamp,
        sessionId: session.sessionId,
        model,
        errorMessage,
        durationMs,
        metadata: {
          ...baseMetadata,
          eventKind,
        },
      })
    }

    return createGenerationEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      durationMs,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      toolTokens,
      cost,
      metadata: {
        ...baseMetadata,
        eventKind,
      },
    })
  }

  static _processToolDecision(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || 'unknown'
    const callId = attrs.call_id
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
      callId,
      decision,
      source,
      metadata: baseMetadata,
    })
  }

  static _processToolResult(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || 'unknown'
    const callId = attrs.call_id
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const success = attrs.success === 'true' || attrs.success === true
    const output = attrs.output
    const args = attrs.arguments

    this.logger.info(
      {
        sessionId: session.sessionId,
        tool: toolName,
        success,
        durationMs,
        agent: this.name,
      },
      'Tool result processed',
    )

    return createToolResultEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      callId,
      success,
      durationMs,
      arguments: args,
      output: output ? output.substring(0, 500) : null, // Truncate long outputs
      metadata: baseMetadata,
    })
  }
}

module.exports = CodexAgent
