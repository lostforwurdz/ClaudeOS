import type {
  Attachment,
  CreateSessionBody,
  CreateWorkspaceBody,
  RunEvent,
  RunRequest,
  Session,
  SubmitRunResponse,
  Workspace,
} from "@claudeos/runtime-client/contracts";

const API_BASE =
  (typeof window !== "undefined" && (window as { __CLAUDEOS_API__?: string }).__CLAUDEOS_API__) ||
  "http://127.0.0.1:7878";

function wsBase(): string {
  return API_BASE.replace(/^http/, "ws");
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  async listWorkspaces(): Promise<Workspace[]> {
    return jsonOrThrow(await fetch(`${API_BASE}/workspaces`));
  },
  async createWorkspace(body: CreateWorkspaceBody): Promise<Workspace> {
    return jsonOrThrow(
      await fetch(`${API_BASE}/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async createSession(body: CreateSessionBody): Promise<Session> {
    return jsonOrThrow(
      await fetch(`${API_BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async uploadFile(workspaceId: string, file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    return jsonOrThrow(
      await fetch(`${API_BASE}/workspaces/${workspaceId}/uploads`, {
        method: "POST",
        body: form,
      }),
    );
  },
  async submitRun(body: RunRequest): Promise<SubmitRunResponse> {
    return jsonOrThrow(
      await fetch(`${API_BASE}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async cancelRun(runId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/runs/${runId}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  async renameWorkspace(id: string, name: string): Promise<Workspace> {
    return jsonOrThrow(
      await fetch(`${API_BASE}/workspaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  },
  async deleteWorkspace(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/workspaces/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  streamRun(runId: string, onEvent: (event: RunEvent) => void): () => void {
    const ws = new WebSocket(`${wsBase()}/runs/${runId}/stream`);
    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as RunEvent;
        onEvent(event);
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  },
};
