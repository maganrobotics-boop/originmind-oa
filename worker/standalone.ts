/** Cloudflare Worker entry point for deployments outside OpenAI Sites. */
import sitesWorker from "./index";
import { withoutUntrustedEdgeHeaders } from "../lib/request-security";

type WorkerEnv = Parameters<typeof sitesWorker.fetch>[1];
type WorkerExecutionContext = Parameters<typeof sitesWorker.fetch>[2];

const worker = {
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<void> {
    return sitesWorker.scheduled(controller, env, ctx);
  },
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    return sitesWorker.fetch(withoutUntrustedEdgeHeaders(request), env, ctx);
  },
};

export default worker;
