/**
 * Protobuf Serializer for OTLP
 *
 * Converts OTLP JSON to protobuf binary format for http/protobuf and gRPC transports.
 */

'use strict'

const path = require('path')
const protobuf = require('protobufjs')

let root = null
let metricsType = null
let logsType = null

/**
 * Load and cache the protobuf definitions
 */
async function loadProtoDefinitions() {
  if (root) return root

  const protoDir = path.join(__dirname, 'proto')

  root = new protobuf.Root()
  root.resolvePath = (origin, target) => {
    // Handle imports - target is relative filename like "common.proto"
    return path.join(protoDir, path.basename(target))
  }

  await root.load([
    path.join(protoDir, 'common.proto'),
    path.join(protoDir, 'resource.proto'),
    path.join(protoDir, 'metrics.proto'),
    path.join(protoDir, 'logs.proto'),
  ])

  metricsType = root.lookupType('opentelemetry.proto.metrics.v1.ExportMetricsServiceRequest')
  logsType = root.lookupType('opentelemetry.proto.logs.v1.ExportLogsServiceRequest')

  return root
}

/**
 * Serialize OTLP metrics JSON to protobuf binary
 * @param {Object} jsonData - OTLP metrics in JSON format (camelCase keys)
 * @returns {Promise<Uint8Array>} Protobuf binary data
 */
async function serializeMetrics(jsonData) {
  await loadProtoDefinitions()

  // Verify the message (optional, for debugging)
  const errMsg = metricsType.verify(jsonData)
  if (errMsg) {
    throw new Error(`Invalid metrics data: ${errMsg}`)
  }

  // Create and encode the message
  const message = metricsType.create(jsonData)
  return metricsType.encode(message).finish()
}

/**
 * Serialize OTLP logs JSON to protobuf binary
 * @param {Object} jsonData - OTLP logs in JSON format (camelCase keys)
 * @returns {Promise<Uint8Array>} Protobuf binary data
 */
async function serializeLogs(jsonData) {
  await loadProtoDefinitions()

  // Verify the message (optional, for debugging)
  const errMsg = logsType.verify(jsonData)
  if (errMsg) {
    throw new Error(`Invalid logs data: ${errMsg}`)
  }

  // Create and encode the message
  const message = logsType.create(jsonData)
  return logsType.encode(message).finish()
}

/**
 * Get the loaded protobuf root (for gRPC service definitions)
 * @returns {Promise<protobuf.Root>} Protobuf root
 */
async function getProtoRoot() {
  await loadProtoDefinitions()
  return root
}

module.exports = {
  serializeMetrics,
  serializeLogs,
  getProtoRoot,
  loadProtoDefinitions,
}
