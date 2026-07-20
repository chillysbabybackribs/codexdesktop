// Browser routing used to be appended to user input as a private model hint.
// Keep old stored turns clean in the transcript without hiding similar text
// unless it is the reserved, single-line note at the end of the message.
const legacyBrowserRoutingNote =
  /(?:\r?\n){0,2}\[browser routing\] mode=(?:live|background|dual) \((?:quality-max|balanced|manual)\):[^\r\n]*$/;

export function stripLegacyBrowserRoutingNote(text: string): string {
  return text.replace(legacyBrowserRoutingNote, '').trimEnd();
}
