"use client";

// New-engagement picker, opened in place over any dashboard view instead of
// routing to its own page. The dispatch contract is POST /engagements with body
// { repoId } only: no scope or spend/token caps (those are server-side operator
// config), so this is a repo picker plus a submit, not a settings form.
//
// NewEngagementProvider wraps the dashboard tree and owns the open state;
// useNewEngagement() opens it from anywhere inside (the page header button and
// the sidebar both use it). While open, the page behind is dimmed to near-black
// and does not scroll, Escape closes it, and the repo list is searchable and
// scrolls on its own so a long account stays navigable.
//
// Flow: open -> load repos (listRepos) -> pick one (we probe GET
// /repos/:id/deployable) -> createEngagement({ repoId }) -> route to the live
// view. On mock, createEngagement synthesizes an id and routes to the demo
// stream. A quota 429 renders inline; the cap is enforced server-side, the UI
// only shows the rejection.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import {
  listRepos,
  getRepoDeployable,
  createEngagement,
  ApiError,
} from "@/lib/api";
import type { Repo } from "@/lib/mock-repos";
import { cn } from "@/lib/format";
import { CheckIcon, SpinnerIcon, BanIcon, SearchIcon, XIcon } from "./icons";

const NewEngagementContext = createContext<(() => void) | null>(null);

/** Open the new-engagement picker. Only valid under <NewEngagementProvider>. */
export function useNewEngagement(): () => void {
  const open = useContext(NewEngagementContext);
  if (!open)
    throw new Error(
      "useNewEngagement must be used within <NewEngagementProvider>",
    );
  return open;
}

export function NewEngagementProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openPicker = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  // While the picker is up: Escape closes it, and the page behind does not
  // scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  return (
    <NewEngagementContext.Provider value={openPicker}>
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(<Picker onClose={close} />, document.body)
        : null}
    </NewEngagementContext.Provider>
  );
}

/**
 * A plain button that opens the picker, for callers that would rather not pull
 * the hook in themselves.
 */
export function NewEngagementTrigger({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const open = useNewEngagement();
  return (
    <button type="button" onClick={open} className={className}>
      {children}
    </button>
  );
}

function Picker({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);

  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  // Deployable probe state for the selected repo.
  const [probing, setProbing] = useState(false);
  const [deployable, setDeployable] = useState<boolean | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on mount (the picker only mounts while open) and focus the search.
  useEffect(() => {
    let live = true;
    listRepos()
      .then((rs) => live && setRepos(rs))
      .catch(() => live && setLoadError(true));
    searchRef.current?.focus();
    return () => {
      live = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return null;
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  function pick(id: number) {
    if (submitting) return;
    setSelected(id);
    setError(null);
    setDeployable(null);
    setProbing(true);
    getRepoDeployable(id)
      .then(setDeployable)
      .catch(() => {
        // A probe failure should not block dispatch: let the server be the gate.
        setDeployable(true);
      })
      .finally(() => setProbing(false));
  }

  async function submit() {
    if (selected == null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await createEngagement({ repoId: selected });
      router.push(`/dashboard/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError(
          "You are at your engagement cap. Wait for a running engagement to finish, or contact the operator to raise the limit.",
        );
      } else if (e instanceof ApiError && e.status === 400) {
        setError("That repo cannot be dispatched. Pick another.");
      } else {
        setError("Could not start the engagement. Try again.");
      }
      setSubmitting(false);
    }
  }

  const canSubmit =
    selected != null && !probing && deployable !== false && !submitting;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-engagement-title"
    >
      {/* the page behind, dimmed to near-black */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        disabled={submitting}
        className="absolute inset-0 cursor-default bg-black/80"
      />

      <div className="relative my-auto flex w-full max-w-lg flex-col rounded-md border border-white/10 bg-surface">
        {/* header */}
        <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <h2
              id="new-engagement-title"
              className="text-sm font-semibold tracking-tight text-text"
            >
              New engagement
            </h2>
            <p className="mt-1 text-sm text-muted">
              Pick a repository to deploy and attack in isolation. Only repos
              with a Dockerfile or compose file can be deployed.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={submitting}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-text active:scale-[0.97] disabled:opacity-50"
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* search */}
        <div className="px-5">
          <div className="flex h-9 items-center gap-2 rounded-md border border-white/10 bg-canvas px-3 focus-within:border-white/20">
            <SearchIcon size={15} className="shrink-0 text-faint" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search repositories"
              disabled={submitting}
              // The container carries the focus state (a subtle hairline shift);
              // override the global accent focus ring so the input itself stays
              // quiet. Inline wins because that ring is unlayered global CSS.
              style={{ outline: "none" }}
              className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-faint disabled:opacity-50"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:text-text"
              >
                <XIcon size={13} />
              </button>
            )}
          </div>
        </div>

        {/* repo list: scrolls on its own so a long account stays navigable */}
        <div className="mt-4 max-h-[46vh] min-h-[7rem] overflow-y-auto border-t border-white/10 sm:max-h-80">
          {repos == null && !loadError && (
            <div className="flex items-center gap-2 px-5 py-6 text-sm text-faint">
              <SpinnerIcon size={15} className="animate-spin" />
              Loading repositories
            </div>
          )}

          {loadError && (
            <div className="px-5 py-6 text-sm text-muted">
              Could not load your repositories. Close this and try again.
            </div>
          )}

          {repos != null && repos.length === 0 && (
            <div className="px-5 py-6 text-sm text-muted">
              No repositories found on your account.
            </div>
          )}

          {filtered != null && repos != null && repos.length > 0 && filtered.length === 0 && (
            <div className="px-5 py-6 text-sm text-muted">
              No repositories match{" "}
              <span className="font-mono text-text">{query}</span>.
            </div>
          )}

          {filtered?.map((r, i) => {
            const isSel = r.id === selected;
            return (
              <button
                key={r.id}
                type="button"
                aria-pressed={isSel}
                onClick={() => pick(r.id)}
                disabled={submitting}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors",
                  i > 0 && "border-t border-white/10",
                  isSel ? "bg-accent-soft" : "hover:bg-surface-2",
                  submitting && "cursor-not-allowed opacity-60",
                )}
              >
                <span className="block min-w-0 truncate font-mono text-sm text-text">
                  {r.fullName}
                </span>
                {isSel && (
                  <span className="flex shrink-0 items-center">
                    {probing ? (
                      <SpinnerIcon
                        size={15}
                        className="animate-spin text-faint"
                      />
                    ) : deployable === false ? (
                      <span className="flex items-center gap-1.5 font-mono text-xs text-faint">
                        <BanIcon size={13} />
                        not deployable
                      </span>
                    ) : (
                      <CheckIcon size={16} className="text-accent-bright" />
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* footer: deployable note / error, then the submit */}
        <div className="border-t border-white/10 px-5 py-4">
          {selected != null && deployable === false && !probing && (
            <p className="mb-3 text-sm text-muted">
              This repository has no Dockerfile or compose file, so it cannot be
              deployed. Pick a deployable one.
            </p>
          )}

          {error && (
            <p className="mb-3 rounded-md border border-accent-line bg-accent-soft px-3 py-2 text-sm text-text">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            {selected == null && (
              <span className="mr-auto text-sm text-faint">
                Select a repository first.
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex h-9 items-center rounded-md px-4 text-sm font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className={cn(
                "flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors",
                canSubmit
                  ? "hover:bg-accent-bright active:scale-[0.99]"
                  : "cursor-not-allowed opacity-50",
              )}
            >
              {submitting && <SpinnerIcon size={15} className="animate-spin" />}
              {submitting ? "Starting" : "Start engagement"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
