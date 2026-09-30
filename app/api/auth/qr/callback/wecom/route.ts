import { qrCallback } from "../../_lib/service";

export function GET(request: Request) {
  return qrCallback(request, "wecom");
}
