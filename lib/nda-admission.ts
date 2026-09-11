export type NdaTaskEntryState = {
  hasCurrentApproval: boolean;
  hasHistoricalArchivedNda: boolean;
  enteredNdaForm: boolean;
  loadFailed: boolean;
};

export function ndaAdmissionIdentityKey(email: string | null | undefined): string {
  return email?.trim().toLowerCase() || "nda-admission-unknown";
}

export function shouldHighlightNdaTaskEntry(state: NdaTaskEntryState): boolean {
  return !state.loadFailed
    && !state.hasCurrentApproval
    && !state.hasHistoricalArchivedNda
    && !state.enteredNdaForm;
}
