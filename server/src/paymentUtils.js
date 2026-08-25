export function generateAccountNumber() {
  return String(
    Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)
  );
}