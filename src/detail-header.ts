/** Shared structural header. Slots are trusted, escaped markup supplied by each view. */
export function renderPageHeader(input: { back?: string; title: string; metadata?: string; actions?: string; notice?: string; className?: string }): string {
  return `<header class="whim-detail-header ${input.className ?? ""}"><div class="detail-copy">${input.back ?? ""}<div class="detail-title">${input.title}</div><div class="detail-metadata">${input.metadata ?? ""}</div></div>${input.actions ? `<div class="detail-actions">${input.actions}</div>` : ""}${input.notice ?? ""}</header>`;
}

export const detailHeaderStyles = `
.whim-detail-header { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:12px; padding-top:2px; }
.whim-detail-header .detail-copy { min-width:0; flex:1; }
.whim-detail-header .detail-title { display:flex; align-items:center; gap:4px; }
.whim-detail-header h1 { font-size:26px; line-height:1.2; letter-spacing:-.01em; overflow-wrap:anywhere; min-width:0; }
.whim-detail-header .detail-metadata > p { margin:8px 0 0; color:var(--muted); font-size:14px; }
.whim-detail-header .detail-actions { align-self:center; }
.whim-detail-header .back-link { display:inline-flex; align-items:center; gap:2px; min-height:44px; margin:-10px 0 -4px -6px; padding:0 8px 0 2px; border-radius:8px; color:var(--muted); font-size:14px; font-weight:500; text-decoration:none; }
.whim-detail-header .back-link:hover { color:var(--text); }
@media(max-width:860px), (hover:none) and (pointer:coarse) and (orientation:landscape) and (max-height:600px) { .whim-detail-header h1 { font-size:24px !important; line-height:1.25; } .whim-detail-header .detail-actions { flex-basis:100%; } .whim-detail-header .detail-actions .share { justify-content:flex-start; flex-wrap:wrap; } }
`;
