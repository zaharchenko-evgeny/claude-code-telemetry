/**
 * OTLP Exporter Module
 *
 * Forwards OTLP telemetry data to an OpenTelemetry Collector.
 * Supports multiple transport protocols:
 * - http/json: HTTP with JSON payload (default)
 * - http/protobuf: HTTP with Protocol Buffers payload
 * - grpc: gRPC with Protocol Buffers payload
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

// Supported protocols
const PROTOCOLS = {
  HTTP_JSON: 'http/json',
  HTTP_PROTOBUF: 'http/protobuf',
  GRPC: 'grpc',
}

// Default ports for different protocols
const DEFAULT_PORTS = {
  [PROTOCOLS.HTTP_JSON]: 4318,
  [PROTOCOLS.HTTP_PROTOBUF]: 4318,
  [PROTOCOLS.GRPC]: 4317,
}

// Content types for HTTP protocols
const CONTENT_TYPES = {
  [PROTOCOLS.HTTP_JSON]: 'application/json',
  [PROTOCOLS.HTTP_PROTOBUF]: 'application/x-protobuf',
}

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
 * Get the endpoint based on protocol
 * @param {string} protocol - Transport protocol
 * @param {string} baseEndpoint - Base endpoint URL
 * @returns {string|null} Endpoint URL or null if not configured
 */
function getEndpoint(protocol, baseEndpoint) {
  // If no endpoint is configured, return null (don't export)
  if (!baseEndpoint) return null

  return baseEndpoint
}

/**
 * Normalize endpoint URL
 * @param {string} endpoint - Endpoint URL
 * @param {string} protocol - Transport protocol
 * @param {string} signalPath - Signal path (e.g., /v1/metrics)
 * @returns {string} Normalized endpoint URL
 */
function normalizeEndpoint(endpoint, protocol, signalPath) {
  if (!endpoint) return null

  // For gRPC, return as-is (no path needed)
  if (protocol === PROTOCOLS.GRPC) {
    return endpoint.replace(/\/$/, '')
  }

  // For HTTP protocols, ensure proper path
  const base = endpoint.replace(/\/$/, '')
  if (base.endsWith(signalPath)) {
    return base
  }
  return `${base}${signalPath}`
}

// ============================================================================
// HTTP/JSON Exporter
// ============================================================================

/**
 * Export data via HTTP/JSON
 * @param {string} endpoint - OTLP endpoint URL
 * @param {Buffer|Object} data - Data to export
 * @param {Object} config - Export configuration
 * @returns {Promise<void>}
 */
async function exportViaHttpJson(endpoint, data, config = {}) {
  const { timeout = 5000, headers = {} } = config

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const body = Buffer.isBuffer(data) ? data : JSON.stringify(data)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': CONTENT_TYPES[PROTOCOLS.HTTP_JSON],
        ...headers,
      },
      body,
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`OTLP export failed: ${response.status} ${response.statusText} - ${errorText}`)
    }

    logger.debug({ endpoint, status: response.status, protocol: 'http/json' }, 'OTLP export successful')
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================================================
// HTTP/Protobuf Exporter
// ============================================================================

// Lazy-load protobuf serializer
let protobufSerializer = null

function getProtobufSerializer() {
  if (!protobufSerializer) {
    protobufSerializer = require('./protobufSerializer')
  }
  return protobufSerializer
}

/**
 * Export data via HTTP/Protobuf
 * @param {string} endpoint - OTLP endpoint URL
 * @param {Object} data - Data to export (JSON format)
 * @param {Object} config - Export configuration
 * @param {string} signalType - Signal type ('metrics' or 'logs')
 * @returns {Promise<void>}
 */
