import { fileURLToPath } from "node:url";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const LIST_ROOTS_TIMEOUT_MS = 3000;

/** The subset of the MCP Server API the resolver needs (eases testing). */
export interface RootsServer {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(
    params?: undefined,
    options?: { timeout?: number }
  ): Promise<{ roots: Array<{ uri: string; name?: string }> }>;
  setNotificationHandler(
    schema: typeof RootsListChangedNotificationSchema,
    handler: () => void | Promise<void>
  ): void;
}

/**
 * Returns a function that resolves the client's first file:// workspace root,
 * or null when the client has no roots capability or none is usable.
 *
 * The lookup is cached as a promise, so concurrent tool calls share a single
 * roots/list request instead of racing past an unfinished one. A failure or
 * timeout is not cached (the next call asks again), and the cache is cleared
 * on notifications/roots/list_changed.
 */
export function createRootResolver(server: RootsServer): () => Promise<string | null> {
  let cached: Promise<string | null> | null = null;

  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    cached = null;
  });

  async function lookup(): Promise<string | null> {
    if (!server.getClientCapabilities()?.roots) return null;
    const { roots } = await server.listRoots(undefined, { timeout: LIST_ROOTS_TIMEOUT_MS });
    const fileRoot = roots.find((root) => root.uri.startsWith("file://"));
    return fileRoot ? fileURLToPath(fileRoot.uri) : null;
  }

  return async () => {
    if (!cached) {
      const attempt = lookup();
      cached = attempt;
      attempt.catch(() => {
        // Don't cache failures; only clear if no newer lookup replaced this one.
        if (cached === attempt) cached = null;
      });
    }
    try {
      return await cached;
    } catch {
      return null;
    }
  };
}
