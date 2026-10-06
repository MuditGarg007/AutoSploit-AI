"use client";

// Repo picker for a new engagement. The real dispatch contract is POST
// /engagements with body { repoId } only: no scope, no spend/token caps (those
// are server-side operator config, not form fields). So this is a picker plus a
// submit, not a settings form. Pick a repo, we probe its deployable gate (GET
// /repos/:id/deployable), then createEngagement({ repoId }) and route to the live
// view. On mock, createEngagement synthesizes an id and we route to the demo
// stream. A quota 429 is rendered inline (the cap is enforced server-side; the UI
// only shows the rejection).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listRepos,
  getRepoDeployable,
  createEngagement,
  ApiError,
} from "@/lib/api";
import type { Repo } from "@/lib/mock-repos";
import { cn } from "@/lib/format";
import { CheckIcon, SpinnerIcon, BanIcon } from "./icons";

export default function NewEngagementForm() {
  const router = useRouter();

  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  // Deployable probe state for the selected repo.
  const [probing, setProbing] = useState(false);
  const [deployable, setDeployable] = useState<boolean | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listRepos()
      .then((rs) => live && setRepos(rs))
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, []);

  function pick(id: number) {
    if (submitting) return;
    setSelected(id);
    setError(null);
    setDeployable(null);
    setProbing(true);
    getRepoDeployable(id)
      .then((d) => {
        setDeployable(d);
      })
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
    <div className="mt-8 max-w-2xl">
      <h2 className="text-sm font-semibold tracking-tight text-text">
        Choose a repository
      </h2>
      <p className="mt-1 text-sm text-muted">
        Only repositories with a Dockerfile or compose file can be deployed.
      </p>

      <div className="mt-4 overflow-hidden rounded-md border border-white/10 bg-surface">
        {repos == null && !loadError && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-faint">
            <SpinnerIcon size={15} className="animate-spin" />
            Loading repositories
          </div>
        )}

        {loadError && (
          <div className="px-4 py-6 text-sm text-muted">
            Could not load your repositories. Reload the page to try again.
          </div>
        )}

        {repos != null && repos.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted">
            No repositories found on your account.
          </div>
        )}

        {repos?.map((r, i) => {
          const isSel = r.id === selected;
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={isSel}
              onClick={() => pick(r.id)}
              disabled={submitting}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors",
                i > 0 && "border-t border-white/10",
                isSel ? "bg-accent-soft" : "hover:bg-surface-2",
                submitting && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm text-text">
                  {r.fullName}
                </span>
              </span>
              {isSel && (
                <span className="flex shrink-0 items-center">
                  {probing ? (
                    <SpinnerIcon size={15} className="animate-spin text-faint" />
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

      {selected != null && deployable === false && !probing && (
        <p className="mt-3 text-sm text-muted">
          This repository has no Dockerfile or compose file, so it cannot be
          deployed. Pick a deployable one.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-md border border-accent-line bg-accent-soft px-3 py-2 text-sm text-text">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
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
        {selected == null && (
          <span className="text-sm text-faint">Select a repository first.</span>
        )}
      </div>
    </div>
  );
}
