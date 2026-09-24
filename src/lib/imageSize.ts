/** PNG / JPEG / WEBP 헤더에서 픽셀 크기를 읽는다 (외부 라이브러리 없이) */
export function imageSize(buf: Buffer): { width: number; height: number; mime: string } | null {
  if (buf.length < 24) return null;
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: "image/png" };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: "image/jpeg" };
      }
      i += 2 + len;
    }
    return null;
  }
  // WEBP
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, mime: "image/webp" };
    if (fmt === "VP8L") {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), mime: "image/webp" };
    }
    if (fmt === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), mime: "image/webp" };
  }
  return null;
}
