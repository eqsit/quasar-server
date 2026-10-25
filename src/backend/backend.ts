import { Span } from '@sentry/node'
import { MusicTrack } from '@v3rt3p/types/music'
import { ProcessorDirectiveFunctions, ProcessorPartialResponseWebSocketMessage, ProcessorProcessWebSocketMessage } from '@v3rt3p/types/processor'
import { EventEmitter } from 'node:stream'

export interface AudioMetadataBackend {
  startCapturing(parentSpan?: Span): Promise<AudioMetadataBackendSession>;
}

export interface ProcessorBackend {
  openSession(parentSpan?: Span): Promise<ProcessorSession>;
}

export type ProcessorPartialResponse = ProcessorPartialResponseWebSocketMessage['data']

export type ProcessorRequest = ProcessorProcessWebSocketMessage['data']

export interface ProcessorSession extends EventEmitter<ProcessorSessionEvents> {
  close(): void;
  prepare(directiveFunctions: ProcessorDirectiveFunctions): Promise<void>;
  process(request: ProcessorRequest): Promise<void>;
}

export interface ProcessorSessionEvents {
  close: []
  partialResponse: [ProcessorPartialResponse]
}

export interface STTBackend {
  startTranscribing(span?: Span): Promise<STTBackendSession>;
}

export type STTChunkTranscribeCallback = (result: STTChunkTranscribeResult) => void

export interface STTChunkTranscribeResult {
  endOfUtt: boolean;
  text: string;
}

export interface TTSBackend {
  synthesize(request: TTSRequest): Promise<TTSResponse>;
}

export interface TTSRequest {
  deviceId?: string
  parentSpan?: Span
  text: string;
}

export interface TTSResponse {
  format: string;
  voiceOutput: Buffer;
}

export abstract class AudioMetadataBackendSession {
  abstract close (): void

  abstract finish (): Promise<object>

  abstract processChunk (chunk: Buffer): Promise<void>
}

export abstract class MusicBackend {
  async advanceQueueAutomatic (deviceId: string): Promise<void> {
    await this.advanceQueueForward(deviceId)
  }
  abstract advanceQueueBackward (deviceId: string): Promise<void>

  abstract advanceQueueForward (deviceId: string): Promise<void>

  abstract getCurrentTrack (deviceId: string): Promise<MusicTrack | null>

  abstract getNextTrack (deviceId: string): Promise<MusicTrack | null>
}

export abstract class STTBackendSession {
  private callback: null | STTChunkTranscribeCallback = null

  abstract close (): void

  // Buffered recognizers must finish their request before the session is closed.
  async finish (): Promise<void> {}

  async markSpotterEnd (): Promise<void> {}

  setCallback (callback: STTChunkTranscribeCallback): void {
    this.callback = callback
  }

  abstract transcribeChunk (chunk: Buffer): void

  protected chunkTranscribed (result: STTChunkTranscribeResult): void {
    if (this.callback) {
      this.callback(result)
    }
  }
}
