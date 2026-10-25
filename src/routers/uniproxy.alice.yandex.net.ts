import { Server } from 'node:http'
import { WebSocketServer } from 'ws'

import { getLogger } from '../logger'
import { UniProxyConnection, UniProxyConnectionParameters } from './uniproxy/uniproxy-connection'

const logger = getLogger()

interface UniProxyRouter {
  connections: Map<string, Set<UniProxyConnection>>
  close(): void
}

export function registerUniproxyAliceYandexNetRouter (parameters: UniProxyConnectionParameters,
  server: Server): UniProxyRouter {
  const wsServer = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/uniproxy.alice.yandex.net/uni.ws') {
      wsServer.handleUpgrade(request, socket, head, client => {
        wsServer.emit('connection', client, request)
      })
    } else {
      logger.warn(`Unsupported WebSocket path: ${pathname}`)
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  const router: UniProxyRouter = {
    connections: new Map(),
    close () {
      for (const client of wsServer.clients) client.terminate()
      wsServer.close()
    }
  }

  wsServer.on('connection', (websocket, request) => {
    logger.debug('Got WebSocket connection')

    const deviceId = String(request.headers['x-uprx-device-id']) ?? 'unknown'
    if (!router.connections.has(deviceId)) {
      router.connections.set(deviceId, new Set())
    }

    const set = router.connections.get(deviceId)
    if (!set) {
      throw new Error('wut?')
    }

    const connection = new UniProxyConnection(websocket, deviceId, parameters)
    websocket.on('close', () => {
      set.delete(connection)
      logger.warn('UniProxy WebSocket closed')
    })
    websocket.on('error', error => {
      set.delete(connection)
      logger.warn(`UniProxy WebSocket error: ${error}`)
    })
    set.add(connection)
  })

  return router
}
