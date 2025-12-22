/**
 * ACP (Agent Client Protocol) Agent
 *
 * Handles telemetry from ACP-compliant agents.
 * ACP is a JSON-RPC over stdio protocol with out-of-band telemetry via OTLP.
 * Events have the prefix 'acp.' and use 'acp.session_id' for session tracking.
 *
 * ACP Telemetry Model:
 * - Client/editor runs a local OTLP receiver
 * - Injects OTEL_* env vars when spawning agent subprocess
 * - Agents use OpenTelemetry SDKs that auto-configure from env vars
 * - Trace context propagated via params._meta (traceparent, tracestate, baggage)
 *
 * See ACP_TELEMETRY.md for detailed specification.
 *
 * Supported events:
 * - acp.initialize - agent initialization
 * - acp.session.create - new session creation
 * - acp.session.resume - session resumption
 * - acp.message.handle - JSON-RPC message handling
 * - acp.request - ACP request processing
 * - acp.response - ACP response
 * - acp.error - ACP error
 * - llm.generate / gen_ai.* - model generation calls
 * - tool.call - tool invocations
 */

const BaseAgent = require('./baseAgent')
const {
  createConversationStartEvent,
  createUserPromptEvent,
  createApiRequestEvent,
  createGenerationEvent,
  createApiErrorEvent,
  createToolResultEvent,
  createAgentLifecycleEvent,
} = require('./types')

class ACPAgent extends BaseAgent {
  static get name() {
    return 'acp'
  }

  static get eventPrefix() {
    return 'acp.'
  }

  static get provider() {
    return 'acp' // ACP is protocol-agnostic, provider varies by implementation
  }

  /**
   * Check if this agent can handle the given event
   * Handles acp.*, llm.*, tool.* events (ACP ecosystem)
   * Note: gen_ai.* is handled by GeminiAgent, so we only handle llm.* and tool.*
   */
  static canHandle(eventName) {
    if (!eventName) return false
    return (
      eventName.startsWith('acp.') ||
      eventName.startsWith('llm.') ||
      eventName.startsWith('tool.')
    )
  }

  /**
   * Extract session ID from attributes
   * ACP uses 'acp.session_id', 'session.id', or 'acp.request_id'
   */
  static extractSessionId(attrs) {
    return (
      attrs['acp.session_id'] ||
      attrs['session.id'] ||
      attrs['acp.request_id'] ||
      null
    )
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
    baseMetadata.acpSessionId = attrs['acp.session_id']
    baseMetadata.acpRequestId = attrs['acp.request_id']
    baseMetadata.agentName = attrs['agent.name']
    baseMetadata.clientName = attrs['client.name']

    // Extract trace context from _meta if available
    baseMetadata.traceparent = attrs['_meta.traceparent'] || attrs.traceparent
    baseMetadata.tracestate = attrs['_meta.tracestate'] || attrs.tracestate
    baseMetadata.baggage = attrs['_meta.baggage'] || attrs.baggage

    switch (eventName) {
      // ACP lifecycle events
      case 'acp.initialize':
        return this._processInitialize(attrs, timestamp, session, baseMetadata)

      case 'acp.session.create':
        return this._processSessionCreate(attrs, timestamp, session, baseMetadata)

      case 'acp.session.resume':
        return this._processSessionResume(attrs, timestamp, session, baseMetadata)

      case 'acp.session.end':
        return this._processSessionEnd(attrs, timestamp, session, baseMetadata)

      // ACP message handling
      case 'acp.message.handle':
        return this._processMessageHandle(attrs, timestamp, session, baseMetadata)

      case 'acp.request':
        return this._processRequest(attrs, timestamp, session, baseMetadata)

      case 'acp.response':
        return this._processResponse(attrs, timestamp, session, baseMetadata)

      case 'acp.error':
        return this._processError(attrs, timestamp, session, baseMetadata)

      // LLM generation events
      case 'llm.generate':
      case 'llm.completion':
      case 'llm.chat':
        return this._processLLMGenerate(attrs, timestamp, session, baseMetadata)

      // Tool events
      case 'tool.call':
      case 'tool.execute':
        return this._processToolCall(attrs, timestamp, session, baseMetadata)

      default:
        // Handle other acp.*, llm.*, tool.* events
        if (eventName && eventName.startsWith('acp.')) {
          this.logger.debug({ eventName, agent: this.name }, 'Unknown ACP event')
        } else if (eventName && eventName.startsWith('llm.')) {
          return this._processLLMGenerate(attrs, timestamp, session, baseMetadata)
        } else if (eventName && eventName.startsWith('tool.')) {
          return this._processToolCall(attrs, timestamp, session, baseMetadata)
        }
        return null
    }
  }

