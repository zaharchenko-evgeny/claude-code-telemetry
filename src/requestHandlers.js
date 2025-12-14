/**
 * Request Handlers Module
 *
 * Handles OTLP endpoint requests for traces, metrics, and logs.
 * Uses the agent registry for automatic detection and routing of
 * telemetry from different AI coding assistants.
 */

const pino = require('pino')
const { SessionHandler, extractAttributesArray } = require('./sessionHandler')
const { processMetric } = require('./metricsProcessor')
const { exportMetrics, exportLogs } = require('./otlpExporter')
const { registry, detectAgent, extractSessionId, processEvent } = require('./agents')
const { handleNormalizedEvent } = require('./langfuseHandler')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

/**
 * Handle OTLP traces endpoint
 */
function handleTraces(data, res, sessions, langfuse, config) {
  try {
    JSON.parse(data.toString()) // Validate JSON
    logger.debug({ size: data.length }, 'Received traces')
    // AI coding assistants typically don't send traces, but handle the endpoint
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ partialSuccess: {} }))
  } catch (error) {
    logger.error({ error }, 'Error parsing traces')
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON' }))
  }
}

/**
 * Handle OTLP metrics endpoint
 */
function handleMetrics(data, res, sessions, langfuse, config) {
  try {
    const metrics = JSON.parse(data.toString())
    logger.info({ size: data.length }, 'Received metrics')

    // Export to OTLP collector if enabled (fire-and-forget)
    if (config?.otlpExport?.enabled) {
      exportMetrics(data, config.otlpExport).catch((error) => {
        logger.error({ error: error.message }, 'OTLP metrics export failed')
      })
    }

    // Log the actual metrics structure
    if (logger.level === 'debug') {
      logger.debug({ metrics: JSON.stringify(metrics, null, 2) }, 'Metrics payload')
    }

    // Process each resource metric
    if (metrics && metrics.resourceMetrics) {
      for (const resourceMetric of metrics.resourceMetrics) {
        const resource = resourceMetric.resource

        for (const scopeMetric of resourceMetric.scopeMetrics || []) {
          for (const metric of scopeMetric.metrics || []) {
            logger.info(
              {
                metricName: metric.name,
                metricDescription: metric.description,
                metricUnit: metric.unit,
                dataPoints:
                  metric.sum?.dataPoints?.length ||
                  metric.gauge?.dataPoints?.length ||
                  metric.histogram?.dataPoints?.length ||
                  0,
              },
              'Processing metric',
            )

            // Process metric data points
            const dataPoints =
              metric.sum?.dataPoints ||
              metric.gauge?.dataPoints ||
              metric.histogram?.dataPoints ||
              []

            for (const dataPoint of dataPoints) {
              const attrs = extractAttributesArray(dataPoint.attributes)
              const sessionId = attrs['session.id']

              if (sessionId) {
                // Get or create session
                if (!sessions.has(sessionId)) {
                  const resourceAttrs = extractAttributesArray(resource?.attributes)
                  sessions.set(sessionId, new SessionHandler(sessionId, resourceAttrs, langfuse))
                }

                const session = sessions.get(sessionId)
                processMetric(metric, dataPoint, attrs, session)
              }
            }
          }
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ partialSuccess: {} }))
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Error processing metrics')
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message || 'Invalid JSON' }))
  }
}

/**
 * Handle OTLP logs endpoint
 * Uses the agent registry for automatic detection and routing
 */
function handleLogs(data, res, sessions, langfuse, config) {
  try {
    const logs = JSON.parse(data.toString())
    logger.debug({ size: data.length }, 'Received logs')

    // Export to OTLP collector if enabled (fire-and-forget)
    if (config?.otlpExport?.enabled) {
      exportLogs(data, config.otlpExport).catch((error) => {
        logger.error({ error: error.message }, 'OTLP logs export failed')
      })
    }

    // Process each resource log
    if (logs && logs.resourceLogs) {
      for (const resourceLog of logs.resourceLogs) {
        const resource = resourceLog.resource

        for (const scopeLog of resourceLog.scopeLogs || []) {
          logger.debug({ scope: scopeLog.scope?.name }, 'Processing scope logs')

          for (const logRecord of scopeLog.logRecords || []) {
            processLogRecord(logRecord, resource, sessions, langfuse)
          }
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ partialSuccess: {} }))
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Error processing logs')
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message || 'Invalid JSON' }))
  }
}

