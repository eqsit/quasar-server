import { OpusEncoder } from '@discordjs/opus'

import { OggPage, OggParser } from './ogg-parser'

const OPUS_HEAD_BUFFER = Buffer.from([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])

interface OpusHead {
  channelCount: number;
  outputGain: number;
  preSkip: number;
  sampleRate: number;
}

export class OpusProcessor {
  private encoder: null | OpusEncoder = null
  private pending = Buffer.alloc(0)
  private packetParts: Buffer[] = []

  constructor (private readonly onAudioData: (data: Buffer) => Promise<void>,
    private readonly onSampleRate: (sampleRate: number) => Promise<void>) {}

  async handleAudioData (audioData: Buffer): Promise<void> {
    this.pending = Buffer.concat([this.pending, audioData])
    while (this.pending.length >= 27) {
      if (this.pending.toString('ascii', 0, 4) !== 'OggS') throw new Error('Not an Ogg stream')
      const headerLength = 27 + this.pending.readUInt8(26)
      if (this.pending.length < headerLength) return
      let pageLength = headerLength
      for (let index = 27; index < headerLength; index++) pageLength += this.pending.readUInt8(index)
      if (this.pending.length < pageLength) return
      const [page] = OggParser.parse(this.pending.subarray(0, pageLength))
      this.pending = this.pending.subarray(pageLength)
      await this.handleOpusPage(page!)
    }
  }

  private async handleOpusPage (page: OggPage): Promise<void> {
    if (page.pageSequenceNumber === 0) {
      this.packetParts = []
    }
    // Ogg lacing values describe fragments; a 255-byte segment is not a complete packet.
    for (const segment of page.segments) {
      this.packetParts.push(segment)
      if (segment.length === 255) continue
      const packet = Buffer.concat(this.packetParts)
      this.packetParts = []
      if (packet.subarray(0, 8).equals(OPUS_HEAD_BUFFER)) {
        const head = parseOpusHead(packet)
        if (head.channelCount !== 1) throw new Error(`Unsupported number of channels: ${head.channelCount}`)
        // OpusHead's rate is informational. Decode at the recognizer's 16 kHz rate.
        this.encoder = new OpusEncoder(16000, head.channelCount)
        await this.onSampleRate(16000)
      } else if (packet.toString('ascii', 0, 8) !== 'OpusTags') {
        if (!this.encoder) throw new Error("Can't decode Opus without OpusHead before")
        await this.onAudioData(this.encoder.decode(packet))
      }
    }
  }
}

function parseOpusHead (buffer: Buffer): OpusHead {
  const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (!buffer.subarray(0, 8).equals(OPUS_HEAD_BUFFER)) {
    throw new Error('OpusHead is not present in zero page')
  }
  if (dataView.getUint8(8) !== 1) {
    throw new Error('Wrong Opus version')
  }
  const channelCount = dataView.getUint8(9)
  const preSkip = dataView.getUint16(10, true)
  const sampleRate = dataView.getUint32(12, true)
  const outputGain = dataView.getUint16(14, true)
  const mappingFamily = dataView.getUint8(16)
  if (mappingFamily !== 0) {
    throw new Error('Unsupported mapping family')
  }
  return {
    channelCount,
    outputGain,
    preSkip,
    sampleRate
  }
}
