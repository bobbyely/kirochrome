export interface PendingImage {
  key: string;
  name: string;
  mime: string;
  /** base64 without the data: prefix. */
  data: string;
}

/** Refuse anything larger than this: it has to fit in a JSON message. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Reads an image file as base64, or null if it is not a usable image. */
export async function fileToImage(file: File): Promise<PendingImage | null> {
  if (!file.type.startsWith("image/")) return null;
  if (file.size > MAX_BYTES) return null;

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked: String.fromCharCode(...wholeArray) overflows the stack on a big
  // image.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return {
    key: `${file.name}-${file.size}-${crypto.randomUUID()}`,
    name: file.name || "pasted image",
    mime: file.type,
    data: btoa(binary),
  };
}
