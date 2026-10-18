// Normalise phone numbers for matching: "+92 300-1234567" -> "+923001234567", "whatsapp:+1..." -> "+1...".
export function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^(whatsapp|sms):/i, '');
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+?\d{6,16}$/.test(s)) return null;
  return s;
}
