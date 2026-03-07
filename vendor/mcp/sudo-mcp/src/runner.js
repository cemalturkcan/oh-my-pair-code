import { spawn } from "node:child_process";

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(command, pattern) {
  return wildcardToRegex(pattern).test(command);
}

function validateCommandSyntax(command) {
  const normalized = command.trim();
  if (!normalized) return "Command must not be empty.";
  if (normalized.includes("\n") || normalized.includes("\r")) {
    return "Multiline commands are not allowed.";
  }

  return null;
}

export function evaluateCommandPolicy(command, config) {
  const syntaxError = validateCommandSyntax(command);
  if (syntaxError) {
    return {
      allowed: false,
      reason: syntaxError,
    };
  }

  const normalized = command.trim();
  const deniedBy = config.deny_patterns.find((pattern) => matchesPattern(normalized, pattern));
  if (deniedBy) {
    return {
      allowed: false,
      reason: `Command blocked by deny pattern '${deniedBy}'.`,
    };
  }

  if (config.require_allowlist && config.allow_patterns.length === 0) {
    return {
      allowed: false,
      reason: "No allow patterns configured. Add allow_patterns in sudo-mcp config.",
    };
  }

  if (config.require_allowlist) {
    const allowedBy = config.allow_patterns.find((pattern) => matchesPattern(normalized, pattern));
    if (!allowedBy) {
      return {
        allowed: false,
        reason: "Command does not match allow_patterns.",
      };
    }

    return {
      allowed: true,
      reason: `Command matched allow pattern '${allowedBy}'.`,
    };
  }

  return {
    allowed: true,
    reason: "Allowlist not required by policy.",
  };
}

function clampTimeout(requested, config) {
  const parsed = Number(requested);
  const fallback = config.default_timeout_seconds;
  const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return Math.min(value, config.max_timeout_seconds);
}

function appendChunk(buffer, chunk, maxBytes) {
  if (buffer.length >= maxBytes) {
    return { text: buffer, full: false };
  }

  const remaining = maxBytes - buffer.length;
  const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
  return {
    text: buffer + slice,
    full: chunk.length <= remaining,
  };
}

export async function runSudoCommand(command, requestedTimeoutSeconds, config) {
  const policy = evaluateCommandPolicy(command, config);
  if (!policy.allowed) {
    throw new Error(policy.reason);
  }

  const timeoutSeconds = clampTimeout(requestedTimeoutSeconds, config);

  return await new Promise((resolve) => {
    const args = [];
    if (config.require_non_interactive_sudo) args.push("-n");
    args.push("bash", "-lc", command);

    const start = Date.now();
    const proc = spawn("sudo", args, {
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTruncated = false;
    let killedByOutputLimit = false;

    const finish = (code, errorMessage) => {
      const durationMs = Date.now() - start;
      const ok = code === 0 && !timedOut && !killedByOutputLimit && !errorMessage;

      resolve({
        ok,
        command,
        timeout_seconds: timeoutSeconds,
        non_interactive_sudo: config.require_non_interactive_sudo,
        exit_code: code,
        duration_ms: durationMs,
        timed_out: timedOut,
        output_truncated: outputTruncated,
        stdout,
        stderr: errorMessage ? `${stderr}\n${errorMessage}`.trim() : stderr,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    proc.stdout.on("data", (chunk) => {
      const result = appendChunk(stdout, chunk.toString(), config.max_output_bytes);
      stdout = result.text;
      if (!result.full) {
        outputTruncated = true;
        killedByOutputLimit = true;
        proc.kill("SIGKILL");
      }
    });

    proc.stderr.on("data", (chunk) => {
      const result = appendChunk(stderr, chunk.toString(), config.max_output_bytes);
      stderr = result.text;
      if (!result.full) {
        outputTruncated = true;
        killedByOutputLimit = true;
        proc.kill("SIGKILL");
      }
    });

    proc.on("error", (error) => {
      clearTimeout(timer);
      finish(null, error.message);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killedByOutputLimit && !stderr.includes("output exceeded")) {
        stderr = `${stderr}\nProcess terminated because output exceeded max_output_bytes.`.trim();
      }
      finish(code, null);
    });
  });
}
