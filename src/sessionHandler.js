// Session Handler class with Langfuse resource attribute support
// Patched version to support langfuse.trace.name, langfuse.tags, langfuse.metadata, etc.
const pino = require('pino')

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

class SessionHandler {
  constructor(sessionId, resourceAttributes = {}, langfuseInstance) {
    if (!sessionId) {
      throw new Error('SessionHandler requires a sessionId')
    }

    this.sessionId = sessionId
    this.createdAt = new Date()
    this.langfuse = langfuseInstance
    this.traces = new Map()
    this.spans = new Map()
    this.rootSpans = new Map()
    this.metrics = []
    this.lastActivity = Date.now()

    // Current conversation state
    this.currentTrace = null
    this.currentSpan = null
    this.toolSequence = []
    this.conversationStartTime = null

    // Metrics
    this.totalCost = 0
    this.totalTokens = 0
    this.apiCallCount = 0
    this.toolCallCount = 0
    this.conversationCount = 0
    this.linesAdded = 0
    this.linesRemoved = 0

    // Performance tracking
    this.latencies = {
      api: [],
      tool: [],
      conversation: [],
    }

    // Extract metadata
    const serviceInfo = this.extractResourceInfo(resourceAttributes)
    this.metadata = {
      sessionId,
      userId: process.env.USER_EMAIL || process.env.USER || 'unknown',
      environment: process.env.NODE_ENV || 'production',
      platform: process.platform,
      node_version: process.version,
      start_time: new Date().toISOString(),
      release: serviceInfo.version || process.env.CLAUDE_CODE_VERSION || 'unknown',
      service: serviceInfo,
    }

    // Extract Langfuse-specific resource attributes
    this.langfuseConfig = this.extractLangfuseConfig(resourceAttributes)

    logger.info(
      {
        sessionId,
        service: serviceInfo.name,
        version: serviceInfo.version,
        langfuseTraceName: this.langfuseConfig.traceName,
        langfuseTags: this.langfuseConfig.tags,
      },
      'Session created',
    )
  }

  extractResourceInfo(resourceAttributes) {
    const attrs = resourceAttributes || {}
    return {
      name: attrs['service.name'] || 'claude-code',
      version:
        attrs['service.version'] || attrs['claude.version'] || attrs['app.version'] || 'unknown',
      instance: attrs['service.instance.id'] || attrs['host.name'],
      telemetrySDK: attrs['telemetry.sdk.name'],
      terminalType: attrs['terminal.type'],
    }
  }

  extractLangfuseConfig(resourceAttributes) {
    const attrs = resourceAttributes || {}
    // Try resource attributes first, then fall back to environment variables
    // This is needed because Claude Code doesn't pass OTEL_RESOURCE_ATTRIBUTES through its telemetry
    const tagsStr = attrs['langfuse.tags'] || process.env.LANGFUSE_TRACE_TAGS || ''
    // Note: OTEL_RESOURCE_ATTRIBUTES uses comma as separator, so tags should use semicolon or pipe
    // Supports: "tag1;tag2;tag3" or "tag1|tag2|tag3" or "tag1,tag2,tag3"
    const tags = tagsStr
      .split(/[;|,]/)
      .map((t) => t.trim())
      .filter((t) => t)
    return {
      traceName: attrs['langfuse.trace.name'] || process.env.LANGFUSE_TRACE_NAME || null,
      tags,
      metadata:
        attrs['langfuse.metadata'] || process.env.LANGFUSE_TRACE_METADATA
          ? this.parseJsonSafe(attrs['langfuse.metadata'] || process.env.LANGFUSE_TRACE_METADATA)
          : null,
      userId: attrs['langfuse.user.id'] || process.env.LANGFUSE_USER_ID || null,
      sessionId: attrs['langfuse.session.id'] || process.env.LANGFUSE_SESSION_ID || null,
    }
  }

  parseJsonSafe(str) {
    try {
      return JSON.parse(str)
    } catch {
      return null
    }
  }

