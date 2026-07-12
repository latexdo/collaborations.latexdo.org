import { routeRequest } from "./router";
import type { Env } from "./types";

export { ProjectRoom } from "./project-room";

export default {
  async fetch(request, env, ctx) {
    return routeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
