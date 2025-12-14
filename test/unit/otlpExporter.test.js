// Mock pino before requiring the module
jest.mock('pino', () => () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}))

const {
  parseHeaders,
  retryWithBackoff,
  exportToEndpoint,
  exportMetrics,
  exportLogs,
  createExporter,
  PROTOCOLS,
  DEFAULT_PORTS,
  CONTENT_TYPES,
} = require('../../src/otlpExporter')

describe('OTLP Exporter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('parseHeaders', () => {
    test('parses single header', () => {
      const result = parseHeaders('Authorization=Bearer token')
      expect(result).toEqual({ Authorization: 'Bearer token' })
    })

    test('parses multiple headers', () => {
      const result = parseHeaders('Authorization=Bearer token,X-API-Key=secret')
      expect(result).toEqual({
        Authorization: 'Bearer token',
        'X-API-Key': 'secret',
      })
    })

    test('handles values with equals signs', () => {
      const result = parseHeaders('Authorization=Bearer token=123')
      expect(result).toEqual({ Authorization: 'Bearer token=123' })
    })

    test('returns empty object for empty string', () => {
      const result = parseHeaders('')
      expect(result).toEqual({})
    })

    test('returns empty object for null/undefined', () => {
      expect(parseHeaders(null)).toEqual({})
      expect(parseHeaders(undefined)).toEqual({})
    })

    test('trims whitespace', () => {
      const result = parseHeaders('  Key = Value  ')
      expect(result).toEqual({ Key: 'Value' })
    })
  })

  describe('retryWithBackoff', () => {
    test('returns result on success', async () => {
      const fn = jest.fn().mockResolvedValue('success')
      const result = await retryWithBackoff(fn, 3, 10)
      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    test('retries on failure', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail1'))
        .mockRejectedValueOnce(new Error('fail2'))
        .mockResolvedValue('success')

      const result = await retryWithBackoff(fn, 3, 10)
      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    test('throws after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('always fails'))

      await expect(retryWithBackoff(fn, 3, 10)).rejects.toThrow('always fails')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    test('uses exponential backoff', async () => {
      jest.useFakeTimers()
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success')

      const promise = retryWithBackoff(fn, 3, 100)

      // First call happens immediately
      expect(fn).toHaveBeenCalledTimes(1)

      // Advance timers for first retry (100ms * 2^0 = 100ms)
      await jest.advanceTimersByTimeAsync(100)

      await promise
      expect(fn).toHaveBeenCalledTimes(2)

      jest.useRealTimers()
    })
  })

  describe('exportToEndpoint', () => {
    test('sends data to endpoint', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
      })

      const data = { test: 'data' }
      await exportToEndpoint('http://localhost:4317/v1/metrics', data, {
        timeout: 5000,
        headers: { 'X-Custom': 'header' },
      })

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4317/v1/metrics',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Custom': 'header',
          },
          body: JSON.stringify(data),
        }),
      )
    })

    test('handles Buffer data', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
      })

      const data = Buffer.from('test data')
      await exportToEndpoint('http://localhost:4317/v1/logs', data, {})

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4317/v1/logs',
        expect.objectContaining({
          body: data,
        }),
      )
    })

    test('throws on non-ok response', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: jest.fn().mockResolvedValue('Server error'),
      })

      await expect(
        exportToEndpoint('http://localhost:4317/v1/metrics', {}, {}),
      ).rejects.toThrow('OTLP export failed: 500 Internal Server Error')
    })

    test('sets up abort controller with timeout', async () => {
      // Verify that the function creates an AbortController for timeout
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      await exportToEndpoint('http://localhost:4317/v1/metrics', {}, { timeout: 5000 })

      // Check that fetch was called with a signal
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4317/v1/metrics',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      )
    })
  })

  describe('exportMetrics', () => {
    test('exports when enabled with endpoint', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        timeout: 5000,
        retries: 3,
      }

      await exportMetrics({ resourceMetrics: [] }, config)

      expect(global.fetch).toHaveBeenCalledWith(
        'http://collector:4318/v1/metrics',
        expect.any(Object),
      )
    })

    test('uses metricsEndpoint override', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        metricsEndpoint: 'http://metrics-collector:4318/v1/metrics',
        timeout: 5000,
      }

      await exportMetrics({}, config)

      expect(global.fetch).toHaveBeenCalledWith(
        'http://metrics-collector:4318/v1/metrics',
        expect.any(Object),
      )
    })

    test('does not export when disabled', async () => {
      const config = {
        enabled: false,
        endpoint: 'http://collector:4318',
      }

      await exportMetrics({}, config)

      expect(global.fetch).not.toHaveBeenCalled()
    })

    test('does not export without endpoint', async () => {
      const config = {
        enabled: true,
        endpoint: '',
      }

      await exportMetrics({}, config)

      expect(global.fetch).not.toHaveBeenCalled()
    })

    test('handles export errors gracefully', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'))

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        timeout: 100,
        retries: 1,
      }

      // Should not throw
      await expect(exportMetrics({}, config)).resolves.not.toThrow()
    })
  })

  describe('exportLogs', () => {
    test('exports when enabled with endpoint', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        timeout: 5000,
        retries: 3,
      }

      await exportLogs({ resourceLogs: [] }, config)

      expect(global.fetch).toHaveBeenCalledWith(
        'http://collector:4318/v1/logs',
        expect.any(Object),
      )
    })

    test('uses logsEndpoint override', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        logsEndpoint: 'http://logs-collector:4318/v1/logs',
        timeout: 5000,
      }

      await exportLogs({}, config)

      expect(global.fetch).toHaveBeenCalledWith(
        'http://logs-collector:4318/v1/logs',
        expect.any(Object),
      )
    })

    test('does not export when disabled', async () => {
      const config = {
        enabled: false,
        endpoint: 'http://collector:4318',
      }

      await exportLogs({}, config)

      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe('createExporter', () => {
    test('creates exporter with config', () => {
      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
      }

      const exporter = createExporter(config)

      expect(exporter).toHaveProperty('exportMetrics')
      expect(exporter).toHaveProperty('exportLogs')
      expect(exporter).toHaveProperty('isEnabled')
      expect(exporter.isEnabled()).toBe(true)
    })

    test('isEnabled returns false when disabled', () => {
      const config = {
        enabled: false,
        endpoint: 'http://collector:4318',
      }

      const exporter = createExporter(config)
      expect(exporter.isEnabled()).toBe(false)
    })

    test('exportMetrics calls with config', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        timeout: 5000,
      }

      const exporter = createExporter(config)
      await exporter.exportMetrics({ test: 'data' })

      expect(global.fetch).toHaveBeenCalled()
    })

    test('getProtocol returns configured protocol', () => {
      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        protocol: 'http/protobuf',
      }

      const exporter = createExporter(config)
      expect(exporter.getProtocol()).toBe('http/protobuf')
    })

    test('getProtocol returns http/json by default', () => {
      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
      }

      const exporter = createExporter(config)
      expect(exporter.getProtocol()).toBe('http/json')
    })
  })

  describe('Protocol Constants', () => {
    test('PROTOCOLS contains all supported protocols', () => {
      expect(PROTOCOLS.HTTP_JSON).toBe('http/json')
      expect(PROTOCOLS.HTTP_PROTOBUF).toBe('http/protobuf')
      expect(PROTOCOLS.GRPC).toBe('grpc')
    })

    test('DEFAULT_PORTS has correct values', () => {
      expect(DEFAULT_PORTS['http/json']).toBe(4318)
      expect(DEFAULT_PORTS['http/protobuf']).toBe(4318)
      expect(DEFAULT_PORTS[PROTOCOLS.GRPC]).toBe(4317)
    })

    test('CONTENT_TYPES has correct values', () => {
      expect(CONTENT_TYPES['http/json']).toBe('application/json')
      expect(CONTENT_TYPES['http/protobuf']).toBe('application/x-protobuf')
    })
  })

  describe('Multi-protocol export', () => {
    test('exports with http/json protocol', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        protocol: 'http/json',
        timeout: 5000,
      }

      await exportMetrics({ resourceMetrics: [] }, config)

      expect(global.fetch).toHaveBeenCalledWith(
        'http://collector:4318/v1/metrics',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      )
    })

    test('exports logs with http/json protocol', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 })

      const config = {
        enabled: true,
        endpoint: 'http://collector:4318',
        protocol: 'http/json',
        timeout: 5000,
      }

      await exportLogs({ resourceLogs: [] }, config)

      expect(global.fetch).toHaveBeenCalledWith(
        'http://collector:4318/v1/logs',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      )
    })
  })
})
