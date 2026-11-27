import { ARTIFACT_SLUG } from './artifactPage.ts';
import { escapeHtml } from './shareCard.ts';

export const RSVP_PATH = '/a/rsvp/';

export function rsvpSlug(path: string) {
  const slug = path.slice(RSVP_PATH.length);
  return path.startsWith(RSVP_PATH) && ARTIFACT_SLUG.test(slug) ? slug : null;
}

export function rsvpId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function rsvpResponse(
  slug: string,
  invitation: { title: string; details: string } | null,
  result: 'saved' | 'invalid' | 'full' | null = null,
) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; sandbox allow-forms; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (!invitation || !ARTIFACT_SLUG.test(slug)) {
    return new Response('This invitation is unavailable.', { status: 404, headers });
  }

  const title = escapeHtml(invitation.title);
  const details = escapeHtml(invitation.details);
  const form = result === 'saved'
    ? '<p role="status">Your RSVP is saved. Thanks for replying.</p>'
    : result === 'full'
      ? '<p role="status">This invitation has stopped accepting replies.</p>'
      : `<form method="post" action="${RSVP_PATH}${slug}">
  ${result === 'invalid' ? '<p role="alert">Enter your name and choose a reply.</p>' : ''}
  <input type="hidden" name="request" value="${rsvpId()}">
  <label for="name">Your name</label>
  <input id="name" name="name" type="text" autocomplete="name" maxlength="80" required>
  <fieldset>
    <legend>Can you make it?</legend>
    <label><input type="radio" name="attendance" value="yes" required> Yes, I’ll be there</label>
    <label><input type="radio" name="attendance" value="no" required> No, I can’t make it</label>
  </fieldset>
  <button type="submit">Send RSVP</button>
  <small>Only the organizer can see your reply.</small>
</form>`;

  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f3eb; color: #202a24; font: 1.0625rem/1.55 system-ui, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: clamp(2rem, 8vw, 6rem) 1.5rem; }
  h1 { margin: 0 0 1rem; font: clamp(2.5rem, 8vw, 4rem)/1.06 Georgia, serif; letter-spacing: -.04em; }
  .details { white-space: pre-wrap; margin: 0 0 1.75rem; }
  form { background: #fffefa; border: 1px solid #d5d9cc; border-radius: 1rem; padding: 1.5rem; }
  label, legend { font-weight: 600; }
  input[type=text] { display: block; width: 100%; margin-top: .45rem; border: 1px solid #879181; padding: .55rem .65rem; border-radius: .4rem; font: inherit; }
  fieldset { border: 0; padding: 0; margin: 1rem 0; }
  fieldset label { display: block; padding: .3rem 0; font-weight: 400; }
  input[type=radio] { accent-color: #235940; }
  button { background: #235940; color: white; border: 0; border-radius: .4rem; padding: .6rem 1rem; font: inherit; cursor: pointer; }
  small { display: block; margin-top: .7rem; color: #48554b; }
</style>
</head>
<body><main><h1>${title}</h1><p class="details">${details}</p>${form}</main></body>
</html>`, { headers, status: result === 'invalid' ? 400 : result === 'full' ? 409 : 200 });
}
