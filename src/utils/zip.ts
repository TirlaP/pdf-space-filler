const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let j = 0; j < 8; j += 1) {
      if ((value & 1) !== 0) {
        value = 0xedb88320 ^ (value >>> 1);
      } else {
        value >>>= 1;
      }
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const computeCrc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    const lookupIndex = (crc ^ byte) & 0xff;
    crc = (crc >>> 8) ^ CRC32_TABLE[lookupIndex];
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const toDosDate = (date: Date) => {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();

  const dosTime =
    ((hours & 0x1f) << 11) |
    ((minutes & 0x3f) << 5) |
    ((Math.floor(seconds / 2) & 0x1f));
  const dosDate =
    (((Math.max(1980, Math.min(year, 2107)) - 1980) & 0x7f) << 9) |
    (((month + 1) & 0xf) << 5) |
    (day & 0x1f);

  return { dosTime, dosDate };
};

type ZipEntry = {
  name: string;
  data: Uint8Array;
  date?: Date;
};

export const createZipFromFiles = (files: ZipEntry[]): Blob => {
  const encoder = new TextEncoder();
  type EntryMeta = {
    name: string;
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc32: number;
    dosTime: number;
    dosDate: number;
    localHeaderLength: number;
    centralHeaderLength: number;
    localHeaderOffset: number;
  };

  const metadata: EntryMeta[] = files.map((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc32 = computeCrc32(data);
    const { dosTime, dosDate } = toDosDate(file.date ?? new Date());
    const localHeaderLength = 30 + nameBytes.length;
    const centralHeaderLength = 46 + nameBytes.length;
    return {
      name: file.name,
      nameBytes,
      data,
      crc32,
      dosTime,
      dosDate,
      localHeaderLength,
      centralHeaderLength,
      localHeaderOffset: 0,
    };
  });

  let offset = 0;
  metadata.forEach((entry) => {
    entry.localHeaderOffset = offset;
    offset += entry.localHeaderLength + entry.data.length;
  });

  const centralDirectorySize = metadata.reduce(
    (sum, entry) => sum + entry.centralHeaderLength,
    0,
  );
  const zipSize = offset + centralDirectorySize + 22;
  const buffer = new ArrayBuffer(zipSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pointer = 0;

  const writeUint32 = (value: number) => {
    view.setUint32(pointer, value >>> 0, true);
    pointer += 4;
  };
  const writeUint16 = (value: number) => {
    view.setUint16(pointer, value & 0xffff, true);
    pointer += 2;
  };

  metadata.forEach((entry) => {
    writeUint32(0x04034b50);
    writeUint16(20);
    writeUint16(0);
    writeUint16(0);
    writeUint16(entry.dosTime);
    writeUint16(entry.dosDate);
    writeUint32(entry.crc32);
    writeUint32(entry.data.length);
    writeUint32(entry.data.length);
    writeUint16(entry.nameBytes.length);
    writeUint16(0);
    bytes.set(entry.nameBytes, pointer);
    pointer += entry.nameBytes.length;
    bytes.set(entry.data, pointer);
    pointer += entry.data.length;
  });

  const centralDirectoryOffset = pointer;

  metadata.forEach((entry) => {
    writeUint32(0x02014b50);
    writeUint16(20);
    writeUint16(20);
    writeUint16(0);
    writeUint16(0);
    writeUint16(entry.dosTime);
    writeUint16(entry.dosDate);
    writeUint32(entry.crc32);
    writeUint32(entry.data.length);
    writeUint32(entry.data.length);
    writeUint16(entry.nameBytes.length);
    writeUint16(0);
    writeUint16(0);
    writeUint16(0);
    writeUint16(0);
    writeUint32(0);
    writeUint32(entry.localHeaderOffset);
    bytes.set(entry.nameBytes, pointer);
    pointer += entry.nameBytes.length;
  });

  writeUint32(0x06054b50);
  writeUint16(0);
  writeUint16(0);
  writeUint16(metadata.length);
  writeUint16(metadata.length);
  writeUint32(centralDirectorySize);
  writeUint32(centralDirectoryOffset);
  writeUint16(0);

  return new Blob([buffer], { type: 'application/zip' });
};
