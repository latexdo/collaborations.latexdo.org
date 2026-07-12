import { corsHeaders, identityFromRequest } from "./auth";
import { emptyResponse, errorResponse, jsonResponse } from "./database";
import { defaultProjectIdForSession, projectIdFromShareToken, randomId } from "./tokens";
import type { ProjectRoom } from "./project-room";
import type { CollaboratorRole, Env, ProjectAccess } from "./types";

function roomFor(env: Env, projectId: string): DurableObjectStub<ProjectRoom> {
  return env.PROJECT_ROOM.getByName(projectId) as DurableObjectStub<ProjectRoom>;
}

async function readJsonBody<T extends Record<string, unknown>>(
  request: Request,
): Promise<T> {
  if (!request.body) {
    return {} as T;
  }
  return (await request.json()) as T;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function filePath(url: URL): string {
  return url.searchParams.get("path") ?? "";
}

function access(request: Request): ProjectAccess {
  return { identity: identityFromRequest(request) };
}

function collaboratorRole(value: unknown): CollaboratorRole {
  if (value === "admin" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new Error("Invalid collaborator role.");
}

async function handleProjectFiles(
  request: Request,
  env: Env,
  projectId: string,
  tail: string[],
): Promise<Response> {
  const room = roomFor(env, projectId);
  const projectAccess = access(request);

  if (tail.length === 0) {
    if (request.method === "GET") {
      const files = await room.listFiles(projectAccess);
      return jsonResponse(request, env, files);
    }

    if (request.method === "POST") {
      const body = await readJsonBody<{
        relativePath?: string;
        type?: "file" | "directory";
      }>(request);
      const created = await room.createEntry({
        ...projectAccess,
        relativePath: String(body.relativePath ?? ""),
        type: body.type === "directory" ? "directory" : "file",
      });
      return jsonResponse(request, env, created, { status: 201 });
    }
  }

  if (tail[0] === "content") {
    if (request.method === "GET") {
      const content = await room.readFile({
        ...projectAccess,
        relativePath: filePath(new URL(request.url)),
      });
      return jsonResponse(request, env, content);
    }

    if (request.method === "PUT") {
      const body = await readJsonBody<{ content?: string }>(request);
      await room.writeFile({
        ...projectAccess,
        relativePath: filePath(new URL(request.url)),
        content: String(body.content ?? ""),
      });
      return emptyResponse(request, env, { status: 204 });
    }
  }

  if (tail[0] === "exists" && request.method === "GET") {
    const exists = await room.fileExists({
      ...projectAccess,
      relativePath: filePath(new URL(request.url)),
    });
    return jsonResponse(request, env, exists);
  }

  if (tail[0] === "move" && request.method === "POST") {
    const body = await readJsonBody<{
      fromRelativePath?: string;
      toRelativePath?: string;
    }>(request);
    const moved = await room.moveEntry({
      ...projectAccess,
      fromRelativePath: String(body.fromRelativePath ?? ""),
      toRelativePath: String(body.toRelativePath ?? ""),
    });
    return jsonResponse(request, env, moved);
  }

  if (tail[0] === "collaborate") {
    return room.fetch(request);
  }

  return errorResponse(request, env, "Not found", 404);
}

async function handleProjects(
  request: Request,
  env: Env,
  segments: string[],
): Promise<Response> {
  if (segments.length === 2 && segments[1] === "open" && request.method === "POST") {
    const identity = identityFromRequest(request);
    const projectId = await defaultProjectIdForSession(identity.sessionId);
    const room = roomFor(env, projectId);
    const project = await room.initProject({
      identity,
      projectId,
      name: "LatexDo Cloud Project",
    });
    return jsonResponse(request, env, project);
  }

  if (segments.length === 1 && request.method === "POST") {
    const identity = identityFromRequest(request);
    const body = await readJsonBody<{ folderName?: string }>(request);
    const projectId = randomId("project");
    const room = roomFor(env, projectId);
    const project = await room.initProject({
      identity,
      projectId,
      name: String(body.folderName ?? "LatexDo Cloud Project"),
    });
    return jsonResponse(request, env, project, { status: 201 });
  }

  const projectId = segments[1];
  if (!projectId) {
    return errorResponse(request, env, "Missing project id", 400);
  }

  if (segments[2] === "files") {
    return await handleProjectFiles(request, env, projectId, segments.slice(3));
  }

  if (segments[2] === "share") {
    const room = roomFor(env, projectId);
    if (request.method === "GET") {
      const state = await room.getShare(access(request));
      return jsonResponse(request, env, state);
    }
    if (request.method === "POST") {
      const state = await room.createShare(access(request));
      return jsonResponse(request, env, state, { status: 201 });
    }
  }

  return errorResponse(request, env, "Not found", 404);
}

async function handleShares(
  request: Request,
  env: Env,
  segments: string[],
): Promise<Response> {
  const token = segments[1];
  if (!token) {
    return errorResponse(request, env, "Missing share token", 400);
  }

  const projectId = projectIdFromShareToken(token);
  if (!projectId) {
    return errorResponse(request, env, "Invalid share token", 400);
  }

  const room = roomFor(env, projectId);
  const projectAccess = {
    identity: {
      ...identityFromRequest(request),
      shareToken: token,
    },
  };

  if (segments[2] === "open" && request.method === "POST") {
    const opened = await room.openShare(projectAccess);
    return jsonResponse(request, env, opened);
  }

  if (segments[2] === "presence" && request.method === "POST") {
    const body = await readJsonBody<{ currentFile?: string | null }>(request);
    const state = await room.updatePresence({
      ...projectAccess,
      currentFile: body.currentFile ?? null,
    });
    return jsonResponse(request, env, state);
  }

  if (segments[2] === "permissions") {
    if (request.method === "GET") {
      const state = await room.getPermissions(projectAccess);
      return jsonResponse(request, env, state);
    }

    if (request.method === "PUT") {
      const body = await readJsonBody<{
        clientId?: string;
        role?: string;
      }>(request);
      const permission = await room.updatePermission({
        ...projectAccess,
        clientId: String(body.clientId ?? ""),
        role: collaboratorRole(body.role),
      });
      return jsonResponse(request, env, permission);
    }
  }

  if (
    segments[2] === "collaborators" &&
    segments[3] &&
    request.method === "DELETE"
  ) {
    await room.removeCollaborator({
      ...projectAccess,
      clientId: decodeURIComponent(segments[3]),
    });
    return emptyResponse(request, env, { status: 204 });
  }

  return errorResponse(request, env, "Not found", 404);
}

export async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  void ctx;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env),
    });
  }

  const url = new URL(request.url);
  const segments = pathSegments(url);

  try {
    if (url.pathname === "/") {
      return jsonResponse(request, env, {
        ok: true,
        service: "LatexDo collaboration API",
        endpoints: {
          health: "/health",
          openProject: "POST /api/projects/open",
          createProject: "POST /api/projects",
          files: "/api/projects/:projectId/files",
          shares: "/api/shares/:token/open",
        },
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse(request, env, { ok: true });
    }

    if (segments[0] === "api" && segments[1] === "projects") {
      return await handleProjects(request, env, segments.slice(1));
    }

    if (segments[0] === "api" && segments[1] === "shares") {
      return await handleShares(request, env, segments.slice(1));
    }

    return errorResponse(request, env, "Not found", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    const status =
      message.includes("access") ||
      message.includes("share token") ||
      message.includes("permission") ||
      message.includes("Only admins") ||
      message.includes("read-only") ||
      message.includes("revoked")
        ? 403
        : 400;
    console.error(
      JSON.stringify({
        level: "error",
        message: "Request failed",
        path: url.pathname,
        method: request.method,
        error: message,
      }),
    );
    return errorResponse(request, env, message, status);
  }
}
