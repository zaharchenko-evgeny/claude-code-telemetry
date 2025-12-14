/**
 * OTLP Exporter Module
 *
 * Forwards OTLP telemetry data to an OpenTelemetry Collector.
 * Supports both metrics and logs export via HTTP/JSON protocol.
 */

'use strict'

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

/**
 * Parse headers string into object
 * Format: "key1=value1,key2=value2"
 * @param {string} headersStr - Headers string
 * @returns {Object} Headers object
 */
function parseHeaders(headersStr) {
  if (!headersStr) return {}

  const headers = {}
  const pairs = headersStr.split(',')

  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split('=')
    if (key && valueParts.length > 0) {
      headers[key.trim()] = valueParts.join('=').trim()
    }
  }

  return headers
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in ms
 * @returns {Promise<any>} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (attempt === maxRetries) {
        throw error
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 10000)
      logger.debug(
        { attempt, maxRetries, delay, error: error.message },
        'OTLP export failed, retrying',
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

/**
 * Export data to OTLP endpoint
 * @param {string} endpoint - OTLP endpoint URL
 * @param {Buffer|Object} data - Data to export (raw OTLP payload)
 * @param {Object} config - Export configuration
 * @returns {Promise<void>}
 */
async function exportToEndpoint(endpoint, data, config = {}) {
  const { timeout = 5000, headers = {} } = config

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const body = Buffer.isBuffer(data) ? data : JSON.stringify(data)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`OTLP export failed: ${response.status} ${response.statusText} - ${errorText}`)
    }

    logger.debug({ endpoint, status: response.status }, 'OTLP export successful')
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Export metrics to OTLP collector
 * @param {Buffer|Object} data - Raw OTLP metrics payload
 * @param {Object} config - Export configuration
 */
async function exportMetrics(data, config) {
  if (!config?.enabled) return

  const endpoint = config.metricsEndpoint || `${config.endpoint}/v1/metrics`

  if (!endpoint || endpoint === '/v1/metrics') {
    logger.warn('OTLP export enabled but no endpoint configured')
    return
  }

  const headers = parseHeaders(config.headers)

  try {
    await retryWithBackoff(
      () =>
        exportToEndpoint(endpoint, data, {
          timeout: config.timeout,
          headers,
        }),
      config.retries || 3,
    )

    logger.info({ endpoint }, 'Metrics exported to OTLP collector')
  } catch (error) {
    logger.error({ error: error.message, endpoint }, 'Failed to export metrics to OTLP collector')
  }
}

/**
 * Export logs to OTLP collector
 * @param {Buffer|Object} data - Raw OTLP logs payload
 * @param {Object} config - Export configuration
 */
async function exportLogs(data, config) {
  if (!config?.enabled) return

  const endpoint = config.logsEndpoint || `${config.endpoint}/v1/logs`

  if (!endpoint || endpoint === '/v1/logs') {
    logger.warn('OTLP export enabled but no endpoint configured')
    return
  }

  const headers = parseHeaders(config.headers)

  try {
    await retryWithBackoff(
      () =>
        exportToEndpoint(endpoint, data, {
          timeout: config.timeout,
          headers,
        }),
      config.retries || 3,
    )

    logger.info({ endpoint }, 'Logs exported to OTLP collector')
  } catch (error) {
    logger.error({ error: error.message, endpoint }, 'Failed to export logs to OTLP collector')
  }
}

/**
 * Create an OTLP exporter instance with configuration
 * @param {Object} config - Export configuration
 * @returns {Object} Exporter instance
 */
function createExporter(config) {
  return {
    exportMetrics: (data) => exportMetrics(data, config),
    exportLogs: (data) => exportLogs(data, config),
    isEnabled: () => config?.enabled === true,
  }
}

module.exports = {
  exportMetrics,
  exportLogs,
  createExporter,
  parseHeaders,
  retryWithBackoff,
  exportToEndpoint,
}
