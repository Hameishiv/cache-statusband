// One definition of "control character" for everything displayed or stored from outside
// input: C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F), which includes the
// 8-bit terminal escape introducers. It also covers the bidirectional embedding,
// override and isolate controls (U+202A-U+202E, U+2066-U+2069) and the line and paragraph
// separators (U+2028, U+2029), which can reorder or break up what is displayed. Ordinary
// Hebrew and Arabic letters and emoji joiners (U+200D) are not touched.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function hasControl(value) {
  return CONTROL.test(String(value ?? ""));
}

// Replace each control character with a space and trim. Callers add their own limits.
export function stripControls(value) {
  return String(value ?? "").replace(CONTROLS, " ").trim();
}
