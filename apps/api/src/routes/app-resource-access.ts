import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getAppRunRuntime } from "../lib/app-run-runtime.js";
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from "../lib/app-resource-sync-web-authority.js";
import { AppResourceAccessService } from "../lib/app-resource-access-service.js";
import { PrivateResourceAccessError } from "../lib/app-resource-access-contract.js";
import { AppError } from "../lib/app-errors.js";
export const appResourceAccessRoutes = new Hono();
appResourceAccessRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  await next();
});
const bound = bodyLimit({ maxSize: 16384, onError: c => c.json({ error: "Invalid access request", code: "APP_RESOURCE_ACCESS_INPUT_INVALID" }, 400) });
const smallBound = bodyLimit({ maxSize: 8192, onError: c => c.json({ error: "Invalid access request", code: "APP_RESOURCE_ACCESS_INPUT_INVALID" }, 400) });
async function caller(c: Context) {
  z.strictObject({}).parse(c.req.queries());
  const { actor, guard, web_session } = await resourceSyncWebAuthority(c.req.header("authorization"));
  const runtime = await getAppRunRuntime();
  return { service: new AppResourceAccessService(runtime.keys), subject: {
      org_id: actor.org_id,
      user_id: actor.actor_id,
      sid: web_session.sid,
      guard
    } };
}
function fail(c: Context, e: unknown) {
  if (e instanceof PrivateResourceAccessError || e instanceof ResourceSyncWebAuthenticationError || e instanceof AppError) {
    return c.json({ error: e.message, code: e.code }, e.status);
  }
  if (e instanceof z.ZodError) {
    return c.json({ error: "Invalid access request", code: "APP_RESOURCE_ACCESS_INPUT_INVALID" }, 400);
  }
  return c.json({ error: "Private access unavailable", code: "APP_RESOURCE_ACCESS_FAILURE" }, 500);
}
appResourceAccessRoutes.post("/reviews", smallBound, async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.prepare(subject, await c.req.json(), c.req.raw.signal));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.post("/inventory", smallBound, async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.inventory(subject, await c.req.json(), c.req.raw.signal));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.post("/maintenance/prune", smallBound, async (c) => {
  try {
    z.strictObject({}).parse(await c.req.json());
    const { service, subject } = await caller(c);
    return c.json(await service.prune(subject, c.req.raw.signal));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.post("/grants", bound, async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.accept(subject, await c.req.json(), c.req.raw.signal), 201);
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.get("/grants/:id/resource", async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.read(subject, z.string().uuid().parse(c.req.param("id")), c.req.raw.signal));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.delete("/grants/:id", async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.revoke(subject, z.string().uuid().parse(c.req.param("id")), c.req.raw.signal));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.get("/grants/:id/citation", async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.read(subject, z.string().uuid().parse(c.req.param("id")), c.req.raw.signal, "cite"));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.get("/grants/:id/scope", async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.read(subject, z.string().uuid().parse(c.req.param("id")), c.req.raw.signal, "scope"));
  }
  catch (e) {
    return fail(c, e);
  }
});
appResourceAccessRoutes.post("/grants/:id/search", bound, async (c) => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.search(subject, z.string().uuid().parse(c.req.param("id")), await c.req.json(), c.req.raw.signal));
  }
  catch (e) {
    return fail(c, e);
  }
});
