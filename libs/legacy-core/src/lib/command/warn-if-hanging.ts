import { log } from "@lerna/core";

const childProcess = require("@lerna/child-process");

export function warnIfHanging() {
  const childProcessCount = childProcess.getChildProcessCount();

  if (childProcessCount > 0) {
    log.warn(
      "complete",
      `Waiting for ${childProcessCount} child ` +
        `process${childProcessCount === 1 ? "" : "es"} to exit. ` +
        "CTRL-C to exit immediately."
    );
  }
}
