// Mock dependencies before requiring the module
jest.mock('langfuse', () => ({
  Langfuse: jest.fn().mockImplementation(() => ({
    trace: jest.fn().mockReturnValue({ id: 'mock-trace-id', update: jest.fn() }),
    generation: jest.fn().mockReturnValue({ id: 'mock-gen-id' }),
    event: jest.fn(),
    flushAsync: jest.fn(() => Promise.resolve()),
  })),
}))

jest.mock('../../src/sessionHandler', () => ({
  SessionHandler: jest.fn().mockImplementation(() => ({
    sessionId: 'test-codex-session',
    handleUserPrompt: jest.fn(),
    handleApiRequest: jest.fn(),
    handleApiError: jest.fn(),
    handleToolResult: jest.fn(),
    handleToolDecision: jest.fn(),
  })),
  extractAttributesArray: (attrs) => {
    const result = {}
    if (attrs && Array.isArray(attrs)) {
      attrs.forEach(attr => {
        const key = attr.key
        const value = attr.value?.stringValue ||
                     attr.value?.intValue ||
                     attr.value?.doubleValue ||
                     attr.value?.boolValue
        if (key && value !== undefined) {
          result[key] = value
        }
      })
    }
    return result
  },
}))

const {
  isCodexEvent,
  extractCodexSessionId,
  processCodexEvent,
  calculateCost,
  TOKEN_PRICING,
} = require('../../src/codexEventProcessor')

