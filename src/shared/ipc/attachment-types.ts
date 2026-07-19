export type ChatAttachment = {
  id: string
  kind: 'image' | 'file'
  name: string
  path: string
  mediaType: string
  size: number
}

export type AttachmentSaveInput = {
  name: string
  mediaType: string
  data: Uint8Array
}

export type AttachmentPreviewParams = {
  path: string
}

export type AttachmentPreviewResult = {
  dataUrl: string | null
}

export type ImageViewPreviewParams = {
  path: string
}

export type ImageViewPreviewResult = {
  dataUrl: string | null
}
