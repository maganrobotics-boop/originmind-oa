import qrcode from "../vendor/qrcode-generator/qrcode.mjs";

export function generateQrSvg(value: string) {
  if (value.length > 512 || !/^[\x20-\x7e]+$/u.test(value) || new URL(value).protocol !== "https:") throw new Error("QR address is invalid");
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true });
}
