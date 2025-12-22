/**
 * ACP Agent Unit Tests
 */

const ACPAgent = require('../../src/agents/acpAgent')
const { EventType } = require('../../src/agents/types')

describe('ACPAgent', () => {
  describe('static properties', () => {
    test('name returns "acp"', () => {
      expect(ACPAgent.name).toBe('acp')
    })

    test('eventPrefix returns "acp."', () => {
      expect(ACPAgent.eventPrefix).toBe('acp.')
    })

    test('provider returns "acp"', () => {
      expect(ACPAgent.provider).toBe('acp')
    })
  })

  describe('canHandle', () => {
    test('returns true for acp.* events', () => {
      expect(ACPAgent.canHandle('acp.initialize')).toBe(true)
      expect(ACPAgent.canHandle('acp.session.create')).toBe(true)
      expect(ACPAgent.canHandle('acp.session.resume')).toBe(true)
      expect(ACPAgent.canHandle('acp.session.end')).toBe(true)
      expect(ACPAgent.canHandle('acp.message.handle')).toBe(true)
      expect(ACPAgent.canHandle('acp.request')).toBe(true)
      expect(ACPAgent.canHandle('acp.response')).toBe(true)
      expect(ACPAgent.canHandle('acp.error')).toBe(true)
    })

    test('returns true for llm.* events', () => {
      expect(ACPAgent.canHandle('llm.generate')).toBe(true)
      expect(ACPAgent.canHandle('llm.completion')).toBe(true)
      expect(ACPAgent.canHandle('llm.chat')).toBe(true)
    })

    test('returns true for tool.* events', () => {
      expect(ACPAgent.canHandle('tool.call')).toBe(true)
      expect(ACPAgent.canHandle('tool.execute')).toBe(true)
    })

    test('returns false for other events', () => {
      expect(ACPAgent.canHandle('claude_code.user_prompt')).toBe(false)
      expect(ACPAgent.canHandle('codex.user_prompt')).toBe(false)
      expect(ACPAgent.canHandle('gemini_cli.user_prompt')).toBe(false)
      expect(ACPAgent.canHandle('other.event')).toBe(false)
      expect(ACPAgent.canHandle(null)).toBeFalsy()
      expect(ACPAgent.canHandle(undefined)).toBeFalsy()
    })
  })

  describe('extractSessionId', () => {
    test('extracts acp.session_id', () => {
      const attrs = { 'acp.session_id': 'acp-session-123' }
      expect(ACPAgent.extractSessionId(attrs)).toBe('acp-session-123')
    })

    test('extracts session.id as fallback', () => {
      const attrs = { 'session.id': 'session-456' }
      expect(ACPAgent.extractSessionId(attrs)).toBe('session-456')
    })

    test('extracts acp.request_id as fallback', () => {
      const attrs = { 'acp.request_id': 'req-789' }
      expect(ACPAgent.extractSessionId(attrs)).toBe('req-789')
    })

    test('prefers acp.session_id over other attributes', () => {
      const attrs = {
        'acp.session_id': 'acp-session-id',
        'session.id': 'session-id',
        'acp.request_id': 'request-id',
      }
      expect(ACPAgent.extractSessionId(attrs)).toBe('acp-session-id')
    })

    test('returns null when no session ID found', () => {
      expect(ACPAgent.extractSessionId({})).toBeNull()
    })
  })

  describe('processEvent', () => {
    const mockSession = {
      sessionId: 'test-session',
      metadata: {},
    }

    const createLogRecord = (eventName, attrs = {}) => ({
      body: { stringValue: eventName },
      timeUnixNano: Date.now() * 1000000,
      attributes: Object.entries(attrs).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
    })

    describe('acp.initialize', () => {
      test('processes initialization event', () => {
        const logRecord = createLogRecord('acp.initialize', {
          'agent.name': 'my-acp-agent',
          'agent.version': '1.0.0',
          'client.name': 'vscode',
          'protocol.version': '1.0',
        })

        const result = ACPAgent.processEvent(logRecord, {
          'agent.name': 'my-acp-agent',
          'agent.version': '1.0.0',
          'client.name': 'vscode',
          'protocol.version': '1.0',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('my-acp-agent')
        expect(result.lifecycle).toBe('start')
        expect(result.metadata.agentVersion).toBe('1.0.0')
        expect(result.metadata.clientName).toBe('vscode')
        expect(result.metadata.protocolVersion).toBe('1.0')
      })
    })

    describe('acp.session.create', () => {
      test('processes session creation event', () => {
        const logRecord = createLogRecord('acp.session.create', {
          'acp.session_id': 'sess-123',
          'agent.name': 'coding-agent',
          model: 'gpt-4',
          capabilities: '{"tools": true, "streaming": true}',
        })

        const result = ACPAgent.processEvent(logRecord, {
          'acp.session_id': 'sess-123',
          'agent.name': 'coding-agent',
          model: 'gpt-4',
          capabilities: '{"tools": true, "streaming": true}',
        }, mockSession)

        expect(result.type).toBe(EventType.CONVERSATION_START)
        expect(result.config.provider).toBe('acp')
        expect(result.config.model).toBe('gpt-4')
        expect(result.config.acpSessionId).toBe('sess-123')
        expect(result.config.agentName).toBe('coding-agent')
        expect(result.config.capabilities).toEqual({ tools: true, streaming: true })
      })
    })

    describe('acp.session.resume', () => {
      test('processes session resume event', () => {
        const logRecord = createLogRecord('acp.session.resume', {
          'acp.session_id': 'sess-123',
          'agent.name': 'coding-agent',
        })

        const result = ACPAgent.processEvent(logRecord, {
          'acp.session_id': 'sess-123',
          'agent.name': 'coding-agent',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('coding-agent')
        expect(result.lifecycle).toBe('start')
        expect(result.metadata.eventType).toBe('resume')
      })
    })

    describe('acp.session.end', () => {
      test('processes session end event', () => {
        const logRecord = createLogRecord('acp.session.end', {
          'acp.session_id': 'sess-123',
          'agent.name': 'coding-agent',
          duration_ms: '60000',
          termination_reason: 'user_exit',
        })

        const result = ACPAgent.processEvent(logRecord, {
          'acp.session_id': 'sess-123',
          'agent.name': 'coding-agent',
          duration_ms: '60000',
          termination_reason: 'user_exit',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('coding-agent')
        expect(result.lifecycle).toBe('finish')
        expect(result.durationMs).toBe(60000)
        expect(result.terminationReason).toBe('user_exit')
      })
    })

    describe('acp.message.handle', () => {
      test('processes message handling event', () => {
        const logRecord = createLogRecord('acp.message.handle', {
          method: 'completion',
          'acp.request_id': 'req-456',
          duration_ms: '1500',
          success: 'true',
        })

        const result = ACPAgent.processEvent(logRecord, {
          method: 'completion',
          'acp.request_id': 'req-456',
          duration_ms: '1500',
          success: 'true',
        }, mockSession)

        expect(result.type).toBe(EventType.API_REQUEST)
        expect(result.durationMs).toBe(1500)
        expect(result.statusCode).toBe(200)
        expect(result.success).toBe(true)
        expect(result.requestId).toBe('req-456')
        expect(result.metadata.method).toBe('completion')
      })

      test('handles failed message', () => {
        const logRecord = createLogRecord('acp.message.handle', {
          method: 'completion',
          'acp.request_id': 'req-456',
          success: 'false',
          status_code: '500',
        })

        const result = ACPAgent.processEvent(logRecord, {
          method: 'completion',
          'acp.request_id': 'req-456',
          success: 'false',
          status_code: '500',
        }, mockSession)

        expect(result.statusCode).toBe(500)
        expect(result.success).toBe(false)
      })
    })

    describe('acp.request', () => {
      test('processes request event', () => {
        const logRecord = createLogRecord('acp.request', {
          method: 'chat.completion',
          'acp.request_id': 'req-789',
          prompt: 'Write a function to sort an array',
          prompt_length: '35',
          'user.id': 'user-123',
        })

        const result = ACPAgent.processEvent(logRecord, {
          method: 'chat.completion',
          'acp.request_id': 'req-789',
          prompt: 'Write a function to sort an array',
          prompt_length: '35',
          'user.id': 'user-123',
        }, mockSession)

        expect(result.type).toBe(EventType.USER_PROMPT)
        expect(result.prompt).toBe('Write a function to sort an array')
        expect(result.promptLength).toBe(35)
        expect(result.metadata.method).toBe('chat.completion')
        expect(result.metadata.requestId).toBe('req-789')
      })

      test('extracts prompt from params JSON', () => {
        const logRecord = createLogRecord('acp.request', {
          method: 'chat.completion',
          params: '{"prompt": "Help me debug this code"}',
        })

        const result = ACPAgent.processEvent(logRecord, {
          method: 'chat.completion',
          params: '{"prompt": "Help me debug this code"}',
        }, mockSession)

        expect(result.prompt).toBe('Help me debug this code')
      })
    })

    describe('acp.response', () => {
      test('processes response event', () => {
        const logRecord = createLogRecord('acp.response', {
          method: 'chat.completion',
          'acp.request_id': 'req-789',
          duration_ms: '2000',
          result: '{"text": "Here is the sorted array..."}',
        })

        const result = ACPAgent.processEvent(logRecord, {
          method: 'chat.completion',
          'acp.request_id': 'req-789',
          duration_ms: '2000',
          result: '{"text": "Here is the sorted array..."}',
        }, mockSession)

        expect(result.type).toBe(EventType.API_REQUEST)
        expect(result.durationMs).toBe(2000)
        expect(result.statusCode).toBe(200)
        expect(result.success).toBe(true)
        expect(result.metadata.hasResult).toBe(true)
      })
    })

    describe('acp.error', () => {
      test('processes error event', () => {
        const logRecord = createLogRecord('acp.error', {
          error_message: 'Context window exceeded',
          error_code: '400',
          method: 'chat.completion',
          'acp.request_id': 'req-789',
          duration_ms: '500',
        })

        const result = ACPAgent.processEvent(logRecord, {
          error_message: 'Context window exceeded',
          error_code: '400',
          method: 'chat.completion',
          'acp.request_id': 'req-789',
          duration_ms: '500',
        }, mockSession)

        expect(result.type).toBe(EventType.API_ERROR)
        expect(result.errorMessage).toBe('Context window exceeded')
        expect(result.statusCode).toBe(400)
        expect(result.durationMs).toBe(500)
        expect(result.metadata.method).toBe('chat.completion')
      })
    })

    describe('llm.generate', () => {
      test('processes LLM generation event', () => {
        const logRecord = createLogRecord('llm.generate', {
          model: 'gpt-4',
          duration_ms: '3000',
          input_tokens: '500',
          output_tokens: '1000',
          cost_usd: '0.05',
          finish_reason: 'stop',
        })

        const result = ACPAgent.processEvent(logRecord, {
          model: 'gpt-4',
          duration_ms: '3000',
          input_tokens: '500',
          output_tokens: '1000',
          cost_usd: '0.05',
          finish_reason: 'stop',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('gpt-4')
        expect(result.durationMs).toBe(3000)
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.output).toBe(1000)
        expect(result.cost).toBe(0.05)
        expect(result.metadata.finishReason).toBe('stop')
      })

      test('handles llm.model attribute', () => {
        const logRecord = createLogRecord('llm.completion', {
          'llm.model': 'claude-3-opus',
          'llm.input_tokens': '200',
          'llm.output_tokens': '800',
        })

        const result = ACPAgent.processEvent(logRecord, {
          'llm.model': 'claude-3-opus',
          'llm.input_tokens': '200',
          'llm.output_tokens': '800',
        }, mockSession)

        expect(result.model).toBe('claude-3-opus')
        expect(result.tokens.input).toBe(200)
        expect(result.tokens.output).toBe(800)
      })

      test('handles gen_ai.usage.* attributes', () => {
        const logRecord = createLogRecord('llm.chat', {
          model: 'gpt-4',
          'gen_ai.usage.input_tokens': '300',
          'gen_ai.usage.output_tokens': '600',
          'gen_ai.completion': 'Here is the response...',
        })

        const result = ACPAgent.processEvent(logRecord, {
          model: 'gpt-4',
          'gen_ai.usage.input_tokens': '300',
          'gen_ai.usage.output_tokens': '600',
          'gen_ai.completion': 'Here is the response...',
        }, mockSession)

        expect(result.tokens.input).toBe(300)
        expect(result.tokens.output).toBe(600)
        expect(result.output).toBe('Here is the response...')
      })
    })

    describe('tool.call', () => {
      test('processes tool call event', () => {
        const logRecord = createLogRecord('tool.call', {
          tool_name: 'file_read',
          tool_args: '{"path": "/src/main.js"}',
          duration_ms: '100',
          success: 'true',
          output: 'File contents here...',
        })

        const result = ACPAgent.processEvent(logRecord, {
          tool_name: 'file_read',
          tool_args: '{"path": "/src/main.js"}',
          duration_ms: '100',
          success: 'true',
          output: 'File contents here...',
        }, mockSession)

        expect(result.type).toBe(EventType.TOOL_RESULT)
        expect(result.toolName).toBe('file_read')
        expect(result.success).toBe(true)
        expect(result.durationMs).toBe(100)
        expect(result.arguments).toEqual({ path: '/src/main.js' })
        expect(result.output).toBe('File contents here...')
      })

      test('handles tool.execute event', () => {
        const logRecord = createLogRecord('tool.execute', {
          'tool.name': 'bash',
          'tool.args': '{"command": "ls -la"}',
          success: 'true',
        })

        const result = ACPAgent.processEvent(logRecord, {
          'tool.name': 'bash',
          'tool.args': '{"command": "ls -la"}',
          success: 'true',
        }, mockSession)

        expect(result.type).toBe(EventType.TOOL_RESULT)
        expect(result.toolName).toBe('bash')
        expect(result.arguments).toEqual({ command: 'ls -la' })
      })

      test('handles failed tool call', () => {
        const logRecord = createLogRecord('tool.call', {
          tool_name: 'file_write',
          success: 'false',
          error: 'Permission denied',
        })

        const result = ACPAgent.processEvent(logRecord, {
          tool_name: 'file_write',
          success: 'false',
          error: 'Permission denied',
        }, mockSession)

        expect(result.success).toBe(false)
        expect(result.error).toBe('Permission denied')
      })
    })

    describe('trace context propagation', () => {
      test('includes trace context from _meta attributes', () => {
        const logRecord = createLogRecord('acp.request', {
          method: 'completion',
          '_meta.traceparent': '00-1234567890abcdef-1234567890ab-01',
          '_meta.tracestate': 'vendor=value',
          '_meta.baggage': 'key1=value1',
        })

        const result = ACPAgent.processEvent(logRecord, {
          method: 'completion',
          '_meta.traceparent': '00-1234567890abcdef-1234567890ab-01',
          '_meta.tracestate': 'vendor=value',
          '_meta.baggage': 'key1=value1',
        }, mockSession)

        expect(result.metadata.traceparent).toBe('00-1234567890abcdef-1234567890ab-01')
        expect(result.metadata.tracestate).toBe('vendor=value')
        expect(result.metadata.baggage).toBe('key1=value1')
      })
    })

    describe('unknown events', () => {
      test('returns null for unknown non-acp events', () => {
        const logRecord = createLogRecord('other.event', {})

        const result = ACPAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })

      test('returns null for non-acp events', () => {
        const logRecord = createLogRecord('claude_code.user_prompt', {})

        const result = ACPAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })

      test('handles unknown acp.* events gracefully', () => {
        const logRecord = createLogRecord('acp.unknown.event', {})

        const result = ACPAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })
    })
  })
})
