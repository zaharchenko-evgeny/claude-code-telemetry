/**
 * AI Agent Telemetry Processors
 *
 * This module provides a pluggable architecture for handling telemetry
 * from different AI coding assistants (Claude Code, Codex, Gemini CLI, Junie CLI, Copilot CLI, ACP agents, etc.)
 *
 * Currently supported agents:
 * - claude-code: Anthropic's Claude Code CLI
 * - codex: OpenAI's Codex CLI
 * - gemini: Google's Gemini CLI
 * - junie: JetBrains' Junie CLI
 * - copilot: GitHub's Copilot CLI (via wrapper bridge)
 * - acp: Agent Client Protocol compliant agents
 *
 * To add support for a new AI agent:
 *
 * 1. Create a new agent file in src/agents/ (e.g., myNewAgent.js):
 *    ```javascript
 *    const BaseAgent = require('./baseAgent');
 *
 *    class MyNewAgent extends BaseAgent {
 *      static get name() { return 'my-agent'; }
 *      static get eventPrefix() { return 'my_agent.'; }
 *      static get provider() { return 'my-provider'; }
 *
 *      static canHandle(eventName) {
 *        return eventName?.startsWith('my_agent.');
 *      }
 *
 *      static extractSessionId(attrs) {
 *        return attrs['my.session.id'] || null;
 *      }
 *
 *      static processEvent(logRecord, attrs, session) {
 *        // Process events and return normalized events
 *        // Use the event types from ./types.js
 *      }
 *    }
 *    module.exports = MyNewAgent;
 *    ```
 *
 * 2. Register the agent in registry.js:
 *    ```javascript
 *    const MyNewAgent = require('./myNewAgent');
 *    const AGENTS = [ClaudeAgent, CodexAgent, MyNewAgent];
 *    ```
 *
 * 3. The agent will automatically be detected and used for matching events.
 */

const { EventType } = require('./types')
const BaseAgent = require('./baseAgent')
const ClaudeAgent = require('./claudeAgent')
const CodexAgent = require('./codexAgent')
const GeminiAgent = require('./geminiAgent')
const JunieAgent = require('./junieAgent')
const CopilotAgent = require('./copilotAgent')
const ACPAgent = require('./acpAgent')
const {
  AgentRegistry,
  registry,
  detectAgent,
  extractSessionId,
  processEvent,
} = require('./registry')

module.exports = {
  // Event types
  EventType,

  // Base class for implementing new agents
  BaseAgent,

  // Built-in agents
  ClaudeAgent,
  CodexAgent,
  GeminiAgent,
  JunieAgent,
  CopilotAgent,
  ACPAgent,

  // Registry
  AgentRegistry,
  registry,

  // Helper functions
  detectAgent,
  extractSessionId,
  processEvent,
}