describe('Codex Event Processor', () => {
  let mockSession
  let mockLangfuse

  beforeEach(() => {
    mockLangfuse = {
      trace: jest.fn().mockReturnValue({ id: 'mock-trace-id', update: jest.fn() }),
      generation: jest.fn().mockReturnValue({ id: 'mock-gen-id' }),
      event: jest.fn(),
      flushAsync: jest.fn(() => Promise.resolve()),
    }

    mockSession = {
      sessionId: 'test-codex-session',
      langfuse: mockLangfuse,
      langfuseConfig: { tags: [], traceName: null, metadata: null },
      metadata: { userId: 'test-user' },
      conversationCount: 0,
      apiCallCount: 0,
      toolCallCount: 0,
      totalTokens: 0,
      totalCost: 0,
    }
  })

  describe('isCodexEvent', () => {
    test('returns true for codex events', () => {
      expect(isCodexEvent('codex.conversation_starts')).toBe(true)
      expect(isCodexEvent('codex.user_prompt')).toBe(true)
      expect(isCodexEvent('codex.api_request')).toBe(true)
      expect(isCodexEvent('codex.sse_event')).toBe(true)
      expect(isCodexEvent('codex.tool_decision')).toBe(true)
      expect(isCodexEvent('codex.tool_result')).toBe(true)
    })

    test('returns false for non-codex events', () => {
      expect(isCodexEvent('claude_code.user_prompt')).toBe(false)
      expect(isCodexEvent('claude_code.api_request')).toBe(false)
      expect(isCodexEvent('')).toBe(false)
      expect(isCodexEvent(null)).toBe(false)
      expect(isCodexEvent(undefined)).toBe(false)
    })
  })

  describe('extractCodexSessionId', () => {
    test('extracts conversation.id', () => {
      expect(extractCodexSessionId({ 'conversation.id': 'conv-123' })).toBe('conv-123')
    })

    test('extracts codex.conversation.id', () => {
      expect(extractCodexSessionId({ 'codex.conversation.id': 'conv-456' })).toBe('conv-456')
    })

    test('returns null when no session ID found', () => {
      expect(extractCodexSessionId({})).toBeNull()
      expect(extractCodexSessionId({ 'session.id': 'wrong' })).toBeNull()
    })
  })

  describe('calculateCost', () => {
    test('calculates cost for gpt-4o', () => {
      const cost = calculateCost('gpt-4o', 1000, 500, 0, 0)
      // 1000 input tokens at $2.5/1M = $0.0025
      // 500 output tokens at $10/1M = $0.005
      expect(cost).toBeCloseTo(0.0075, 5)
    })

    test('calculates cost with cached tokens', () => {
      const cost = calculateCost('gpt-4o', 1000, 500, 200, 0)
      // 1000 input at $2.5/1M = $0.0025
      // 500 output at $10/1M = $0.005
      // 200 cached at $1.25/1M = $0.00025
      expect(cost).toBeCloseTo(0.00775, 5)
    })

    test('calculates cost with reasoning tokens', () => {
      const cost = calculateCost('o1', 1000, 500, 0, 300)
      // 1000 input at $15/1M = $0.015
      // (500 + 300) output at $60/1M = $0.048
      expect(cost).toBeCloseTo(0.063, 5)
    })

    test('uses default pricing for unknown models', () => {
      const cost = calculateCost('unknown-model', 1000000, 1000000, 0, 0)
      // 1M input at $5/1M = $5
      // 1M output at $15/1M = $15
      expect(cost).toBe(20)
    })
  })

  describe('processCodexEvent', () => {
    describe('codex.conversation_starts', () => {
      test('processes conversation starts event', () => {
        const logRecord = {
          body: { stringValue: 'codex.conversation_starts' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'provider_name', value: { stringValue: 'openai' } },
            { key: 'model', value: { stringValue: 'gpt-4o' } },
            { key: 'approval_policy', value: { stringValue: 'suggest' } },
            { key: 'sandbox_policy', value: { stringValue: 'network-only' } },
            { key: 'context_window', value: { stringValue: '128000' } },
            { key: 'max_output_tokens', value: { stringValue: '16384' } },
            { key: 'app.version', value: { stringValue: '0.53.0' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result).toEqual({
          type: 'conversation_starts',
          config: {
            providerName: 'openai',
            reasoningEffort: undefined,
            reasoningSummary: undefined,
            contextWindow: 128000,
            maxOutputTokens: 16384,
            autoCompactTokenLimit: 0,
            approvalPolicy: 'suggest',
            sandboxPolicy: 'network-only',
            mcpServers: [],
            activeProfile: undefined,
          },
          conversationId: 'conv-123',
          userAccountId: undefined,
          authMode: undefined,
          terminalType: undefined,
          appVersion: '0.53.0',
          model: 'gpt-4o',
          slug: undefined,
          environment: 'dev',
          timestamp: expect.any(String),
        })

        expect(mockSession.conversationCount).toBe(1)
        expect(mockSession.codexConfig).toBeDefined()
        expect(mockLangfuse.trace).toHaveBeenCalled()
      })
    })

    describe('codex.user_prompt', () => {
      test('processes user prompt event', () => {
        const logRecord = {
          body: { stringValue: 'codex.user_prompt' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'prompt_length', value: { stringValue: '42' } },
            { key: 'prompt', value: { stringValue: 'Test prompt' } },
            { key: 'model', value: { stringValue: 'gpt-4o' } },
            { key: 'user.account_id', value: { stringValue: 'user-123' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result).toEqual({
          type: 'user_prompt',
          prompt: 'Test prompt',
          promptLength: 42,
          conversationId: 'conv-123',
          userAccountId: 'user-123',
          authMode: undefined,
          terminalType: undefined,
          appVersion: undefined,
          model: 'gpt-4o',
          slug: undefined,
          environment: 'dev',
          timestamp: expect.any(String),
        })
      })

      test('handles hidden prompts', () => {
        const logRecord = {
          body: { stringValue: 'codex.user_prompt' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'prompt_length', value: { stringValue: '100' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.prompt).toBe('')
        expect(result.promptLength).toBe(100)
      })
    })

    describe('codex.api_request', () => {
      test('processes api request event', () => {
        const logRecord = {
          body: { stringValue: 'codex.api_request' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'attempt', value: { stringValue: '1' } },
            { key: 'duration_ms', value: { stringValue: '1500' } },
            { key: 'http.response.status_code', value: { stringValue: '200' } },
            { key: 'model', value: { stringValue: 'gpt-4o' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result).toEqual({
          type: 'api_request',
          attempt: 1,
          durationMs: 1500,
          statusCode: 200,
          errorMessage: undefined,
          isSuccess: true,
          conversationId: 'conv-123',
          userAccountId: undefined,
          authMode: undefined,
          terminalType: undefined,
          appVersion: undefined,
          model: 'gpt-4o',
          slug: undefined,
          environment: 'dev',
          timestamp: expect.any(String),
        })

        expect(mockSession.apiCallCount).toBe(1)
      })

      test('processes api request error', () => {
        const logRecord = {
          body: { stringValue: 'codex.api_request' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'attempt', value: { stringValue: '3' } },
            { key: 'duration_ms', value: { stringValue: '500' } },
            { key: 'http.response.status_code', value: { stringValue: '429' } },
            { key: 'error.message', value: { stringValue: 'Rate limit exceeded' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.isSuccess).toBe(false)
        expect(result.errorMessage).toBe('Rate limit exceeded')
        expect(result.statusCode).toBe(429)
        expect(result.attempt).toBe(3)
      })
    })

    describe('codex.sse_event', () => {
      test('processes sse event with token counts', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.sse_event' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'event.kind', value: { stringValue: 'response' } },
            { key: 'duration_ms', value: { stringValue: '2000' } },
            { key: 'input_token_count', value: { stringValue: '1000' } },
            { key: 'output_token_count', value: { stringValue: '500' } },
            { key: 'cached_token_count', value: { stringValue: '200' } },
            { key: 'reasoning_token_count', value: { stringValue: '0' } },
            { key: 'tool_token_count', value: { stringValue: '50' } },
            { key: 'model', value: { stringValue: 'gpt-4o' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result).toEqual({
          type: 'sse_event',
          eventKind: 'response',
          durationMs: 2000,
          errorMessage: undefined,
          tokens: {
            input: 1000,
            output: 500,
            cached: 200,
            reasoning: 0,
            tool: 50,
            total: 1750,
          },
          cost: expect.any(Number),
          conversationId: 'conv-123',
          userAccountId: undefined,
          authMode: undefined,
          terminalType: undefined,
          appVersion: undefined,
          model: 'gpt-4o',
          slug: undefined,
          environment: 'dev',
          timestamp: expect.any(String),
        })

        // Check session metrics updated
        expect(mockSession.totalTokens).toBe(1750)
        expect(mockSession.totalCost).toBeGreaterThan(0)
        expect(mockSession.tokenBreakdown).toEqual({
          input: 1000,
          output: 500,
          cached: 200,
          reasoning: 0,
          tool: 50,
        })

        // Check Langfuse generation was created
        expect(mockLangfuse.generation).toHaveBeenCalled()
      })

      test('handles sse event with error', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.sse_event' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'event.kind', value: { stringValue: 'error' } },
            { key: 'error.message', value: { stringValue: 'Connection timeout' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.errorMessage).toBe('Connection timeout')
        expect(result.eventKind).toBe('error')
      })
    })

    describe('codex.tool_decision', () => {
      test('processes tool decision - approved', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.tool_decision' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'tool_name', value: { stringValue: 'shell' } },
            { key: 'call_id', value: { stringValue: 'call-456' } },
            { key: 'decision', value: { stringValue: 'approved' } },
            { key: 'source', value: { stringValue: 'user' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result).toEqual({
          type: 'tool_decision',
          toolName: 'shell',
          callId: 'call-456',
          decision: 'approved',
          source: 'user',
          isApproved: true,
          conversationId: 'conv-123',
          userAccountId: undefined,
          authMode: undefined,
          terminalType: undefined,
          appVersion: undefined,
          model: undefined,
          slug: undefined,
          environment: 'dev',
          timestamp: expect.any(String),
        })

        expect(mockSession.toolDecisions).toHaveLength(1)
        expect(mockLangfuse.event).toHaveBeenCalled()
      })

      test('processes tool decision - denied', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.tool_decision' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'tool_name', value: { stringValue: 'shell' } },
            { key: 'decision', value: { stringValue: 'denied' } },
            { key: 'source', value: { stringValue: 'config' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.isApproved).toBe(false)
        expect(result.decision).toBe('denied')
      })

      test('processes tool decision - approved_for_session', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.tool_decision' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'tool_name', value: { stringValue: 'file_read' } },
            { key: 'decision', value: { stringValue: 'approved_for_session' } },
            { key: 'source', value: { stringValue: 'user' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.isApproved).toBe(true)
        expect(result.decision).toBe('approved_for_session')
      })
    })

    describe('codex.tool_result', () => {
      test('processes successful tool result', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.tool_result' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'tool_name', value: { stringValue: 'shell' } },
            { key: 'call_id', value: { stringValue: 'call-456' } },
            { key: 'duration_ms', value: { stringValue: '250' } },
            { key: 'success', value: { stringValue: 'true' } },
            { key: 'output', value: { stringValue: 'Command executed successfully' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result).toEqual({
          type: 'tool_result',
          toolName: 'shell',
          callId: 'call-456',
          success: true,
          durationMs: 250,
          output: 'Command executed successfully',
          arguments: undefined,
          conversationId: 'conv-123',
          userAccountId: undefined,
          authMode: undefined,
          terminalType: undefined,
          appVersion: undefined,
          model: undefined,
          slug: undefined,
          environment: 'dev',
          timestamp: expect.any(String),
        })

        expect(mockSession.toolCallCount).toBe(1)
        expect(mockSession.toolSequence).toHaveLength(1)
        expect(mockLangfuse.event).toHaveBeenCalled()
      })

      test('processes failed tool result', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.tool_result' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'tool_name', value: { stringValue: 'shell' } },
            { key: 'success', value: { stringValue: 'false' } },
            { key: 'output', value: { stringValue: 'Permission denied' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.success).toBe(false)
        expect(result.output).toBe('Permission denied')
      })

      test('handles tool result with arguments', () => {
        mockSession.currentTrace = { id: 'trace-123' }

        const logRecord = {
          body: { stringValue: 'codex.tool_result' },
          timeUnixNano: Date.now() * 1000000,
          attributes: [
            { key: 'conversation.id', value: { stringValue: 'conv-123' } },
            { key: 'tool_name', value: { stringValue: 'file_write' } },
            { key: 'arguments', value: { stringValue: '{"path": "/tmp/test.txt"}' } },
            { key: 'success', value: { stringValue: 'true' } },
          ],
        }

        const result = processCodexEvent(logRecord, {}, mockSession)

        expect(result.arguments).toBe('{"path": "/tmp/test.txt"}')
      })
    })

    test('returns null for unknown event types', () => {
      const logRecord = {
        body: { stringValue: 'codex.unknown_event' },
        timeUnixNano: Date.now() * 1000000,
        attributes: [],
      }

      const result = processCodexEvent(logRecord, {}, mockSession)

      expect(result).toBeNull()
    })
  })

  describe('TOKEN_PRICING', () => {
    test('has pricing for common models', () => {
      expect(TOKEN_PRICING['gpt-4o']).toBeDefined()
      expect(TOKEN_PRICING['gpt-4o-mini']).toBeDefined()
      expect(TOKEN_PRICING['o1']).toBeDefined()
      expect(TOKEN_PRICING['o1-mini']).toBeDefined()
      expect(TOKEN_PRICING['default']).toBeDefined()
    })

    test('pricing has required fields', () => {
      Object.values(TOKEN_PRICING).forEach(pricing => {
        expect(pricing).toHaveProperty('input')
        expect(pricing).toHaveProperty('output')
        expect(pricing).toHaveProperty('cached')
      })
    })
  })
})
