import { spawn } from "node:child_process";

function quoteSingle(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function clampTimeout(requested, host) {
  const parsed = Number(requested);
  const fallback = host.default_timeout_seconds;
  const timeout = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return Math.min(timeout, host.max_timeout_seconds);
}

function toWildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function commandAllowed(command, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const normalized = command.trim();
  return allowlist.some((pattern) => toWildcardRegex(pattern).test(normalized));
}

function buildSshInvocation(host, command) {
  const sshArgs = [
    "-p",
    String(host.port),
    "-o",
    `StrictHostKeyChecking=${host.strict_host_key_checking}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "LogLevel=ERROR",
  ];

  if (typeof host.connect_timeout_seconds === "number") {
    sshArgs.push("-o", `ConnectTimeout=${host.connect_timeout_seconds}`);
  }

  if (host.keyPath) {
    sshArgs.push("-i", host.keyPath);
  }

  const target = `${host.user}@${host.host}`;
  const remoteCommand = `bash -lc ${quoteSingle(command)}`;
  sshArgs.push(target, remoteCommand);

  if (!host.password) {
    return {
      cmd: "ssh",
      args: sshArgs,
      env: process.env,
      auth: host.keyPath ? "key" : "agent/default",
    };
  }

  return {
    cmd: "sshpass",
    args: ["-e", "ssh", ...sshArgs],
    env: { ...process.env, SSHPASS: host.password },
    auth: host.keyPath ? "key+password" : "password",
  };
}

function appendChunk(buffer, chunk, maxBytes) {
  if (buffer.length >= maxBytes) return { text: buffer, full: false };
  const remaining = maxBytes - buffer.length;
  const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
  return {
    text: buffer + slice,
    full: chunk.length <= remaining,
  };
}

export async function runSshCommand(host, command, options = {}) {
  if (!commandAllowed(command, host.command_allowlist)) {
    throw new Error(
      "Command rejected by allowlist. Update command_allowlist in ssh-mcp config for this host."
    );
  }

  const timeoutSeconds = clampTimeout(options.timeout_seconds, host);
  const maxOutputBytes = host.max_output_bytes;

  return await new Promise((resolve) => {
    const start = Date.now();
    const invocation = buildSshInvocation(host, command);
    const proc = spawn(invocation.cmd, invocation.args, { env: invocation.env });

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
        connection: `${host.user}@${host.host}:${host.port}`,
        auth: invocation.auth,
        command,
        timeout_seconds: timeoutSeconds,
        max_output_bytes: maxOutputBytes,
        timed_out: timedOut,
        output_truncated: outputTruncated,
        exit_code: code,
        duration_ms: durationMs,
        stdout,
        stderr: errorMessage ? `${stderr}\n${errorMessage}`.trim() : stderr,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    proc.stdout.on("data", (chunk) => {
      const result = appendChunk(stdout, chunk.toString(), maxOutputBytes);
      stdout = result.text;
      if (!result.full) {
        outputTruncated = true;
        killedByOutputLimit = true;
        proc.kill("SIGKILL");
      }
    });

    proc.stderr.on("data", (chunk) => {
      const result = appendChunk(stderr, chunk.toString(), maxOutputBytes);
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
      if (killedByOutputLimit && !stderr.includes("output limit")) {
        stderr = `${stderr}\nProcess terminated because output exceeded max_output_bytes.`.trim();
      }
      finish(code, null);
    });
  });
}

export async function testSshConnection(host) {
  return await runSshCommand(host, host.ready_command, {
    timeout_seconds: Math.min(host.default_timeout_seconds, 20),
  });
}
