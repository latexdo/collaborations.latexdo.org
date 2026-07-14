export interface Env {
  PROJECT_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
}

export interface RequestIdentity {
  sessionId: string;
  clientId: string;
  clientName: string;
  shareToken?: string;
}

export type CollaboratorRole = "admin" | "editor" | "viewer";

export interface OpenProject {
  id: string;
  rootPath: string;
  name: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: ProjectEntry[];
}

export interface CollaboratorPresence {
  clientId: string;
  name: string;
  currentFile: string | null;
  lastSeen: number;
  role?: CollaboratorRole;
}

export interface CollaborationState {
  enabled: boolean;
  token?: string;
  shareUrl?: string;
  projectId?: string;
  projectName?: string;
  users: CollaboratorPresence[];
  currentUserRole?: CollaboratorRole;
  isAdmin?: boolean;
}

export interface ProjectAccess {
  identity: RequestIdentity;
}

export interface CollaboratorPermission {
  clientId: string;
  name: string;
  role: CollaboratorRole;
  isCurrent?: boolean;
}

export interface PermissionUpdateInput extends ProjectAccess {
  clientId: string;
  role: CollaboratorRole;
}

export interface InitProjectInput extends ProjectAccess {
  projectId: string;
  name: string;
}

export interface CreateEntryInput extends ProjectAccess {
  relativePath: string;
  type: "file" | "directory";
}

export interface MoveEntryInput extends ProjectAccess {
  fromRelativePath: string;
  toRelativePath: string;
}

export interface PresenceInput extends ProjectAccess {
  currentFile?: string | null;
}

export interface AwarenessClientState {
  clientId: number;
  clock: number;
}

export interface WebSocketAttachment {
  projectId: string;
  path: string;
  clientId: string;
  clientName: string;
  role: CollaboratorRole;
  awarenessClientStates?: AwarenessClientState[];
}
