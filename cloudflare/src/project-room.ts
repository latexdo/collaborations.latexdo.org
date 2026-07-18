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
  CollaboratorPermission,
  CollaboratorRole,
  CreateEntryInput,
  Env,
  InitProjectInput,
  MoveEntryInput,
  OpenProject,
  PermissionUpdateInput,
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
const defaultShareRole: CollaboratorRole = "editor";
const roles: CollaboratorRole[] = ["admin", "editor", "viewer"];

interface ProjectMeta {
  projectId: string;
  name: string;
  ownerSessionId: string;
  ownerClientId?: string;
  shareToken?: string;
  defaultRole?: CollaboratorRole;
}

interface FileRow extends Record<string, SqlStorageValue> {
  path: string;
  type: "file" | "directory";
  content: string;
  y_update: string | null;
}

interface CollaboratorRow extends Record<string, SqlStorageValue> {
  client_id: string;
  session_id: string;
  name: string;
  role: CollaboratorRole;
  joined_at: number;
  last_seen: number;
  revoked: number;
}

type AttachmentWebSocket = WebSocket & {
  serializeAttachment(value: WebSocketAttachment): void;
  deserializeAttachment(): WebSocketAttachment | undefined;
};

type AwarenessClientStates = NonNullable<
  WebSocketAttachment["awarenessClientStates"]
>;

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

function isCollaboratorRole(value: unknown): value is CollaboratorRole {
  return roles.includes(value as CollaboratorRole);
}

function canEditContent(role: CollaboratorRole): boolean {
  return role === "admin" || role === "editor";
}

function canManageProject(role: CollaboratorRole): boolean {
  return role === "admin";
}

function anonymousName(clientId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < clientId.length; index += 1) {
    hash ^= clientId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `Anonymous ${hash.toString(36).toUpperCase().slice(0, 6)}`;
}

function displayName(identity: RequestIdentity): string {
  const trimmed = identity.clientName.trim().replace(/\s+/g, " ").slice(0, 80);
  return trimmed || anonymousName(identity.clientId);
}

function cfSocket(socket: WebSocket): AttachmentWebSocket {
  return socket as AttachmentWebSocket;
}

function readAwarenessClientStates(
  update: Uint8Array,
): AwarenessClientStates | null {
  try {
    const decoder = decoding.createDecoder(update);
    const length = decoding.readVarUint(decoder);
    const states: AwarenessClientStates = [];
    for (let index = 0; index < length; index += 1) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      decoding.readVarString(decoder);
      states.push({ clientId, clock });
    }
    return states;
  } catch {
    return null;
  }
}

function mergeAwarenessClientStates(
  current: AwarenessClientStates | undefined,
  incoming: AwarenessClientStates,
): AwarenessClientStates {
  const merged = new Map<number, number>();
  for (const state of current ?? []) {
    merged.set(state.clientId, state.clock);
  }
  for (const state of incoming) {
    merged.set(
      state.clientId,
      Math.max(merged.get(state.clientId) ?? 0, state.clock),
    );
  }
  return [...merged.entries()].map(([clientId, clock]) => ({
    clientId,
    clock,
  }));
}