  /**
   * Process ACP initialization event
   * Attributes: agent.name, agent.version, client.name, protocol.version
   */
  static _processInitialize(attrs, timestamp, session, baseMetadata) {
    const agentName = attrs['agent.name'] || 'acp-agent'
    const agentVersion = attrs['agent.version']
    const clientName = attrs['client.name']
    const protocolVersion = attrs['protocol.version'] || '1.0'

    this.logger.info(
      {
        sessionId: session.sessionId,
        agentName,
        agentVersion,
        clientName,
        protocolVersion,
        agent: this.name,
      },
      'ACP agent initialized',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'start',
      metadata: {
        ...baseMetadata,
        agentVersion,
        clientName,
        protocolVersion,
        eventType: 'initialize',
      },
    })
  }

  /**
   * Process session creation event
   * Attributes: acp.session_id, agent.name, capabilities
   */
  static _processSessionCreate(attrs, timestamp, session, baseMetadata) {
    const acpSessionId = attrs['acp.session_id']
    const agentName = attrs['agent.name'] || 'acp-agent'
    const capabilities = attrs.capabilities

    // Parse capabilities if JSON string
    let parsedCapabilities = null
    if (capabilities) {
      try {
        parsedCapabilities =
          typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities
      } catch {
        parsedCapabilities = capabilities
      }
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        acpSessionId,
        agentName,
        agent: this.name,
      },
      'ACP session created',
    )

    return createConversationStartEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.id'] || session.metadata?.userId,
      provider: this.provider,
      model: attrs.model || 'unknown',
      extraConfig: {
        acpSessionId,
        agentName,
        capabilities: parsedCapabilities,
      },
      metadata: baseMetadata,
    })
  }

  /**
   * Process session resume event
   * Attributes: acp.session_id, agent.name
   */
  static _processSessionResume(attrs, timestamp, session, baseMetadata) {
    const acpSessionId = attrs['acp.session_id']
    const agentName = attrs['agent.name'] || 'acp-agent'

    this.logger.info(
      {
        sessionId: session.sessionId,
        acpSessionId,
        agentName,
        agent: this.name,
      },
      'ACP session resumed',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'start',
      metadata: {
        ...baseMetadata,
        acpSessionId,
        eventType: 'resume',
      },
    })
  }

  /**
   * Process session end event
   * Attributes: acp.session_id, duration_ms, termination_reason
   */
  static _processSessionEnd(attrs, timestamp, session, baseMetadata) {
    const acpSessionId = attrs['acp.session_id']
    const agentName = attrs['agent.name'] || 'acp-agent'
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const terminationReason = attrs.termination_reason || 'completed'

    this.logger.info(
      {
        sessionId: session.sessionId,
        acpSessionId,
        agentName,
        durationMs,
        terminationReason,
        agent: this.name,
      },
      'ACP session ended',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'finish',
      durationMs,
      terminationReason,
      metadata: {
        ...baseMetadata,
        acpSessionId,
      },
    })
  }

  /**
   * Process message handling event (per JSON-RPC call)
   * Attributes: method, acp.request_id, duration_ms, success
   */
  static _processMessageHandle(attrs, timestamp, session, baseMetadata) {
    const method = attrs.method || 'unknown'
    const requestId = attrs['acp.request_id']
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const success = attrs.success !== 'false' && attrs.success !== false

    this.logger.info(
      {
        sessionId: session.sessionId,
        method,
        requestId,
        durationMs,
        success,
        agent: this.name,
      },
      'ACP message handled',
    )

    return createApiRequestEvent({
      timestamp,
      sessionId: session.sessionId,
      model: attrs.model || 'acp',
      durationMs,
      statusCode: success ? 200 : parseInt(attrs.status_code || '500', 10),
      success,
      requestId,
      metadata: {
        ...baseMetadata,
        method,
      },
    })
  }

  /**
   * Process ACP request event
   * Attributes: method, params, acp.request_id
   */
  static _processRequest(attrs, timestamp, session, baseMetadata) {
    const method = attrs.method || 'unknown'
    const requestId = attrs['acp.request_id']

    // Parse params if available
    let params = null
    if (attrs.params) {
      try {
        params = typeof attrs.params === 'string' ? JSON.parse(attrs.params) : attrs.params
      } catch {
        params = attrs.params
      }
    }

    // Extract prompt from params if available
    const prompt = attrs.prompt || params?.prompt || params?.message || ''
    const promptLength = parseInt(attrs.prompt_length || String(prompt.length) || '0', 10)

    this.logger.info(
      {
        sessionId: session.sessionId,
        method,
        requestId,
        promptLength,
        agent: this.name,
      },
      'ACP request received',
    )

    return createUserPromptEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.id'] || session.metadata?.userId,
      prompt,
      promptLength,
      metadata: {
        ...baseMetadata,
        method,
        requestId,
      },
    })
  }

  /**
   * Process ACP response event
   * Attributes: method, result, acp.request_id, duration_ms
   */
  static _processResponse(attrs, timestamp, session, baseMetadata) {
    const method = attrs.method || 'unknown'
    const requestId = attrs['acp.request_id']
    const durationMs = parseInt(attrs.duration_ms || '0', 10)

    // Parse result if available
    let result = null
    if (attrs.result) {
      try {
        result = typeof attrs.result === 'string' ? JSON.parse(attrs.result) : attrs.result
      } catch {
        result = attrs.result
      }
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        method,
        requestId,
        durationMs,
        agent: this.name,
      },
      'ACP response sent',
    )

    return createApiRequestEvent({
      timestamp,
      sessionId: session.sessionId,
      model: attrs.model || 'acp',
      durationMs,
      statusCode: 200,
      success: true,
      requestId,
      metadata: {
        ...baseMetadata,
        method,
        hasResult: !!result,
      },
    })
  }

  /**
   * Process ACP error event
   * Attributes: error, error_code, error_message, acp.request_id, method
   */
  static _processError(attrs, timestamp, session, baseMetadata) {
    const errorMessage = attrs.error_message || attrs.error || 'Unknown error'
    const errorCode = parseInt(attrs.error_code || attrs.code || '0', 10)
    const method = attrs.method || 'unknown'
    const requestId = attrs['acp.request_id']
    const durationMs = parseInt(attrs.duration_ms || '0', 10)

    this.logger.warn(
      {
        sessionId: session.sessionId,
        error: errorMessage,
        errorCode,
        method,
        requestId,
        agent: this.name,
      },
      'ACP error occurred',
    )

    return createApiErrorEvent({
      timestamp,
      sessionId: session.sessionId,
      model: attrs.model || 'acp',
      errorMessage,
      statusCode: errorCode,
      durationMs,
      requestId,
      metadata: {
        ...baseMetadata,
        method,
      },
    })
  }

  /**
   * Process LLM generation event
   * Attributes: model, input_tokens, output_tokens, duration_ms, cost_usd,
   *             prompt, completion, finish_reason
   */
  static _processLLMGenerate(attrs, timestamp, session, baseMetadata) {
    const model = attrs.model || attrs['llm.model'] || 'unknown'
    const durationMs = parseInt(attrs.duration_ms || '0', 10)

    // Token counts
    const inputTokens = parseInt(
      attrs.input_tokens || attrs['llm.input_tokens'] || attrs['gen_ai.usage.input_tokens'] || '0',
      10,
    )
    const outputTokens = parseInt(
      attrs.output_tokens || attrs['llm.output_tokens'] || attrs['gen_ai.usage.output_tokens'] || '0',
      10,
    )
    const cachedTokens = parseInt(attrs.cached_tokens || '0', 10)
    const reasoningTokens = parseInt(attrs.reasoning_tokens || attrs.thinking_tokens || '0', 10)

    // Cost
    const cost = parseFloat(attrs.cost_usd || attrs.cost || '0')

    // Content
    const prompt = attrs.prompt || attrs['llm.prompt'] || attrs['gen_ai.prompt']
    const completion = attrs.completion || attrs['llm.completion'] || attrs['gen_ai.completion']
    const finishReason = attrs.finish_reason || attrs['llm.finish_reason']

    this.logger.info(
      {
        sessionId: session.sessionId,
        model,
        durationMs,
        tokens: inputTokens + outputTokens,
        cost,
        agent: this.name,
      },
      'LLM generation processed',
    )

    return createGenerationEvent({
      timestamp,
      sessionId: session.sessionId,
      model,
      durationMs,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      cost,
      input: prompt,
      output: completion ? String(completion).substring(0, 2000) : null,
      metadata: {
        ...baseMetadata,
        finishReason,
      },
    })
  }

  /**
   * Process tool call event
   * Attributes: tool_name, tool_args, duration_ms, success, error, output
   */
  static _processToolCall(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || attrs['tool.name'] || attrs.name || 'unknown'
    const success = attrs.success !== 'false' && attrs.success !== false
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const error = attrs.error
    const output = attrs.output

    // Parse tool arguments
    let toolArgs = null
    if (attrs.tool_args || attrs['tool.args'] || attrs.arguments) {
      try {
        const argsStr = attrs.tool_args || attrs['tool.args'] || attrs.arguments
        toolArgs = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr
      } catch {
        toolArgs = attrs.tool_args || attrs['tool.args'] || attrs.arguments
      }
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        tool: toolName,
        success,
        durationMs,
        agent: this.name,
      },
      'Tool call processed',
    )

    return createToolResultEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      success,
      durationMs,
      arguments: toolArgs,
      output: output ? String(output).substring(0, 500) : null,
      error,
      metadata: baseMetadata,
    })
  }
}

module.exports = ACPAgent
