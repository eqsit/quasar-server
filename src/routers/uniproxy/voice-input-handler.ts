import { Span, startInactiveSpan } from '@sentry/node'
import { Sema } from 'async-sema'
import EventEmitter from 'node:events'

import { AudioMetadataBackend, AudioMetadataBackendSession, STTBackend, STTBackendSession } from '../../backend/backend'
import { getLogger } from '../../logger'
import { InputMetadata } from './input-handler'

export interface VoiceInputAudioEvent {
  buffer: Buffer
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VoiceInputCancelEvent {
}

export interface VoiceInputEvent {
  metadata: InputMetadata
  parentSpan?: Span
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VoiceInputFinishEvent {
}

export interface VoiceInputHandlerErrorEvent {
  error: unknown
}

export interface VoiceInputHandlerEvents {
  error: [VoiceInputHandlerErrorEvent]
  finish: [VoiceInputHandlerFinishEvent]
  transcribed: [VoiceInputHandlerTranscribedEvent]
}

export interface VoiceInputHandlerFinishEvent {
  metadata: InputMetadata
  text: string
}

export interface VoiceInputHandlerProperties {
  audioMetadata: AudioMetadataBackend
  stt: STTBackend
}

export interface VoiceInputHandlerTranscribedEvent {
  text: string
}

export interface VoiceInputSpeakerMetadataEvent {
  metadata: object
}

// eslint-disable-next-line unicorn/prefer-event-target
export class VoiceInputHandler extends EventEmitter<VoiceInputHandlerEvents> {
  private audioDataQueue: (Buffer | 'spotter_end')[] = []
  private audioMetadataSession: AudioMetadataBackendSession | null = null
  private audioSendingLock = new Sema(1)
  private lastTranscribeResult: string = ''
  private readonly logger = getLogger<VoiceInputHandler>()
  private metadata: InputMetadata = {}
  private sttSession: null | STTBackendSession = null
  private voiceSpan: null | Span = null
  private finalizing = false
  private generation = 0
  private initialization: Promise<void> | null = null

  constructor (private readonly properties: VoiceInputHandlerProperties) {
    super()
  }

  close (): void {
    this.generation++
    this.finalizing = false
    this.initialization = null
    this.audioMetadataSession?.close()
    this.audioMetadataSession = null
    this.sttSession?.close()
    this.sttSession = null
    this.audioDataQueue = []
    this.lastTranscribeResult = ''
    this.metadata = {}

    this.voiceSpan?.setAttribute('endReason', 'close')
    this.voiceSpan?.end()
    this.voiceSpan = null
  }

  async handleVoiceInputAudioEvent (data: VoiceInputAudioEvent): Promise<void> {
    await this.audioSendingLock.acquire()
    try {
      if (this.audioMetadataSession && this.sttSession) {
        await Promise.all([this.audioMetadataSession.processChunk(data.buffer),
          this.sttSession.transcribeChunk(data.buffer)])
      } else {
        this.audioDataQueue.push(data.buffer)
      }
    } finally {
      this.audioSendingLock.release()
    }
  }

  async handleVoiceInputCancelEvent (_request: VoiceInputCancelEvent): Promise<void> {
    this.logger.debug('VoiceInputHandler received Cancel')
    this.close()
  }

  async handleSpotterEndEvent (): Promise<void> {
    await this.audioSendingLock.acquire()
    try {
      if (this.sttSession) await this.sttSession.markSpotterEnd()
      else this.audioDataQueue.push('spotter_end')
    } finally {
      this.audioSendingLock.release()
    }
  }

  async handleVoiceInputEvent (request: VoiceInputEvent): Promise<void> {
    this.logger.debug('VoiceInputHandler received Input')
    this.close()
    const generation = this.generation
    this.metadata = { ...request.metadata }
    const pending = this.initialize(request, generation)
    this.initialization = pending
    await pending
    if (generation === this.generation) this.initialization = null
  }

