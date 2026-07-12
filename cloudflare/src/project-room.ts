import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { identityFromRequest } from "./auth";
import {
  entriesToTree,
  normalizeRelativePath,
  starterContent,
} from "./database";
import { createShareToken } from "./tokens";
import type {
  CollaborationState,
  CreateEntryInput,
  Env,
  InitProjectInput,
  MoveEntryInput,
  OpenProject,
  PresenceInput,
  ProjectAccess,
  ProjectEntry,
  RequestIdentity,
  WebSocketAttachment,
} from "./types";

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;
const yTextName = "content";
const presenceTtlMs = 45_000;

interface ProjectMeta {
  projectId: string;
  name: string;
  ownerSessionId: string;
  shareToken?: string;
}

interface FileRow extends Record<string, SqlStorageValue> {
  path: string;
  type: "file" | "directory";
  content: string;
  y_update: string | null;
}

type AttachmentWebSocket = WebSocket & {
  serializeAttachment(value: WebSocketAttachment): void;
  deserializeAttachment(): WebSocketAttachment | undefined;
};

function now(): number {
  return Date.now();
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function cfSocket(socket: WebSocket): AttachmentWebSocket {
  return socket as AttachmentWebSocket;
}

export class ProjectRoom extends DurableObject<Env> {
  private docs = new Map<string, Y.Doc>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async initProject(input: InitProjectInput): Promise<OpenProject> {
    const existing = this.getProjectMeta();
    if (existing) {
      this.requireAccess(input.identity, existing);
      return this.openProject(existing);
    }

    const meta: ProjectMeta = {
      projectId: input.projectId,
      name: input.name.trim().slice(0, 120) || "LatexDo Project",
      ownerSessionId: input.identity.sessionId,
    };

    this.setMeta("project", meta);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO files (path, type, content, updated_at) VALUES (?, 'file', ?, ?)",
      "main.tex",
      starterContent("main.tex"),
      now(),
    );

    return this.openProject(meta);
  }

  async getProject(access: ProjectAccess): Promise<OpenProject> {
    const meta = this.requireExistingAccess(access.identity);
    return this.openProject(meta);
  }

  async listFiles(access: ProjectAccess): Promise<ProjectEntry[]> {
    const meta = this.requireExistingAccess(access.identity);
    const rows = this.ctx.storage.sql
      .exec<{ path: string; type: "file" | "directory" }>(
        "SELECT path, type FROM files ORDER BY path",
      )
      .toArray();
    return entriesToTree(rows, this.projectRoot(meta));
  }

  async readFile(
    access: ProjectAccess & { relativePath: string },
  ): Promise<{ content: string }> {
    this.requireExistingAccess(access.identity);
    const path = normalizeRelativePath(access.relativePath);
    return { content: this.readFileContent(path) };
  }

  async writeFile(
    access: ProjectAccess & { relativePath: string; content: string },
  ): Promise<void> {
    this.requireExistingAccess(access.identity);
    const path = normalizeRelativePath(access.relativePath);
    const content = String(access.content ?? "");
    this.writeFileContent(path, content);

    const doc = this.docs.get(path);
    if (doc) {
      const yText = doc.getText(yTextName);
      doc.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, content);
      }, "rest-write");
      this.persistYDoc(path, doc);
    }
  }

  async fileExists(
    access: ProjectAccess & { relativePath: string },
  ): Promise<{ exists: boolean }> {
    this.requireExistingAccess(access.identity);
    const path = normalizeRelativePath(access.relativePath);
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM files WHERE path = ?", path)
      .one();
    return { exists: row.count > 0 };
  }

  async createEntry(input: CreateEntryInput): Promise<{ relativePath: string }> {
    this.requireExistingAccess(input.identity);
    const path = normalizeRelativePath(input.relativePath);
    const type = input.type;
    const exists = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM files WHERE path = ?", path)
      .one().count;
    if (exists) {
      throw new Error(`${path} already exists.`);
    }

    this.ensureParentDirectories(path);
    this.ctx.storage.sql.exec(
      "INSERT INTO files (path, type, content, updated_at) VALUES (?, ?, ?, ?)",
      path,
      type,
      type === "file" ? starterContent(path) : "",
      now(),
    );
    return { relativePath: path };
  }

  async moveEntry(input: MoveEntryInput): Promise<{ relativePath: string }> {
    this.requireExistingAccess(input.identity);
    const fromPath = normalizeRelativePath(input.fromRelativePath);
    const toPath = normalizeRelativePath(input.toRelativePath);
    const existing = this.ctx.storage.sql
      .exec<{ path: string; type: "file" | "directory" }>(
        "SELECT path, type FROM files WHERE path = ?",
        fromPath,
      )
      .toArray()[0];
    if (!existing) {
      throw new Error(`${fromPath} does not exist.`);
    }
    const targetExists = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM files WHERE path = ?", toPath)
      .one().count;
    if (targetExists) {
      throw new Error(`${toPath} already exists.`);
    }

    this.ensureParentDirectories(toPath);
    if (existing.type === "file") {
      this.ctx.storage.sql.exec(
        "UPDATE files SET path = ?, updated_at = ? WHERE path = ?",
        toPath,
        now(),
        fromPath,
      );
      const doc = this.docs.get(fromPath);
      if (doc) {
        this.docs.delete(fromPath);
        this.docs.set(toPath, doc);
      }
    } else {
      const rows = this.ctx.storage.sql
        .exec<FileRow>(
          "SELECT path, type, content, y_update FROM files WHERE path = ? OR path LIKE ? ORDER BY length(path) DESC",
          fromPath,
          `${fromPath}/%`,
        )
        .toArray();
      for (const row of rows) {
        const nextPath = `${toPath}${row.path.slice(fromPath.length)}`;
        this.ctx.storage.sql.exec(
          "UPDATE files SET path = ?, updated_at = ? WHERE path = ?",
          nextPath,
          now(),
          row.path,
        );
        const doc = this.docs.get(row.path);
        if (doc) {
          this.docs.delete(row.path);
          this.docs.set(nextPath, doc);
        }
      }
    }
    return { relativePath: toPath };
  }

  async getShare(access: ProjectAccess): Promise<CollaborationState> {
    const meta = this.requireExistingAccess(access.identity);
    return this.collaborationState(meta);
  }

  async createShare(access: ProjectAccess): Promise<CollaborationState> {
    const meta = this.requireExistingAccess(access.identity);
    const token = meta.shareToken ?? createShareToken(meta.projectId);
    const nextMeta = { ...meta, shareToken: token };
    this.setMeta("project", nextMeta);
    return this.collaborationState(nextMeta);
  }

  async openShare(access: ProjectAccess): Promise<{
    project: OpenProject;
    collaboration: CollaborationState;
  }> {
    const meta = this.requireExistingAccess(access.identity);
    this.updatePresence({
      identity: access.identity,
      currentFile: null,
    });
    return {
      project: this.openProject(meta),
      collaboration: this.collaborationState(meta),
    };
  }

  async updatePresence(input: PresenceInput): Promise<CollaborationState> {
    const meta = this.requireExistingAccess(input.identity);
    this.ctx.storage.sql.exec(
      "INSERT INTO presence (client_id, name, current_file, last_seen) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, current_file = excluded.current_file, last_seen = excluded.last_seen",
      input.identity.clientId,
      input.identity.clientName,
      input.currentFile ?? null,
      now(),
    );
    this.prunePresence();
    return this.collaborationState(meta);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const meta = this.requireExistingAccess(identityFromRequest(request));
    const url = new URL(request.url);
    const path = normalizeRelativePath(url.searchParams.get("path") ?? "main.tex");
    const identity = identityFromRequest(request);
    this.requireAccess(identity, meta);
    this.ensureYDoc(path);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const serverSocket = cfSocket(server);
    serverSocket.serializeAttachment({
      projectId: meta.projectId,
      path,
      clientId: identity.clientId,
      clientName: identity.clientName,
    });
    this.ctx.acceptWebSocket(server);
    this.updatePresence({ identity, currentFile: path });
    this.sendSyncStep1(path, server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      return;
    }

    const attachment = cfSocket(socket).deserializeAttachment();
    if (!attachment) {
      socket.close(1008, "Missing collaboration attachment");
      return;
    }

    const doc = this.ensureYDoc(attachment.path);
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const messageType = decoding.readVarUint(decoder);

    if (messageType === messageSync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }
      return;
    }

    if (messageType === messageAwareness || messageType === messageQueryAwareness) {
      this.broadcastToFile(attachment.path, new Uint8Array(message), socket);
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = cfSocket(socket).deserializeAttachment();
    if (!attachment) return;
    this.ctx.storage.sql.exec("DELETE FROM presence WHERE client_id = ?", attachment.clientId);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('file', 'directory')),
        content TEXT NOT NULL DEFAULT '',
        y_update TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presence (
        client_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        current_file TEXT,
        last_seen INTEGER NOT NULL
      );
    `);
  }

  private getProjectMeta(): ProjectMeta | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM project_meta WHERE key = 'project'")
      .toArray()[0];
    return safeJsonParse<ProjectMeta>(row?.value ?? null);
  }

  private setMeta(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO project_meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  private requireExistingAccess(identity: RequestIdentity): ProjectMeta {
    const meta = this.getProjectMeta();
    if (!meta) {
      throw new Error("Project does not exist.");
    }
    this.requireAccess(identity, meta);
    return meta;
  }

  private requireAccess(identity: RequestIdentity, meta: ProjectMeta): void {
    if (identity.sessionId === meta.ownerSessionId) {
      return;
    }
    if (meta.shareToken && identity.shareToken === meta.shareToken) {
      return;
    }
    throw new Error("You do not have access to this project.");
  }

  private openProject(meta: ProjectMeta): OpenProject {
    return {
      id: meta.projectId,
      rootPath: this.projectRoot(meta),
      name: meta.name,
    };
  }

  private projectRoot(meta: ProjectMeta): string {
    return `cloud://latexdo/${meta.projectId}/${encodeURIComponent(meta.name)}`;
  }

  private collaborationState(meta: ProjectMeta): CollaborationState {
    return {
      enabled: Boolean(meta.shareToken),
      token: meta.shareToken,
      projectId: meta.projectId,
      projectName: meta.name,
      users: this.presenceUsers(),
    };
  }

  private presenceUsers(): CollaborationState["users"] {
    this.prunePresence();
    return this.ctx.storage.sql
      .exec<{
        client_id: string;
        name: string;
        current_file: string | null;
        last_seen: number;
      }>(
        "SELECT client_id, name, current_file, last_seen FROM presence ORDER BY name",
      )
      .toArray()
      .map((row) => ({
        clientId: row.client_id,
        name: row.name,
        currentFile: row.current_file,
        lastSeen: row.last_seen,
      }));
  }

  private prunePresence(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM presence WHERE last_seen < ?",
      now() - presenceTtlMs,
    );
  }

  private ensureParentDirectories(path: string): void {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO files (path, type, content, updated_at) VALUES (?, 'directory', '', ?)",
        current,
        now(),
      );
    }
  }

  private readFileContent(path: string): string {
    const row = this.ctx.storage.sql
      .exec<FileRow>(
        "SELECT path, type, content, y_update FROM files WHERE path = ?",
        path,
      )
      .toArray()[0];
    if (!row || row.type !== "file") {
      throw new Error(`${path} is not a file.`);
    }
    const doc = this.docs.get(path);
    return doc ? doc.getText(yTextName).toString() : row.content;
  }

  private writeFileContent(path: string, content: string): void {
    this.ensureParentDirectories(path);
    this.ctx.storage.sql.exec(
      "INSERT INTO files (path, type, content, y_update, updated_at) VALUES (?, 'file', ?, NULL, ?) " +
        "ON CONFLICT(path) DO UPDATE SET type = 'file', content = excluded.content, y_update = excluded.y_update, updated_at = excluded.updated_at",
      path,
      content,
      now(),
    );
  }

  private ensureYDoc(path: string): Y.Doc {
    const existing = this.docs.get(path);
    if (existing) {
      return existing;
    }

    const row = this.ctx.storage.sql
      .exec<FileRow>(
        "SELECT path, type, content, y_update FROM files WHERE path = ?",
        path,
      )
      .toArray()[0];
    if (!row || row.type !== "file") {
      this.writeFileContent(path, starterContent(path));
    }

    const currentRow =
      row ??
      this.ctx.storage.sql
        .exec<FileRow>(
          "SELECT path, type, content, y_update FROM files WHERE path = ?",
          path,
        )
        .toArray()[0];

    const doc = new Y.Doc();
    if (currentRow?.y_update) {
      Y.applyUpdate(doc, base64ToUint8(currentRow.y_update), "storage");
    } else if (currentRow?.content) {
      doc.getText(yTextName).insert(0, currentRow.content);
    }

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.persistYDoc(path, doc);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcastToFile(
        path,
        encoding.toUint8Array(encoder),
        origin instanceof WebSocket ? origin : undefined,
      );
    });

    this.docs.set(path, doc);
    return doc;
  }

  private persistYDoc(path: string, doc: Y.Doc): void {
    const content = doc.getText(yTextName).toString();
    const update = uint8ToBase64(Y.encodeStateAsUpdate(doc));
    this.ctx.storage.sql.exec(
      "UPDATE files SET content = ?, y_update = ?, updated_at = ? WHERE path = ?",
      content,
      update,
      now(),
      path,
    );
  }

  private sendSyncStep1(path: string, socket: WebSocket): void {
    const doc = this.ensureYDoc(path);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    socket.send(encoding.toUint8Array(encoder));
  }

  private broadcastToFile(
    path: string,
    message: Uint8Array,
    except?: WebSocket,
  ): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const attachment = cfSocket(socket).deserializeAttachment();
      if (!attachment || attachment.path !== path) continue;
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Unable to send collaboration update");
      }
    }
  }
}
