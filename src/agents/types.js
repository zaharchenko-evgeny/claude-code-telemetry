/**
 * Common Event Types for AI Agent Telemetry
 *
 * This module defines the normalized event types that all agent processors
 * should produce. Events are normalized to a common format before being
 * sent to Langfuse.
 */

/**
 * Event types supported by the telemetry system
 */
const EventType = {
  CONVERSATION_START: 'conversation_start',
  USER_PROMPT: 'user_prompt',
  API_REQUEST: 'api_request',
  API_ERROR: 'api_error',
  GENERATION: 'generation', // Token usage / model response
  TOOL_DECISION: 'tool_decision',
  TOOL_RESULT: 'tool_result',
  FILE_OPERATION: 'file_operation', // File create/read/update operations
  AGENT_LIFECYCLE: 'agent_lifecycle', // Agent start/finish events
}

/**
 * Create a normalized conversation start event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createConversationStartEvent(params) {
  return {
    type: EventType.CONVERSATION_START,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    userId: params.userId,
    config: {
      provider: params.provider || 'unknown',
      model: params.model,
      approvalPolicy: params.approvalPolicy,
      sandboxPolicy: params.sandboxPolicy,
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      ...params.extraConfig,
    },
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized user prompt event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createUserPromptEvent(params) {
  return {
    type: EventType.USER_PROMPT,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    userId: params.userId,
    prompt: params.prompt || '',
    promptLength: params.promptLength || 0,
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized API request event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createApiRequestEvent(params) {
  return {
    type: EventType.API_REQUEST,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model || 'unknown',
    durationMs: params.durationMs || 0,
    statusCode: params.statusCode,
    attempt: params.attempt || 1,
    success: params.success !== false,
    requestId: params.requestId,
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized API error event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createApiErrorEvent(params) {
  return {
    type: EventType.API_ERROR,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model || 'unknown',
    errorMessage: params.errorMessage || 'Unknown error',
    statusCode: params.statusCode || 0,
    durationMs: params.durationMs || 0,
    attempt: params.attempt || 1,
    requestId: params.requestId,
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized generation event (token usage)
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createGenerationEvent(params) {
  return {
    type: EventType.GENERATION,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model || 'unknown',
    durationMs: params.durationMs || 0,
    tokens: {
      input: params.inputTokens || 0,
      output: params.outputTokens || 0,
      cached: params.cachedTokens || 0,
      reasoning: params.reasoningTokens || 0,
      tool: params.toolTokens || 0,
      total:
        (params.inputTokens || 0) +
        (params.outputTokens || 0) +
        (params.cachedTokens || 0) +
        (params.reasoningTokens || 0) +
        (params.toolTokens || 0),
    },
    cost: params.cost || 0,
    requestId: params.requestId,
    input: params.input,
    output: params.output,
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized tool decision event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createToolDecisionEvent(params) {
  return {
    type: EventType.TOOL_DECISION,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    toolName: params.toolName || 'unknown',
    callId: params.callId,
    decision: params.decision || 'unknown',
    source: params.source || 'unknown',
    isApproved:
      params.decision === 'approved' ||
      params.decision === 'approved_for_session' ||
      params.decision === 'accept',
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized tool result event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createToolResultEvent(params) {
  return {
    type: EventType.TOOL_RESULT,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    toolName: params.toolName || 'unknown',
    callId: params.callId,
    success: params.success !== false,
    durationMs: params.durationMs || 0,
    arguments: params.arguments,
    output: params.output,
    error: params.error,
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized file operation event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createFileOperationEvent(params) {
  return {
    type: EventType.FILE_OPERATION,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    toolName: params.toolName || 'file',
    operation: params.operation || 'unknown', // create, read, update
    lines: params.lines || 0,
    mimetype: params.mimetype,
    extension: params.extension,
    programmingLanguage: params.programmingLanguage,
    metadata: params.metadata || {},
  }
}

/**
 * Create a normalized agent lifecycle event
 * @param {Object} params - Event parameters
 * @returns {Object} Normalized event
 */
function createAgentLifecycleEvent(params) {
  return {
    type: EventType.AGENT_LIFECYCLE,
    timestamp: params.timestamp || new Date().toISOString(),
    sessionId: params.sessionId,
    agentName: params.agentName || 'default',
    lifecycle: params.lifecycle || 'unknown', // start, finish
    durationMs: params.durationMs || 0,
    turns: params.turns || 0,
    terminationReason: params.terminationReason,
    metadata: params.metadata || {},
  }
}

module.exports = {
  EventType,
  createConversationStartEvent,
  createUserPromptEvent,
  createApiRequestEvent,
  createApiErrorEvent,
  createGenerationEvent,
  createToolDecisionEvent,
  createToolResultEvent,
  createFileOperationEvent,
  createAgentLifecycleEvent,
}
