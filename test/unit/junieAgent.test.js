/**
 * Junie Agent Unit Tests
 */

const JunieAgent = require('../../src/agents/junieAgent')
const { EventType } = require('../../src/agents/types')

describe('JunieAgent', () => {
  describe('static properties', () => {
    test('name returns "junie"', () => {
      expect(JunieAgent.name).toBe('junie')
    })

    test('eventPrefix returns "junie_cli."', () => {
      expect(JunieAgent.eventPrefix).toBe('junie_cli.')
    })

    test('provider returns "jetbrains"', () => {
      expect(JunieAgent.provider).toBe('jetbrains')
    })
  })

  describe('canHandle', () => {
    test('returns true for junie_cli.* events', () => {
      expect(JunieAgent.canHandle('junie_cli.config')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.user_prompt')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.api_request')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.api_response')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.api_error')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.tool_call')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.file_operation')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.agent.start')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.agent.finish')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.task.start')).toBe(true)
      expect(JunieAgent.canHandle('junie_cli.task.finish')).toBe(true)
    })

    test('returns false for other events', () => {
      expect(JunieAgent.canHandle('claude_code.user_prompt')).toBe(false)
      expect(JunieAgent.canHandle('codex.user_prompt')).toBe(false)
      expect(JunieAgent.canHandle('gemini_cli.user_prompt')).toBe(false)
      expect(JunieAgent.canHandle('other.event')).toBe(false)
      expect(JunieAgent.canHandle(null)).toBeFalsy()
      expect(JunieAgent.canHandle(undefined)).toBeFalsy()
    })
  })

  describe('extractSessionId', () => {
    test('extracts session.id', () => {
      const attrs = { 'session.id': 'test-session-123' }
      expect(JunieAgent.extractSessionId(attrs)).toBe('test-session-123')
    })

    test('extracts junie.session.id as fallback', () => {
      const attrs = { 'junie.session.id': 'junie-456' }
      expect(JunieAgent.extractSessionId(attrs)).toBe('junie-456')
    })

    test('extracts task.id as fallback', () => {
      const attrs = { 'task.id': 'task-789' }
      expect(JunieAgent.extractSessionId(attrs)).toBe('task-789')
    })

    test('prefers session.id over other attributes', () => {
      const attrs = {
        'session.id': 'session-id',
        'junie.session.id': 'junie-id',
        'task.id': 'task-id',
      }
      expect(JunieAgent.extractSessionId(attrs)).toBe('session-id')
    })

    test('returns null when no session ID found', () => {
      expect(JunieAgent.extractSessionId({})).toBeNull()
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

    describe('junie_cli.config', () => {
      test('processes config event', () => {
        const logRecord = createLogRecord('junie_cli.config', {
          model: 'claude-3-opus',
          auto_approve: 'true',
          sandbox_mode: 'enabled',
          project_context: 'true',
          extensions: 'ext1, ext2',
          max_iterations: '10',
        })

        const result = JunieAgent.processEvent(logRecord, {
          model: 'claude-3-opus',
          auto_approve: 'true',
          sandbox_mode: 'enabled',
          project_context: 'true',
          extensions: 'ext1, ext2',
          max_iterations: '10',
        }, mockSession)

        expect(result.type).toBe(EventType.CONVERSATION_START)
        expect(result.config.model).toBe('claude-3-opus')
        expect(result.config.approvalPolicy).toBe('auto')
        expect(result.config.sandboxPolicy).toBe('enabled')
        expect(result.config.projectContext).toBe(true)
        expect(result.config.extensions).toEqual(['ext1', 'ext2'])
      })

      test('handles config with auto_approve disabled', () => {
        const logRecord = createLogRecord('junie_cli.config', {
          auto_approve: 'false',
        })

        const result = JunieAgent.processEvent(logRecord, {
          auto_approve: 'false',
        }, mockSession)

        expect(result.config.approvalPolicy).toBe('manual')
      })
    })

    describe('junie_cli.user_prompt', () => {
      test('processes user prompt event', () => {
        const logRecord = createLogRecord('junie_cli.user_prompt', {
          prompt: 'Refactor this code',
          prompt_length: '17',
          prompt_id: 'prompt-123',
          task_description: 'Code refactoring task',
          'user.id': 'user-123',
        })

        const result = JunieAgent.processEvent(logRecord, {
          prompt: 'Refactor this code',
          prompt_length: '17',
          prompt_id: 'prompt-123',
          task_description: 'Code refactoring task',
          'user.id': 'user-123',
        }, mockSession)

        expect(result.type).toBe(EventType.USER_PROMPT)
        expect(result.prompt).toBe('Refactor this code')
        expect(result.promptLength).toBe(17)
        expect(result.metadata.promptId).toBe('prompt-123')
        expect(result.metadata.taskDescription).toBe('Code refactoring task')
      })

      test('handles missing prompt with task_description', () => {
        const logRecord = createLogRecord('junie_cli.user_prompt', {
          task_description: 'Fix the bug',
          prompt_length: '11',
        })

        const result = JunieAgent.processEvent(logRecord, {
          task_description: 'Fix the bug',
          prompt_length: '11',
        }, mockSession)

        expect(result.type).toBe(EventType.USER_PROMPT)
        expect(result.prompt).toBe('Fix the bug')
        expect(result.promptLength).toBe(11)
      })
    })

    describe('junie_cli.api_request', () => {
      test('processes API request event', () => {
        const logRecord = createLogRecord('junie_cli.api_request', {
          model: 'claude-3-opus',
          prompt_id: 'prompt-123',
          request_type: 'completion',
        })

        const result = JunieAgent.processEvent(logRecord, {
          model: 'claude-3-opus',
          prompt_id: 'prompt-123',
          request_type: 'completion',
        }, mockSession)

        expect(result.type).toBe(EventType.API_REQUEST)
        expect(result.model).toBe('claude-3-opus')
        expect(result.requestId).toBe('prompt-123')
        expect(result.metadata.requestType).toBe('completion')
      })
    })

    describe('junie_cli.api_response', () => {
      test('processes API response event with token counts', () => {
        const logRecord = createLogRecord('junie_cli.api_response', {
          model: 'claude-3-opus',
          status_code: '200',
          duration_ms: '2500',
          input_tokens: '150',
          output_tokens: '300',
          cached_tokens: '50',
          reasoning_tokens: '100',
          total_tokens: '600',
          cost_usd: '0.025',
        })

        const result = JunieAgent.processEvent(logRecord, {
          model: 'claude-3-opus',
          status_code: '200',
          duration_ms: '2500',
          input_tokens: '150',
          output_tokens: '300',
          cached_tokens: '50',
          reasoning_tokens: '100',
          total_tokens: '600',
          cost_usd: '0.025',
        }, mockSession)

        expect(result.type).toBe(EventType.GENERATION)
        expect(result.model).toBe('claude-3-opus')
        expect(result.durationMs).toBe(2500)
        expect(result.tokens.input).toBe(150)
        expect(result.tokens.output).toBe(300)
        expect(result.tokens.cached).toBe(50)
        expect(result.tokens.reasoning).toBe(100)
        expect(result.cost).toBe(0.025)
        expect(result.metadata.statusCode).toBe(200)
      })
    })

    describe('junie_cli.api_error', () => {
      test('processes API error event', () => {
        const logRecord = createLogRecord('junie_cli.api_error', {
          error: 'Context window exceeded',
          error_type: 'ContextLengthError',
          status_code: '400',
          duration_ms: '300',
          model: 'claude-3-opus',
        })

        const result = JunieAgent.processEvent(logRecord, {
          error: 'Context window exceeded',
          error_type: 'ContextLengthError',
          status_code: '400',
          duration_ms: '300',
          model: 'claude-3-opus',
        }, mockSession)

        expect(result.type).toBe(EventType.API_ERROR)
        expect(result.errorMessage).toBe('Context window exceeded')
        expect(result.statusCode).toBe(400)
        expect(result.durationMs).toBe(300)
        expect(result.metadata.errorType).toBe('ContextLengthError')
      })
    })

    describe('junie_cli.tool_call', () => {
      test('processes tool call event', () => {
        const logRecord = createLogRecord('junie_cli.tool_call', {
          tool_name: 'file_read',
          tool_args: '{"path": "/src/main.js"}',
          duration_ms: '150',
          success: 'true',
          decision: 'auto_accept',
          tool_type: 'native',
        })

        const result = JunieAgent.processEvent(logRecord, {
          tool_name: 'file_read',
          tool_args: '{"path": "/src/main.js"}',
          duration_ms: '150',
          success: 'true',
          decision: 'auto_accept',
          tool_type: 'native',
        }, mockSession)

        expect(result.type).toBe(EventType.TOOL_RESULT)
        expect(result.toolName).toBe('file_read')
        expect(result.success).toBe(true)
        expect(result.durationMs).toBe(150)
        expect(result.arguments).toEqual({ path: '/src/main.js' })
        expect(result.metadata.decision).toBe('auto_accept')
        expect(result.metadata.toolType).toBe('native')
      })

      test('handles plugin tool', () => {
        const logRecord = createLogRecord('junie_cli.tool_call', {
          tool_name: 'database_query',
          tool_type: 'plugin',
          plugin_name: 'db-plugin',
          success: 'true',
        })

        const result = JunieAgent.processEvent(logRecord, {
          tool_name: 'database_query',
          tool_type: 'plugin',
          plugin_name: 'db-plugin',
          success: 'true',
        }, mockSession)

        expect(result.metadata.toolType).toBe('plugin')
        expect(result.metadata.pluginName).toBe('db-plugin')
      })

      test('handles failed tool call', () => {
        const logRecord = createLogRecord('junie_cli.tool_call', {
          tool_name: 'file_write',
          success: 'false',
          error: 'Permission denied',
        })

        const result = JunieAgent.processEvent(logRecord, {
          tool_name: 'file_write',
          success: 'false',
          error: 'Permission denied',
        }, mockSession)

        expect(result.success).toBe(false)
        expect(result.error).toBe('Permission denied')
      })
    })

    describe('junie_cli.file_operation', () => {
      test('processes file operation event', () => {
        const logRecord = createLogRecord('junie_cli.file_operation', {
          tool_name: 'file_write',
          operation: 'create',
          lines: '100',
          file_path: '/src/component.tsx',
          extension: '.tsx',
          language: 'typescript',
        })

        const result = JunieAgent.processEvent(logRecord, {
          tool_name: 'file_write',
          operation: 'create',
          lines: '100',
          file_path: '/src/component.tsx',
          extension: '.tsx',
          language: 'typescript',
        }, mockSession)

        expect(result.type).toBe(EventType.FILE_OPERATION)
        expect(result.toolName).toBe('file_write')
        expect(result.operation).toBe('create')
        expect(result.lines).toBe(100)
        expect(result.extension).toBe('.tsx')
        expect(result.programmingLanguage).toBe('typescript')
        expect(result.metadata.filePath).toBe('/src/component.tsx')
      })
    })

    describe('junie_cli.agent.start and junie_cli.task.start', () => {
      test('processes agent start event', () => {
        const logRecord = createLogRecord('junie_cli.agent.start', {
          agent_name: 'refactor-agent',
          task_id: 'task-123',
        })

        const result = JunieAgent.processEvent(logRecord, {
          agent_name: 'refactor-agent',
          task_id: 'task-123',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('refactor-agent')
        expect(result.lifecycle).toBe('start')
        expect(result.metadata.taskId).toBe('task-123')
      })

      test('processes task start event', () => {
        const logRecord = createLogRecord('junie_cli.task.start', {
          task_name: 'code-review',
          task_id: 'task-456',
        })

        const result = JunieAgent.processEvent(logRecord, {
          task_name: 'code-review',
          task_id: 'task-456',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('code-review')
        expect(result.lifecycle).toBe('start')
      })
    })

    describe('junie_cli.agent.finish and junie_cli.task.finish', () => {
      test('processes agent finish event', () => {
        const logRecord = createLogRecord('junie_cli.agent.finish', {
          agent_name: 'refactor-agent',
          task_id: 'task-123',
          duration_ms: '10000',
          iterations: '5',
          termination_reason: 'completed',
          success: 'true',
        })

        const result = JunieAgent.processEvent(logRecord, {
          agent_name: 'refactor-agent',
          task_id: 'task-123',
          duration_ms: '10000',
          iterations: '5',
          termination_reason: 'completed',
          success: 'true',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('refactor-agent')
        expect(result.lifecycle).toBe('finish')
        expect(result.durationMs).toBe(10000)
        expect(result.turns).toBe(5)
        expect(result.terminationReason).toBe('completed')
        expect(result.metadata.success).toBe(true)
      })

      test('processes task finish event with failure', () => {
        const logRecord = createLogRecord('junie_cli.task.finish', {
          task_name: 'bugfix',
          task_id: 'task-789',
          duration_ms: '3000',
          success: 'false',
        })

        const result = JunieAgent.processEvent(logRecord, {
          task_name: 'bugfix',
          task_id: 'task-789',
          duration_ms: '3000',
          success: 'false',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.terminationReason).toBe('failed')
        expect(result.metadata.success).toBe(false)
      })
    })

    describe('workflow events', () => {
      test('processes plan.start event', () => {
        const logRecord = createLogRecord('junie_cli.plan.start', {
          workflow_name: 'implementation-plan',
        })

        const result = JunieAgent.processEvent(logRecord, {
          workflow_name: 'implementation-plan',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.agentName).toBe('implementation-plan')
        expect(result.lifecycle).toBe('start')
        expect(result.metadata.workflowType).toBe('plan')
      })

      test('processes review.finish event', () => {
        const logRecord = createLogRecord('junie_cli.review.finish', {
          workflow_name: 'code-review',
          duration_ms: '5000',
          success: 'true',
        })

        const result = JunieAgent.processEvent(logRecord, {
          workflow_name: 'code-review',
          duration_ms: '5000',
          success: 'true',
        }, mockSession)

        expect(result.type).toBe(EventType.AGENT_LIFECYCLE)
        expect(result.lifecycle).toBe('finish')
        expect(result.durationMs).toBe(5000)
        expect(result.terminationReason).toBe('completed')
        expect(result.metadata.workflowType).toBe('review')
      })
    })

    describe('unknown events', () => {
      test('returns null for unknown events', () => {
        const logRecord = createLogRecord('unknown.event', {})

        const result = JunieAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })

      test('returns null for non-junie events', () => {
        const logRecord = createLogRecord('claude_code.user_prompt', {})

        const result = JunieAgent.processEvent(logRecord, {}, mockSession)

        expect(result).toBeNull()
      })
    })
  })
})
