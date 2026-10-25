import { musicTrack, MusicTrack } from '@v3rt3p/types/music'

import { MusicBackend } from '../backend'

export class BasicMusicBackend extends MusicBackend {
  constructor (private readonly baseUrl: string) {
    super()
  }

  override async advanceQueueAutomatic (deviceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/commit`, { method: 'POST' })
    if (!response.ok) throw new Error(`Music automatic advance failed: ${response.status}`)
  }

  async advanceQueueBackward (deviceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/backward`, {
      method: 'POST'
    })
    if (!response.ok) throw new Error(`Music backward failed: ${response.status}`)
  }

  async advanceQueueForward (deviceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/forward`, {
      method: 'POST'
    })
    if (!response.ok) throw new Error(`Music forward failed: ${response.status}`)
  }

  async getCurrentTrack (deviceId: string): Promise<MusicTrack | null> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/current`, {
      method: 'GET'
    })

    if (!response.ok) throw new Error(`Music current failed: ${response.status}`)
    const body = await response.json()
    if (body === null) return null

    return musicTrack.parse(body)
  }

  async getNextTrack (deviceId: string): Promise<MusicTrack | null> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/next`, {
      method: 'GET'
    })

    if (!response.ok) throw new Error(`Music next failed: ${response.status}`)
    const body = await response.json()
    if (body === null) return null

    return musicTrack.parse(body)
  }
}
