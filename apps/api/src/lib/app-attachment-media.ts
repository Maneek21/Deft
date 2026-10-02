import type { AttachmentPolicy } from '@deft/app-kit';

/** Classification only, not malware certification. Nothing is rendered inline,
 * expanded, or fetched from a provider URL. Unknown/mismatched bytes are blocked. */
export function appAttachmentMediaAllowed(bytes: Uint8Array, declared: AttachmentPolicy['allowed_media_types'][number]): boolean {
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const starts = (prefix: readonly number[]) => prefix.every((byte, index) => value[index] === byte);
  if (declared === 'image/png') return value.length >= 33
    && starts([137, 80, 78, 71, 13, 10, 26, 10]) && value.subarray(12, 16).toString('ascii') === 'IHDR';
  if (declared === 'image/jpeg') return value.length >= 4 && starts([255, 216, 255])
    && value[value.length - 2] === 255 && value[value.length - 1] === 217;
  if (declared === 'image/gif') return value.length >= 14
    && ['GIF87a', 'GIF89a'].includes(value.subarray(0, 6).toString('ascii')) && value[value.length - 1] === 59;
  if (declared === 'image/webp') return value.length >= 20 && value.subarray(0, 4).toString('ascii') === 'RIFF'
    && value.subarray(8, 12).toString('ascii') === 'WEBP' && value.readUInt32LE(4) === value.length - 8;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { return false; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    || /^\s*(?:<!doctype\s+html|<html(?:\s|>)|<svg(?:\s|>))/iu.test(text)) return false;
  if (declared === 'application/json') {
    try { JSON.parse(text); return true; } catch { return false; }
  }
  return declared === 'text/plain' || declared === 'text/csv';
}
