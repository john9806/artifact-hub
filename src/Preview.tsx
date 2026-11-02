import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "./api";

type Source = { environment?: "dev" | "prod"; pullNumber?: number; revision?: string };
const messageSchema = z.object({
  type: z.literal("artifact-hub:query"),
  channel: z.string().regex(/^[a-f0-9]{32}$/),
  id: z.string().max(20),
  query: z.unknown(),
});

export function Preview({ id, revision, source }: { id: string; revision: string; source: Source }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    const controller = new AbortController();
    setUrl("");
    setError("");
    api<{ url: string }>(`/api/artifacts/${id}/preview`, "POST", { ...JSON.parse(sourceKey), expectedRevision: revision }, controller.signal)
      .then((result) => setUrl(result.url))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Cannot load preview.");
      });
    return () => controller.abort();
  }, [id, revision, sourceKey, generation]);

  useEffect(() => {
    const controller = new AbortController();
    let active = 0;
    const handle = async (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const message = messageSchema.safeParse(event.data);
      if (!message.success) return;
      const target = frame.current.contentWindow;
      const reply = (result?: unknown, failure?: string) => {
        if (!controller.signal.aborted) target?.postMessage({
          type: "artifact-hub:result", channel: message.data.channel, id: message.data.id,
          result, error: failure,
        }, "*");
      };
      if (active >= 3) { reply(undefined, "Too many concurrent queries."); return; }
      active++;
      try {
        const result = await api(`/api/artifacts/${id}/query`, "POST", {
          source: { revision }, query: message.data.query,
        }, controller.signal);
        reply(result);
      } catch (failure) {
        reply(undefined, failure instanceof Error ? failure.message : "Cube query failed.");
      } finally { active--; }
    };
    window.addEventListener("message", handle);
    return () => { controller.abort(); window.removeEventListener("message", handle); };
  }, [id, revision, generation]);

  return <section className="preview-shell">
    <div className="preview-toolbar">
      <span><span className="status-dot" /> Isolated browser preview</span>
      <button className="button small ghost" onClick={() => setGeneration((value) => value + 1)}>Reload preview</button>
    </div>
    {error ? <div className="notice error" role="alert">{error}</div> :
      url ? <iframe key={url} ref={frame} title="Interactive artifact preview" src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" /> :
        <div className="empty small-empty">Preparing an immutable preview...</div>}
    <div className="preview-footer">No app cookies or direct network access. Only explicitly granted Cube queries are bridged.</div>
  </section>;
}
