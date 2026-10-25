import { getTraceData, Span, startInactiveSpan } from '@sentry/node'
import { WebSocket } from 'ws'

import { OpusProcessor } from '../../codecs/opus-processor'
import { getLogger } from '../../logger'
import { STTBackend, STTBackendSession } from '../backend'

interface GigaAMMessage {
  end_of_utt: boolean;
  text: string;
}

class GigaAMSTTSession extends STTBackendSession {
  private readonly logger = getLogger<GigaAMSTTSession>()
  private readonly opusProcessor: OpusProcessor
  private spanEnded = false
  private stopped = false
  private completed = false
  private finishResolve?: () => void
  private finishReject?: (error: Error) => void

  constructor (private readonly webSocket: WebSocket, private readonly span?: Span,
    private readonly flushOnFinish = false) {
    super()
    this.opusProcessor = new OpusProcessor(
      data => this.send(data, true),
      sampleRate => this.send(JSON.stringify({ sample_rate: sampleRate }), false)
    )

    webSocket.on('message', (message) => {
      if (this.stopped) return
      const simplifiedMessage = Array.isArray(message) ? Buffer.concat(message) : Buffer.from(message as ArrayBuffer)
      const response = JSON.parse(simplifiedMessage.toString('utf8')) as GigaAMMessage
      if (response.end_of_utt) {
        this.completed = true
        this.finishResolve?.()
      }
      if (!this.stopped) {
        this.chunkTranscribed({
          endOfUtt: response.end_of_utt,
          text: response.text
        })
      }
    })
    webSocket.on('close', () => {
      this.finishReject?.(new Error('STT connection closed before final transcription'))
      this.stopped = true
    })
  }

  override async finish (): Promise<void> {
    if (!this.flushOnFinish || this.completed) return
    if (this.stopped) throw new Error('STT connection is closed')
    let timer: ReturnType<typeof setTimeout>
    try {
      await new Promise<void>((resolve, reject) => {
        this.finishResolve = resolve
        this.finishReject = reject
        timer = setTimeout(() => reject(new Error('STT final transcription timed out')), 45000)
        this.webSocket.send(JSON.stringify({ type: 'finish' }), error => {
          if (error) reject(error)
        })
      })
    } finally {
      clearTimeout(timer!)
      this.finishResolve = undefined
      this.finishReject = undefined
    }
  }

  override async markSpotterEnd (): Promise<void> {
    if (this.flushOnFinish) await this.send(JSON.stringify({ type: 'spotter_end' }), false)
  }

  close (): void {
    if (this.stopped) return
    this.stopped = true
    if (!this.spanEnded) {
      this.spanEnded = true
      this.span?.end()
    }
    if (this.webSocket.readyState === this.webSocket.OPEN) {
      this.webSocket.close()
    }
  }

  async transcribeChunk (chunk: Buffer): Promise<void> {
    if (this.stopped) return
    await this.opusProcessor.handleAudioData(chunk)
  }

  private send (data: Buffer | string, binary: boolean): Promise<void> {
    if (this.stopped || this.webSocket.readyState !== this.webSocket.OPEN) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.webSocket.send(data, { binary }, error => {
        if (error && !this.stopped) {
          this.logger.warn({ error: String(error), event: 'gigaam_socket_send_failed' })
        }
        resolve()
      })
    })
  }
}

export class GigaAMSTTBackend implements STTBackend {
  constructor (private readonly endpoint: string, private readonly flushOnFinish = false) {}

  startTranscribing (parentSpan?: Span): Promise<STTBackendSession> {
    let span: Span | undefined
    if (parentSpan) {
      span = startInactiveSpan({
        name: 'GigaAM STT transcribing',
        op: 'gigaam-stt',
        parentSpan
      })
    }
    const webSocket = new WebSocket(this.endpoint, span
      ? {
          headers: {
            ...getTraceData({
              span: startInactiveSpan({
                name: 'GigaAM STT transcribing connection',
                op: 'gigaam-stt-connection',
                parentSpan: span
              })
            })
          }
        }
      : {})
    return new Promise((resolve, reject) => {
      let opened = false
      webSocket.on('error', error => {
        if (!opened) reject(error)
      })
      webSocket.on('close', () => {
        if (!opened) reject(new Error('Unexpected close'))
      })
      webSocket.on('open', () => {
        opened = true
        resolve(new GigaAMSTTSession(webSocket, span, this.flushOnFinish))
      })
    })
  }
}
