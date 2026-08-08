const HEADER_BYTES = 16;

export const FILE_CHUNK_BYTES = 64 * 1024;

export interface FileFrame {
  fileIndex: number;
  offset: number;
  data: Buffer;
}

export function encodeFileFrame(frame: FileFrame): Buffer {
  if (!Number.isSafeInteger(frame.fileIndex) || frame.fileIndex < 0) {
    throw new Error('Invalid file index');
  }
  if (!Number.isSafeInteger(frame.offset) || frame.offset < 0) {
    throw new Error('Invalid file offset');
  }
  if (frame.data.length > FILE_CHUNK_BYTES) throw new Error('File frame exceeds chunk limit');
  const output = Buffer.allocUnsafe(HEADER_BYTES + frame.data.length);
  output.writeUInt32BE(frame.fileIndex, 0);
  output.writeBigUInt64BE(BigInt(frame.offset), 4);
  output.writeUInt32BE(frame.data.length, 12);
  frame.data.copy(output, HEADER_BYTES);
  return output;
}

export function decodeFileFrame(input: Buffer): FileFrame {
  if (input.length < HEADER_BYTES) throw new Error('Truncated file frame');
  const fileIndex = input.readUInt32BE(0);
  const offset = Number(input.readBigUInt64BE(4));
  const length = input.readUInt32BE(12);
  if (!Number.isSafeInteger(offset)) throw new Error('File offset exceeds safe integer range');
  if (length > FILE_CHUNK_BYTES || input.length !== HEADER_BYTES + length) {
    throw new Error('Invalid file frame length');
  }
  return { fileIndex, offset, data: input.subarray(HEADER_BYTES) };
}
