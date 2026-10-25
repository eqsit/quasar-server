import { Span, startInactiveSpan } from '@sentry/node'

import { ProcessorBackend, ProcessorPartialResponse, ProcessorSession } from '../../backend/backend'
import { getLogger } from '../../logger'
import { Notifier } from '../../notifier'
import proto from '../../protos/protos'
import { textToDirectiveMap, musicShortcuts, musicSeekShortcut, normalizeCommand } from '../alice/base-provider'
import { DirectiveFunctionProvider, mmSemanticFrame, ttsPlayPlaceholderDirective, WrappedDirective } from '../alice/directives'
import { continueSessionStage1SemanticFrame } from '../alice/typed-payloads'

export interface Input {
  metadata: InputMetadata
}

export interface InputHandlerProperties {
  directiveFunctionProvider: DirectiveFunctionProvider
  processor: ProcessorBackend
}

export type InputMetadata = Omit<object, 'deviceState'> & {
  deviceState?: proto.NAlice.NAliceApi.ITDeviceState
  deviceId?: string
}

export interface InputResult {
  dialogFinished: boolean
  directives: WrappedDirective[]
  shouldListen: boolean
  text: null | string
}

export type TextInput = Input & {
  data: TextInputData
}

export type TextInputData = {
  eventText: string
  kind: 'event'
} | {
  kind: 'continue'
} | {
  kind: 'musicFetchNextTrack'
} | {
  kind: 'musicRecoverCommit'
  recoverCommitToken: string
} | {
  kind: 'playButtonPressPlay'
} | {
  kind: 'text'
  text: string
} | {
  kind: 'tts'
  text: string
}

export type VoiceInput = Input & {
  text: string
}

// Buffered HTTP providers return a final answer rather than continuation callbacks.
const MAX_WAIT = 45000

export class InputHandler {
  private readonly logger = getLogger()
  private notifier: Notifier = new Notifier()
  private partialResponses: ProcessorPartialResponse[] = []
  private requestSent: boolean = false
  private session: null | ProcessorSession = null
  private span: Span | undefined
  private sessionGeneration = 0
  private openingSession: Promise<void> | null = null

  constructor (private readonly properties: InputHandlerProperties) {}

  closeSession (closePartially?: boolean): void {
    this.sessionGeneration++
    this.openingSession = null
    this.notifier.notifyAll()
    if (this.session) {
      if (!closePartially) {
        this.partialResponses = []
      }
      const session = this.session
      this.session = null
      session.close()
      this.requestSent = false
      this.logger.debug('Session closed')
      this.span?.end()
      this.span = undefined
    } else {
      this.logger.debug('Session already closed')
    }
  }

  async getPartialResponse (): Promise<null | ProcessorPartialResponse> {
    if (this.partialResponses.length > 0) {
      const response = this.partialResponses[0]
      this.partialResponses = this.partialResponses.slice(1)
      return response ?? null
    }

    if (!this.session || !this.requestSent) {
      return null
    }

    await this.notifier.wait(MAX_WAIT)

    if (this.partialResponses.length > 0) {
      const response = this.partialResponses[0]
      this.partialResponses = this.partialResponses.slice(1)
      return response ?? null
    }

    return null
  }

  async openSession (parentSpan?: Span): Promise<void> {
    if (this.session) return
    if (this.openingSession) return await this.openingSession
    const generation = this.sessionGeneration
    const pending = this.startSession(parentSpan, generation)
    this.openingSession = pending
    try {
      await pending
    } catch (error) {
      if (generation === this.sessionGeneration) throw error
    } finally {
      if (this.openingSession === pending) this.openingSession = null
    }
  }

  private async startSession (parentSpan: Span | undefined, generation: number): Promise<void> {
    const session = await this.properties.processor.openSession(parentSpan)
    if (generation !== this.sessionGeneration) {
      session.close()
      return
    }
    if (parentSpan) {
      this.span = startInactiveSpan({ name: 'InputHandler session processing', op: 'input-handler', parentSpan })
    }
    this.partialResponses = []
    this.session = session
    session.addListener('close', () => {
      if (this.session === session) this.closeSession(true)
    })
    session.addListener('partialResponse', data => {
      if (this.session !== session || generation !== this.sessionGeneration) return
      this.partialResponses.push(data)
      this.notifier.notifyAll()
    })
    await session.prepare(this.properties.directiveFunctionProvider.getSupportedFunctions())
  }

