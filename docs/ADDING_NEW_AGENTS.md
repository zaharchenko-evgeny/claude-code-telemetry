# Adding Support for New AI Agents

This guide explains how to add telemetry support for a new AI coding assistant to the claude-code-telemetry bridge.

## Architecture Overview

The telemetry system uses a pluggable agent architecture:

```
OTLP Logs → Agent Registry → Agent Processor → Normalized Events → Langfuse Handler → Langfuse
```

Each AI agent (Claude Code, Codex, etc.) has its own processor that:
1. Detects events by their prefix (e.g., `claude_code.`, `codex.`)
2. Extracts session IDs using agent-specific attribute names
3. Normalizes events to a common format
4. Sends normalized events to Langfuse

## Step-by-Step Guide

### 1. Create Your Agent File

Create a new file in `src/agents/` (e.g., `myAgent.js`):

```javascript
const BaseAgent = require('./baseAgent')
const {
  EventType,
  createUserPromptEvent,
  createGenerationEvent,
  createToolResultEvent,
  // ... other event creators
} = require('./types')

class MyAgent extends BaseAgent {
  // Required: Unique identifier for your agent
  static get name() {
    return 'my-agent'
  }

  // Required: Event prefix used by this agent's telemetry
  static get eventPrefix() {
    return 'my_agent.'
  }

  // Optional: Model provider name (e.g., 'anthropic', 'openai', 'google')
  static get provider() {
    return 'my-provider'
  }

  // Required: Check if this agent can handle an event
  static canHandle(eventName) {
    return eventName && eventName.startsWith('my_agent.')
  }

  // Required: Extract session ID from attributes
  static extractSessionId(attrs) {
    // Return the attribute name your agent uses for session tracking
    return attrs['my.session.id'] || attrs['session.id'] || null
  }

  // Required: Process events and return normalized events
  static processEvent(logRecord, attrs, session) {
    const eventName = logRecord.body?.stringValue
    const timestamp = logRecord.timeUnixNano
      ? new Date(Number(logRecord.timeUnixNano) / 1000000).toISOString()
      : new Date().toISOString()

    const baseMetadata = this.getStandardMetadata(attrs, session)

    switch (eventName) {
      case 'my_agent.user_input':
        return this._processUserInput(attrs, timestamp, session, baseMetadata)

      case 'my_agent.model_response':
        return this._processModelResponse(attrs, timestamp, session, baseMetadata)

      case 'my_agent.tool_call':
        return this._processToolCall(attrs, timestamp, session, baseMetadata)

      default:
        this.logger.debug({ eventName, agent: this.name }, 'Unknown event')
        return null
    }
  }

  // Private helper methods for processing specific events
  static _processUserInput(attrs, timestamp, session, baseMetadata) {
    return createUserPromptEvent({
      timestamp,
      sessionId: session.sessionId,
      userId: attrs['user.id'] || session.metadata?.userId,
      prompt: attrs.input || '',
      promptLength: parseInt(attrs.input_length || '0', 10),
      metadata: baseMetadata,
    })
  }

  static _processModelResponse(attrs, timestamp, session, baseMetadata) {
    return createGenerationEvent({
      timestamp,
      sessionId: session.sessionId,
      model: attrs.model || 'unknown',
      durationMs: parseInt(attrs.duration_ms || '0', 10),
      inputTokens: parseInt(attrs.input_tokens || '0', 10),
      outputTokens: parseInt(attrs.output_tokens || '0', 10),
      cachedTokens: parseInt(attrs.cached_tokens || '0', 10),
      // Use cost provided by the agent - don't calculate
      cost: parseFloat(attrs.cost_usd || attrs.cost || '0'),
      metadata: baseMetadata,
    })
  }

  static _processToolCall(attrs, timestamp, session, baseMetadata) {
    return createToolResultEvent({
      timestamp,
      sessionId: session.sessionId,
      toolName: attrs.tool_name || 'unknown',
      success: attrs.success === 'true' || attrs.success === true,
      durationMs: parseInt(attrs.duration_ms || '0', 10),
      output: attrs.output,
      error: attrs.error,
      metadata: baseMetadata,
    })
  }
}

module.exports = MyAgent
```

### 2. Register Your Agent

Add your agent to the registry in `src/agents/registry.js`:

