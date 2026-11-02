export async function api<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, credentials: "same-origin", signal,
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Artifact-Hub": "1" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = typeof result === "object" && result && "error" in result && typeof result.error === "string"
      ? result.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return result as T;
}