  processLogRecord(logRecord, resource) {
    const eventName = logRecord.body?.stringValue
    const timestamp = logRecord.timeUnixNano
      ? new Date(Number(logRecord.timeUnixNano) / 1000000).toISOString()
      : new Date().toISOString()
    const attrs = extractAttributesArray(logRecord.attributes)

    logger.debug({ eventName, attrs, sessionId: this.sessionId }, 'Processing event')

    switch (eventName) {
      case 'claude_code.user_prompt':
        this.handleUserPrompt(attrs, timestamp)
        break
      case 'claude_code.api_request':
        this.handleApiRequest(attrs, timestamp)
        break
      case 'claude_code.tool_result':
        this.handleToolResult(attrs, timestamp)
        break
      case 'claude_code.api_error':
        this.handleApiError(attrs, timestamp)
        break
      case 'claude_code.tool_decision':
        this.handleToolDecision(attrs, timestamp)
        break
      default:
        logger.debug({ eventName, sessionId: this.sessionId }, 'Unknown event type')
    }
  }

  handleUserPrompt(attrs, timestamp) {
    logger.info(
      { sessionId: this.sessionId, promptLength: attrs.prompt_length || 0 },
      'User prompt received',
    )

    this.conversationCount++
    this.conversationStartTime = Date.now()
    this.toolSequence = []

    // Build trace options with Langfuse config
    const traceOptions = {
      name: this.langfuseConfig.traceName || `conversation-${this.conversationCount}`,
      sessionId: this.langfuseConfig.sessionId || this.sessionId,
      userId:
        this.langfuseConfig.userId ||
        attrs['user.email'] ||
        attrs['user.id'] ||
        this.metadata.userId,
      input: {
        prompt: attrs.prompt || '[Prompt hidden]',
        length: attrs.prompt_length || 0,
      },
      metadata: {
        ...(this.langfuseConfig.metadata || {}),
        promptId: attrs.prompt_id,
        promptTimestamp: attrs['event.timestamp'] || timestamp,
        conversationIndex: this.conversationCount,
        organizationId: attrs['organization.id'] || this.organizationId,
        userAccountUuid: attrs['user.account_uuid'] || this.userAccountUuid,
        terminalType: attrs['terminal.type'] || this.terminalType,
        claude: {
          sessionId: attrs['session.id'] || this.sessionId,
          version: attrs['app.version'] || this.metadata.service.version,
        },
      },
      version: this.metadata.release,
    }

    // Add tags if configured
    if (this.langfuseConfig.tags.length > 0) {
      traceOptions.tags = this.langfuseConfig.tags
    }

    // Create a new trace for this conversation
    this.currentTrace = this.langfuse.trace(traceOptions)
  }

