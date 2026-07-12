import { corsHeaders } from "./auth";
import type { Env, ProjectEntry } from "./types";

export const starterDocument = String.raw`\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{microtype}
\usepackage{hyperref}

\title{My LatexDo Document}
\author{}
\date{\today}

\begin{document}

\maketitle

\section{Introduction}

Start writing here.

\end{document}
`;

export function jsonResponse(
  request: Request,
  env: Env,
  data: unknown,
  init: ResponseInit = {},
): Response {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      ...init.headers,
    },
  });
}

export function emptyResponse(
  request: Request,
  env: Env,
  init: ResponseInit = {},
): Response {
  return new Response(null, {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      ...init.headers,
    },
  });
}

export function errorResponse(
  request: Request,
  env: Env,
  message: string,
  status = 400,
): Response {
  return jsonResponse(request, env, { error: message }, { status });
}

export function normalizeRelativePath(path: string): string {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)\.\//g, "$1")
    .replace(/\/+$/g, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized.length > 512 ||
    normalized.split("/").some((segment) => !segment || segment === "..")
  ) {
    throw new Error("Use a relative path inside the project.");
  }

  return normalized;
}

export function fileName(path: string): string {
  return path.split("/").pop() || path;
}

export function starterContent(path: string): string {
  if (fileName(path) === "main.tex") {
    return starterDocument;
  }
  if (path.endsWith(".bib")) {
    return "% Add BibTeX entries here.\n";
  }
  return "";
}

interface TreeNode {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  children: Map<string, TreeNode>;
}

function toProjectEntry(node: TreeNode, projectRoot: string): ProjectEntry {
  const children = [...node.children.values()]
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    })
    .map((child) => toProjectEntry(child, projectRoot));

  return {
    name: node.name,
    path: `${projectRoot}/${node.relativePath}`,
    relativePath: node.relativePath,
    type: node.type,
    ...(children.length > 0 ? { children } : {}),
  };
}

export function entriesToTree(
  rows: Array<{ path: string; type: "file" | "directory" }>,
  projectRoot: string,
): ProjectEntry[] {
  const root: TreeNode = {
    name: "",
    relativePath: "",
    type: "directory",
    children: new Map(),
  };

  for (const row of rows) {
    const parts = row.path.split("/");
    let parent = root;
    let relativePath = "";
    parts.forEach((part, index) => {
      relativePath = relativePath ? `${relativePath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      const existing = parent.children.get(part);
      if (existing) {
        parent = existing;
        return;
      }
      const node: TreeNode = {
        name: part,
        relativePath,
        type: isLeaf ? row.type : "directory",
        children: new Map(),
      };
      parent.children.set(part, node);
      parent = node;
    });
  }

  return [...root.children.values()]
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    })
    .map((node) => toProjectEntry(node, projectRoot));
}
