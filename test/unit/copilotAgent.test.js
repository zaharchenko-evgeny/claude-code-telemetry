/**
 * Copilot Agent Unit Tests
 */

const CopilotAgent = require('../../src/agents/copilotAgent')
const { EventType } = require('../../src/agents/types')

describe('CopilotAgent', () => {
  describe('static properties', () => {
    test('name returns "copilot"', () => {
      expect(CopilotAgent.name).toBe('copilot')
    })

    test('eventPrefix returns "copilot_cli."', () => {
      expect(CopilotAgent.eventPrefix).toBe('copilot_cli.')
    })

    test('provider returns "github"', () => {
      expect(CopilotAgent.provider).toBe('github')
    })
  })

  describe('canHandle', () => {
    test('returns true for copilot_cli.* events', () => {
      expect(CopilotAgent.canHandle('copilot_cli.run')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.user_prompt')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.generation')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.api_error')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.tool_call')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.usage')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.session.start')).toBe(true)
      expect(CopilotAgent.canHandle('copilot_cli.session.end')).toBe(true)
    })

    test('returns true for copilot.* events (alternative prefix)', () => {
      expect(CopilotAgent.canHandle('copilot.run')).toBe(true)
      expect(CopilotAgent.canHandle('copilot.user_prompt')).toBe(true)
      expect(CopilotAgent.canHandle('copilot.generation')).toBe(true)
    })

    test('returns false for other events', () => {
      expect(CopilotAgent.canHandle('claude_code.user_prompt')).toBe(false)
      expect(CopilotAgent.canHandle('codex.user_prompt')).toBe(false)
      expect(CopilotAgent.canHandle('gemini_cli.user_prompt')).toBe(false)
      expect(CopilotAgent.canHandle('junie_cli.user_prompt')).toBe(false)
      expect(CopilotAgent.canHandle('other.event')).toBe(false)
      expect(CopilotAgent.canHandle(null)).toBeFalsy()
      expect(CopilotAgent.canHandle(undefined)).toBeFalsy()
    })
  })

  describe('extractSessionId', () => {
    test('extracts session.id', () => {
      const attrs = { 'session.id': 'test-session-123' }
      expect(CopilotAgent.extractSessionId(attrs)).toBe('test-session-123')
    })

    test('extracts copilot.session.id as fallback', () => {
      const attrs = { 'copilot.session.id': 'copilot-456' }
      expect(CopilotAgent.extractSessionId(attrs)).toBe('copilot-456')
    })

    test('extracts conversation.id as fallback', () => {
      const attrs = { 'conversation.id': 'conv-789' }
      expect(CopilotAgent.extractSessionId(attrs)).toBe('conv-789')
    })

    test('prefers session.id over other attributes', () => {
      const attrs = {
        'session.id': 'session-id',
        'copilot.session.id': 'copilot-id',
        'conversation.id': 'conv-id',
      }
      expect(CopilotAgent.extractSessionId(attrs)).toBe('session-id')
    })

    test('returns null when no session ID found', () => {
      expect(CopilotAgent.extractSessionId({})).toBeNull()
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

    describe('copilot_cli.run and copilot.run', () => {
      test('processes CLI run event from bridge wrapper', () => {
        const logRecord = createLogRecord('copilot_cli.run', {
          prompt: 'Explain this code',
          output: 'This code does X, Y, Z...',
          duration_s: '2.5',
          exit_code: '0',
          agent: 'explain-agent',
          input_tokens: '100',
          output_tokens: '500',
          cost_usd: '0.01',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          prompt: 'Explain this code',
          output: 'This code does X, Y, Z...',
          duration_s: '2.5',
          exit_code: '0',
          agent: 'explain-agent',
          input_tokens: '100',
          output_tokens: '500',
          cost_usd: '0.01',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('copilot')
        expect(result.durationMs).toBe(2500)
        expect(result.input).toBe('Explain this code')
        expect(result.output).toBe('This code does X, Y, Z...')
        expect(result.tokens.input).toBe(100)
        expect(result.tokens.output).toBe(500)
        expect(result.cost).toBe(0.01)
        expect(result.metadata.agent).toBe('explain-agent')
        expect(result.metadata.exitCode).toBe(0)
        expect(result.metadata.success).toBe(true)
        expect(result.metadata.source).toBe('bridge-wrapper')
      })

      test('handles Langfuse-compatible attributes', () => {
        const logRecord = createLogRecord('copilot.run', {
          'gen_ai.prompt': 'Refactor this function',
          'gen_ai.completion': 'Here is the refactored code...',
          'langfuse.trace.name': 'copilot-cli-run',
          'langfuse.observation.type': 'generation',
          duration_s: '1.5',
          exit_code: '0',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          'gen_ai.prompt': 'Refactor this function',
          'gen_ai.completion': 'Here is the refactored code...',
          'langfuse.trace.name': 'copilot-cli-run',
          'langfuse.observation.type': 'generation',
          duration_s: '1.5',
          exit_code: '0',
        }, mockSession)

        expect(result.input).toBe('Refactor this function')
        expect(result.output).toBe('Here is the refactored code...')
        expect(result.metadata.langfuseTraceName).toBe('copilot-cli-run')
        expect(result.metadata.langfuseObservationType).toBe('generation')
      })

      test('handles failed run (non-zero exit code)', () => {
        const logRecord = createLogRecord('copilot_cli.run', {
          prompt: 'Do something',
          exit_code: '1',
          stderr: 'Error: Command failed',
          duration_s: '0.5',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          prompt: 'Do something',
          exit_code: '1',
          stderr: 'Error: Command failed',
          duration_s: '0.5',
        }, mockSession)

        expect(result.metadata.exitCode).toBe(1)
        expect(result.metadata.success).toBe(false)
        expect(result.metadata.stderr).toBe('Error: Command failed')
      })
    })

    describe('copilot_cli.user_prompt', () => {
      test('processes user prompt event', () => {
        const logRecord = createLogRecord('copilot_cli.user_prompt', {
          prompt: 'Write a unit test',
          prompt_length: '16',
          agent: 'test-agent',
          'user.id': 'user-123',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          prompt: 'Write a unit test',
          prompt_length: '16',
          agent: 'test-agent',
          'user.id': 'user-123',
        }, mockSession)

        expect(result.type).toBe(EventType.USER_PROMPT)
        expect(result.prompt).toBe('Write a unit test')
        expect(result.promptLength).toBe(16)
        expect(result.metadata.agent).toBe('test-agent')
      })

      test('calculates prompt length from prompt if not provided', () => {
        const logRecord = createLogRecord('copilot.user_prompt', {
          prompt: 'Hello world',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          prompt: 'Hello world',
        }, mockSession)

        expect(result.promptLength).toBe(11) // 'Hello world'.length
      })
    })

    describe('copilot_cli.generation', () => {
      test('processes generation event', () => {
        const logRecord = createLogRecord('copilot_cli.generation', {
          model: 'gpt-4',
          duration_ms: '3000',
          input_tokens: '200',
          output_tokens: '800',
          cost_usd: '0.05',
          response_text: 'Generated response here...',
          finish_reason: 'stop',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          model: 'gpt-4',
          duration_ms: '3000',
          input_tokens: '200',
          output_tokens: '800',
          cost_usd: '0.05',
          response_text: 'Generated response here...',
          finish_reason: 'stop',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('gpt-4')
        expect(result.durationMs).toBe(3000)
        expect(result.tokens.input).toBe(200)
        expect(result.tokens.output).toBe(800)
        expect(result.cost).toBe(0.05)
        expect(result.output).toBe('Generated response here...')
        expect(result.metadata.finishReason).toBe('stop')
      })

      test('handles gen_ai.usage.* attributes', () => {
        const logRecord = createLogRecord('copilot.generation', {
          model: 'gpt-4',
          'gen_ai.usage.input_tokens': '150',
          'gen_ai.usage.output_tokens': '400',
          'gen_ai.completion': 'Completion text...',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          model: 'gpt-4',
          'gen_ai.usage.input_tokens': '150',
          'gen_ai.usage.output_tokens': '400',
          'gen_ai.completion': 'Completion text...',
        }, mockSession)

        expect(result.tokens.input).toBe(150)
        expect(result.tokens.output).toBe(400)
        expect(result.output).toBe('Completion text...')
      })
    })

    describe('copilot_cli.api_error', () => {
      test('processes API error event', () => {
        const logRecord = createLogRecord('copilot_cli.api_error', {
          error: 'Rate limit exceeded',
          error_type: 'RateLimitError',
          status_code: '429',
          duration_ms: '100',
          model: 'gpt-4',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          error: 'Rate limit exceeded',
          error_type: 'RateLimitError',
          status_code: '429',
          duration_ms: '100',
          model: 'gpt-4',
        }, mockSession)

        expect(result.type).toBe(EventType.API_ERROR)
        expect(result.errorMessage).toBe('Rate limit exceeded')
        expect(result.statusCode).toBe(429)
        expect(result.durationMs).toBe(100)
        expect(result.metadata.errorType).toBe('RateLimitError')
      })
    })

    describe('copilot_cli.tool_call', () => {
      test('processes tool call event', () => {
        const logRecord = createLogRecord('copilot_cli.tool_call', {
          tool_name: 'search_code',
          tool_args: '{"query": "function main"}',
          duration_ms: '250',
          success: 'true',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          tool_name: 'search_code',
          tool_args: '{"query": "function main"}',
          duration_ms: '250',
          success: 'true',
        }, mockSession)

        expect(result.type).toBe(EventType.TOOL_RESULT)
        expect(result.toolName).toBe('search_code')
        expect(result.success).toBe(true)
        expect(result.durationMs).toBe(250)
        expect(result.arguments).toEqual({ query: 'function main' })
      })

      test('handles failed tool call', () => {
        const logRecord = createLogRecord('copilot.tool_call', {
          tool_name: 'file_write',
          success: 'false',
          error: 'File not found',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          tool_name: 'file_write',
          success: 'false',
          error: 'File not found',
        }, mockSession)

        expect(result.success).toBe(false)
        expect(result.error).toBe('File not found')
      })
    })

    describe('copilot_cli.usage', () => {
      test('processes usage statistics event', () => {
        const logRecord = createLogRecord('copilot_cli.usage', {
          premium_requests: '25',
          session_duration_s: '1800',
          lines_edited: '500',
          token_breakdown: '{"input": 10000, "output": 50000}',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          premium_requests: '25',
          session_duration_s: '1800',
          lines_edited: '500',
          token_breakdown: '{"input": 10000, "output": 50000}',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('copilot')
        expect(result.durationMs).toBe(1800000)
        expect(result.tokens.input).toBe(10000)
        expect(result.tokens.output).toBe(50000)
        expect(result.metadata.premiumRequests).toBe(25)
        expect(result.metadata.linesEdited).toBe(500)
        expect(result.metadata.source).toBe('usage-command')
      })
    })

    describe('copilot_cli.session.start', () => {
      test('processes session start event', () => {
        const logRecord = createLogRecord('copilot_cli.session.start', {
          agent: 'code-assist',
          model: 'gpt-4-turbo',
          'user.id': 'user-123',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          agent: 'code-assist',
          model: 'gpt-4-turbo',
          'user.id': 'user-123',
        }, mockSession)

        expect(result.type).toBe(EventType.CONVERSATION_START)
        expect(result.config.provider).toBe('github')
        expect(result.config.model).toBe('gpt-4-turbo')
        expect(result.config.agent).toBe('code-assist')
      })
    })

    describe('copilot_cli.session.end', () => {
      test('processes session end event', () => {
        const logRecord = createLogRecord('copilot_cli.session.end', {
          agent: 'code-assist',
          duration_ms: '60000',
          premium_requests: '10',
          termination_reason: 'user_exit',
        })

        const result = CopilotAgent.processEvent(logRecord, {
          agent: 'code-assist',
          duration_ms: '60000',
          premium_requests: '10',
          termination_reason: 'user_exit',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('code-assist')
        expect(result.lifecycle).toBe('finish')
        expect(result.durationMs).toBe(60000)
        expect(result.terminationReason).toBe('user_exit')
        expect(result.metadata.premiumRequests).toBe(10)
      })
    })

    describe('unknown events', () => {
      test('returns null for unknown events', () => {
        const logRecord = createLogRecord('unknown.event', {})

        const result = CopilotAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })

      test('returns null for non-copilot events', () => {
        const logRecord = createLogRecord('claude_code.user_prompt', {})

        const result = CopilotAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })
    })
  })
})
