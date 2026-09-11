import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { resolveExecutableCommand } from "./local-agent-command.js";
import { terminateProcessTree } from "./process-platform.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const DEFAULT_AGY_TIMEOUT_MS = 10 * 60_000;

export function resolveAgyCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const command = env.AGY_COMMAND ?? "agy";
  const resolved = resolveExecutableCommand(command, env);
  if (resolved) return resolved;

  // Fallback check in ~/.local/bin/agy on unix platforms if PATH doesn't include it
  if (process.platform !== "win32") {
    const localBinPath = join(homedir(), ".local", "bin", "agy");
    if (resolveExecutableCommand(localBinPath, env)) {
      return localBinPath;
    }
  }

  return undefined;
}

export function agyCommandArgs(
  input: LocalAgentRunInput,
  context: LocalAgentRuntimeContext,
  _env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [
    "-p", input.prompt,
    "--output-format", "json",
  ];

  if (input.providerSessionId) {
    args.push("--conversation", input.providerSessionId);
  }

  const workspaceRoot = input.workspaceRoot || context.workspaceRoot;
  if (workspaceRoot) {
    args.push("--add-dir", resolve(workspaceRoot));
  }

  const model = input.model || context.model;
  if (model) {
    args.push("--model", model);
  }

  const effort = input.effort || context.effort;
  if (effort) {
    args.push("--effort", effort);
  }

  const writeMode = input.writeMode || context.writeMode;
  if (writeMode === "read_only") {
    args.push("--mode", "plan");
  } else if (writeMode === "full_access") {
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

export interface AgyRuntimeOptions {
  command: string;
  context: LocalAgentRuntimeContext;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class AgyLocalAgentRuntime implements LocalAgentRuntime {
  readonly provider = "agy" as const;
  private alive = true;
  private child?: ChildProcess;

  constructor(private readonly options: AgyRuntimeOptions) {}

  async run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
  ) {
    return captureAgentProviderResult({
      provider: "agy",
      agentId: this.options.context.agentId,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.alive) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: "agy",
            agentId: this.options.context.agentId,
            operation: "run",
            retryable: false,
            message: "Antigravity runtime is closed.",
          });
        }

        const args = agyCommandArgs(input, this.options.context, this.options.env);
        const cwd = resolve(input.workspaceRoot || this.options.context.workspaceRoot);

        let stdout = "";
        let stderr = "";

        const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
          const child = spawn(this.options.command, args, {
            cwd,
            env: this.options.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
          });
          this.child = child;

          const timeoutMs = this.options.timeoutMs ?? DEFAULT_AGY_TIMEOUT_MS;
          const timer = setTimeout(() => {
            terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
            setTimeout(() => {
              terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
            }, 2_000).unref();
            reject(new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: "agy",
              agentId: this.options.context.agentId,
              operation: "run",
              retryable: true,
              message: `Antigravity CLI timed out after ${Math.round(timeoutMs / 1000)}s.`,
            }));
          }, timeoutMs);
          timer.unref();

          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });

          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });

          child.once("error", (error) => {
            clearTimeout(timer);
            this.child = undefined;
            reject(new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: "agy",
              agentId: this.options.context.agentId,
              operation: "run",
              retryable: false,
              cause: error,
              message: `Failed to spawn Antigravity CLI: ${error.message}`,
            }));
          });

          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            this.child = undefined;
            resolvePromise({ code, signal });
          });
        });

        if (exitResult.code !== 0) {
          throw new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: "agy",
            agentId: this.options.context.agentId,
            operation: "run",
            retryable: false,
            message: `Antigravity CLI exited with code ${exitResult.code ?? 1}.${stderr.trim() ? ` Stderr:\n${stderr.trim()}` : ""}`,
          });
        }

        const trimmedOut = stdout.trim();
        let conversationId: string | null = null;
        let finalResponse = trimmedOut;

        try {
          const parsed = JSON.parse(trimmedOut) as Record<string, unknown>;
          if (typeof parsed.conversation_id === "string") {
            conversationId = parsed.conversation_id;
          }
          if (typeof parsed.response === "string") {
            finalResponse = parsed.response.trim();
          }
        } catch {
          // If stdout is not JSON, fallback to raw stdout
          finalResponse = trimmedOut;
        }

        if (conversationId && callbacks?.onSessionId) {
          await callbacks.onSessionId(conversationId);
        }

        return {
          provider: "agy",
          providerSessionId: conversationId,
          finalResponse,
          items: [],
        };
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // Sessions in Antigravity are durable and stateless from the CLI caller's perspective
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.child && this.child.exitCode === null) {
      terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
    }
  }

  isAlive(): boolean {
    return this.alive;
  }
}

export class AgyLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "agy" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  private commandResolved = false;
  private resolvedCommand?: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: (env: NodeJS.ProcessEnv) => string | undefined = resolveAgyCommand,
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand() ?? "agy";
    return `agy:${command}:${resolve(context.workspaceRoot)}`;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: "agy",
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: "agy",
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: "Antigravity CLI (agy) executable was not found.",
          });
        }

        return new AgyLocalAgentRuntime({
          command,
          context,
          env: this.env,
        });
      },
    });
  }

  private resolveCommand(): string | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}
