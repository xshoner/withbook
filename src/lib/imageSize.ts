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

/** 올린 이미지의 긴 변 상한 — A5 풀블리드(154×216mm)도 300 DPI(약 2,551px)를 넘는다 */
export const MAX_EDGE_PX = 3200;

export type PreparedImage = { buffer: Buffer; width: number; height: number; mime: string };

/**
 * 올린 이미지를 저장 전에 다듬는다 (서버 전용 — sharp).
 * - 휴대폰 사진의 EXIF 방향을 실제 픽셀에 반영한다(가로세로가 뒤바뀌어 DPI·HWPX 비율이 틀리던 문제)
 * - 긴 변이 3,200px를 넘을 때만 줄인다(그 이하는 원본 그대로)
 * - WEBP는 한글(HWPX)이 읽지 못할 수 있어 PNG(투명 있음)·JPEG(없음)로 바꾼다
 * 형식은 유지한다(JPEG 품질 92, PNG는 PNG). 돌려주는 크기는 저장할 파일의 실제 픽셀이다.
 */
export async function prepareImage(buf: Buffer): Promise<PreparedImage | null> {
  const head = imageSize(buf);
  if (!head) return null;
  const sharp = (await import("sharp")).default;
  const opts = { failOn: "none" as const, limitInputPixels: 100_000_000 };
  const meta = await sharp(buf, opts).metadata();
  const orient = meta.orientation ?? 1;
  const w0 = meta.width ?? head.width;
  const h0 = meta.height ?? head.height;
  const [w, h] = orient >= 5 ? [h0, w0] : [w0, h0]; // 5~8: 90도 돌린 방향
  const resize = Math.max(w, h) > MAX_EDGE_PX;
  const webp = head.mime === "image/webp";
  if (orient <= 1 && !resize && !webp) return { buffer: buf, width: w, height: h, mime: head.mime };

  let img = sharp(buf, opts).rotate(); // EXIF 방향대로 돌리고 방향 표시는 지운다
  if (resize) img = img.resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true });
  const png = head.mime === "image/png" || (webp && Boolean(meta.hasAlpha));
  img = png ? img.png({ compressionLevel: 9 }) : img.jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, mime: png ? "image/png" : "image/jpeg" };
}
