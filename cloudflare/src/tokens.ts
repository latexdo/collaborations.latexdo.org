const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function randomSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function createShareToken(projectId: string): string {
  return `${projectId}.${randomSecret()}`;
}

export function projectIdFromShareToken(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const projectId = token.slice(0, separator);
  return /^[a-z0-9_:-]{6,128}$/i.test(projectId) ? projectId : null;
}

export async function defaultProjectIdForSession(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`latexdo-default-project:${sessionId}`),
  );
  return `session_${bytesToHex(new Uint8Array(digest)).slice(0, 32)}`;
}
