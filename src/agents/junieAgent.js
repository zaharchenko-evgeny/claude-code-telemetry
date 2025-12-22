/**
 * Junie CLI Agent
 *
 * Handles telemetry from JetBrains' Junie CLI.
 * Events have the prefix 'junie_cli.' and use 'session.id' for session tracking.
 *
 * Junie CLI uses standard OpenTelemetry environment variables for telemetry export.
 * See JUNIE_TELEMETRY.md for configuration details.
 *
 * Supported events:
 * - junie_cli.config - session configuration at startup
 * - junie_cli.user_prompt - user prompts
 * - junie_cli.api_request - API request initiation
 * - junie_cli.api_response - API response with token counts
 * - junie_cli.api_error - API errors
 * - junie_cli.tool_call - tool invocations with decisions
 * - junie_cli.file_operation - file operations
 * - junie_cli.agent.start - agent run start
 * - junie_cli.agent.finish - agent run completion
 * - junie_cli.task.start - task execution start
 * - junie_cli.task.finish - task execution completion
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

class JunieAgent extends BaseAgent {
  static get name() {
    return 'junie'
  }

  static get eventPrefix() {
    return 'junie_cli.'
  }

  static get provider() {
    return 'jetbrains'
  }

  /**
   * Check if this agent can handle the given event
   * Handles junie_cli.* events
   */
  static canHandle(eventName) {
    return eventName && eventName.startsWith('junie_cli.')
  }

  /**
   * Extract session ID from attributes
   * Junie uses 'session.id' or 'junie.session.id' or 'task.id'
   */
  static extractSessionId(attrs) {
    return attrs['session.id'] || attrs['junie.session.id'] || attrs['task.id'] || null
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
    baseMetadata.taskId = attrs['task.id'] || session.taskId
    baseMetadata.projectId = attrs['project.id']
    baseMetadata.workspaceId = attrs['workspace.id']
    baseMetadata.ideVersion = attrs['ide.version']
    baseMetadata.junieVersion = attrs['junie.version']

    switch (eventName) {
      case 'junie_cli.config':
        return this._processConfig(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.user_prompt':
        return this._processUserPrompt(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.api_request':
        return this._processApiRequest(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.api_response':
        return this._processApiResponse(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.api_error':
        return this._processApiError(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.tool_call':
        return this._processToolCall(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.file_operation':
        return this._processFileOperation(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.agent.start':
      case 'junie_cli.task.start':
        return this._processAgentStart(attrs, timestamp, session, baseMetadata)

      case 'junie_cli.agent.finish':
      case 'junie_cli.task.finish':
        return this._processAgentFinish(attrs, timestamp, session, baseMetadata)

      // Additional Junie-specific events
      case 'junie_cli.plan.start':
      case 'junie_cli.plan.finish':
      case 'junie_cli.review.start':
      case 'junie_cli.review.finish':
        return this._processWorkflowEvent(eventName, attrs, timestamp, session, baseMetadata)

      default:
        // Check for other junie_cli.* events we might want to log
        if (eventName && eventName.startsWith('junie_cli.')) {
          this.logger.debug({ eventName, agent: this.name }, 'Unknown Junie CLI event')
        }
        return null
    }
  }

  /**
   * Process config event - emitted once at startup
   * Attributes: model, auto_approve, sandbox_mode, project_context, extensions
   */
  static _processConfig(attrs, timestamp, session, baseMetadata) {
    const config = {
      model: attrs.model,
      autoApprove: attrs.auto_approve === 'true' || attrs.auto_approve === true,
      sandboxMode: attrs.sandbox_mode || 'disabled',
      projectContext: attrs.project_context === 'true' || attrs.project_context === true,
      extensions: attrs.extensions ? attrs.extensions.split(',').map((e) => e.trim()) : [],
      maxIterations: parseInt(attrs.max_iterations || '0', 10),
    }

    this.logger.info(
      {
        sessionId: session.sessionId,
        model: config.model,
        autoApprove: config.autoApprove,
        sandboxMode: config.sandboxMode,
        agent: this.name,
      },
      'Junie CLI session configured',
    )

    return createConversationStartEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.id'] || session.metadata?.userId,
      provider: this.provider,
      model: config.model,
      approvalPolicy: config.autoApprove ? 'auto' : 'manual',
      sandboxPolicy: config.sandboxMode,
      extraConfig: {
        projectContext: config.projectContext,
        extensions: config.extensions,
        maxIterations: config.maxIterations,
      },
      metadata: baseMetadata,
    })
  }

  /**
   * Process user prompt event
   * Attributes: prompt_length, prompt_id, prompt (if logging enabled), task_description
   */
  static _processUserPrompt(attrs, timestamp, session, baseMetadata) {
    const prompt = attrs.prompt || attrs.task_description || ''
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
      userId: attrs['user.id'] || session.metadata?.userId,
      prompt,
      promptLength,
      metadata: {
        ...baseMetadata,
        promptId,
        taskDescription: attrs.task_description,
      },
    })
  }

  /**
   * Process API request event
   * Attributes: model, prompt_id, request_type
   */
  static _processApiRequest(attrs, timestamp, session, baseMetadata) {
    const model = attrs.model || session.defaultModel || 'unknown'
    const promptId = attrs.prompt_id
    const requestType = attrs.request_type || 'completion'

    this.logger.info(
      {
        sessionId: session.sessionId,
        model,
        promptId,
        requestType,
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
        requestType,
      },
    })
  }

  /**
   * Process API response event
   * Attributes: status_code, duration_ms, input_tokens, output_tokens,
   *             cached_tokens, total_tokens, cost_usd, response_text (optional)
   */
  static _processApiResponse(attrs, timestamp, session, baseMetadata) {
    const statusCode = parseInt(attrs.status_code || '200', 10)
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const model = attrs.model || session.defaultModel || 'unknown'

    // Token counts
    const inputTokens = parseInt(attrs.input_tokens || attrs.input_token_count || '0', 10)
    const outputTokens = parseInt(attrs.output_tokens || attrs.output_token_count || '0', 10)
    const cachedTokens = parseInt(attrs.cached_tokens || attrs.cached_token_count || '0', 10)
    const reasoningTokens = parseInt(attrs.reasoning_tokens || attrs.thinking_tokens || '0', 10)
    const totalTokens = parseInt(
      attrs.total_tokens || String(inputTokens + outputTokens + cachedTokens + reasoningTokens),
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
      reasoningTokens,
      cost,
      metadata: {
        ...baseMetadata,
        statusCode,
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
   * Attributes: tool_name, tool_args, duration_ms, success, decision,
   *             error, tool_type (native/plugin), plugin_name
   */
  static _processToolCall(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || attrs.function_name || 'unknown'
    const decision = attrs.decision || 'auto_accept'
    const success = attrs.success === 'true' || attrs.success === true
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const error = attrs.error
    const toolType = attrs.tool_type || 'native'
    const pluginName = attrs.plugin_name

    // Parse tool arguments
    let toolArgs = null
    if (attrs.tool_args || attrs.function_args) {
      try {
        const argsStr = attrs.tool_args || attrs.function_args
        toolArgs = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr
      } catch {
        toolArgs = attrs.tool_args || attrs.function_args
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

    return createToolResultEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName,
      success,
      durationMs,
      arguments: toolArgs,
      error,
      metadata: {
        ...baseMetadata,
        decision,
        toolType,
        pluginName,
      },
    })
  }

  /**
   * Process file operation event
   * Attributes: tool_name, operation ("create"/"read"/"update"/"delete"), lines,
   *             file_path, extension, language
   */
  static _processFileOperation(attrs, timestamp, session, baseMetadata) {
    const toolName = attrs.tool_name || 'file'
    const operation = attrs.operation || 'unknown'
    const lines = parseInt(attrs.lines || '0', 10)
    const filePath = attrs.file_path
    const extension = attrs.extension
    const language = attrs.language || attrs.programming_language

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
      extension,
      programmingLanguage: language,
      metadata: {
        ...baseMetadata,
        filePath,
      },
    })
  }

  /**
   * Process agent/task start event
   * Attributes: agent_name, task_id, config
   */
  static _processAgentStart(attrs, timestamp, session, baseMetadata) {
    const agentName = attrs.agent_name || attrs.task_name || 'default'
    const taskId = attrs.task_id

    this.logger.info(
      {
        sessionId: session.sessionId,
        agentName,
        taskId,
        agent: this.name,
      },
      'Agent/task started',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'start',
      metadata: {
        ...baseMetadata,
        taskId,
      },
    })
  }

  /**
   * Process agent/task finish event
   * Attributes: agent_name, task_id, duration_ms, iterations, termination_reason, success
   */
  static _processAgentFinish(attrs, timestamp, session, baseMetadata) {
    const agentName = attrs.agent_name || attrs.task_name || 'default'
    const taskId = attrs.task_id
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const iterations = parseInt(attrs.iterations || attrs.turns || '0', 10)
    const terminationReason = attrs.termination_reason || (attrs.success === 'true' ? 'completed' : 'failed')
    const success = attrs.success === 'true' || attrs.success === true

    this.logger.info(
      {
        sessionId: session.sessionId,
        agentName,
        taskId,
        durationMs,
        iterations,
        terminationReason,
        success,
        agent: this.name,
      },
      'Agent/task finished',
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName,
      lifecycle: 'finish',
      durationMs,
      turns: iterations,
      terminationReason,
      metadata: {
        ...baseMetadata,
        taskId,
        success,
      },
    })
  }

  /**
   * Process workflow events (plan, review, etc.)
   */
  static _processWorkflowEvent(eventName, attrs, timestamp, session, baseMetadata) {
    const parts = eventName.split('.')
    const workflow = parts[1] // plan, review, etc.
    const lifecycle = parts[2] // start, finish

    const workflowName = attrs.workflow_name || workflow
    const durationMs = parseInt(attrs.duration_ms || '0', 10)
    const success = attrs.success === 'true' || attrs.success === true

    this.logger.info(
      {
        sessionId: session.sessionId,
        workflow: workflowName,
        lifecycle,
        durationMs,
        success,
        agent: this.name,
      },
      `Workflow ${lifecycle === 'start' ? 'started' : 'finished'}`,
    )

    return createAgentLifecycleEvent({
      timestamp,
      sessionId: session.sessionId,
      agentName: workflowName,
      lifecycle,
      durationMs: lifecycle === 'finish' ? durationMs : 0,
      terminationReason: lifecycle === 'finish' ? (success ? 'completed' : 'failed') : undefined,
      metadata: {
        ...baseMetadata,
        workflowType: workflow,
        success: lifecycle === 'finish' ? success : undefined,
      },
    })
  }
}

module.exports = JunieAgent
