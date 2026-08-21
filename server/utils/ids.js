export function nextComplaintId(sequence) {
  return `CIV-${new Date().getFullYear()}-${String(sequence).padStart(6, '0')}`;
}