/**
 * Process a single log record using the agent registry
 * @param {Object} logRecord - OTLP log record
 * @param {Object} resource - Resource information
 * @param {Map} sessions - Sessions map
 * @param {Object} langfuse - Langfuse instance
 */
function processLogRecord(logRecord, resource, sessions, langfuse) {
  const eventName = logRecord.body?.stringValue
  const attrs = extractAttributesArray(logRecord.attributes)

  // Use agent registry to detect and extract session ID
  const { sessionId, agent } = extractSessionId(attrs, eventName)

  if (sessionId) {
    const session = getOrCreateSession(sessionId, resource, sessions, langfuse, agent)

    // Process event using registry
    const { event, agent: detectedAgent } = processEvent(logRecord, attrs, session)

    if (event) {
      // Handle the normalized event
      handleNormalizedEvent(event, session, detectedAgent)
    }
  } else {
    // Try to create session from fallback identifiers
    const fallbackSessionId = tryCreateFallbackSessionId(attrs, eventName, agent)

    if (fallbackSessionId) {
      const session = getOrCreateSession(fallbackSessionId, resource, sessions, langfuse, agent)
      const { event, agent: detectedAgent } = processEvent(logRecord, attrs, session)

      if (event) {
        handleNormalizedEvent(event, session, detectedAgent)
      }
    } else {
      logger.debug({ body: eventName, attrs }, 'Log without session identifier')
    }
  }
}

/**
 * Get or create a session
 * @param {string} sessionId - Session ID
 * @param {Object} resource - Resource information
 * @param {Map} sessions - Sessions map
 * @param {Object} langfuse - Langfuse instance
 * @param {Object} agent - Agent class
 * @returns {Object} Session handler
 */
function getOrCreateSession(sessionId, resource, sessions, langfuse, agent) {
  if (!sessions.has(sessionId)) {
    const resourceAttrs = extractAttributesArray(resource?.attributes)
    const session = new SessionHandler(sessionId, resourceAttrs, langfuse)
    session.source = agent?.name || 'unknown'
    sessions.set(sessionId, session)
    logger.info({ sessionId, source: session.source }, 'New session created')
  }
  return sessions.get(sessionId)
}

/**
 * Try to create a fallback session ID from other identifiers
 * @param {Object} attrs - Extracted attributes
 * @param {string} eventName - Event name
 * @param {Object} agent - Agent class
 * @returns {string|null} Generated session ID or null
 */
function tryCreateFallbackSessionId(attrs, eventName, agent) {
  // Try different user ID fields based on agent
  const userId =
    attrs['user.account_id'] ||
    attrs['user.id'] ||
    attrs['user.email'] ||
    attrs['user.account_uuid']

  const eventTimestamp = attrs['event.timestamp']

  if (userId && eventTimestamp) {
    const timeWindow = new Date(eventTimestamp).toISOString().substring(0, 13)
    const agentName = agent?.name || detectAgent(eventName)?.name || 'unknown'
    return `${agentName}-${userId}-${timeWindow}`.replace(/[^a-zA-Z0-9-]/g, '-')
  }

  return null
}

/**
 * Handle health check endpoint
 */
function handleHealthCheck(res, serverStartTime, sessions, requestCount, errorCount) {
  const uptime = Date.now() - serverStartTime
  const health = {
    status: 'healthy',
    uptime,
    sessions: sessions.size,
    requestCount,
    errorCount,
    langfuse: 'connected',
    agents: registry.getSummary(),
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(health))
}

module.exports = {
  handleTraces,
  handleMetrics,
  handleLogs,
  handleHealthCheck,
  processLogRecord,
  getOrCreateSession,
  tryCreateFallbackSessionId,
}
