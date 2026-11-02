import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Artifact, ArtifactSummary, Environment, Promotion, Session } from "../shared/model";
import { MAX_HTML_BYTES } from "../shared/model";
import { api } from "./api";
import { Preview } from "./Preview";
import { SAMPLE_HTML } from "./sample";

type History = { revision: string; title: string; at: string }[];
type PullSummary = { number: number; title: string; html_url: string };
type EditorState = {
  id?: string;
  expectedRevision: string | null;
  title: string;
  description: string;
  html: string;
  allowedMembers: string[];
};
const emptyEditor = (): EditorState => ({ expectedRevision: null, title: "", description: "", html: "", allowedMembers: [] });
const displayDate = (date: string) => new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const libraryUrl = (environment: Environment, id?: string) =>
  `/?${new URLSearchParams({ environment, ...(id ? { artifact: id } : {}) })}`;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [environment, setEnvironment] = useState<Environment>(new URLSearchParams(location.search).get("environment") === "prod" ? "prod" : "dev");
  const [view, setView] = useState<"library" | "reviews">(new URLSearchParams(location.search).get("view") === "reviews" ? "reviews" : "library");
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [pulls, setPulls] = useState<PullSummary[]>([]);
  const [review, setReview] = useState<Promotion | null>(null);
  const [compare, setCompare] = useState<Artifact | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const reviewNumber = /^\/review\/(\d+)$/.exec(location.pathname)?.[1];

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Operation failed."); }
    finally { setBusy(false); }
  };
  const loadSession = useCallback(async () => setSession(await api<Session>("/api/session")), []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!session?.user) return;
    if (reviewNumber) {
      const promotion = await api<Promotion>(`/api/promotions/${reviewNumber}`, "GET", undefined, signal);
      if (!signal?.aborted) setReview(promotion);
    } else if (view === "reviews") {
      const results = await api<PullSummary[]>("/api/promotions", "GET", undefined, signal);
      if (!signal?.aborted) setPulls(results);
    } else {
      const results = await api<ArtifactSummary[]>(`/api/artifacts?environment=${environment}`, "GET", undefined, signal);
      if (!signal?.aborted) setArtifacts(results);
      const linkedId = new URLSearchParams(location.search).get("artifact");
      if (linkedId) {
        const artifact = await api<Artifact>(`/api/artifacts/${encodeURIComponent(linkedId)}?environment=${environment}`, "GET", undefined, signal);
        if (!signal?.aborted) setSelected(artifact);
      }
    }
  }, [session?.user, environment, reviewNumber, view]);

  useEffect(() => {
    loadSession().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Cannot load session."))
      .finally(() => setLoading(false));
  }, [loadSession]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    refresh(controller.signal).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Cannot load library.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  const open = async (id: string) => {
    setShowHistory(false); setHistory([]);
    setSelected(await api<Artifact>(`/api/artifacts/${id}?environment=${environment}`));
    window.history.replaceState({}, "", libraryUrl(environment, id));
  };
  const changeEnvironment = (value: Environment) => {
    setEnvironment(value); setSelected(null); setShowHistory(false); setError("");
    window.history.replaceState({}, "", libraryUrl(value));
  };
  const edit = (artifact: Artifact) => {
    setError("");
    setUploadedFileName(null);
    setEditor({
      id: artifact.id, expectedRevision: artifact.revision,
      title: artifact.title, description: artifact.description, html: artifact.html, allowedMembers: artifact.allowedMembers,
    });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    await perform(async () => {
      const { id, ...body } = editor;
      const result = await api<Artifact>(id ? `/api/artifacts/${id}` : "/api/artifacts", id ? "PUT" : "POST", body);
      setEnvironment("dev"); setView("library"); setSelected(result); setEditor(null); setShowHistory(false);
      window.history.replaceState({}, "", libraryUrl("dev", result.id));
      setArtifacts(await api<ArtifactSummary[]>("/api/artifacts?environment=dev"));
      setNotice("Saved to DEV and committed to Git. Production is unchanged.");
    });
  };
  const upload = async (file: File | undefined) => {
    if (!file || !editor) return;
    if (!/\.html?$/i.test(file.name)) { setError("Upload a self-contained .html file. Other formats are not supported yet."); return; }
    if (file.size > MAX_HTML_BYTES) { setError("HTML must be at most 1 MB."); return; }
    await perform(async () => {
      const html = await file.text();
      if (!html.trim()) throw new Error("The HTML file is empty. Choose a file containing an artifact.");
      setEditor({
        ...editor, html,
        title: editor.id ? editor.title : editor.title || file.name.replace(/\.html?$/i, "").replaceAll(/[-_]/g, " "),
      });
      setUploadedFileName(file.name);
    });
  };
  const filtered = artifacts.filter((artifact) =>
    `${artifact.title} ${artifact.description} ${artifact.owner}`.toLowerCase().includes(search.toLowerCase()));

  if (!session?.user) return <div className="login-page">
    <div className="login-card">
      <div className="brand-mark">a<span>.</span></div>
      <p className="eyebrow">YOUR TEAM'S IDEAS, PUT TO WORK</p>
      <h1>A home for the tools<br />you create with AI.</h1>
      <p>Keep interactive artifacts together. Test in isolation. Review what ships. Every version backed by Git.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? <p>Loading...</p> : <a className="button primary" href="/auth/github">Sign in with GitHub</a>}
      {session?.localDevelopment && <button className="button secondary" disabled={busy} onClick={() => void perform(async () => {
        await api("/auth/local", "POST"); await loadSession();
      })}>Enter local development</button>}
      <small>Private by authentication, not by obscurity. Repository privacy is configured separately.</small>
    </div>
    <div className="login-aside"><div className="orb" /><h2>From a great chat.<br />To a useful team tool.</h2><p>CREATE / KEEP / REVIEW / SHARE</p></div>
  </div>;

  return <div className="app-layout">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark">a<span>.</span></span><span>artifact<span className="brand-light">hub</span></span></a>
      <div className="workspace-label">TEAM WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={view === "library" && !reviewNumber ? "nav-item active" : "nav-item"} onClick={() => {
          if (reviewNumber) location.href = "/"; else { setView("library"); setSelected(null); window.history.replaceState({}, "", libraryUrl(environment)); }
        }}><span className="nav-symbol">&#9638;</span> Artifact library <span className="count">{artifacts.length}</span></button>
        <button className={view === "reviews" || reviewNumber ? "nav-item active" : "nav-item"} onClick={() => {
          if (reviewNumber) location.href = "/?view=reviews"; else { setView("reviews"); setSelected(null); window.history.replaceState({}, "", "/?view=reviews"); }
        }}><span className="nav-symbol">&#8644;</span> Publication reviews</button>
        <a className="nav-item" href={`https://github.com/${session.repository}`} target="_blank" rel="noreferrer"><span className="nav-symbol">&#9095;</span> Git repository <span className="external">&#8599;</span></a>
      </nav>
      <div className="sidebar-info"><span className="status-dot" /><strong>Built for a second look.</strong><p>Draft freely in DEV. A different reviewer approves what goes live.</p></div>
      <div className="profile"><div className="avatar">{session.user.login.slice(0, 2).toUpperCase()}</div><div><strong>{session.user.login}</strong><small>{session.user.canReview ? "Reviewer" : session.user.canWrite ? "Creator" : "Viewer"}</small></div>
        <button className="text-button" onClick={() => void perform(async () => { await api("/auth/logout", "POST"); await loadSession(); })}>Sign out</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>Workspace <span className="breadcrumb">/</span> {reviewNumber ? `Review #${reviewNumber}` : view === "library" ? "Artifact library" : "Publication reviews"}</span><span className="git-pill"><span className="status-dot" /> Git-backed workspace</span></header>
      <div className="page-content">
        {session.localDevelopment && <div className="notice warning">Local development identity. Use GitHub sign-in with a configured reviewer account to publish. Never expose this mode publicly.</div>}
        {error && <div className="notice error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>Dismiss</button></div>}
        {notice && <div className="notice success" role="status">{notice}</div>}
        {review ? <>
          <div className="page-heading"><div><p className="eyebrow">IMMUTABLE RELEASE CANDIDATE</p><h1>{review.artifact.title}</h1><p>Review #{review.number} / requested by @{review.artifact.requestedBy}</p></div>
            <a className="button secondary" href={review.url} target="_blank" rel="noreferrer">Review on GitHub &#8599;</a></div>
          <div className="review-summary"><div><small>PINNED DEV SOURCE</small><code>{review.artifact.sourceRevision?.slice(0, 12)}</code></div><div><small>PR HEAD</small><code>{review.head.slice(0, 12)}</code></div><div><small>APPROVALS</small><strong>{review.approvals.map((name) => `@${name}`).join(", ") || "Awaiting independent review"}</strong></div></div>
          <p>{review.artifact.description}</p>
          <div className="action-row"><button className="button secondary" disabled={busy} onClick={() => void perform(refresh)}>Refresh approval</button>
            <button className="button secondary" disabled={busy} onClick={() => void perform(async () => {
              setCompare(await api<Artifact>(`/api/artifacts/${review.artifact.id}?environment=prod`));
            })}>Compare with production</button>
            <button className="button primary" disabled={busy || !review.canPublish || !session.user.canReview} onClick={() => void perform(async () => {
              await api(`/api/promotions/${review.number}/publish`, "POST", { head: review.head });
              await refresh(); setNotice("Approved artifact published. Other artifacts are unchanged.");
            })}>{review.merged ? "Published" : "Publish approved version"}</button></div>
          {review.blockers.length > 0 && !review.merged && <div className="notice warning">{review.blockers.join(" ")}</div>}
          <div className={compare ? "compare-grid" : ""}><div><h3>Proposed version</h3><Preview id={review.artifact.id} revision={review.head} source={{ pullNumber: review.number }} /></div>
            {compare && <div><h3>Current production <button className="text-button" onClick={() => setCompare(null)}>Close</button></h3><Preview id={compare.id} revision={compare.revision} source={{ environment: "prod" }} /></div>}</div>
          <section className="source-details"><h3>Data grants</h3><p>Cube members: {review.artifact.allowedMembers.join(", ") || "None (offline artifact)"}</p><a className="text-button" href={`${review.url}/files`} target="_blank" rel="noreferrer">Inspect code changes on GitHub &#8599;</a></section>
        </> : view === "reviews" ? <>
          <div className="page-heading"><div><p className="eyebrow">A SECOND PAIR OF EYES</p><h1>Publication reviews</h1><p>Interactive previews of the exact artifact proposed for production.</p></div><button className="button secondary" disabled={busy} onClick={() => void perform(refresh)}>Refresh</button></div>
          {loading ? <div className="empty">Loading reviews...</div> : pulls.length ? <div className="review-list">{pulls.map((pull) => <a className="review-row" key={pull.number} href={`/review/${pull.number}`}><span className="tile-icon">&#8644;</span><div><strong>{pull.title}</strong><p>Pull request #{pull.number} / artifact-scoped promotion</p></div><span>Open preview &#8594;</span></a>)}</div> : <div className="empty"><h2>Nothing waiting for review.</h2><p>Request publication from an artifact's DEV version to create a PR.</p></div>}
        </> : <>
          <div className="page-heading"><div><p className="eyebrow">GOOD IDEAS DESERVE A HOME</p><h1>Your team's little superpowers.</h1><p>Simulators, calculators, and useful things. Kept together, ready to use.</p></div>
            {session.user.canWrite && <button className="button primary" onClick={() => { setError(""); setUploadedFileName(null); setEditor(emptyEditor()); }}>+ Upload new artifact</button>}</div>
          <section className="intro-banner"><div className="banner-icon">&#10023;</div><div><strong>From AI output to a team asset.</strong><p>Upload a self-contained HTML tool. Experiment in DEV. Preview and approve before it reaches PROD.</p></div><span className="badge">HTML + JAVASCRIPT</span></section>
          <div className="library-toolbar"><div className="tabs" aria-label="Environment"><button className={environment === "dev" ? "selected" : ""} onClick={() => changeEnvironment("dev")}><span className="dev-dot" /> Development</button><button className={environment === "prod" ? "selected" : ""} onClick={() => changeEnvironment("prod")}><span className="status-dot" /> Production</button></div><label className="search"><span>&#9906;</span><input aria-label="Search artifacts" placeholder="Search artifacts or owners..." value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
          {selected ? <section className="artifact-detail">
            <button className="text-button back" onClick={() => { setSelected(null); setShowHistory(false); window.history.replaceState({}, "", libraryUrl(environment)); }}>&#8592; All artifacts</button>
            <div className="detail-heading"><div><h2>{selected.title}</h2><p>{selected.description}</p><div className="metadata">@{selected.owner} <span>/</span> {selected.digest.slice(0, 12)} <span>/</span> {environment === "dev" ? "Development draft" : "Approved production"}</div></div>
              <div className="action-row">
                <a className="button secondary" download href={`/api/artifacts/${selected.id}/source?revision=${selected.revision}`}>Download artifact</a>
                <a className="button secondary" href={`https://github.com/${session.repository}/blob/${selected.revision}/artifacts/${selected.id}/artifact.html`} target="_blank" rel="noreferrer">View code on GitHub &#8599;</a>
                <button className="button secondary" onClick={() => void perform(async () => {
                  await navigator.clipboard.writeText(`${location.origin}${libraryUrl(environment, selected.id)}`);
                  setNotice("Artifact link copied. Recipients must sign in to this workspace.");
                })}>Copy link</button>
                {environment === "dev" && session.user.canWrite && <><button className="button secondary" disabled={busy} onClick={() => edit(selected)}>Upload revised version</button><button className="button primary" disabled={busy} onClick={() => void perform(async () => {
                  const promotion = await api<Promotion>(`/api/artifacts/${selected.id}/promote`, "POST", { expectedRevision: selected.revision });
                  location.href = `/review/${promotion.number}`;
                })}>Request publication &#8599;</button></>}
                <button className="button secondary" disabled={busy} onClick={() => void perform(async () => {
                  setHistory(await api<History>(`/api/artifacts/${selected.id}/history`)); setShowHistory((value) => !value);
                })}>Version history</button>
              </div></div>
            <p>To make changes with Claude, download the artifact and give Claude the file. Return to this artifact's DEV version and choose <strong>Upload revised version</strong>. Downloaded HTML runs outside the Hub sandbox if opened locally.</p>
            <Preview id={selected.id} revision={selected.revision} source={{ environment }} />
            {showHistory && <section className="history"><h3>Git version history</h3><p>Restoring creates a new DEV revision. Production still requires a new approval.</p>{history.map((item) => <div className="history-row" key={item.revision}><code>{item.revision.slice(0, 10)}</code><span>{item.title}</span><small>{displayDate(item.at)}</small>{session.user?.canWrite && <button className="text-button" disabled={busy} onClick={() => void perform(async () => {
              const [old, current] = await Promise.all([
                api<Artifact>(`/api/artifacts/${selected.id}/revisions/${item.revision}`),
                api<Artifact>(`/api/artifacts/${selected.id}?environment=dev`),
              ]);
              edit({ ...old, revision: current.revision });
            })}>Restore to editor</button>}</div>)}</section>}
          </section> : loading ? <div className="empty">Loading your workspace...</div> : filtered.length ? <>
            <div className="section-heading"><span>{filtered.length} {filtered.length === 1 ? "artifact" : "artifacts"}</span><span>{environment === "dev" ? "Drafts are ready to try. Approval is only needed to publish." : "Only independently approved, merged releases appear here."}</span></div>
            <div className="artifact-grid">{filtered.map((artifact, index) => <button className="artifact-card" key={artifact.id} onClick={() => void perform(() => open(artifact.id))}>
              <div className="card-top"><span className={`tile-icon tone-${index % 3}`}>&#10023;</span><span className={`badge ${environment}`}>{environment === "dev" ? "DEV" : "PROD"}</span></div>
              <h2>{artifact.title}</h2><p>{artifact.description || "An interactive tool, ready for your team."}</p><div className="card-format">HTML <span>+ JavaScript</span></div><div className="card-bottom"><span>@{artifact.owner}</span><span>{displayDate(artifact.updatedAt)} &#8599;</span></div>
            </button>)}</div>
          </> : <div className="empty"><span className="empty-symbol">&#10023;</span><h2>{search ? "No matching artifacts." : environment === "prod" ? "Your approved tools will live here." : "Your first superpower starts here."}</h2><p>{environment === "prod" ? "Open a DEV artifact, request publication, and get an independent GitHub review." : "Upload a self-contained HTML artifact, or try our synthetic price simulator."}</p>{environment === "dev" && session.user.canWrite && <button className="button secondary" onClick={() => { setError(""); setUploadedFileName(null); setEditor({ ...emptyEditor(), title: "Price simulator", description: "Explore a synthetic price / demand scenario. Demo data only.", html: SAMPLE_HTML }); }}>Try the example simulator</button>}</div>}
          <footer className="page-footer"><span>Every save has a history. Every release has a review.</span><span>Self-contained artifacts / Separate-origin previews</span></footer>
        </>}
      </div>
    </main>
    {editor && <div className="modal-backdrop"><section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-heading">
      <div className="modal-heading"><div><p className="eyebrow">SAVE TO DEVELOPMENT</p><h2 id="editor-heading">{editor.id ? "Update artifact" : "Give your artifact a home."}</h2></div><button className="button ghost" aria-label="Close editor" disabled={busy} onClick={() => setEditor(null)}>Close</button></div>
      <form onSubmit={(event) => void save(event)}>
        {editor.id ? <div className="notice success"><strong>Updating {selected?.id === editor.id ? selected.title : editor.title}</strong><br />Artifact ID: <code>{editor.id}</code><br />The file name does not select the artifact. This replaces its DEV content and keeps its owner, history, and shared link. Production changes only after a new review.</div> :
          <p>This creates a new artifact. To update an existing tool instead, open it in DEV and choose <strong>Upload revised version</strong>.</p>}
        <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) void upload(event.dataTransfer.files[0]); }}><strong>{editor.id ? "Choose the revised HTML file for this artifact" : "Drop your HTML artifact here"}</strong><span>or choose a file / self-contained HTML + inline JavaScript / up to 1 MB</span><input type="file" disabled={busy} accept=".html,.htm,text/html" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
        <div className="form-grid"><label>Title<input required maxLength={100} value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} /></label><label>Purpose and assumptions<input maxLength={800} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="What does it do? What should reviewers verify?" /></label></div>
        <p role="status">{uploadedFileName ? `Selected file: ${uploadedFileName}` : editor.html ? "Artifact content ready. Upload a revised file to replace it, or save changes to its details only." : "Choose an HTML file before saving."} Source code and code diffs are available in GitHub, not in this dialog.</p>
        {session.cubeMembers.length > 0 && <fieldset><legend>Optional Cube data grants</legend><p>Only grant members this artifact needs. Changes are included in publication review.</p><div className="member-list">{session.cubeMembers.map((member) => <label key={member}><input type="checkbox" checked={editor.allowedMembers.includes(member)} onChange={(event) => setEditor({ ...editor, allowedMembers: event.target.checked ? [...editor.allowedMembers, member] : editor.allowedMembers.filter((value) => value !== member) })} />{member}</label>)}</div></fieldset>}
        <div className="notice warning">Only upload content approved for this Git repository. Files remain in Git history. Do not include secrets or confidential data in a public repository.</div>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="modal-actions"><small>Saving does not change production. Preview becomes available after saving.</small><button className="button primary" disabled={busy || !editor.html.trim()}>{busy ? "Saving..." : "Save to DEV"}</button></div>
      </form>
    </section></div>}
  </div>;
}