  async processTextInput (input: TextInput, parentSpan?: Span, dialogSpan?: Span): Promise<InputResult> {
    this.logger.debug(`Received TextInput with kind: ${input.data.kind}`)
    switch (input.data.kind) {
      case 'continue': {
        return await this.getPartialResponseResult(parentSpan)
      }
      case 'event': {
        if (!this.session) {
          await this.openSession(dialogSpan)
        }
        await this.session!.process({
          isExternalEvent: true,
          metadata: input.metadata,
          text: input.data.eventText
        })
        this.requestSent = true
        return await this.getPartialResponseResult(parentSpan)
      }
      case 'musicFetchNextTrack': {
        return {
          dialogFinished: true,
          directives: [{
            internalDirective: {
              type: 'music_recover_next_track'
            }
          }],
          shouldListen: false,
          text: null
        }
      }
      case 'musicRecoverCommit': {
        return {
          dialogFinished: true,
          directives: [{
            internalDirective: {
              recoverCommitToken: input.data.recoverCommitToken,
              type: 'music_recover_commit'
            }
          }],
          shouldListen: false,
          text: null
        }
      }
      case 'playButtonPressPlay': {
        return {
          dialogFinished: true,
          directives: [{
            internalDirective: {
              type: 'music_play'
            }
          }],
          shouldListen: false,
          text: null
        }
      }
      case 'text': {
        const command = normalizeCommand(input.data.text)
        const directive = textToDirectiveMap[command] ?? this.musicShortcut(command, input.metadata)
        if (!directive) {
          if (!this.session) await this.openSession(dialogSpan)
          await this.session!.process({ metadata: input.metadata, text: input.data.text })
          this.requestSent = true
          return await this.getPartialResponseResult(parentSpan)
        }

        return {
          dialogFinished: true,
          directives: [directive],
          shouldListen: false,
          text: null
        }
      }
      case 'tts': {
        return {
          dialogFinished: true,
          directives: [
            ttsPlayPlaceholderDirective()
          ],
          shouldListen: false,
          text: input.data.text
        }
      }
    }
  }

  async processVoiceInput (input: VoiceInput, parentSpan?: Span): Promise<InputResult> {
    this.logger.debug(`Received VoiceInput: ${input.text}`)
    const shortcut = this.musicShortcut(normalizeCommand(input.text), input.metadata)
    if (shortcut) return { dialogFinished: true, directives: [shortcut], shouldListen: false, text: null }
    if (!this.session) {
      this.logger.warn('No session opened')
      return {
        dialogFinished: true,
        directives: [
        ],
        shouldListen: false,
        text: null
      }
    }

    await this.session.process({
      metadata: input.metadata,
      text: input.text
    })
    this.requestSent = true
    return await this.getPartialResponseResult(parentSpan)
  }

  private musicShortcut (command: string, metadata: InputMetadata): WrappedDirective | undefined {
    const states = proto.NAlice.NAliceApi.TDeviceState.TAudioPlayer.TPlayerState
    const state = metadata.deviceState?.AudioPlayer?.PlayerState
    if (state !== states.Playing && state !== states.Buffering && state !== states.Paused) return undefined
    return musicShortcuts[command] ?? musicSeekShortcut(command)
  }

  private async getPartialResponseResult (parentSpan?: Span): Promise<InputResult> {
    if ((!this.session || !this.requestSent) && this.partialResponses.length === 0) {
      return {
        dialogFinished: true,
        directives: [],
        shouldListen: false,
        text: null
      }
    }

    let span: Span | undefined
    if (this.span && parentSpan) {
      span = startInactiveSpan({
        links: [{
          context: this.span?.spanContext()
        }],
        name: 'InputHandler waiting for partial response',
        op: 'input-handler-get-partial-response',
        parentSpan
      })
    }
    const partialResponse = await this.getPartialResponse()

    if (partialResponse === null) {
      span?.setAttribute('endReason', 'no-partial-response')
      span?.end()
      this.logger.debug('No partial response, sending continue')
      return {
        dialogFinished: false,
        directives: [
          mmSemanticFrame(continueSessionStage1SemanticFrame)
        ],
        shouldListen: false,
        text: null
      }
    }

    if (partialResponse.finished) {
      span?.setAttribute('endReason', 'partial-response-finished')
      span?.setAttribute('text', partialResponse.text)
      span?.setAttribute('should-listen', partialResponse.shouldListen)
      span?.setAttribute('directives', JSON.stringify(partialResponse.directives, undefined, 2))
      span?.end()
      this.logger.debug('Partial response is finished')
      if (partialResponse.finished && !partialResponse.shouldListen) {
        this.logger.debug('Partial response is finished, and no more input is required - closing')
        this.closeSession()
      }
      return {
        dialogFinished: !partialResponse.shouldListen,
        directives: [
          ...(partialResponse.directives.map(directive =>
            this.properties.directiveFunctionProvider
              .convertToWrappedDirective(directive)).filter(Boolean) as WrappedDirective[]),
          ...(partialResponse.text.trim() ? [ttsPlayPlaceholderDirective()] : [])
        ],
        shouldListen: partialResponse.shouldListen,
        text: partialResponse.text.trim() ? partialResponse.text : null
      }
    }

    this.logger.debug('Partial response is not finished, sending continue')
    span?.setAttribute('endReason', 'partial-response-not-finished')
    span?.setAttribute('text', partialResponse.text)
    span?.setAttribute('directives', JSON.stringify(partialResponse.directives, undefined, 2))
    span?.end()
    return {
      dialogFinished: false,
      directives: [
        ...(partialResponse.directives.map(directive =>
          this.properties.directiveFunctionProvider.convertToWrappedDirective(directive))
          .filter(Boolean) as WrappedDirective[]),
        ttsPlayPlaceholderDirective({
          TypedCallbackRequest: continueSessionStage1SemanticFrame
        })
      ],
      shouldListen: false,
      text: partialResponse.text
    }
  }
}
