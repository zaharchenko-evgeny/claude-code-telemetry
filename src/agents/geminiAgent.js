/**
 * Gemini CLI Agent
 *
 * Handles telemetry from Google's Gemini CLI.
 * Events have the prefix 'gemini_cli.' and use 'session.id' for session tracking.
 *
 * Gemini CLI telemetry documentation:
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/telemetry.md
 *
 * Supported events:
 * - gemini_cli.config - session configuration at startup
 * - gemini_cli.user_prompt - user prompts
 * - gemini_cli.api_request - API request initiation
 * - gemini_cli.api_response - API response with token counts
 * - gemini_cli.api_error - API errors
 * - gemini_cli.tool_call - tool invocations with decisions
 * - gemini_cli.file_operation - file operations
 * - gemini_cli.agent.start - agent run start
 * - gemini_cli.agent.finish - agent run completion
 * - gen_ai.client.inference.operation.details - GenAI semantic convention event
 */

const BaseAgent = require('./baseAgent')
const {
  createConversationStartEvent,
  createUserPromptEvent,
  createApiRequestEvent,
  createGenerationEvent,
  createApiErrorEvent,
  createToolResultEvent,
  createFileOperationEvent,
  createAgentLifecycleEvent,
} = require('./types')

class GeminiAgent extends BaseAgent {
  static get name() {
    return 'gemini'
  }

  static get eventPrefix() {
    return 'gemini_cli.'
  }

  static get provider() {
    return 'google'
  }

  /**
   * Check if this agent can handle the given event
   * Handles both gemini_cli.* events and gen_ai.* OTEL events from Gemini
   */
  static canHandle(eventName) {
    return (
      eventName &&
      (eventName.startsWith('gemini_cli.') || eventName.startsWith('gen_ai.'))
    )
  }

  /**
   * Extract session ID from attributes
   * Gemini uses 'session.id' or 'installation.id'
   */
  static extractSessionId(attrs) {
    return attrs['session.id'] || attrs['installation.id'] || attrs['gemini.session.id'] || null
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
    baseMetadata.installationId = attrs['installation.id']
    baseMetadata.userEmail = attrs['user.email'] || session.userEmail
    baseMetadata.authType = attrs.auth_type
    baseMetadata.promptId = attrs.prompt_id

    switch (eventName) {
      case 'gemini_cli.config':
        return this._processConfig(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.user_prompt':
        return this._processUserPrompt(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.api_request':
        return this._processApiRequest(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.api_response':
        return this._processApiResponse(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.api_error':
        return this._processApiError(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.tool_call':
        return this._processToolCall(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.file_operation':
        return this._processFileOperation(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.agent.start':
        return this._processAgentStart(attrs, timestamp, session, baseMetadata)

      case 'gemini_cli.agent.finish':
        return this._processAgentFinish(attrs, timestamp, session, baseMetadata)

      case 'gen_ai.client.inference.operation.details':
        return this._processGenAiDetails(attrs, timestamp, session, baseMetadata)

      // Additional events that can be handled
      case 'gemini_cli.slash_command':
      case 'gemini_cli.model_routing':
      case 'gemini_cli.chat_compression':
      case 'gemini_cli.conversation_finished':
        return this._processMiscEvent(eventName, attrs, timestamp, session, baseMetadata)

      default:
        // Check for other gemini_cli.* events we might want to log
        if (eventName && eventName.startsWith('gemini_cli.')) {
          this.logger.debug({ eventName, agent: this.name }, 'Unknown Gemini CLI event')
        }
        return null
    }
  }

  /**
   * Process config event - emitted once at startup
   * Attributes: model, sandbox_enabled, approval_mode, mcp_servers, extensions, output_format
   */
  static _processConfig(attrs, timestamp, session, baseMetadata) {
    const config = {
      model: attrs.model,
      sandboxEnabled: attrs.sandbox_enabled === 'true' || attrs.sandbox_enabled === true,
      approvalMode: attrs.approval_mode || 'suggest',
      mcpServers: attrs.mcp_servers ? attrs.mcp_servers.split(',').map((s) => s.trim()) : [],
      extensions: attrs.extensions ? attrs.extensions.split(',').map((e) => e.trim()) : [],
      outputFormat: attrs.output_format || 'default',
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        model: config.model,
        approvalMode: config.approvalMode,
        sandboxEnabled: config.sandboxEnabled,
        agent: this.name,
      },
      'Gemini CLI session configured',
    )

    return createConversationStartEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.email'] || session.userEmail || session.metadata?.userId,
      provider: this.provider,
      model: config.model,
      approvalPolicy: config.approvalMode,
      sandboxPolicy: config.sandboxEnabled ? 'enabled' : 'disabled',
      extraConfig: {
        mcpServers: config.mcpServers,
        extensions: config.extensions,
        outputFormat: config.outputFormat,
      },
      metadata: baseMetadata,
    })
  }

  /**
   * Process user prompt event
   * Attributes: prompt_length, prompt_id, prompt (if logPrompts enabled), auth_type
   */
  static _processUserPrompt(attrs, timestamp, session, baseMetadata) {
    const prompt = attrs.prompt || ''
    const promptLength = parseInt(attrs.prompt_length || '0', 10)
    const promptId = attrs.prompt_id

    this.logger.info(
      {
        sessionId: session.sessionId,
        promptLength,
        promptId,
        hasPrompt: !!prompt,
        agent: this.name,
      },
      'User prompt received',
    )

    return createUserPromptEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.email'] || session.userEmail || session.metadata?.userId,
      prompt,
      promptLength,
      metadata: {
        ...baseMetadata,
        promptId,
      },
    })
  }

  /**
   * Process API request event
   * Attributes: model, prompt_id, request_text (optional)
   */
  static _processApiRequest(attrs, timestamp, session, baseMetadata) {
    const model = attrs.model || session.defaultModel || 'unknown'
    const promptId = attrs.prompt_id

    this.logger.info(
      {
        sessionId: session.sessionId,
        model,
        promptId,
        agent: this.name,
      },
      'API request initiated',
    )

    return createApiRequestEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      requestId: promptId,
      metadata: {
        ...baseMetadata,
        promptId,
        requestText: attrs.request_text,
      },
    })
  }