```javascript
const ClaudeAgent = require('./claudeAgent')
const CodexAgent = require('./codexAgent')
const MyAgent = require('./myAgent')  // Import your agent

// Add to the AGENTS array (order matters - first match wins)
const AGENTS = [ClaudeAgent, CodexAgent, MyAgent]
```

### 3. Export Your Agent (Optional)

If you want users to be able to import your agent directly, add it to `src/agents/index.js`:

```javascript
const MyAgent = require('./myAgent')

module.exports = {
  // ... existing exports
  MyAgent,
}
```

### 4. Test Your Agent

Create a test file at `test/unit/myAgent.test.js`:

```javascript
jest.mock('langfuse', () => ({
  Langfuse: jest.fn().mockImplementation(() => ({
    trace: jest.fn().mockReturnValue({ id: 'mock-trace-id' }),
    generation: jest.fn().mockReturnValue({ id: 'mock-gen-id' }),
    event: jest.fn(),
    flushAsync: jest.fn(() => Promise.resolve()),
  })),
}))

const MyAgent = require('../../src/agents/myAgent')

describe('MyAgent', () => {
  test('canHandle returns true for my_agent events', () => {
    expect(MyAgent.canHandle('my_agent.user_input')).toBe(true)
    expect(MyAgent.canHandle('my_agent.model_response')).toBe(true)
  })

  test('canHandle returns false for other events', () => {
    expect(MyAgent.canHandle('claude_code.user_prompt')).toBe(false)
    expect(MyAgent.canHandle('codex.api_request')).toBe(false)
  })

  test('extractSessionId extracts correct attribute', () => {
    expect(MyAgent.extractSessionId({ 'my.session.id': 'sess-123' })).toBe('sess-123')
    expect(MyAgent.extractSessionId({ 'session.id': 'sess-456' })).toBe('sess-456')
  })

  // Add more tests for processEvent, calculateCost, etc.
})
```

## Available Event Types

The `src/agents/types.js` file provides these event creators:

| Creator | Description | Required Fields |
|---------|-------------|-----------------|
| `createConversationStartEvent` | Session/conversation initialization | `sessionId`, `config` |
| `createUserPromptEvent` | User input | `sessionId`, `promptLength` |
| `createApiRequestEvent` | API call (non-generation) | `sessionId`, `model`, `durationMs` |
| `createApiErrorEvent` | API error | `sessionId`, `errorMessage` |
| `createGenerationEvent` | Token usage/model response | `sessionId`, `model`, `tokens` |
| `createToolDecisionEvent` | Tool approval/rejection | `sessionId`, `toolName`, `decision` |
| `createToolResultEvent` | Tool execution result | `sessionId`, `toolName`, `success` |

## Event Type Constants

```javascript
const { EventType } = require('./types')

EventType.CONVERSATION_START  // 'conversation_start'
EventType.USER_PROMPT         // 'user_prompt'
EventType.API_REQUEST         // 'api_request'
EventType.API_ERROR           // 'api_error'
EventType.GENERATION          // 'generation'
EventType.TOOL_DECISION       // 'tool_decision'
EventType.TOOL_RESULT         // 'tool_result'
```

## Best Practices

1. **Event Detection**: Keep `canHandle()` simple and fast - it's called for every log record
2. **Session ID**: Support multiple attribute names for flexibility
3. **Cost**: Use cost provided by the agent via `cost_usd` or `cost` attribute (don't calculate)
4. **Logging**: Use `this.logger` for consistent logging
5. **Metadata**: Include agent-specific attributes in the metadata object
6. **Error Handling**: Return `null` for unknown events rather than throwing

## Example: Real-World Agent Structure

See the existing implementations for reference:
- `src/agents/claudeAgent.js` - Claude Code CLI
- `src/agents/codexAgent.js` - OpenAI Codex CLI

## Troubleshooting

### Events Not Being Processed

1. Check that `canHandle()` returns `true` for your event prefix
2. Verify your agent is registered in `registry.js`
3. Check the server logs for "Unknown event" messages

### Session Not Creating

1. Verify `extractSessionId()` returns the correct attribute
2. Check that your telemetry includes the session attribute

### Costs Not Showing

1. Ensure your agent's telemetry provides `cost_usd` or `cost` attribute
2. Verify the cost value is a valid number
