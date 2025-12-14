/**
 * Agent Registry
 *
 * Central registry for all supported AI agent telemetry processors.
 * Handles agent detection, routing, and session creation.
 *
 * To add a new agent:
 * 1. Create an agent class extending BaseAgent (see baseAgent.js)
 * 2. Import and register it in the AGENTS array below
 *
 * The registry will automatically detect which agent should handle
 * incoming events based on the event name prefix.
 */

const pino = require('pino')
const ClaudeAgent = require('./claudeAgent')
const CodexAgent = require('./codexAgent')
const GeminiAgent = require('./geminiAgent')

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

/**
 * Registered agents - add new agents here
 * Order matters: first matching agent wins
 */
const AGENTS = [ClaudeAgent, CodexAgent, GeminiAgent]

/**
 * Agent registry for managing telemetry processors
 */
class AgentRegistry {
  constructor() {
    this.agents = new Map()
    this._registerBuiltInAgents()
  }

  /**
   * Register built-in agents
   */
  _registerBuiltInAgents() {
    for (const agent of AGENTS) {
      this.register(agent)
    }
  }

  /**
   * Register a new agent
   * @param {typeof BaseAgent} agentClass - Agent class to register
   */
  register(agentClass) {
    if (!agentClass.name || !agentClass.canHandle) {
      throw new Error('Agent must have a name and canHandle method')
    }
    this.agents.set(agentClass.name, agentClass)
    logger.info({ agent: agentClass.name, provider: agentClass.provider }, 'Agent registered')
  }

  /**
   * Unregister an agent
   * @param {string} name - Agent name to unregister
   */
  unregister(name) {
    this.agents.delete(name)
    logger.info({ agent: name }, 'Agent unregistered')
  }

  /**
   * Get agent by name
   * @param {string} name - Agent name
   * @returns {typeof BaseAgent|null}
   */
  getAgent(name) {
    return this.agents.get(name) || null
  }

  /**
   * Get all registered agents
   * @returns {Array<typeof BaseAgent>}
   */
  getAllAgents() {
    return Array.from(this.agents.values())
  }

  /**
   * Get agent names
   * @returns {Array<string>}
   */
  getAgentNames() {
    return Array.from(this.agents.keys())
  }

  /**
   * Detect which agent can handle the given event
   * @param {string} eventName - Event name from log record
   * @returns {typeof BaseAgent|null}
   */
  detectAgent(eventName) {
    if (!eventName) return null

    for (const agent of this.agents.values()) {
      if (agent.canHandle(eventName)) {
        return agent
      }
    }
    return null
  }

  /**
   * Extract session ID using the appropriate agent
   * @param {Object} attrs - Extracted attributes
   * @param {string} eventName - Event name to detect agent
   * @returns {{sessionId: string|null, agent: typeof BaseAgent|null}}
   */
  extractSessionId(attrs, eventName) {
    const agent = this.detectAgent(eventName)
    if (!agent) {
      return { sessionId: null, agent: null }
    }
    return {
      sessionId: agent.extractSessionId(attrs),
      agent,
    }
  }

  /**
   * Process an event using the appropriate agent
   * @param {Object} logRecord - OTLP log record
   * @param {Object} attrs - Pre-extracted attributes
   * @param {Object} session - Session handler instance
   * @returns {{event: Object|null, agent: typeof BaseAgent|null}}
   */
  processEvent(logRecord, attrs, session) {
    const eventName = logRecord.body?.stringValue
    const agent = this.detectAgent(eventName)

    if (!agent) {
      logger.debug({ eventName }, 'No agent found for event')
      return { event: null, agent: null }
    }

    const event = agent.processEvent(logRecord, attrs, session)
    return { event, agent }
  }

  /**
   * Get a summary of registered agents for health check
   * @returns {Object}
   */
  getSummary() {
    const summary = {
      count: this.agents.size,
      agents: {},
    }

    for (const [name, agent] of this.agents.entries()) {
      summary.agents[name] = {
        provider: agent.provider,
        eventPrefix: agent.eventPrefix,
      }
    }

    return summary
  }
}

// Singleton instance
const registry = new AgentRegistry()

/**
 * Helper function to detect agent from event name
 * @param {string} eventName - Event name
 * @returns {typeof BaseAgent|null}
 */
function detectAgent(eventName) {
  return registry.detectAgent(eventName)
}

/**
 * Helper function to extract session ID
 * @param {Object} attrs - Attributes
 * @param {string} eventName - Event name
 * @returns {{sessionId: string|null, agent: typeof BaseAgent|null}}
 */
function extractSessionId(attrs, eventName) {
  return registry.extractSessionId(attrs, eventName)
}

/**
 * Helper function to process event
 * @param {Object} logRecord - Log record
 * @param {Object} attrs - Attributes
 * @param {Object} session - Session
 * @returns {{event: Object|null, agent: typeof BaseAgent|null}}
 */
function processEvent(logRecord, attrs, session) {
  return registry.processEvent(logRecord, attrs, session)
}

module.exports = {
  AgentRegistry,
  registry,
  detectAgent,
  extractSessionId,
  processEvent,
  // Export agent classes for direct access
  ClaudeAgent,
  CodexAgent,
  GeminiAgent,
}
