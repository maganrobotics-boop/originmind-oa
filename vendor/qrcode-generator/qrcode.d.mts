type QrCode = {
  addData(data: string, mode?: "Byte" | "Numeric" | "Alphanumeric"): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
  createSvgTag(options: { cellSize: number; margin: number; scalable: boolean }): string;
};
declare function qrcode(typeNumber: 0, level: "M"): QrCode;
export default qrcode;