async function exportViaHttpProtobuf(endpoint, data, config = {}, signalType = 'metrics') {
  const { timeout = 5000, headers = {} } = config
  const serializer = getProtobufSerializer()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    // Convert JSON to protobuf binary
    let body
    if (signalType === 'metrics') {
      body = await serializer.serializeMetrics(data)
    } else {
      body = await serializer.serializeLogs(data)
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': CONTENT_TYPES[PROTOCOLS.HTTP_PROTOBUF],
        ...headers,
      },
      body,
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`OTLP export failed: ${response.status} ${response.statusText} - ${errorText}`)
    }

    logger.debug({ endpoint, status: response.status, protocol: 'http/protobuf' }, 'OTLP export successful')
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================================================
// gRPC Exporter
// ============================================================================

// Lazy-load gRPC client
let grpcModule = null
let grpcClients = {}

function getGrpcModule() {
  if (!grpcModule) {
    try {
      grpcModule = require('@grpc/grpc-js')
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to load @grpc/grpc-js')
      throw new Error('gRPC support requires @grpc/grpc-js package')
    }
  }
  return grpcModule
}

/**
 * Get or create a gRPC client for the given endpoint and service
 * @param {string} endpoint - gRPC endpoint
 * @param {string} serviceName - Service name ('metrics' or 'logs')
 * @param {Object} headers - Headers/metadata for authentication
 * @returns {Object} gRPC client
 */
function getGrpcClient(endpoint, serviceName, headers = {}) {
  const clientKey = `${endpoint}:${serviceName}`

  if (grpcClients[clientKey]) {
    return grpcClients[clientKey]
  }

  const grpc = getGrpcModule()
  const serializer = getProtobufSerializer()

  // Parse endpoint
  const url = new URL(endpoint.startsWith('http') ? endpoint : `http://${endpoint}`)
  const target = `${url.hostname}:${url.port || DEFAULT_PORTS[PROTOCOLS.GRPC]}`

  // Create credentials
  const isSecure = url.protocol === 'https:'
  const credentials = isSecure
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure()

  // Create metadata for headers
  const metadata = new grpc.Metadata()
  for (const [key, value] of Object.entries(headers)) {
    metadata.add(key, value)
  }

  // Create client using generic method
  const client = new grpc.Client(target, credentials)

  // Store wrapper with metadata and serializer reference
  grpcClients[clientKey] = {
    client,
    metadata,
    serviceName,
    serializer,
    target,
  }

  logger.info({ target, serviceName }, 'Created gRPC client')

  return grpcClients[clientKey]
}

/**
 * Export data via gRPC
 * @param {string} endpoint - gRPC endpoint
 * @param {Object} data - Data to export (JSON format)
 * @param {Object} config - Export configuration
 * @param {string} signalType - Signal type ('metrics' or 'logs')
 * @returns {Promise<void>}
 */
async function exportViaGrpc(endpoint, data, config = {}, signalType = 'metrics') {
  const { timeout = 5000, headers = {} } = config

  getGrpcModule() // Ensure gRPC module is loaded
  const clientInfo = getGrpcClient(endpoint, signalType, headers)

  // Serialize the request using protobuf serializer
  let serializedData
  if (signalType === 'metrics') {
    serializedData = await clientInfo.serializer.serializeMetrics(data)
  } else {
    serializedData = await clientInfo.serializer.serializeLogs(data)
  }

  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeout)

    // Make unary call
    const methodPath = signalType === 'metrics'
      ? '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export'
      : '/opentelemetry.proto.collector.logs.v1.LogsService/Export'

    clientInfo.client.makeUnaryRequest(
      methodPath,
      (arg) => arg, // Already serialized
      (buffer) => buffer, // Don't deserialize response
      serializedData,
      clientInfo.metadata,
      { deadline },
      (error, response) => {
        if (error) {
          // Handle gRPC errors
          const grpcError = new Error(`gRPC export failed: ${error.message} (code: ${error.code})`)
          grpcError.code = error.code
          reject(grpcError)
        } else {
          logger.debug({ endpoint: clientInfo.target, protocol: 'grpc', signalType }, 'OTLP export successful')
          resolve(response)
        }
      },
    )
  })
}

/**
 * Close all gRPC clients
 */
