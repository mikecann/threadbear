// What a published Print's HTML is wrapped in before the website draws it
// (print.tsx): the same Content-Security-Policy the Mac puts in front of a
// page in a reply (RichPages.policy), so nothing loads from anywhere and
// only inline styles and data: pictures show, and a <base> that sends every
// link to a new window, which the frame's sandbox then refuses. With the
// frame's empty `sandbox` (no scripts, no forms, no same origin), a print
// is a picture of a page: it can't run, send or go anywhere.
export const PRINT_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'";

export function printDoc(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${PRINT_POLICY}"><base target="_blank">`;
  // In front of everything, so no markup of the print's comes before it.
  return /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${head}`) : head + html;
}
