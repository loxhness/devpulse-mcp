import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createRootResolver, type RootsServer } from "../src/utils/roots.js";

const dirA = resolve("tests", "fixtures", "express");
const dirB = resolve("tests", "fixtures", "nextjs");

function fakeServer(opts: { roots?: boolean; list: () => Promise<{ roots: Array<{ uri: string }> }> }) {
  let onChanged: (() => void) | undefined;
  const server: RootsServer = {
    getClientCapabilities: () => (opts.roots === false ? {} : { roots: { listChanged: true } }),
    listRoots: vi.fn(opts.list),
    setNotificationHandler: (_schema, handler) => {
      onChanged = handler as () => void;
    },
  };
  return { server, fireChanged: () => onChanged?.() };
}

const rootsOf = (...dirs: string[]) => async () => ({ roots: dirs.map((d) => ({ uri: pathToFileURL(d).href })) });

describe("createRootResolver", () => {
  it("returns null without asking when the client has no roots capability", async () => {
    const { server } = fakeServer({ roots: false, list: rootsOf(dirA) });
    await expect(createRootResolver(server)()).resolves.toBeNull();
    expect(server.listRoots).not.toHaveBeenCalled();
  });

  it("shares one in-flight roots/list between concurrent callers", async () => {
    const { server } = fakeServer({
      list: () => new Promise((r) => setTimeout(() => r({ roots: [{ uri: pathToFileURL(dirA).href }] }), 50)),
    });
    const resolveRoot = createRootResolver(server);
    await expect(Promise.all([resolveRoot(), resolveRoot(), resolveRoot()])).resolves.toEqual([dirA, dirA, dirA]);
    expect(server.listRoots).toHaveBeenCalledTimes(1);
  });

  it("skips non-file roots and uses the first file:// root", async () => {
    const { server } = fakeServer({
      list: async () => ({ roots: [{ uri: "https://example.com/repo" }, { uri: pathToFileURL(dirB).href }] }),
    });
    await expect(createRootResolver(server)()).resolves.toBe(dirB);
  });

  it("does not cache a failure or timeout", async () => {
    let attempt = 0;
    const { server } = fakeServer({
      list: async () => {
        attempt++;
        if (attempt === 1) throw new Error("Request timed out");
        return { roots: [{ uri: pathToFileURL(dirA).href }] };
      },
    });
    const resolveRoot = createRootResolver(server);
    await expect(resolveRoot()).resolves.toBeNull();
    await expect(resolveRoot()).resolves.toBe(dirA);
    expect(server.listRoots).toHaveBeenCalledTimes(2);
  });

  it("refreshes after roots/list_changed", async () => {
    let current = dirA;
    const { server, fireChanged } = fakeServer({ list: async () => ({ roots: [{ uri: pathToFileURL(current).href }] }) });
    const resolveRoot = createRootResolver(server);
    await expect(resolveRoot()).resolves.toBe(dirA);
    await expect(resolveRoot()).resolves.toBe(dirA);
    current = dirB;
    fireChanged();
    await expect(resolveRoot()).resolves.toBe(dirB);
    expect(server.listRoots).toHaveBeenCalledTimes(2);
  });
});
