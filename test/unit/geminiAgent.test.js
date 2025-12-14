/**
 * Gemini Agent Unit Tests
 */

const GeminiAgent = require('../../src/agents/geminiAgent')
const { EventType } = require('../../src/agents/types')

describe('GeminiAgent', () => {
  describe('static properties', () => {
    test('name returns "gemini"', () => {
      expect(GeminiAgent.name).toBe('gemini')
    })

    test('eventPrefix returns "gemini_cli."', () => {
      expect(GeminiAgent.eventPrefix).toBe('gemini_cli.')
    })

    test('provider returns "google"', () => {
      expect(GeminiAgent.provider).toBe('google')
    })
  })

  describe('canHandle', () => {
    test('returns true for gemini_cli.* events', () => {
      expect(GeminiAgent.canHandle('gemini_cli.config')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.user_prompt')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.api_request')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.api_response')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.api_error')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.tool_call')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.file_operation')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.agent.start')).toBe(true)
      expect(GeminiAgent.canHandle('gemini_cli.agent.finish')).toBe(true)
    })

    test('returns true for gen_ai.* events', () => {
      expect(GeminiAgent.canHandle('gen_ai.client.inference.operation.details')).toBe(true)
    })

    test('returns false for other events', () => {
      expect(GeminiAgent.canHandle('claude_code.user_prompt')).toBe(false)
      expect(GeminiAgent.canHandle('codex.user_prompt')).toBe(false)
      expect(GeminiAgent.canHandle('other.event')).toBe(false)
      expect(GeminiAgent.canHandle(null)).toBeFalsy()
      expect(GeminiAgent.canHandle(undefined)).toBeFalsy()
    })
  })

  describe('extractSessionId', () => {
    test('extracts session.id', () => {
      const attrs = { 'session.id': 'test-session-123' }
      expect(GeminiAgent.extractSessionId(attrs)).toBe('test-session-123')
    })

    test('extracts installation.id as fallback', () => {
      const attrs = { 'installation.id': 'install-456' }
      expect(GeminiAgent.extractSessionId(attrs)).toBe('install-456')
    })

    test('extracts gemini.session.id as fallback', () => {
      const attrs = { 'gemini.session.id': 'gemini-789' }
      expect(GeminiAgent.extractSessionId(attrs)).toBe('gemini-789')
    })

    test('prefers session.id over other attributes', () => {
      const attrs = {
        'session.id': 'session-id',
        'installation.id': 'install-id',
        'gemini.session.id': 'gemini-id',
      }
      expect(GeminiAgent.extractSessionId(attrs)).toBe('session-id')
    })

    test('returns null when no session ID found', () => {
      expect(GeminiAgent.extractSessionId({})).toBeNull()
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

    describe('gemini_cli.config', () => {
      test('processes config event', () => {
        const logRecord = createLogRecord('gemini_cli.config', {
          model: 'gemini-pro',
          sandbox_enabled: 'true',
          approval_mode: 'auto',
          mcp_servers: 'server1, server2',
          extensions: 'ext1, ext2',
          output_format: 'json',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          model: 'gemini-pro',
          sandbox_enabled: 'true',
          approval_mode: 'auto',
          mcp_servers: 'server1, server2',
          extensions: 'ext1, ext2',
          output_format: 'json',
        }, mockSession)

        expect(result.type).toBe(EventType.CONVERSATION_START)
        expect(result.config.model).toBe('gemini-pro')
        expect(result.config.approvalPolicy).toBe('auto')
        expect(result.config.sandboxPolicy).toBe('enabled')
        expect(result.config.mcpServers).toEqual(['server1', 'server2'])
        expect(result.config.extensions).toEqual(['ext1', 'ext2'])
      })

      test('handles config with sandbox disabled', () => {
        const logRecord = createLogRecord('gemini_cli.config', {
          sandbox_enabled: 'false',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          sandbox_enabled: 'false',
        }, mockSession)

        expect(result.config.sandboxPolicy).toBe('disabled')
      })
    })

    describe('gemini_cli.user_prompt', () => {
      test('processes user prompt event', () => {
        const logRecord = createLogRecord('gemini_cli.user_prompt', {
          prompt: 'Hello, Gemini!',
          prompt_length: '14',
          prompt_id: 'prompt-123',
          'user.email': 'test@example.com',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          prompt: 'Hello, Gemini!',
          prompt_length: '14',
          prompt_id: 'prompt-123',
          'user.email': 'test@example.com',
        }, mockSession)

        expect(result.type).toBe(EventType.USER_PROMPT)
        expect(result.prompt).toBe('Hello, Gemini!')
        expect(result.promptLength).toBe(14)
        expect(result.metadata.promptId).toBe('prompt-123')
      })

      test('handles missing prompt', () => {
        const logRecord = createLogRecord('gemini_cli.user_prompt', {
          prompt_length: '100',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          prompt_length: '100',
        }, mockSession)

        expect(result.type).toBe(EventType.USER_PROMPT)
        expect(result.prompt).toBe('')
        expect(result.promptLength).toBe(100)
      })
    })

    describe('gemini_cli.api_request', () => {
      test('processes API request event', () => {
        const logRecord = createLogRecord('gemini_cli.api_request', {
          model: 'gemini-pro',
          prompt_id: 'prompt-123',
          request_text: 'test request',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          model: 'gemini-pro',
          prompt_id: 'prompt-123',
          request_text: 'test request',
        }, mockSession)

        expect(result.type).toBe(EventType.API_REQUEST)
        expect(result.model).toBe('gemini-pro')
        expect(result.requestId).toBe('prompt-123')
        expect(result.metadata.requestText).toBe('test request')
      })
    })

    describe('gemini_cli.api_response', () => {
      test('processes API response event with token counts', () => {
        const logRecord = createLogRecord('gemini_cli.api_response', {
          model: 'gemini-pro',
          status_code: '200',
          duration_ms: '1500',
          input_token_count: '100',
          output_token_count: '200',
          cached_content_token_count: '50',
          thoughts_token_count: '25',
          tool_token_count: '10',
          total_token_count: '385',
          cost_usd: '0.015',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          model: 'gemini-pro',
          status_code: '200',
          duration_ms: '1500',
          input_token_count: '100',
          output_token_count: '200',
          cached_content_token_count: '50',
          thoughts_token_count: '25',
          tool_token_count: '10',
          total_token_count: '385',
          cost_usd: '0.015',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('gemini-pro')
        expect(result.durationMs).toBe(1500)
        expect(result.tokens.input).toBe(100)
        expect(result.tokens.output).toBe(200)
        expect(result.tokens.cached).toBe(50)
        expect(result.tokens.reasoning).toBe(25)
        expect(result.tokens.tool).toBe(10)
        expect(result.cost).toBe(0.015)
        expect(result.metadata.statusCode).toBe(200)
      })
    })

    describe('gemini_cli.api_error', () => {
      test('processes API error event', () => {
        const logRecord = createLogRecord('gemini_cli.api_error', {
          error: 'Rate limit exceeded',
          error_type: 'RateLimitError',
          status_code: '429',
          duration_ms: '500',
          model: 'gemini-pro',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          error: 'Rate limit exceeded',
          error_type: 'RateLimitError',
          status_code: '429',
          duration_ms: '500',
          model: 'gemini-pro',
        }, mockSession)

        expect(result.type).toBe(EventType.API_ERROR)
        expect(result.errorMessage).toBe('Rate limit exceeded')
        expect(result.statusCode).toBe(429)
        expect(result.durationMs).toBe(500)
        expect(result.metadata.errorType).toBe('RateLimitError')
      })
    })

    describe('gemini_cli.tool_call', () => {
      test('processes tool call event', () => {
        const logRecord = createLogRecord('gemini_cli.tool_call', {
          function_name: 'read_file',
          function_args: '{"path": "/test.txt"}',
          duration_ms: '100',
          success: 'true',
          decision: 'auto_accept',
          tool_type: 'native',
          content_length: '1024',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          function_name: 'read_file',
          function_args: '{"path": "/test.txt"}',
          duration_ms: '100',
          success: 'true',
          decision: 'auto_accept',
          tool_type: 'native',
          content_length: '1024',
        }, mockSession)

        expect(result.type).toBe(EventType.TOOL_RESULT)
        expect(result.toolName).toBe('read_file')
        expect(result.success).toBe(true)
        expect(result.durationMs).toBe(100)
        expect(result.arguments).toEqual({ path: '/test.txt' })
        expect(result.metadata.decision).toBe('auto_accept')
        expect(result.metadata.toolType).toBe('native')
      })

      test('handles MCP tool', () => {
        const logRecord = createLogRecord('gemini_cli.tool_call', {
          function_name: 'custom_tool',
          tool_type: 'mcp',
          mcp_server_name: 'my-server',
          success: 'true',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          function_name: 'custom_tool',
          tool_type: 'mcp',
          mcp_server_name: 'my-server',
          success: 'true',
        }, mockSession)

        expect(result.metadata.toolType).toBe('mcp')
        expect(result.metadata.mcpServerName).toBe('my-server')
      })

      test('handles failed tool call', () => {
        const logRecord = createLogRecord('gemini_cli.tool_call', {
          function_name: 'write_file',
          success: 'false',
          error: 'Permission denied',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          function_name: 'write_file',
          success: 'false',
          error: 'Permission denied',
        }, mockSession)

        expect(result.success).toBe(false)
        expect(result.error).toBe('Permission denied')
      })
    })

    describe('gemini_cli.file_operation', () => {
      test('processes file operation event', () => {
        const logRecord = createLogRecord('gemini_cli.file_operation', {
          tool_name: 'file_write',
          operation: 'create',
          lines: '50',
          mimetype: 'text/javascript',
          extension: '.js',
          programming_language: 'javascript',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          tool_name: 'file_write',
          operation: 'create',
          lines: '50',
          mimetype: 'text/javascript',
          extension: '.js',
          programming_language: 'javascript',
        }, mockSession)

        expect(result.type).toBe(EventType.FILE_OPERATION)
        expect(result.toolName).toBe('file_write')
        expect(result.operation).toBe('create')
        expect(result.lines).toBe(50)
        expect(result.mimetype).toBe('text/javascript')
        expect(result.extension).toBe('.js')
        expect(result.programmingLanguage).toBe('javascript')
      })
    })

    describe('gemini_cli.agent.start', () => {
      test('processes agent start event', () => {
        const logRecord = createLogRecord('gemini_cli.agent.start', {
          agent_name: 'code-review',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          agent_name: 'code-review',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('code-review')
        expect(result.lifecycle).toBe('start')
      })
    })

    describe('gemini_cli.agent.finish', () => {
      test('processes agent finish event', () => {
        const logRecord = createLogRecord('gemini_cli.agent.finish', {
          agent_name: 'code-review',
          duration_ms: '5000',
          turns: '10',
          termination_reason: 'completed',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          agent_name: 'code-review',
          duration_ms: '5000',
          turns: '10',
          termination_reason: 'completed',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('code-review')
        expect(result.lifecycle).toBe('finish')
        expect(result.durationMs).toBe(5000)
        expect(result.turns).toBe(10)
        expect(result.terminationReason).toBe('completed')
      })
    })

    describe('gen_ai.client.inference.operation.details', () => {
      test('processes GenAI semantic convention event', () => {
        const logRecord = createLogRecord('gen_ai.client.inference.operation.details', {
          model: 'gemini-pro',
          input_token_count: '100',
          output_token_count: '200',
          temperature: '0.7',
          finish_reason: 'stop',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          model: 'gemini-pro',
          input_token_count: '100',
          output_token_count: '200',
          temperature: '0.7',
          finish_reason: 'stop',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('gemini-pro')
        expect(result.tokens.input).toBe(100)
        expect(result.tokens.output).toBe(200)
        expect(result.metadata.temperature).toBe(0.7)
        expect(result.metadata.finishReason).toBe('stop')
        expect(result.metadata.otelGenAi).toBe(true)
      })
    })

    describe('miscellaneous events', () => {
      test('processes slash_command event', () => {
        const logRecord = createLogRecord('gemini_cli.slash_command', {
          command: '/help',
        })

        const result = GeminiAgent.processEvent(logRecord, {
          command: '/help',
        }, mockSession)

        expect(result.type).toBe('misc')
        expect(result.eventName).toBe('gemini_cli.slash_command')
      })

      test('returns null for unknown events', () => {
        const logRecord = createLogRecord('unknown.event', {})

        const result = GeminiAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })
    })
  })
})
