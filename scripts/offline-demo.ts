import { spawn } from "node:child_process";
import { portOf, startMockServer } from "./mock-server.js";

const server = await startMockServer(4010);
console.log(`mock API listening on http://127.0.0.1:${portOf(server)}`);
// Async spawn: the mock server lives in this process and must keep serving requests.
const child = spawn("npx", ["tsx", "src/cli.ts", "run", "workflows/offline-demo.yaml", "--allow-private-network"], { stdio: "inherit" });
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