function closeGrpcClients() {
  for (const [key, clientInfo] of Object.entries(grpcClients)) {
    try {
      clientInfo.client.close()
      logger.debug({ key }, 'Closed gRPC client')
    } catch (error) {
      logger.warn({ key, error: error.message }, 'Error closing gRPC client')
    }
  }
  grpcClients = {}
}

// ============================================================================
// Unified Export Functions
// ============================================================================

/**
 * Export data to OTLP endpoint using configured protocol
 * @param {string} endpoint - OTLP endpoint URL
 * @param {Buffer|Object} data - Data to export
 * @param {Object} config - Export configuration
 * @param {string} signalType - Signal type ('metrics' or 'logs')
 * @returns {Promise<void>}
 */
async function exportToEndpoint(endpoint, data, config = {}, signalType = 'metrics') {
  const protocol = config.protocol || PROTOCOLS.HTTP_JSON

  switch (protocol) {
    case PROTOCOLS.HTTP_JSON:
      return exportViaHttpJson(endpoint, data, config)

    case PROTOCOLS.HTTP_PROTOBUF:
      return exportViaHttpProtobuf(endpoint, data, config, signalType)

    case PROTOCOLS.GRPC:
      return exportViaGrpc(endpoint, data, config, signalType)

    default:
      throw new Error(`Unsupported protocol: ${protocol}. Supported: ${Object.values(PROTOCOLS).join(', ')}`)
  }
}

/**
 * Export metrics to OTLP collector
 * @param {Buffer|Object} data - Raw OTLP metrics payload
 * @param {Object} config - Export configuration
 */
async function exportMetrics(data, config) {
  if (!config?.enabled) return

  const protocol = config.protocol || PROTOCOLS.HTTP_JSON
  const signalPath = '/v1/metrics'

  // Get endpoint - use specific metrics endpoint or construct from base
  let endpoint = config.metricsEndpoint
  if (!endpoint) {
    const baseEndpoint = getEndpoint(protocol, config.endpoint)
    endpoint = normalizeEndpoint(baseEndpoint, protocol, signalPath)
  }

  if (!endpoint || endpoint === signalPath) {
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
          protocol,
        }, 'metrics'),
      config.retries || 3,
    )

    logger.info({ endpoint, protocol }, 'Metrics exported to OTLP collector')
  } catch (error) {
    logger.error({ error: error.message, endpoint, protocol }, 'Failed to export metrics to OTLP collector')
  }
}

/**
 * Export logs to OTLP collector
 * @param {Buffer|Object} data - Raw OTLP logs payload
 * @param {Object} config - Export configuration
 */
async function exportLogs(data, config) {
  if (!config?.enabled) return

  const protocol = config.protocol || PROTOCOLS.HTTP_JSON
  const signalPath = '/v1/logs'

  // Get endpoint - use specific logs endpoint or construct from base
  let endpoint = config.logsEndpoint
  if (!endpoint) {
    const baseEndpoint = getEndpoint(protocol, config.endpoint)
    endpoint = normalizeEndpoint(baseEndpoint, protocol, signalPath)
  }

  if (!endpoint || endpoint === signalPath) {
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
          protocol,
        }, 'logs'),
      config.retries || 3,
    )

    logger.info({ endpoint, protocol }, 'Logs exported to OTLP collector')
  } catch (error) {
    logger.error({ error: error.message, endpoint, protocol }, 'Failed to export logs to OTLP collector')
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
    getProtocol: () => config?.protocol || PROTOCOLS.HTTP_JSON,
    close: () => closeGrpcClients(),
  }
}

module.exports = {
  // Main exports
  exportMetrics,
  exportLogs,
  createExporter,

  // Protocol-specific exports
  exportViaHttpJson,
  exportViaHttpProtobuf,
  exportViaGrpc,

  // Utilities
  parseHeaders,
  retryWithBackoff,
  exportToEndpoint,
  closeGrpcClients,

  // Constants
  PROTOCOLS,
  DEFAULT_PORTS,
  CONTENT_TYPES,
}
