export { runHarness, parseStream, buildArgs } from "./claude-code.js";
export type {
  HarnessOptions,
  HarnessResult,
  PermissionDecision,
  PermissionRequestPayload,
} from "./claude-code.js";
export {
  toClaudeMcpConfig,
  materializeMcpConfig,
} from "./mcp-config.js";
export type {
  ClaudeMcpConfigFile,
  ClaudeMcpServerEntry,
  MaterializedMcpConfig,
} from "./mcp-config.js";
export {
  buildStreamUserMessage,
  needsStreamInput,
} from "./stream-input.js";
export type { ExtraHookCommands } from "./permission-hook-config.js";
export type {
  AttachmentReader,
  StreamUserMessage,
} from "./stream-input.js";
export type {
  RunRequest,
  RunEvent,
  TokenUsage,
} from "@claudeos/runtime-client/contracts";
