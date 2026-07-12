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
}

export interface CollaborationState {
  enabled: boolean;
  token?: string;
  shareUrl?: string;
  projectId?: string;
  projectName?: string;
  users: CollaboratorPresence[];
}

export interface ProjectAccess {
  identity: RequestIdentity;
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

export interface WebSocketAttachment {
  projectId: string;
  path: string;
  clientId: string;
  clientName: string;
}
