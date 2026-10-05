export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error) ||
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data && typeof data === "object" ? (data as Record<string, unknown>) : null);
  }
  return data as T;
}

export async function startDemo(): Promise<void> {
  const res = await fetch("/api/demo", {
    method: "POST",
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  if (res.type !== "opaqueredirect" && !res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? `Could not start the demo (${res.status})`, res.status);
  }
}

export async function startCheckout(plan: "monthly" | "yearly"): Promise<void> {
  const { url } = await postJson<{ url: string }>("/api/checkout", { plan });
  window.location.assign(url);
}

export async function openPortal(): Promise<void> {
  const { url } = await postJson<{ url: string }>("/api/portal");
  window.location.assign(url);
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST", headers: { Accept: "application/json" } }).catch(() => null);
}
