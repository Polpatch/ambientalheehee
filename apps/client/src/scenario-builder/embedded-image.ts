import { inspectImageDataUri } from '@ambiental/core';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

function mimeFor(file: File): ImageMime | undefined {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') return file.type;
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  return undefined;
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  return btoa(binary);
}

export async function fileToEmbeddedImageDataUri(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Embedded image exceeds 8 MiB');
  const mime = mimeFor(file);
  if (!mime) throw new Error('Choose a PNG, JPEG or WebP image');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const location = `data:${mime};base64,${encodeBase64(bytes)}`;
  inspectImageDataUri(location);
  return location;
}
