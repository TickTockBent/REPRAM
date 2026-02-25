import { describe, it, expect, vi, afterEach } from "vitest";
import { Logger } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Logger level filtering", () => {
  it("suppresses debug at info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");

    logger.debug("should not appear");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows info at info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");

    logger.info("visible");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[INFO]");
    expect(spy.mock.calls[0][0]).toContain("visible");
  });

  it("shows warn at info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");

    logger.warn("warning");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[WARN]");
  });

  it("shows error at all levels", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new Logger("error");

    logger.error("critical");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[ERROR]");
  });

  it("error level suppresses info and warn", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new Logger("error");

    logger.info("nope");
    logger.warn("nope");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("debug level shows everything", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new Logger("debug");

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(logSpy).toHaveBeenCalledTimes(3);  // debug, info, warn
    expect(errorSpy).toHaveBeenCalledTimes(1); // error
  });
});

describe("Logger output format", () => {
  it("includes timestamp and level label", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");

    logger.info("test message");

    const output = spy.mock.calls[0][0] as string;
    // ISO timestamp followed by [INFO]
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T.+\[INFO\] test message$/);
  });

  it("appends extra args", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");

    logger.info("count:", 42, "done");

    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("count: 42 done");
  });
});

describe("Logger defaults", () => {
  it("defaults to info when no level provided and env is unset", () => {
    const originalEnv = process.env.REPRAM_LOG_LEVEL;
    delete process.env.REPRAM_LOG_LEVEL;

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger();

    logger.debug("hidden");
    logger.info("visible");

    expect(spy).toHaveBeenCalledTimes(1);

    if (originalEnv !== undefined) process.env.REPRAM_LOG_LEVEL = originalEnv;
  });

  it("reads from REPRAM_LOG_LEVEL env var", () => {
    const originalEnv = process.env.REPRAM_LOG_LEVEL;
    process.env.REPRAM_LOG_LEVEL = "warn";

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger();

    logger.info("hidden at warn level");
    logger.warn("visible");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[WARN]");

    if (originalEnv !== undefined) {
      process.env.REPRAM_LOG_LEVEL = originalEnv;
    } else {
      delete process.env.REPRAM_LOG_LEVEL;
    }
  });

  it("treats invalid level as info", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("garbage" as any);

    logger.debug("hidden");
    logger.info("visible");

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
