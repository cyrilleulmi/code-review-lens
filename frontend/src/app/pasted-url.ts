/** Characters copy and paste brings along around a URL: spaces incl. non-breaking and zero-width ones, byte order mark, <…> of mails. */
const NOISE = /^[\s ​-‍⁠﻿<]+|[\s ​-‍⁠﻿>]+$/g;

/** The http(s) URL in a pasted text without the noise copying brings along; null when the text is no URL. */
export function pastedUrl(text: string): string | null {
  const url = text.replace(NOISE, '');
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}