  handleApiRequest(attrs, timestamp) {
    const model = attrs.model || 'unknown'
    const inputTokens = parseInt(attrs.input_tokens || 0)
    const outputTokens = parseInt(attrs.output_tokens || 0)
    const cacheReadTokens = parseInt(attrs.cache_read_tokens || 0)
    const cacheCreationTokens = parseInt(attrs.cache_creation_tokens || 0)
    const totalTokens = inputTokens + outputTokens
    const cost = parseFloat(attrs.cost || 0)
    const requestId = attrs.request_id

    const startTime = new Date(timestamp)
    const endTime = attrs['api.response_time']
      ? new Date(new Date(timestamp).getTime() + (attrs['api.response_time'] || 0))
      : new Date()
    const durationMs = attrs['api.response_time'] || attrs.duration || endTime - startTime

    // Update metrics
    this.totalCost += cost
    this.totalTokens += totalTokens
    this.apiCallCount++

    // If no trace exists yet (no user_prompt event), create one now
    if (!this.currentTrace && this.apiCallCount === 1) {
      this.conversationCount++
      this.conversationStartTime = Date.now()

      // Build trace options with Langfuse config
      const traceOptions = {
        name: this.langfuseConfig.traceName || `conversation-${this.conversationCount}`,
        sessionId: this.langfuseConfig.sessionId || this.sessionId,
        userId:
          this.langfuseConfig.userId ||
          attrs['user.email'] ||
          this.userEmail ||
          this.metadata.userId,
        input: {
          prompt: '[No user prompt captured - OTEL_LOG_USER_PROMPTS may be disabled]',
          model,
          firstApiCall: true,
        },
        metadata: {
          ...(this.langfuseConfig.metadata || {}),
          conversationIndex: this.conversationCount,
          startedFrom: 'api_request',
          organizationId: attrs['organization.id'] || this.organizationId,
          userAccountUuid: attrs['user.account_uuid'] || this.userAccountUuid,
          terminalType: attrs['terminal.type'] || this.terminalType,
          claude: {
            sessionId: attrs['session.id'] || this.sessionId,
            version: this.metadata.service.version,
            appVersion: attrs['app.version'] || this.metadata.service.version,
          },
        },
        version: this.metadata.release,
      }

      // Add tags if configured
      if (this.langfuseConfig.tags.length > 0) {
        traceOptions.tags = this.langfuseConfig.tags
      }

      this.currentTrace = this.langfuse.trace(traceOptions)
    }

    // Create generation span
    const modelType = model.includes('haiku') ? 'routing' : 'generation'

    logger.debug(
      {
        sessionId: this.sessionId,
        traceId: this.currentTrace?.id,
        model,
        modelType,
        hasTrace: !!this.currentTrace,
        langfuseAvailable: !!this.langfuse,
      },
      'Creating generation observation',
    )

    const span = this.langfuse.generation({
      name: `${modelType}-${model}`,
      traceId: this.currentTrace?.id,
      startTime,
      endTime,
      model,
      input: attrs.input || `[${modelType} request]`,
      output: attrs.output || attrs.response || `[${modelType} response]`,
      usage: {
        input: inputTokens,
        output: outputTokens,
        total: totalTokens,
        unit: 'TOKENS',
      },
      metadata: {
        cost,
        requestId,
        cache: {
          read: cacheReadTokens,
          creation: cacheCreationTokens,
          hitRate: totalTokens > 0 ? cacheReadTokens / totalTokens : 0,
        },
        performance: {
          durationMs,
          tokensPerSecond: durationMs > 0 ? (outputTokens / durationMs) * 1000 : 0,
        },
        model: {
          name: model,
          type: modelType,
          provider: 'anthropic',
        },
        claude: {
          sessionId: attrs['session.id'] || this.sessionId,
          apiCallIndex: this.apiCallCount,
        },
      },
      level: modelType === 'generation' ? 'DEFAULT' : 'DEBUG',
      statusMessage: attrs.status_message || `${modelType} completed`,
      version: this.metadata.release,
    })

    logger.debug(
      {
        sessionId: this.sessionId,
        generationId: span?.id,
        modelType,
      },
      'Generation observation created',
    )

    if (modelType === 'generation') {
      this.currentSpan = span
    }

    // Collect latency
    if (durationMs > 0) {
      this.latencies.api.push(durationMs)
    }

    logger.info(
      {
        sessionId: this.sessionId,
        model,
        tokens: totalTokens,
        cost,
        duration: durationMs,
        cache: { read: cacheReadTokens, creation: cacheCreationTokens },
        requestId,
      },
      `API call #${this.apiCallCount}`,
    )
  }

