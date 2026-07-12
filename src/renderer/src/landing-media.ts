export type LandingMediaSource = {
  src: string
  type: 'video/mp4' | 'video/webm'
}

export type LandingMediaConfig = {
  sources: LandingMediaSource[]
  poster?: string
  durationLabel: string
}

/**
 * Media replacement boundary.
 * Add the local MP4/WebM files and optional poster here; the landing page
 * component does not need to change.
 */
export const LANDING_MEDIA: LandingMediaConfig = {
  sources: [],
  poster: undefined,
  durationLabel: '01:18'
}
