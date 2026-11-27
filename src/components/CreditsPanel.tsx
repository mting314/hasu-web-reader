import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import type { TranslationSource } from "../types/scenario";
import { APP_CREDITS, FAN_DISCLAIMER } from "../credits";

interface CreditsPanelProps {
  translationSources: TranslationSource[];
  episodeTitle: string;
  onClose: () => void;
}

const LinkOut: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 hover:underline"
  >
    {children}
    <ExternalLink className="h-3 w-3 shrink-0" />
  </a>
);

export const CreditsPanel: React.FC<CreditsPanelProps> = ({ translationSources, episodeTitle, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // De-duplicate sources that share a translator (e.g. Hasu-KO EN and its dub edit)
  const translators = Array.from(
    new Map(translationSources.map((s) => [s.attribution, s])).values()
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Credits"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-[#0f131c] p-5 text-sm text-slate-200 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Credits</h2>
            <p className="mt-0.5 text-xs text-slate-400">{FAN_DISCLAIMER}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close credits"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <section className="mt-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
            Translations · {episodeTitle}
          </h3>
          {translators.length === 0 ? (
            <p className="mt-2 text-slate-400">No translations for this episode.</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {translators.map((t) => (
                <li key={t.attribution}>
                  <div className="font-medium text-white">
                    {t.homepage ? <LinkOut href={t.homepage}>{t.attribution}</LinkOut> : t.attribution}
                  </div>
                  <ul className="mt-1 space-y-1 text-xs text-slate-400">
                    {translationSources
                      .filter((s) => s.attribution === t.attribution)
                      .map((s) => (
                        <li key={s.id}>
                          <span className="text-slate-200">{s.label}</span>
                          {s.note && <span> — {s.note}</span>}
                          {s.url && (
                            <span className="ml-1.5">
                              <LinkOut href={s.url}>this episode</LinkOut>
                            </span>
                          )}
                          {s.credits && s.credits.length > 0 && (
                            <ul className="mt-1 space-y-0.5 pl-3">
                              {s.credits.map((c) => (
                                <li key={c.role}>
                                  <span className="text-slate-300">{c.role}:</span>{" "}
                                  {c.people.map((p, i) => (
                                    <React.Fragment key={p.url ?? p.name}>
                                      {i > 0 && ", "}
                                      {p.url ? <LinkOut href={p.url}>{p.name}</LinkOut> : p.name}
                                    </React.Fragment>
                                  ))}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        {APP_CREDITS.map((section) => (
          <section key={section.title} className="mt-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
              {section.title}
            </h3>
            <ul className="mt-2 space-y-2.5">
              {section.items.map((item) => (
                <li key={item.name}>
                  <div className="font-medium text-white">
                    {item.url ? <LinkOut href={item.url}>{item.name}</LinkOut> : item.name}
                    {item.license && (
                      <a
                        href={item.license.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-normal text-slate-300 hover:bg-slate-700"
                      >
                        {item.license.label}
                      </a>
                    )}
                  </div>
                  {item.detail && <p className="mt-0.5 text-xs text-slate-400">{item.detail}</p>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>,
    document.fullscreenElement ?? document.body
  );
};