  handleToolResult(attrs, timestamp) {
    const toolName = attrs.tool_name || attrs.tool || attrs.name || 'unknown'
    const success = attrs.success !== false
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const decision = attrs.decision || 'execute'
    const source = attrs.source || 'automated'
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
        // Keep as string if not valid JSON
        toolParameters = attrs.tool_parameters
      }
    }

    this.toolCallCount++
    const startTime =
      durationMs > 0 ? new Date(new Date(timestamp).getTime() - durationMs) : new Date(timestamp)

    // Track tool sequence
    this.toolSequence.push({
      name: toolName,
      success,
      duration: durationMs,
      timestamp,
      parameters: toolParameters,
      error,
    })

    // Create event
    if (this.currentTrace) {
      this.langfuse.event({
        name: `tool-${toolName}`,
        traceId: this.currentTrace.id,
        parentObservationId: this.currentSpan?.id,
        startTime,
        input: {
          toolName,
          decision,
          source,
          parameters: toolParameters,
        },
        output: {
          success,
          durationMs,
          error,
        },
        metadata: {
          eventTimestamp: attrs['event.timestamp'] || timestamp,
          toolIndex: this.toolCallCount,
          decision: {
            type: decision,
            source,
          },
          performance: {
            durationMs,
          },
          toolParameters,
          error,
          claude: {
            sessionId: attrs['session.id'] || this.sessionId,
          },
        },
        level: success ? 'DEFAULT' : 'WARNING',
      })
    }

    // Collect tool latency
    if (durationMs > 0) {
      this.latencies.tool.push(durationMs)
    }

    logger.info(
      {
        sessionId: this.sessionId,
        tool: toolName,
        success,
        duration: durationMs,
        parameters: toolParameters,
        error,
      },
      `Tool #${this.toolCallCount}`,
    )
  }

  handleApiError(attrs, timestamp) {
    const model = attrs.model || 'unknown'
    const errorMessage = attrs.error_message || attrs.error || 'Unknown error'
    const statusCode = attrs.status_code || attrs.status || 0
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const attempt = parseInt(attrs.attempt || '1', 10)

    logger.error(
      {
        sessionId: this.sessionId,
        model,
        error: errorMessage,
        statusCode,
        durationMs,
        attempt,
        timestamp,
      },
      'API error occurred',
    )

    if (this.currentTrace) {
      this.langfuse.event({
        name: 'api-error',
        traceId: this.currentTrace.id,
        input: {
          model,
          attempt,
        },
        output: {
          error: errorMessage,
          statusCode,
        },
        metadata: {
          model,
          error: errorMessage,
          statusCode,
          durationMs,
          attempt,
          timestamp,
          claude: {
            sessionId: attrs['session.id'] || this.sessionId,
          },
        },
        level: 'ERROR',
      })
    }
  }

  handleToolDecision(attrs, timestamp) {
    const toolName = attrs.tool_name || attrs.tool || 'unknown'
    const decision = attrs.decision || 'unknown'
    const source = attrs.source || 'unknown'

    logger.info(
      {
        sessionId: this.sessionId,
        tool: toolName,
        decision,
        source,
        timestamp,
      },
      'Tool decision',
    )

    if (this.currentTrace) {
      this.langfuse.event({
        name: 'tool-decision',
        traceId: this.currentTrace.id,
        parentObservationId: this.currentSpan?.id,
        input: {
          toolName,
          source,
        },
        output: {
          decision,
        },
        metadata: {
          tool: toolName,
          decision,
          source,
          eventTimestamp: attrs['event.timestamp'] || timestamp,
          claude: {
            sessionId: attrs['session.id'] || this.sessionId,
          },
        },
        level: decision === 'accept' ? 'DEFAULT' : 'WARNING',
      })
    }
  }

  processMetric(metric, dataPoint, attrs) {
    this.lastActivity = Date.now()

    // Handle different metric types
    switch (metric.name) {
      case 'claude_code.session.count': {
        const sessionCount = dataPoint.asDouble || dataPoint.asInt || 1
        logger.info(
          {
            sessionId: this.sessionId,
            count: sessionCount,
          },
          'Session count metric',
        )

        if (this.currentTrace) {
          this.langfuse.event({
            name: 'session-started',
            traceId: this.currentTrace.id,
            metadata: {
              count: sessionCount,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.cost.usage': {
        const cost = dataPoint.asDouble || 0
        const costModel = attrs.model || 'unknown'
        this.totalCost += cost
        logger.info(
          { sessionId: this.sessionId, cost, model: costModel, totalCost: this.totalCost },
          'Cost metric received',
        )
        break
      }

      case 'claude_code.token.usage': {
        const tokens = parseInt(dataPoint.asDouble || dataPoint.asInt || 0)
        const tokenType = attrs.type || 'unknown'
        const tokenModel = attrs.model || 'unknown'

        if (!this.cacheTokens) {
          this.cacheTokens = { read: 0, creation: 0 }
        }

        switch (tokenType) {
          case 'input':
          case 'output':
            this.totalTokens += tokens
            break
          case 'cacheRead':
            this.cacheTokens.read += tokens
            break
          case 'cacheCreation':
            this.cacheTokens.creation += tokens
            break
        }

        logger.info(
          {
            sessionId: this.sessionId,
            tokens,
            tokenType,
            model: tokenModel,
            totalTokens: this.totalTokens,
            cacheTokens: this.cacheTokens,
          },
          'Token metric received',
        )
        break
      }

      case 'claude_code.lines_of_code.count': {
        const lines = dataPoint.asDouble || 0
        const modificationType = attrs.type

        if (modificationType === 'added') {
          this.linesAdded += lines
        } else if (modificationType === 'removed') {
          this.linesRemoved += lines
        }

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'code-modification',
            metadata: {
              lines,
              type: modificationType,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }

        logger.info(
          {
            sessionId: this.sessionId,
            lines,
            type: modificationType,
          },
          'Code modification metric',
        )
        break
      }

      case 'claude_code.pull_request.count': {
        const prCount = dataPoint.asDouble || dataPoint.asInt || 1
        logger.info(
          {
            sessionId: this.sessionId,
            count: prCount,
          },
          'Pull request created',
        )

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'pull-request-created',
            metadata: {
              count: prCount,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.commit.count': {
        const commitCount = dataPoint.asDouble || dataPoint.asInt || 1
        logger.info(
          {
            sessionId: this.sessionId,
            count: commitCount,
          },
          'Git commit created',
        )

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'git-commit-created',
            metadata: {
              count: commitCount,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.code_edit_tool.decision': {
        const decision = attrs.decision
        const tool = attrs.tool
        const language = attrs.language

        logger.info(
          {
            sessionId: this.sessionId,
            tool,
            decision,
            language,
          },
          'Tool permission decision',
        )

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'tool-permission-decision',
            metadata: {
              tool,
              decision,
              language,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.active_time.total': {
        const activeTime = dataPoint.asDouble || 0
        logger.info(
          {
            sessionId: this.sessionId,
            activeTimeSeconds: activeTime,
          },
          'Active time metric',
        )

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'active-time-update',
            metadata: {
              seconds: activeTime,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      default:
        logger.debug(
          {
            sessionId: this.sessionId,
            metricName: metric.name,
            value: dataPoint.asDouble || dataPoint.asInt || 0,
            attributes: attrs,
          },
          'Unknown metric received',
        )
    }
  }

  async finalize() {
    try {
      if (this.currentSpan) {
        this.currentSpan.end({
          output: {
            toolCount: this.toolSequence.length,
            tools: this.toolSequence.map((t) => `${t.name}:${t.success}`).join(', '),
            totalDuration: this.toolSequence.reduce((sum, t) => sum + t.duration, 0),
          },
        })
        this.currentSpan = null
      }

      if (this.currentTrace) {
        this.currentTrace.update({
          output: {
            status: 'session_ended',
            duration: this.conversationStartTime ? Date.now() - this.conversationStartTime : 0,
          },
        })
        if (this.conversationStartTime) {
          this.latencies.conversation.push(Date.now() - this.conversationStartTime)
        }
      }

      const calculatePercentiles = (data) => {
        if (!data || data.length === 0) return null
        const sorted = [...data].sort((a, b) => a - b)
        return {
          count: data.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          avg: Math.round(data.reduce((a, b) => a + b, 0) / data.length),
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
        }
      }

      const apiPercentiles = calculatePercentiles(this.latencies.api)
      const toolPercentiles = calculatePercentiles(this.latencies.tool)
      const conversationPercentiles = calculatePercentiles(this.latencies.conversation)

      const sessionDuration = Date.now() - this.createdAt.getTime()

      // Build session summary trace options
      const summaryOptions = {
        name: 'session-summary',
        sessionId: this.langfuseConfig.sessionId || this.sessionId,
        userId: this.langfuseConfig.userId || this.metadata.userId || 'claude-code-user',
        version: this.metadata.release,
        input: {
          sessionStart: this.createdAt.toISOString(),
          metadata: this.metadata,
        },
        output: {
          sessionEnd: new Date().toISOString(),
          sessionDuration,
          conversationCount: this.conversationCount,
          apiCallCount: this.apiCallCount,
          toolCallCount: this.toolCallCount,
          totalCost: this.totalCost,
          totalTokens: this.totalTokens,
          cacheTokens: this.cacheTokens || { read: 0, creation: 0 },
          codeChanges: {
            linesAdded: this.linesAdded,
            linesRemoved: this.linesRemoved,
            netChange: this.linesAdded - this.linesRemoved,
          },
          performance: {
            api: apiPercentiles,
            tool: toolPercentiles,
            conversation: conversationPercentiles,
          },
          additionalMetrics: {
            activeTime: this.activeTime || 0,
            commitCount: this.commitCount || 0,
            pullRequestCount: this.prCount || 0,
            toolDecisions: this.toolDecisions || [],
          },
        },
        metadata: {
          ...(this.langfuseConfig.metadata || {}),
          service: this.metadata.service,
          environment: this.metadata.environment,
          platform: this.metadata.platform,
          nodeVersion: this.metadata.node_version,
          toolSequence: this.toolSequence,
          finalStatus: 'completed',
          organizationId: this.organizationId,
          userAccountUuid: this.userAccountUuid,
          userEmail: this.userEmail,
          terminalType: this.terminalType,
        },
      }

      // Add tags if configured
      if (this.langfuseConfig.tags.length > 0) {
        summaryOptions.tags = this.langfuseConfig.tags
      }

      const sessionSummary = this.langfuse.trace(summaryOptions)

      const cacheHitRate =
        this.totalTokens > 0
          ? this.latencies.api.reduce((sum, l) => sum + l, 0) / this.totalTokens
          : 0
      const avgResponseTime = apiPercentiles ? apiPercentiles.avg : 0
      const toolSuccessRate =
        this.toolSequence.length > 0
          ? this.toolSequence.filter((t) => t.success).length / this.toolSequence.length
          : 1
      const qualityScore = Math.min(
        100,
        Math.round(cacheHitRate * 20 + toolSuccessRate * 40 + (avgResponseTime < 1000 ? 40 : 20)),
      )

      this.langfuse.score({
        traceId: sessionSummary.id,
        name: 'quality',
        value: qualityScore,
        comment: `Cache rate: ${cacheHitRate.toFixed(2)}, Tool success: ${toolSuccessRate.toFixed(2)}, Avg response: ${avgResponseTime}ms`,
      })

      if (this.totalCost > 0) {
        const tokenEfficiency = this.totalTokens / this.totalCost
        this.langfuse.score({
          traceId: sessionSummary.id,
          name: 'efficiency',
          value: Math.min(100, Math.round(tokenEfficiency / 10)),
          comment: `${this.conversationCount} conversations, $${this.totalCost.toFixed(4)}/conversation, $${tokenEfficiency.toFixed(4)}/1k tokens`,
        })
      }

      logger.info({ sessionId: this.sessionId, totalCost: this.totalCost }, 'Session finalized')
      const baseUrl = (process.env.LANGFUSE_HOST || 'http://localhost:3000').replace(
        /\/api\/public.*$/,
        '',
      )
      logger.info(`View at: ${baseUrl}/sessions/${this.sessionId}`)

      await retry(() => this.langfuse.flushAsync())
    } catch (error) {
      logger.error({ error, sessionId: this.sessionId }, 'Error finalizing session')
    }
  }
}

function extractAttributesArray(attributes) {
  const result = {}
  if (!attributes) return result

  for (const attr of attributes) {
    const key = attr.key
    let value = null

    if (attr.value.stringValue !== undefined) value = attr.value.stringValue
    else if (attr.value.intValue !== undefined) value = parseInt(attr.value.intValue)
    else if (attr.value.doubleValue !== undefined) value = parseFloat(attr.value.doubleValue)
    else if (attr.value.boolValue !== undefined) value = attr.value.boolValue
    else if (attr.value.arrayValue !== undefined) {
      value = attr.value.arrayValue.values.map((v) => extractAttributeValue(v))
    } else if (attr.value.kvlistValue !== undefined) {
      value = {}
      for (const kv of attr.value.kvlistValue.values) {
        value[kv.key] = extractAttributeValue(kv.value)
      }
    }

    result[key] = value
  }

  return result
}

function extractAttributeValue(value) {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return parseInt(value.intValue)
  if (value.doubleValue !== undefined) return parseFloat(value.doubleValue)
  if (value.boolValue !== undefined) return value.boolValue
  if (value.arrayValue !== undefined) {
    return value.arrayValue.values.map((v) => extractAttributeValue(v))
  }
  if (value.kvlistValue !== undefined) {
    const obj = {}
    for (const kv of value.kvlistValue.values) {
      obj[kv.key] = extractAttributeValue(kv.value)
    }
    return obj
  }
  return null
}

async function retry(fn, attempts = 3) {
  try {
    return await fn()
  } catch (error) {
    if (attempts <= 1) throw error
    const delay = Math.min(1000 * Math.pow(2, 3 - attempts), 10000)
    logger.debug({ delay, attemptsLeft: attempts - 1 }, 'Retrying after delay')
    await new Promise((resolve) => setTimeout(resolve, delay))
    return retry(fn, attempts - 1)
  }
}

module.exports = {
  SessionHandler,
  extractAttributesArray,
  extractAttributeValue,
  retry,
}
