// colour.js - a server's identity hue.
//
// The Go side decides which hue a server wears (config.Server.Colour, which
// derives one from the name when the config-file does not say). The browser
// only turns that name into a class, so the two never disagree about which
// server is which.

const NAMES = ['violet', 'indigo', 'azure', 'magenta', 'plum', 'steel'];

// classOf returns the class that sets --srv for a server's hue. An unknown
// name gets no class rather than a wrong colour: a server drawn in the
// default grey is honest, one drawn in another server's colour is not.
export function classOf(colour) {
  return NAMES.includes(colour) ? 'srv-' + colour : '';
}

// paint puts a server's hue on an element, replacing whatever was there.
export function paint(el, colour) {
  for (const n of NAMES) el.classList.remove('srv-' + n);
  const c = classOf(colour);
  if (c) el.classList.add(c);
  return el;
}

export const colourNames = NAMES;
