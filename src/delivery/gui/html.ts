/**
 * HTML-escaping for any string interpolated into innerHTML. Workflow ids,
 * agent names, and gate output originate from user-authored YAML and script
 * stdout — never trust them as markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
