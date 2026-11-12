import { describe, expect, it } from "vitest";
import { getRunningServices, settleDefaultPorts, type Lookup } from "../src/tools/processes.js";
import { makeProject, startListener } from "./helpers.js";

const canCheckOwnership = process.platform === "linux" || process.platform === "darwin";

describe("getRunningServices", () => {
  it("returns empty arrays for no expected ports", async () => {
    const result = await getRunningServices([]);
    expect(result).toMatchObject({ running: [], expected_but_missing: [], detection_available: true });
  });

  it("treats invalid ports as missing", async () => {
    const result = await getRunningServices([99999]);
    expect(result.running).toEqual([]);
    expect(result.expected_but_missing).toEqual([99999]);
  });

  it("detects a process listening on a port (regression: silently missed without netstat)", async () => {
    const dir = makeProject();
    const { port, pid } = await startListener(dir);
    const result = await getRunningServices([port], dir);
    expect(result.detection_available).toBe(true);
    expect(result.expected_but_missing).toEqual([]);
    expect(result.running).toHaveLength(1);
    expect(result.running[0].port).toBe(port);
    expect(result.running[0].pid).toBe(pid);
  });

  it.skipIf(!canCheckOwnership)("marks a listener started from the project as owned", async () => {
    const dir = makeProject();
    const { port } = await startListener(dir);
    const [service] = (await getRunningServices([port], dir)).running;
    expect(service.owned_by_project).toBe(true);
  });

  it.skipIf(!canCheckOwnership)("marks a listener started from another directory as not owned", async () => {
    const project = makeProject();
    const elsewhere = makeProject();
    const { port } = await startListener(elsewhere);
    const [service] = (await getRunningServices([port], project)).running;
    expect(service.owned_by_project).toBe(false);
    expect(service.process_cwd).toBeTruthy();
  });

  it("reports a free port as missing", async () => {
    const dir = makeProject();
    const { port } = await startListener(dir);
    // A port right next to a live one is almost certainly free; skip if not.
    const free = port === 65535 ? port - 1 : port + 1;
    const result = await getRunningServices([free], dir);
    if (result.running.length === 0) expect(result.expected_but_missing).toEqual([free]);
  });
});

describe("getRunningServices per-port fallback (unchecked_ports)", () => {
  const fails: Lookup = async () => {
    throw new Error("unavailable");
  };
  const failsOn = (bad: number): Lookup => async (port) => {
    if (port === bad) throw new Error("timed out");
    return null;
  };
  const holds = (held: number): Lookup => async (port) => (port === held ? { pid: 7, name: "node" } : null);

  it("lists ports whose lookup failed while others succeeded", async () => {
    const result = await getRunningServices([3000, 8080], undefined, { procfs: false, chain: [["a", failsOn(8080)]] });
    expect(result.detection_available).toBe(true);
    expect(result.expected_but_missing).toEqual([3000]);
    expect(result.unchecked_ports).toEqual([8080]);
  });

  it("tries the next method for a port the first one couldn't check", async () => {
    const result = await getRunningServices([3000, 8080], undefined, {
      procfs: false,
      chain: [["a", failsOn(8080)], ["b", holds(8080)]],
    });
    expect(result.unchecked_ports).toEqual([]);
    expect(result.running.map((s) => s.port)).toEqual([8080]);
    expect(result.expected_but_missing).toEqual([3000]);
  });

  it("reports detection unavailable when every lookup fails", async () => {
    const result = await getRunningServices([3000, 8080], undefined, { procfs: false, chain: [["a", fails]] });
    expect(result.detection_available).toBe(false);
    expect(result.unchecked_ports).toEqual([3000, 8080]);
    expect(result.expected_but_missing).toEqual([]);
  });
});

describe("settleDefaultPorts", () => {
  const base = {
    running: [{ port: 3000, pid: 1, name: "node", process_cwd: null, owned_by_project: true }],
    expected_but_missing: [8080],
    unchecked_ports: [],
    detection_available: true,
    detection_method: "procfs",
  };

  it("clears the other default ports once our server is up", () => {
    expect(settleDefaultPorts(base, "default").expected_but_missing).toEqual([]);
  });

  it("keeps missing ports when they came from config", () => {
    expect(settleDefaultPorts(base, "config").expected_but_missing).toEqual([8080]);
  });

  it("keeps missing ports when only a foreign process is up", () => {
    const foreign = { ...base, running: [{ ...base.running[0], owned_by_project: false }] };
    expect(settleDefaultPorts(foreign, "default").expected_but_missing).toEqual([8080]);
  });
});
