// Moss's AutoLinkPlugin matchers. Tests first: these still run moss's own regexes.

const EMAIL_REGEX =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;

const SCHEMELESS_URL_REGEX =
  /(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{1,23}(?::\d{1,5})?(?:[/?#][^\s<>{}|\\^[\]`]*)?/g;

export interface AutolinkMatch {
  index: number;
  text: string;
}

export function* schemelessUrlMatches(text: string): Generator<AutolinkMatch> {
  for (const match of text.matchAll(SCHEMELESS_URL_REGEX)) yield { index: match.index, text: match[0] };
}

export function findEmail(text: string): AutolinkMatch | null {
  const match = EMAIL_REGEX.exec(text);
  return match && { index: match.index, text: match[0] };
}
