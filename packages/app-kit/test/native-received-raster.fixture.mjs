// Captured received scanner before M37; test-only equality oracle.
// Original module SHA256 e9727aa8ffe186ab873afd93890b7a17ffc7b547871b8b542768fe484972b5ea
const MAX_BYTES=2*1024*1024;
const TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export function validMessageImage(bytes, type) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_BYTES || !TYPES.has(type)) return false;
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const bounded = (width, height) => width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4_000_000;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png') {
    if (!(bytes.length >= 33 && starts(137, 80, 78, 71, 13, 10, 26, 10)
      && [73,72,68,82].every((value,index) => bytes[index + 12] === value) && bounded(view.getUint32(16), view.getUint32(20)))) return false;
    for (let offset=8; offset + 12 <= bytes.length;) {
      const length=view.getUint32(offset); if (offset+12+length > bytes.length) return false;
      if (String.fromCharCode(...bytes.slice(offset+4,offset+8)) === 'acTL') return false;
      offset+=12+length;
    }
    return true;
  }
  if (type === 'image/gif') {
    if (!(bytes.length >= 14 && starts(71,73,70,56) && [55,57].includes(bytes[4]) && bytes[5]===97 && bounded(view.getUint16(6,true),view.getUint16(8,true)))) return false;
    let offset=13 + (bytes[10]&128 ? 3*(2**((bytes[10]&7)+1)) : 0),frames=0,pixels=0;
    const blocks=()=>{while(offset<bytes.length){const length=bytes[offset++];if(!length)return true;if(offset+length>bytes.length)return false;offset+=length;}return false;};
    while(offset<bytes.length){
      const kind=bytes[offset++]; if(kind===59)return frames>0;
      if(kind===33){if(offset>=bytes.length)return false;offset++;if(!blocks())return false;continue;}
      if(kind!==44||offset+9>=bytes.length)return false;
      const width=view.getUint16(offset+4,true),height=view.getUint16(offset+6,true);
      if(!bounded(width,height)||++frames>32||(pixels+=width*height)>16_000_000)return false;
      const packed=bytes[offset+8];offset+=9+(packed&128?3*(2**((packed&7)+1)):0);
      if(offset>=bytes.length)return false;offset++;if(!blocks())return false;
    }
    return false;
  }
  if (type === 'image/jpeg') {
    if (!starts(255, 216, 255)) return false;
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 255) return false;
      const marker = bytes[offset + 1];
      if (marker === 255) { offset++; continue; }
      if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) { offset += 2; continue; }
      if (marker === 217 || marker === 218) return false;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return false;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return length >= 8 && bounded(view.getUint16(offset + 7),view.getUint16(offset + 5));
      offset += 2 + length;
    }
    return false;
  }
  if (!(starts(82, 73, 70, 70) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value))) return false;
  const chunk = String.fromCharCode(...bytes.slice(12,16));
  if (chunk === 'VP8X' && bytes.length >= 30) {
    if (bytes[20] & 2) return false; // Animated WebP has an unbounded frame budget.
    return bounded(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return bounded(view.getUint16(26,true) & 0x3fff,view.getUint16(28,true) & 0x3fff);
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) return bounded(1 + bytes[21] + ((bytes[22] & 63) << 8),1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10));
  return false;
}
