import { randomBytes } from "node:crypto";

export function frameDocument(html: string, appOrigin: string): string {
  const channel = randomBytes(16).toString("hex");
  const bridge = `<script>(() => {
    const parentOrigin = ${JSON.stringify(appOrigin)};
    const channel = ${JSON.stringify(channel)};
    let sequence = 0;
    const pending = new Map();
    addEventListener("message", event => {
      if (event.source !== parent || event.origin !== parentOrigin ||
          event.data?.type !== "artifact-hub:result" || event.data.channel !== channel) return;
      const operation = pending.get(event.data.id);
      if (!operation) return;
      pending.delete(event.data.id);
      clearTimeout(operation.timer);
      if (event.data.error) operation.reject(new Error(event.data.error));
      else operation.resolve(event.data.result);
    });
    Object.defineProperty(globalThis, "artifactHub", { value: Object.freeze({
      query(query) {
        if (pending.size >= 3) return Promise.reject(new Error("Too many pending queries."));
        return new Promise((resolve, reject) => {
          const id = String(++sequence);
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Cube query timed out.")); }, 25000);
          pending.set(id, { resolve, reject, timer });
          parent.postMessage({ type: "artifact-hub:query", channel, id, query }, parentOrigin);
        });
      }
    }), writable: false, configurable: false });
  })();</script>`;
  // Prefixing executes the bridge before any untrusted script. HTML parsers accept it before a doctype.
  return bridge + html;
}

export function artifactCsp(appOrigin: string): string {
  return [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    "img-src data: blob:", "font-src data:", "connect-src 'none'", "frame-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "worker-src 'none'",
    "sandbox allow-scripts", `frame-ancestors ${appOrigin}`,
  ].join("; ");
}
