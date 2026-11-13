// One definition of "control character" for everything displayed or stored from outside
// input: C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F), which includes the
// 8-bit terminal escape introducers.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

export function hasControl(value) {
  return CONTROL.test(String(value ?? ""));
}

// Replace each control character with a space and trim. Callers add their own limits.
export function stripControls(value) {
  return String(value ?? "").replace(CONTROLS, " ").trim();
}