  /**
   * Process API response event
   * Attributes: status_code, duration_ms, input_token_count, output_token_count,
   *             cached_content_token_count, thoughts_token_count, tool_token_count,
   *             total_token_count, response_text (optional), finish_reasons, auth_type
   */
  static _processApiResponse(attrs, timestamp, session, baseMetadata) {
    const statusCode = parseInt(attrs.status_code || '200', 10)
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const model = attrs.model || session.defaultModel || 'unknown'

    // Token counts - Gemini uses slightly different attribute names
    const inputTokens = parseInt(attrs.input_token_count || attrs.input_tokens || '0', 10)
    const outputTokens = parseInt(attrs.output_token_count || attrs.output_tokens || '0', 10)
    const cachedTokens = parseInt(attrs.cached_content_token_count || attrs.cached_tokens || '0', 10)
    const thoughtsTokens = parseInt(attrs.thoughts_token_count || '0', 10)
    const toolTokens = parseInt(attrs.tool_token_count || '0', 10)
    const totalTokens = parseInt(
      attrs.total_token_count || String(inputTokens + outputTokens + cachedTokens + thoughtsTokens + toolTokens),
      10,
    )

    // Cost from the response if provided
    const cost = parseFloat(attrs.cost_usd || attrs.cost || '0')

    this.logger.info(
      {
        sessionId: session.sessionId,
        model,
        statusCode,
        durationMs,
        tokens: totalTokens,
        cost,
        agent: this.name,
      },
      'API response received',
    )

    return createGenerationEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      durationMs,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens: thoughtsTokens,
      toolTokens,
      cost,
      metadata: {
        ...baseMetadata,
        statusCode,
        finishReasons: attrs.finish_reasons,
        totalTokens,
      },
    })
  }

  /**
   * Process API error event
   * Attributes: error, error_type, status_code, duration_ms
   */
  static _processApiError(attrs, timestamp, session, baseMetadata) {
    const errorMessage = attrs.error || attrs.error_message || 'Unknown error'
    const errorType = attrs.error_type || 'unknown'
    const statusCode = parseInt(attrs.status_code || '0', 10)
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const model = attrs.model || session.defaultModel || 'unknown'

    this.logger.warn(
      {
        sessionId: session.sessionId,
        error: errorMessage,
        errorType,
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
      metadata: {
        ...baseMetadata,
        errorType,
      },
    })
  }

  /**
   * Process tool call event
   * Gemini combines tool decision and result in one event
   * Attributes: function_name, function_args, duration_ms, success, decision,
   *             error, tool_type (native/mcp), mcp_server_name, extension_name,
   *             content_length
   */
  static _processToolCall(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.function_name || attrs.tool_name || 'unknown'
    const decision = attrs.decision || 'auto_accept'
    const success = attrs.success === 'true' || attrs.success === true
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const error = attrs.error
    const toolType = attrs.tool_type || 'native'
    const mcpServerName = attrs.mcp_server_name
    const extensionName = attrs.extension_name
    const contentLength = parseInt(attrs.content_length || '0', 10)

    // Parse function arguments
    let functionArgs = null
    if (attrs.function_args) {
      try {
        functionArgs =
          typeof attrs.function_args === 'string'
            ? JSON.parse(attrs.function_args)
            : attrs.function_args
      } catch {
        functionArgs = attrs.function_args
      }
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        tool: toolName,
        decision,
        success,
        durationMs,
        toolType,
        agent: this.name,
      },
      'Tool call processed',
    )

    // Return as tool result event (since it includes execution result)
    return createToolResultEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      success,
      durationMs,
      arguments: functionArgs,
      error,
      metadata: {
        ...baseMetadata,
        decision,
        toolType,
        mcpServerName,
        extensionName,
        contentLength,
      },
    })
  }

  /**
   * Process file operation event
   * Attributes: tool_name, operation ("create"/"read"/"update"), lines,
   *             mimetype, extension, programming_language
   */
  static _processFileOperation(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || 'file'
    const operation = attrs.operation || 'unknown'
    const lines = parseInt(attrs.lines || '0', 10)
    const mimetype = attrs.mimetype
    const extension = attrs.extension
    const programmingLanguage = attrs.programming_language

    this.logger.info(
      {
        sessionId: session.sessionId,
        tool: toolName,
        operation,
        lines,
        extension,
        agent: this.name,
      },
      'File operation processed',
    )

    return createFileOperationEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      operation,
      lines,
      mimetype,
      extension,
      programmingLanguage,
      metadata: baseMetadata,
    })
  }

  /**
   * Process agent start event
   * Attributes: agent_name, config
   */
  static _processAgentStart(attrs, timestamp, session, baseMetadata) {
    const agentName = attrs.agent_name || 'default'

    this.logger.info(
      {
        sessionId: session.sessionId,
        agentName,
        agent: this.name,
      },
      'Agent run started',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'start',
      metadata: baseMetadata,
    })
  }

  /**
   * Process agent finish event
   * Attributes: agent_name, duration_ms, turns, termination_reason
   */
  static _processAgentFinish(attrs, timestamp, session, baseMetadata) {
    const agentName = attrs.agent_name || 'default'
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const turns = parseInt(attrs.turns || '0', 10)
    const terminationReason = attrs.termination_reason || 'completed'

    this.logger.info(
      {
        sessionId: session.sessionId,
        agentName,
        durationMs,
        turns,
        terminationReason,
        agent: this.name,
      },
      'Agent run finished',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'finish',
      durationMs,
      turns,
      terminationReason,
      metadata: baseMetadata,
    })
  }

  /**
   * Process GenAI semantic convention event
   * This follows OTEL GenAI conventions and includes detailed model information
   */
  static _processGenAiDetails(attrs, timestamp, session, baseMetadata) {
    const model = attrs.model || attrs['gen_ai.model'] || session.defaultModel || 'unknown'
    const inputTokens = parseInt(attrs.input_token_count || attrs['gen_ai.input_tokens'] || '0', 10)
    const outputTokens = parseInt(attrs.output_token_count || attrs['gen_ai.output_tokens'] || '0', 10)
    const temperature = parseFloat(attrs.temperature || attrs['gen_ai.temperature'] || '0')
    const finishReason = attrs.finish_reason || attrs['gen_ai.finish_reason']

    this.logger.info(
      {
        sessionId: session.sessionId,
        model,
        inputTokens,
        outputTokens,
        temperature,
        agent: this.name,
      },
      'GenAI inference details',
    )

    return createGenerationEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      inputTokens,
      outputTokens,
      metadata: {
        ...baseMetadata,
        temperature,
        finishReason,
        otelGenAi: true,
      },
    })
  }

  /**
   * Process miscellaneous events that we want to track but don't need special handling
   */
  static _processMiscEvent(eventName, attrs, timestamp, session, baseMetadata) {
    this.logger.debug(
      {
        sessionId: session.sessionId,
        eventName,
        attrs,
        agent: this.name,
      },
      'Miscellaneous Gemini event',
    )

    // Return a generic event structure
    return {
      type: 'misc',
      eventName,
      timestamp,
      sessionId: session.sessionId,
      attributes: attrs,
      metadata: baseMetadata,
    }
  }
}

module.exports = GeminiAgent