function awarenessRemovalUpdate(states: AwarenessClientStates): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, states.length);
  for (const state of states) {
    encoding.writeVarUint(encoder, state.clientId);
    encoding.writeVarUint(encoder, state.clock + 1);
    encoding.writeVarString(encoder, "null");
  }
  return encoding.toUint8Array(encoder);
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
      ownerClientId: input.identity.clientId,
      defaultRole: defaultShareRole,
    };

    this.setMeta("project", meta);
    this.upsertCollaborator(input.identity, "admin", true);
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
      .exec<{
        path: string;
        type: "file" | "directory";
      }>("SELECT path, type FROM files ORDER BY path")
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
    const meta = this.requireExistingRole(
      access.identity,
      canEditContent,
      "This project is read-only for you.",
    );
    const role = this.roleForIdentity(access.identity, meta);
    const path = normalizeRelativePath(access.relativePath);
    if (!canManageProject(role) && !this.fileRow(path)) {
      throw new Error("Only admins can create files.");
    }
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
      .exec<{
        count: number;
      }>("SELECT COUNT(*) as count FROM files WHERE path = ?", path)
      .one();
    return { exists: row.count > 0 };
  }

  async createEntry(
    input: CreateEntryInput,
  ): Promise<{ relativePath: string }> {
    this.requireExistingRole(
      input.identity,
      canManageProject,
      "Only admins can create files or folders.",
    );
    const path = normalizeRelativePath(input.relativePath);
    const type = input.type;
    const exists = this.ctx.storage.sql
      .exec<{
        count: number;
      }>("SELECT COUNT(*) as count FROM files WHERE path = ?", path)
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
    this.requireExistingRole(
      input.identity,
      canManageProject,
      "Only admins can move project entries.",
    );
    const fromPath = normalizeRelativePath(input.fromRelativePath);
    const toPath = normalizeRelativePath(input.toRelativePath);
    const existing = this.ctx.storage.sql
      .exec<{
        path: string;
        type: "file" | "directory";
      }>("SELECT path, type FROM files WHERE path = ?", fromPath)
      .toArray()[0];
    if (!existing) {
      throw new Error(`${fromPath} does not exist.`);
    }
    const targetExists = this.ctx.storage.sql
      .exec<{
        count: number;
      }>("SELECT COUNT(*) as count FROM files WHERE path = ?", toPath)
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
    return this.collaborationState(meta, access.identity);
  }

  async createShare(access: ProjectAccess): Promise<CollaborationState> {
    const meta = this.requireExistingRole(
      access.identity,
      canManageProject,
      "Only admins can share this project.",
    );
    const token = meta.shareToken ?? createShareToken(meta.projectId);
    const nextMeta = {
      ...meta,
      shareToken: token,
      defaultRole: meta.defaultRole ?? defaultShareRole,
    };
    this.setMeta("project", nextMeta);
    return this.collaborationState(nextMeta, access.identity);
  }

  async rotateShare(access: ProjectAccess): Promise<CollaborationState> {
    const meta = this.requireExistingRole(
      access.identity,
      canManageProject,
      "Only admins can regenerate this share link.",
    );
    const nextMeta = {
      ...meta,
      shareToken: createShareToken(meta.projectId),
      defaultRole: meta.defaultRole ?? defaultShareRole,
    };
    this.setMeta("project", nextMeta);
    return this.collaborationState(nextMeta, access.identity);
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
      collaboration: this.collaborationState(meta, access.identity),
    };
  }

  async updatePresence(input: PresenceInput): Promise<CollaborationState> {
    const meta = this.requireExistingAccess(input.identity);
    const role = this.roleForIdentity(input.identity, meta);
    this.ctx.storage.sql.exec(
      "INSERT INTO presence (client_id, name, current_file, last_seen) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, current_file = excluded.current_file, last_seen = excluded.last_seen",
      input.identity.clientId,
      displayName(input.identity),
      input.currentFile ?? null,
      now(),
    );
    this.prunePresence();
    this.upsertCollaborator(input.identity, role);
    return this.collaborationState(meta, input.identity);
  }

  async getPermissions(access: ProjectAccess): Promise<{
    permissions: CollaboratorPermission[];
    isAdmin: boolean;
    currentUserRole: CollaboratorRole;
  }> {
    const meta = this.requireExistingAccess(access.identity);
    const currentUserRole = this.roleForIdentity(access.identity, meta);
    return {
      permissions: this.permissions(access.identity),
      isAdmin: currentUserRole === "admin",
      currentUserRole,
    };
  }

  async updatePermission(
    input: PermissionUpdateInput,
  ): Promise<CollaboratorPermission> {
    this.requireExistingRole(
      input.identity,
      canManageProject,
      "Only admins can change permissions.",
    );
    if (!input.clientId) {
      throw new Error("Missing collaborator id.");
    }
    if (!isCollaboratorRole(input.role)) {
      throw new Error("Invalid collaborator role.");
    }

    const target = this.collaboratorByClientId(input.clientId);
    if (!target || target.revoked) {
      throw new Error("Collaborator not found.");
    }
    if (input.clientId === input.identity.clientId && input.role !== "admin") {
      throw new Error("Admins cannot remove their own admin access.");
    }
    if (
      target.role === "admin" &&
      input.role !== "admin" &&
      this.activeAdminCount() <= 1
    ) {
      throw new Error("At least one admin is required.");
    }

    this.ctx.storage.sql.exec(
      "UPDATE collaborators SET role = ?, last_seen = ? WHERE client_id = ?",
      input.role,
      now(),
      input.clientId,
    );
    this.closeSocketsForRoleChange(input.clientId, input.role);
    return {
      clientId: input.clientId,
      name: target.name,
      role: input.role,
      isCurrent: input.clientId === input.identity.clientId,
    };
  }

  async removeCollaborator(
    input: ProjectAccess & { clientId: string },
  ): Promise<void> {
    const meta = this.requireExistingRole(
      input.identity,
      canManageProject,
      "Only admins can remove collaborators.",
    );
    if (!input.clientId) {
      throw new Error("Missing collaborator id.");
    }
    if (input.clientId === input.identity.clientId) {
      throw new Error("Admins cannot remove themselves.");
    }
    if (meta.ownerClientId && input.clientId === meta.ownerClientId) {
      throw new Error("The project owner cannot be removed.");
    }

    const target = this.collaboratorByClientId(input.clientId);
    if (!target || target.revoked) {
      return;
    }
    if (target.role === "admin" && this.activeAdminCount() <= 1) {
      throw new Error("At least one admin is required.");
    }

    this.ctx.storage.sql.exec(
      "UPDATE collaborators SET revoked = 1, last_seen = ? WHERE client_id = ?",
      now(),
      input.clientId,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM presence WHERE client_id = ?",
      input.clientId,
    );
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = cfSocket(socket).deserializeAttachment();
      if (attachment?.clientId === input.clientId) {
        this.broadcastAwarenessRemoval(socket, attachment);
        socket.close(1008, "Project access revoked");
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const identity = identityFromRequest(request);
    const meta = this.requireExistingAccess(identity);
    const url = new URL(request.url);
    const path = normalizeRelativePath(
      url.searchParams.get("path") ?? "main.tex",
    );
    const role = this.requireAccess(identity, meta);
    if (!canManageProject(role) && !this.fileRow(path)) {
      throw new Error(`${path} is not a file.`);
    }
    this.ensureYDoc(path);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const serverSocket = cfSocket(server);
    serverSocket.serializeAttachment({
      projectId: meta.projectId,
      path,
      clientId: identity.clientId,
      clientName: displayName(identity),
      role,
    });
    this.ctx.acceptWebSocket(server);
    this.updatePresence({ identity, currentFile: path });
    this.sendSyncStep1(path, server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message === "string") {
      return;
    }
    if (message.byteLength === 0) {
      return;
    }

    const attachment = cfSocket(socket).deserializeAttachment();
    if (!attachment) {
      socket.close(1008, "Missing collaboration attachment");
      return;
    }

    const doc = this.ensureYDoc(attachment.path);
    const bytes = new Uint8Array(message);
    let decoder: decoding.Decoder;
    let messageType: number;
    try {
      decoder = decoding.createDecoder(bytes);
      messageType = decoding.readVarUint(decoder);
    } catch {
      return;
    }

    if (messageType === messageSync) {
      const role = this.roleForClientId(attachment.clientId);
      if (!role) {
        socket.close(1008, "Project access revoked");
        return;
      }
      if (!canEditContent(role)) {
        let innerMessageType: number;
        try {
          innerMessageType = decoding.readVarUint(decoder);
        } catch {
          return;
        }
        if (innerMessageType !== syncProtocol.messageYjsSyncStep1) {
          socket.close(1008, "This project is read-only for you.");
          return;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        try {
          syncProtocol.readSyncStep1(decoder, encoder, doc);
        } catch {
          return;
        }
        if (encoding.length(encoder) > 1) {
          socket.send(encoding.toUint8Array(encoder));
        }
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      try {
        syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
      } catch {
        return;
      }
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }
      return;
    }

    if (
      messageType === messageAwareness ||
      messageType === messageQueryAwareness
    ) {
      if (messageType === messageAwareness) {
        let update: Uint8Array;
        try {
          if (!decoding.hasContent(decoder)) return;
          update = decoding.readVarUint8Array(decoder);
        } catch {
          return;
        }
        const clientStates = readAwarenessClientStates(update);
        if (clientStates === null) {
          return;
        }
        cfSocket(socket).serializeAttachment({
          ...attachment,
          awarenessClientStates: mergeAwarenessClientStates(
            attachment.awarenessClientStates,
            clientStates,
          ),
        });
      }
      this.broadcastToFile(attachment.path, bytes, socket);
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = cfSocket(socket).deserializeAttachment();
    if (!attachment) return;
    this.broadcastAwarenessRemoval(socket, attachment);
    this.ctx.storage.sql.exec(
      "DELETE FROM presence WHERE client_id = ?",
      attachment.clientId,
    );
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
      CREATE TABLE IF NOT EXISTS collaborators (
        client_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS collaborators_active_role_idx
        ON collaborators (revoked, role);
    `);
  }

  private getProjectMeta(): ProjectMeta | null {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM project_meta WHERE key = 'project'")
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

  private requireExistingRole(
    identity: RequestIdentity,
    allow: (role: CollaboratorRole) => boolean,
    message: string,
  ): ProjectMeta {
    const meta = this.requireExistingAccess(identity);
    const role = this.roleForIdentity(identity, meta);
    if (!allow(role)) {
      throw new Error(message);
    }
    return meta;
  }

  private requireAccess(
    identity: RequestIdentity,
    meta: ProjectMeta,
  ): CollaboratorRole {
    return this.roleForIdentity(identity, meta);
  }

  private roleForIdentity(
    identity: RequestIdentity,
    meta: ProjectMeta,
  ): CollaboratorRole {
    if (
      identity.sessionId === meta.ownerSessionId ||
      (meta.ownerClientId !== undefined &&
        identity.clientId === meta.ownerClientId)
    ) {
      if (!meta.ownerClientId) {
        this.setMeta("project", { ...meta, ownerClientId: identity.clientId });
      }
      return this.upsertCollaborator(identity, "admin", true);
    }
    if (meta.shareToken && identity.shareToken === meta.shareToken) {
      return this.upsertCollaborator(
        identity,
        meta.defaultRole ?? defaultShareRole,
      );
    }
    throw new Error("You do not have access to this project.");
  }

  private upsertCollaborator(
    identity: RequestIdentity,
    fallbackRole: CollaboratorRole,
    forceRole = false,
  ): CollaboratorRole {
    const existing = this.collaboratorByClientId(identity.clientId);
    if (existing?.revoked && !forceRole) {
      throw new Error("Your access to this project was revoked.");
    }
    const role = forceRole ? fallbackRole : (existing?.role ?? fallbackRole);
    const name = displayName(identity);
    const timestamp = now();

    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE collaborators SET session_id = ?, name = ?, role = ?, last_seen = ?, revoked = 0 WHERE client_id = ?",
        identity.sessionId,
        name,
        role,
        timestamp,
        identity.clientId,
      );
    } else {
      this.ctx.storage.sql.exec(
        "INSERT INTO collaborators (client_id, session_id, name, role, joined_at, last_seen, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)",
        identity.clientId,
        identity.sessionId,
        name,
        role,
        timestamp,
        timestamp,
      );
    }

    return role;
  }

  private collaboratorByClientId(clientId: string): CollaboratorRow | null {
    const row = this.ctx.storage.sql
      .exec<CollaboratorRow>(
        "SELECT client_id, session_id, name, role, joined_at, last_seen, revoked FROM collaborators WHERE client_id = ?",
        clientId,
      )
      .toArray()[0];
    return row ?? null;
  }

  private roleForClientId(clientId: string): CollaboratorRole | null {
    const collaborator = this.collaboratorByClientId(clientId);
    if (!collaborator || collaborator.revoked) {
      return null;
    }
    return collaborator.role;
  }

  private activeAdminCount(): number {
    return this.ctx.storage.sql
      .exec<{
        count: number;
      }>(
        "SELECT COUNT(*) as count FROM collaborators WHERE revoked = 0 AND role = 'admin'",
      )
      .one().count;
  }

  private permissions(identity: RequestIdentity): CollaboratorPermission[] {
    return this.ctx.storage.sql
      .exec<CollaboratorRow>(
        "SELECT client_id, session_id, name, role, joined_at, last_seen, revoked FROM collaborators WHERE revoked = 0 ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, name",
      )
      .toArray()
      .map((row) => ({
        clientId: row.client_id,
        name: row.name,
        role: row.role,
        ...(row.client_id === identity.clientId ? { isCurrent: true } : {}),
      }));
  }

  private closeSocketsForRoleChange(
    clientId: string,
    role: CollaboratorRole,
  ): void {
    if (canEditContent(role)) {
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = cfSocket(socket).deserializeAttachment();
      if (attachment?.clientId === clientId) {
        socket.close(1008, "This project is read-only for you.");
      }
    }
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

  private collaborationState(
    meta: ProjectMeta,
    identity?: RequestIdentity,
  ): CollaborationState {
    const currentUserRole = identity
      ? this.roleForIdentity(identity, meta)
      : undefined;
    return {
      enabled: Boolean(meta.shareToken),
      token: meta.shareToken,
      projectId: meta.projectId,
      projectName: meta.name,
      users: this.presenceUsers(),
      ...(currentUserRole
        ? { currentUserRole, isAdmin: currentUserRole === "admin" }
        : {}),
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
        role: CollaboratorRole | null;
      }>(
        "SELECT presence.client_id, presence.name, presence.current_file, presence.last_seen, collaborators.role " +
          "FROM presence LEFT JOIN collaborators ON collaborators.client_id = presence.client_id AND collaborators.revoked = 0 " +
          "ORDER BY presence.name",
      )
      .toArray()
      .map((row) => ({
        clientId: row.client_id,
        name: row.name,
        currentFile: row.current_file,
        lastSeen: row.last_seen,
        role: row.role ?? "viewer",
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
    const row = this.fileRow(path);
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

  private fileRow(path: string): FileRow | null {
    const row = this.ctx.storage.sql
      .exec<FileRow>(
        "SELECT path, type, content, y_update FROM files WHERE path = ?",
        path,
      )
      .toArray()[0];
    return row ?? null;
  }

  private ensureYDoc(path: string): Y.Doc {
    const existing = this.docs.get(path);
    if (existing) {
      return existing;
    }

    const row = this.fileRow(path);
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

  private broadcastAwarenessRemoval(
    socket: WebSocket,
    attachment: WebSocketAttachment,
  ): void {
    const states = attachment.awarenessClientStates ?? [];
    if (!states.length) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(encoder, awarenessRemovalUpdate(states));
    this.broadcastToFile(
      attachment.path,
      encoding.toUint8Array(encoder),
      socket,
    );
  }
}
