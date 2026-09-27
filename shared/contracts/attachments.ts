export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export const IMAGE_ATTACHMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(",");
export const IMAGE_ATTACHMENT_ACCEPT = IMAGE_ATTACHMENT_MIME_TYPES.join(",");
