export type CirculationPerson = { memberId: string; email: string; name: string; accountUserId: string };
export type CirculationDecision = CirculationPerson & { confirmedAt: string; note: string };
type DirectoryMember = { id: string; fullName: string; chatgptAccount: string; accountUserId: string | null; status: string };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const email = (value: unknown) => text(value).toLowerCase();

export function circulationPeople(value: unknown): CirculationPerson[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const person = item as Record<string, unknown>;
    return text(person.memberId) && email(person.email) && text(person.accountUserId)
      ? [{ memberId: text(person.memberId), email: email(person.email), name: text(person.name), accountUserId: text(person.accountUserId) }]
      : [];
  });
}

export function normalizeCirculationSelection(raw: unknown, directory: DirectoryMember[], label: string, allowEmpty = false): { people: CirculationPerson[]; error?: string } {
  if (!Array.isArray(raw) || raw.length > 50 || (!allowEmpty && raw.length === 0)) return { people: [], error: `请选择 1 至 50 位${label}。` };
  const selected: CirculationPerson[] = [];
  for (const value of raw) {
    const id = text(typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).memberId : "");
    const member = directory.find((item) => item.id === id && item.status === "active" && item.accountUserId);
    if (!member) return { people: [], error: `${label}中有成员已失效或尚未完成成员准入，请重新选择。` };
    if (selected.some((person) => person.memberId === id || person.accountUserId === member.accountUserId || person.email === email(member.chatgptAccount))) return { people: [], error: `${label}不能重复选择。` };
    selected.push({ memberId: id, email: email(member.chatgptAccount), name: member.fullName, accountUserId: member.accountUserId! });
  }
  return { people: selected };
}

export function isCirculationParticipant(payload: Record<string, unknown>, currentEmail: string) {
  return [...circulationPeople(payload.circulationRecipients), ...circulationPeople(payload.circulationApprovers)].some((person) => person.email === email(currentEmail));
}

export function pendingCirculationPeople(payload: Record<string, unknown>, step: string) {
  const review = step === "指定审批";
  if (!review && step !== "流转确认") return [];
  const selected = circulationPeople(review ? payload.circulationApprovers : payload.circulationRecipients);
  const decisions = circulationPeople(review ? payload.circulationApprovals : payload.circulationConfirmations);
  return selected.filter((person) => !decisions.some((decision) => decision.memberId === person.memberId && decision.accountUserId === person.accountUserId && decision.email === person.email));
}

export function circulationPendingForEmail(payload: Record<string, unknown>, step: string, currentEmail: string) {
  return pendingCirculationPeople(payload, step).some((person) => person.email === email(currentEmail));
}

export function validateStoredCirculation(payload: Record<string, unknown>, directory: DirectoryMember[], requesterEmail: string) {
  const recipients = circulationPeople(payload.circulationRecipients);
  const approvers = circulationPeople(payload.circulationApprovers);
  if ((!recipients.length && !approvers.length) || !text(payload.circulationContent)) return "请填写流转事项，并至少选择流转对象或审批人。";
  for (const [people, label] of [[recipients, "流转对象"], [approvers, "审批人"]] as const) {
    const normalized = normalizeCirculationSelection(people, directory, label, true);
    if (normalized.error) return normalized.error;
    if (normalized.people.some((person, index) => person.accountUserId !== people[index].accountUserId || person.email !== people[index].email)) return `${label}的账户身份已变化，请重新编辑并选择。`;
  }
  if (approvers.some((person) => person.email === email(requesterEmail))) return "申请人不能审批自己的申请，请选择其他成员。";
  return null;
}
