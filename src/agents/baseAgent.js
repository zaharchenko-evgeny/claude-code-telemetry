/**
 * Base Agent Class
 *
 * All AI agent telemetry processors should extend this class and implement
 * the required methods. This provides a consistent interface for handling
 * telemetry from different AI coding assistants.
 *
 * To add support for a new AI agent:
 * 1. Create a new file in src/agents/ (e.g., newAgent.js)
 * 2. Extend BaseAgent and implement all abstract methods
 * 3. Register the agent in src/agents/registry.js
 *
 * Example:
 * ```javascript
 * class MyNewAgent extends BaseAgent {
 *   static get name() { return 'my-agent' }
 *   static get eventPrefix() { return 'my_agent.' }
 *   static canHandle(eventName) { return eventName?.startsWith('my_agent.') }
 *   // ... implement other methods
 * }
 * ```
 */

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

class BaseAgent {
  /**
   * Agent identifier (e.g., 'claude-code', 'codex')
   * @returns {string}
   */
  static get name() {
    throw new Error('Subclass must implement static getter "name"')
  }

  /**
   * Event prefix for this agent (e.g., 'claude_code.', 'codex.')
   * @returns {string}
   */
  static get eventPrefix() {
    throw new Error('Subclass must implement static getter "eventPrefix"')
  }

  /**
   * Model provider for this agent (e.g., 'anthropic', 'openai')
   * @returns {string}
   */
  static get provider() {
    return 'unknown'
  }

  /**
   * Check if this agent can handle the given event
   * @param {string} eventName - Event name from log record
   * @returns {boolean}
   */
  static canHandle(eventName) {
    throw new Error('Subclass must implement static method "canHandle"')
  }

  /**
   * Extract session ID from attributes
   * Different agents may use different attribute names for session ID
   * @param {Object} attrs - Extracted attributes
   * @returns {string|null}
   */
  static extractSessionId(attrs) {
    throw new Error('Subclass must implement static method "extractSessionId"')
  }

  /**
   * Process a log record and return a normalized event
   * @param {Object} logRecord - OTLP log record
   * @param {Object} attrs - Pre-extracted attributes
   * @param {Object} session - Session handler instance
   * @returns {Object|null} Normalized event or null if not processed
   */
  static processEvent(logRecord, attrs, session) {
    throw new Error('Subclass must implement static method "processEvent"')
  }

  /**
   * Get standard metadata to include with all events
   * @param {Object} attrs - Extracted attributes
   * @param {Object} session - Session handler instance
   * @returns {Object} Standard metadata
   */
  static getStandardMetadata(attrs, session) {
    return {
      agent: this.name,
      provider: this.provider,
      sessionId: session.sessionId,
      appVersion: attrs['app.version'] || session.metadata?.service?.version,
      terminalType: attrs['terminal.type'] || session.terminalType,
    }
  }

  /**
   * Calculate cost from token counts (can be overridden by subclasses)
   * @param {string} model - Model name
   * @param {Object} tokens - Token counts
   * @returns {number} Cost in USD
   */
  static calculateCost(model, tokens) {
    // Default implementation returns 0 - subclasses should override
    return 0
  }

  /**
   * Get the logger instance for this agent
   * @returns {Object} Pino logger
   */
  static get logger() {
    return logger
  }
}

module.exports = BaseAgent