  private async initialize (request: VoiceInputEvent, generation: number): Promise<void> {
    if (request.parentSpan) {
      this.voiceSpan = startInactiveSpan({
        name: 'VoiceInputHandler processing',
        op: 'voice-input-handler',
        parentSpan: request.parentSpan
      })
    }

    let audioMetadataSession: AudioMetadataBackendSession
    let sttSession: STTBackendSession

    try {
      [audioMetadataSession, sttSession] = await Promise.all([
        this.properties.audioMetadata.startCapturing(this.voiceSpan ?? undefined),
        this.properties.stt.startTranscribing(this.voiceSpan ?? undefined)
      ])
    } catch (error) {
      if (generation !== this.generation) return
      this.emit('error', {
        error
      })
      this.close()
      return
    }

    if (generation !== this.generation) {
      audioMetadataSession.close()
      sttSession.close()
      return
    }

    sttSession.setCallback(({ endOfUtt, text }) => {
      if (generation !== this.generation) return
      this.lastTranscribeResult = text
      this.emit('transcribed', {
        text
      })
      this.logger.debug(`VoiceInputHandler transcribed: ${text}`)
      if (endOfUtt) void this.complete(false)
    })

    this.logger.debug('VoiceInputHandler streams created')

    await this.audioSendingLock.acquire()
    try {
      while (this.audioDataQueue.length > 0) {
        const copy = [...this.audioDataQueue]

        for (const data of copy) {
          if (data === 'spotter_end') await sttSession.markSpotterEnd()
          else await Promise.all([audioMetadataSession.processChunk(data), sttSession.transcribeChunk(data)])
        }
        this.logger.debug(`Sent ${this.audioDataQueue.length} chunks`)
        this.audioDataQueue = this.audioDataQueue.slice(copy.length)
      }

      this.audioMetadataSession = audioMetadataSession
      this.sttSession = sttSession
    } finally {
      this.audioSendingLock.release()
    }

    this.logger.debug('VoiceInputHandler streaming started')
  }

  async handleVoiceInputFinishEvent (_request: VoiceInputFinishEvent): Promise<void> {
    this.logger.debug('VoiceInputHandler received Finish')
    await this.complete(true)
  }

  private async complete (flush: boolean): Promise<void> {
    if (this.finalizing) return
    this.finalizing = true
    const generation = this.generation
    try {
      await this.initialization
      if (generation !== this.generation) return
      await this.audioSendingLock.acquire()
      try {
        if (flush) await this.sttSession?.finish()
        if (generation !== this.generation) return
        await this.stop()
        if (generation === this.generation) this.transcribeFinished()
      } finally {
        this.audioSendingLock.release()
      }
    } catch (error) {
      if (generation !== this.generation) return
      this.emit('error', { error })
      this.close()
    }
  }

  async handleVoiceInputSpeakerMetadataEvent (request: VoiceInputSpeakerMetadataEvent): Promise<void> {
    this.logger.debug('VoiceInputHandler received Metadata')
    this.metadata = {
      ...this.metadata,
      ...request.metadata
    }
  }

  private async stop (): Promise<void> {
    this.metadata = {
      ...this.metadata,
      ...(await this.audioMetadataSession?.finish())
    }
    this.audioMetadataSession = null
    this.sttSession?.close()
    this.sttSession = null
    this.audioDataQueue = []
    this.voiceSpan?.setAttribute('endReason', 'finish')
    this.voiceSpan?.setAttribute('text', this.lastTranscribeResult)
    this.voiceSpan?.setAttribute('metadata', JSON.stringify(this.metadata, undefined, 2))
    this.voiceSpan?.end()
    this.voiceSpan = null
  }

  private transcribeFinished (): void {
    const metadata = this.metadata
    this.metadata = {}
    this.logger.debug(`VoiceInputHandler transcribe finished: ${this.lastTranscribeResult}`)
    this.emit('finish', {
      metadata: metadata!,
      text: this.lastTranscribeResult
    })
  }
}
