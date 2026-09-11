import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgyLocalAgentDriver,
  AgyLocalAgentRuntime,
  agyCommandArgs,
  resolveAgyCommand,
} from "./local-agent-agy.js";

const context = {
  agentId: "agt_agy_test",
  provider: "agy" as const,
  workspaceRoot: "/tmp/project",
};

// 1. Test argument formatting
{
  const args = agyCommandArgs(
    {
      prompt: "analyze security",
      workspaceRoot: "/tmp/project",
      model: "flash",
      effort: "high",
      writeMode: "read_only",
    },
    context,
  );
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("analyze security"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("flash"));
  assert.ok(args.includes("--effort"));
  assert.ok(args.includes("high"));
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("plan"));
}

// 2. Test session continuation argument formatting
{
  const args = agyCommandArgs(
    {
      prompt: "continue previous task",
      workspaceRoot: "/tmp/project",
      providerSessionId: "session-12345",
      writeMode: "full_access",
    },
    context,
  );
  assert.ok(args.includes("--conversation"));
  assert.ok(args.includes("session-12345"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
}

// 3. Test execution and response parsing with a mock binary
if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-test-"));
  try {
    const fakeAgy = join(root, "fake-agy");
    await writeFile(
      fakeAgy,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  conversation_id: "conv-abc-123",
  status: "SUCCESS",
  response: "Security analysis completed: no vulnerabilities found."
}));
process.exit(0);
`,
      { mode: 0o700 },
    );
    await chmod(fakeAgy, 0o700);

    // Test command resolver with AGY_COMMAND
    const testEnv = { ...process.env, AGY_COMMAND: fakeAgy };
    const resolved = resolveAgyCommand(testEnv);
    assert.equal(resolved, fakeAgy);

    // Test driver runtime creation
    const driver = new AgyLocalAgentDriver(
      testEnv,
      () => fakeAgy,
    );
    const runtimeResult = await driver.createRuntime(context);
    assert.equal(runtimeResult.isOk(), true);
    const runtime = runtimeResult.unwrap();

    let capturedSessionId: string | undefined;
    const runResult = await runtime.run(
      {
        prompt: "audit this repo",
        workspaceRoot: root,
      },
      {
        onSessionId: (id) => {
          capturedSessionId = id;
        },
      },
    );

    assert.equal(runResult.isOk(), true);
    const output = runResult.unwrap();
    assert.equal(output.provider, "agy");
    assert.equal(output.providerSessionId, "conv-abc-123");
    assert.equal(capturedSessionId, "conv-abc-123");
    assert.equal(output.finalResponse, "Security analysis completed: no vulnerabilities found.");

    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
