import fs from "node:fs";

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const count = fs.readSync(fd, buffer, 0, length, position);
  if (count !== length) throw new Error("Unexpected end of media file.");
  return buffer;
}

function boxes(fd, start, end) {
  const items = [];
  let position = start;
  while (position + 8 <= end) {
    const header = readAt(fd, position, 8);
    let size = header.readUInt32BE(0);
    const type = header.toString("ascii", 4, 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(readAt(fd, position + 8, 8).readBigUInt64BE(0));
      headerSize = 16;
    } else if (size === 0) size = end - position;
    if (!Number.isSafeInteger(size) || size < headerSize || position + size > end) break;
    items.push({ type, start: position, dataStart: position + headerSize, end: position + size });
    position += size;
  }
  return items;
}

export function probeMp4Dimensions(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const moov = boxes(fd, 0, size).find((item) => item.type === "moov");
    if (!moov) throw new Error("MP4 moov box was not found.");
    for (const trak of boxes(fd, moov.dataStart, moov.end).filter((item) => item.type === "trak")) {
      const tkhd = boxes(fd, trak.dataStart, trak.end).find((item) => item.type === "tkhd");
      if (!tkhd || tkhd.end - tkhd.dataStart < 8) continue;
      const dimensions = readAt(fd, tkhd.end - 8, 8);
      const width = Math.round(dimensions.readUInt32BE(0) / 65536);
      const height = Math.round(dimensions.readUInt32BE(4) / 65536);
      if (width > 0 && height > 0) return { width, height };
    }
    throw new Error("A video track with dimensions was not found.");
  } finally {
    fs.closeSync(fd);
  }
}
